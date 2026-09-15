import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.js';
import { authenticated,setScope } from '../src/core/database.js';
import { hash } from '../src/core/crypto.js';
import * as gallery from '../src/modules/gallery/service.js';

test('tenant, identity, provider, private-room and quota boundaries',async t=>{
 const f=await fixture(),{pg,db,ids}=f;
 const scope=(person:string,tenantId=ids.a,providerAccessId?:string)=>({sessionHash:hash(person),tenantId,providerAccessId,requestId:randomUUID()});
 const actor=async<T>(person:string,fn:Parameters<typeof authenticated<T>>[2],tenantId=ids.a,access?:string)=>authenticated(db,scope(person,tenantId,access),fn);
 try {
   const a=await actor('alice',sql=>gallery.create(sql,ids.a,'artists',{name:'Artist A'}));
   const b=await actor('bob',sql=>gallery.create(sql,ids.b,'artists',{name:'Artist B'}),ids.b);
   await t.test('an omitted WHERE clause cannot disclose another tenant',async()=>{
     const rows=await actor('alice',async sql=>(await sql.query('SELECT * FROM app.artists')).rows);
     assert.deepEqual(rows.map(r=>r.id),[a.id]);
   });
   await t.test('tenant IDs and identity flags cannot grant membership',async()=>{
     await assert.rejects(actor('alice',sql=>sql.query('SELECT * FROM app.artists'),ids.b),/Gallery access denied/);
     await assert.rejects(db.transaction(async sql=>{await sql.query("SELECT set_config('vayu.tenant',$1,true),set_config('vayu.is_provider','true',true),set_config('vayu.user',$2,true)",[ids.b,ids.provider]);assert.equal((await sql.query('SELECT * FROM app.artists')).rows.length,0);await sql.query("INSERT INTO app.artists(tenant_id,name) VALUES($1,'forged')",[ids.b]);}),/row-level security/);
   });
   await t.test('cross-gallery foreign keys fail',async()=>{
     await assert.rejects(actor('alice',sql=>gallery.create(sql,ids.a,'artworks',{title:'Wrong artist',inventory_number:'wrong',artist_id:b.id})),/foreign key/);
   });
   await t.test('client input cannot overwrite tenant, identity or sale state',async()=>{
     await assert.rejects(actor('alice',sql=>gallery.create(sql,ids.a,'artworks',{title:'Bad',inventory_number:'bad',tenant_id:ids.b,status:'sold'})),/Unrecognized/);
   });
   await t.test('tenant admins cannot inspect private spaces they did not join',async()=>{
     assert.equal((await actor('alice',sql=>sql.query('SELECT * FROM app.spaces'))).rows.length,0);
     assert.equal((await actor('staff',sql=>sql.query('SELECT * FROM app.spaces'))).rows.length,1);
   });
   let access:string;
   await t.test('provider must explicitly enter a gallery after MFA',async()=>{
     await assert.rejects(actor('provider',sql=>sql.query('SELECT * FROM app.spaces')),/Gallery access denied/);
     access=await authenticated(db,{sessionHash:hash('provider'),requestId:'enter'},async sql=>(await sql.query("SELECT security.open_provider_access($1,'Support requested in case 123') AS id",[ids.a])).rows[0]!.id);
     assert.equal((await actor('provider',sql=>sql.query('SELECT * FROM app.spaces'),ids.a,access)).rows.length,1);
     await assert.rejects(actor('provider',sql=>sql.query('SELECT * FROM app.artists'),ids.b,access),/Gallery access denied/);
     await assert.rejects(actor('alice',sql=>sql.query('SELECT * FROM app.spaces'),ids.b,access),/Gallery access denied/);
   });
   await t.test('provider edits preserve sender, revisions and attribution',async()=>{
     const message=(await actor('staff',sql=>sql.query("INSERT INTO app.messages(tenant_id,space_id,body) VALUES($1,$2,'original private body') RETURNING *",[ids.a,ids.space]))).rows[0]!;
     await actor('provider',sql=>sql.query("SELECT security.edit_message($1,$2,'edited by provider',false,1)",[ids.a,message.id]),ids.a,access);
     const revised=(await actor('staff',sql=>sql.query('SELECT * FROM app.messages WHERE id=$1',[message.id]))).rows[0]!;
     assert.equal(revised.created_by,ids.staff);assert.equal(revised.version,2);
     const history=(await actor('staff',sql=>sql.query('SELECT * FROM app.record_revisions WHERE entity_id=$1',[message.id]))).rows[0]!;
     assert.equal(history.data.body,'original private body');assert.equal(history.created_by,ids.provider);
     const events=(await actor('alice',sql=>sql.query("SELECT * FROM control.audit_events WHERE entity_type='messages' AND action='update'"))).rows;
     assert.equal(events[0]!.actor_type,'provider');assert.equal(events[0]!.after_data.body,undefined);
     assert.equal((await actor('alice',sql=>sql.query('SELECT * FROM app.record_revisions'))).rows.length,0);
   });
   await t.test('stale edits do not overwrite a newer update',async()=>{
     await actor('alice',sql=>gallery.update(sql,ids.a,'artists',a.id,1,{name:'Updated',biography:'Keep this biography'}));
     await assert.rejects(actor('alice',sql=>gallery.update(sql,ids.a,'artists',a.id,1,{name:'Stale'})),/Record changed/);
     const partial=await actor('alice',sql=>gallery.update(sql,ids.a,'artists',a.id,2,{name:'Another title'}));
     assert.equal(partial.biography,'Keep this biography');
   });
   await t.test('active invitations reserve seats and tokens require the invited identity',async()=>{
     await actor('alice',sql=>sql.query("SELECT security.invite_member($1,'future@example.com','staff',$2)",[ids.a,hash('invite')]));
     await assert.rejects(actor('alice',sql=>sql.query("SELECT security.invite_member($1,'excess@example.com','staff',$2)",[ids.a,hash('excess')])),/seat limit/);
     await assert.rejects(authenticated(db,{sessionHash:hash('bob'),requestId:'accept'},sql=>sql.query('SELECT security.accept_invitation($1)',[hash('invite')])),/Invitation unavailable/);
   });
   await t.test('identity tables and platform roles cannot be mutated by the API role',async()=>{
     for(const statement of ['SELECT * FROM identity.sessions',"INSERT INTO control.provider_staff(user_id,role) VALUES($1,'owner')",'SET ROLE vayu_jobs']) {
       await assert.rejects(actor('alice',sql=>sql.query(statement,statement.includes('$1')?[ids.alice]:undefined)),/permission denied/);
     }
   });
   await t.test('audit records cannot be rewritten',async()=>{
     await assert.rejects(actor('alice',sql=>sql.query("UPDATE control.audit_events SET action='hidden'")),/permission denied/);
     await assert.rejects(pg.query("UPDATE control.audit_events SET action='hidden'"),/immutable/);
   });
   await t.test('quota failures roll back reservations and cannot accept caller-chosen limits',async()=>{
     await assert.rejects(actor('alice',sql=>sql.query("SELECT security.reserve_usage($1,'storage','all',1099511627776)",[ids.a])),/allowance reached/);
     const usage=(await pg.query('SELECT value FROM app.usage_counters WHERE tenant_id=$1',[ids.a])).rows;assert.equal(usage.length,0);
   });
   await t.test('MFA expiry immediately closes provider data access',async()=>{
     await pg.query("UPDATE identity.sessions SET mfa_at=now()-interval '31 minutes' WHERE user_id=$1",[ids.provider]);
     await assert.rejects(actor('provider',sql=>sql.query('SELECT * FROM app.artists'),ids.a,access),/Gallery access denied/);
   });
   await t.test('revoked sessions and suspended galleries fail closed',async()=>{
     await pg.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1',[ids.staff]);
     await assert.rejects(actor('staff',sql=>sql.query('SELECT * FROM app.spaces')),/Sign in required/);
     await pg.query("UPDATE control.organizations SET status='suspended' WHERE id=$1",[ids.a]);
     await assert.rejects(actor('alice',sql=>sql.query('SELECT * FROM app.artists')),/Gallery access denied/);
   });
 }finally{await f.close();}
});

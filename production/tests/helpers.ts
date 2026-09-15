import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/core/migrations.js';
import { hash } from '../src/core/crypto.js';
import type { Database, SQL } from '../src/core/database.js';
export async function fixture() {
 const pg=new PGlite();await migrate(pg,s=>pg.exec(s));
 const ids={a:randomUUID(),b:randomUUID(),alice:randomUUID(),bob:randomUUID(),staff:randomUUID(),provider:randomUUID(),space:randomUUID()};
 for(const person of ['alice','bob','staff','provider'] as const){
   await pg.query("INSERT INTO identity.users(id,issuer,subject,email,name,email_verified) VALUES($1,'https://identity.test',$2,$3,$2,true)",[ids[person],person,`${person}@example.com`]);
   await pg.query("INSERT INTO identity.sessions(token_hash,user_id,csrf_hash,authenticated_at,mfa_at,expires_at) VALUES($1,$2,$3,now(),now(),now()+interval '8 hours')",[hash(person),ids[person],hash('csrf')]);
 }
 await pg.query("INSERT INTO control.organizations(id,name,slug) VALUES($1,'Gallery A','gallery-a'),($2,'Gallery B','gallery-b')",[ids.a,ids.b]);
 await pg.query("INSERT INTO control.memberships(tenant_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner'),($1,$5,'staff')",[ids.a,ids.alice,ids.b,ids.bob,ids.staff]);
 await pg.query("INSERT INTO control.subscriptions(tenant_id,plan_version_id,status) SELECT t.id,p.id,'active' FROM control.organizations t CROSS JOIN control.plan_versions p WHERE p.code='studio'");
 await pg.query("INSERT INTO control.provider_staff(user_id,role) VALUES($1,'owner')",[ids.provider]);
 await pg.query("INSERT INTO app.spaces(tenant_id,id,title,kind,created_by) VALUES($1,$2,'Private staff room','group',$3)",[ids.a,ids.space,ids.staff]);
 await pg.query("INSERT INTO security.space_grants(tenant_id,space_id,user_id,role) VALUES($1,$2,$3,'owner')",[ids.a,ids.space,ids.staff]);
 await pg.query('INSERT INTO app.site_settings(tenant_id) VALUES($1),($2)',[ids.a,ids.b]);
 // PGlite has one connection. Serialize test transactions; real lock races have a separate PostgreSQL test.
 let tail=Promise.resolve();
 function database(role:string):Database{return {
   transaction<T>(fn:(sql:SQL)=>Promise<T>):Promise<T>{
     const run=tail.then(async()=>{
       await pg.exec(`SET SESSION AUTHORIZATION ${role}`);await pg.query('BEGIN');
       try{await pg.exec(`SET LOCAL ROLE ${role}`);const result=await fn(pg);await pg.query('COMMIT');return result;}
       catch(e){await pg.query('ROLLBACK');throw e;}
       finally{await pg.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE');}
     });tail=run.then(()=>{},()=>{});return run;
   },async close(){}
 };}
 return {pg,ids,db:database('vayu_api'),jobs:database('vayu_jobs'),identity:database('vayu_identity'),async close(){await tail;await pg.close();}};
}

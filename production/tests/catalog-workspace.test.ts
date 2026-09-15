import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {fixture} from './helpers.js';
import {createApp} from '../src/http/app.js';
import {authenticated} from '../src/core/database.js';
import {hash} from '../src/core/crypto.js';
import {readConfig} from '../src/core/config.js';
import {verifyMedia} from '../src/modules/jobs/media.js';
import {runOne} from '../src/modules/jobs/service.js';
import * as media from '../src/modules/storage/service.js';
import type {ObjectStore} from '../src/modules/storage/s3.js';

const config=readConfig({NODE_ENV:'test',APP_ORIGIN:'http://localhost:4180',DATABASE_URL:'postgresql://vayu_api@localhost/test',AUTH_DATABASE_URL:'postgresql://vayu_identity@localhost/test',OIDC_ISSUER:'https://identity.test',OIDC_CLIENT_ID:'test',OIDC_CLIENT_SECRET:'test-client-secret',OIDC_MFA_ACR:'urn:test:aal2',TOKEN_ENCRYPTION_KEY:'test-only-encryption-secret-at-least-32',STORAGE_ENDPOINT:'https://storage.test',STORAGE_BUCKET:'test',STORAGE_ACCESS_KEY_ID:'test-access',STORAGE_SECRET_ACCESS_KEY:'test-only-storage-secret'});
test('catalog workspace preserves ordered selections, drafts, media and tenant boundaries',async t=>{
 const f=await fixture();const store:ObjectStore={async uploadUrl(){return 'https://storage.test/upload';},async downloadUrl(){return 'https://storage.test/download';},async read(){return new Uint8Array([1,2,3]);},async head(){return {bytes:3,mime:'image/webp'};},async put(){},async remove(){}};
 const app=createApp({config,db:f.db,identity:{async begin(){throw Error();},async callback(){throw Error();}},storage:store,log:()=>{}});
 const base=`/api/galleries/${f.ids.a}`;
 const req=(url:string,body?:unknown,version?:number,user='alice')=>app.request(`http://localhost:4180${url}`,{method:body===undefined?'GET':'POST',headers:{cookie:`vayu-session=${user}`,Origin:config.APP_ORIGIN,'Content-Type':'application/json','X-CSRF-Token':'csrf',...(version?{'If-Match':`"${version}"`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 try{
  await t.test('PDF uploads fail before reserving storage when verification is unavailable',async()=>{
   const response=await req(`${base}/media/uploads`,{name:'catalog.pdf',mime:'application/pdf',bytes:100,checksum:'a'.repeat(64),purpose:'catalog'});assert.equal(response.status,503);
   assert.equal((await f.pg.query('SELECT * FROM app.media')).rows.length,0);
   assert.equal((await f.pg.query('SELECT * FROM app.usage_counters')).rows.length,0);
  });
  const artA=await (await req(`${base}/artworks`,{title:'First artwork',inventory_number:'INV-1'})).json();
  const artB=await (await req(`${base}/artworks`,{title:'Second artwork',inventory_number:'INV-2'})).json();
  const c=await (await req(`${base}/catalogs`,{title:'Autumn',source:'generated',design:{}})).json();
  const draft={title:'Autumn edition',description:'Introduction retained',artworkIds:[artB.id,artA.id],design:{logoSize:26,showPrice:false,template:'split'}};
  await t.test('selection order and rich design survive save and reload independently of picker pages',async()=>{
   const saved=await req(`${base}/catalogs/${c.id}/design`,draft,1);assert.equal(saved.status,200,await saved.clone().text());const row=await saved.json();assert.equal(row.version,2);assert.deepEqual(row.artworkIds,draft.artworkIds);assert.deepEqual(row.artworks.map((a:any)=>a.id),draft.artworkIds);assert.equal(row.design.logoSize,26);assert.equal(row.design.showPrice,false);assert.equal(row.description,draft.description);
   const picker=await(await req(`${base}/inventory?limit=1`)).json();assert.equal(picker.items.length,1);assert.ok(picker.next);const next=await(await req(`${base}/inventory?limit=1&${new URLSearchParams(picker.next)}`)).json();assert.notEqual(next.items[0].id,picker.items[0].id);
   const detail=await(await req(`${base}/catalogs/${c.id}/detail`)).json();assert.equal(detail.artworks.length,2);
  });
  await t.test('personal drafts cannot overwrite a later saved catalog or another editor draft',async()=>{
   assert.equal((await req(`${base}/catalogs/${c.id}/draft`,draft,2)).status,200);
   const staff=await(await req(`${base}/catalogs/${c.id}/draft`,undefined,undefined,'staff')).json();assert.equal(staff.draft,null);
   assert.equal((await req(`${base}/catalogs/${c.id}/design`,{...draft,title:'Final title'},2)).status,200);
   assert.equal((await req(`${base}/catalogs/${c.id}/draft`,draft,2)).status,409);
   assert.equal((await(await req(`${base}/catalogs/${c.id}/draft`)).json()).draft,null);
   assert.equal((await req(`${base}/catalogs/${c.id}/design`,draft,2)).status,409);
  });
  await t.test('cross-tenant selections roll back without touching the saved design',async()=>{
   const foreign=await(await req(`/api/galleries/${f.ids.b}/artworks`,{title:'Other gallery',inventory_number:'OTHER'},undefined,'bob')).json();
   assert.equal((await req(`${base}/catalogs/${c.id}/design`,{...draft,artworkIds:[foreign.id]},3)).status,404);
   const persisted=await(await req(`${base}/catalogs/${c.id}/detail`)).json();assert.equal(persisted.title,'Final title');assert.equal(persisted.version,3);
   assert.equal((await req(`${base}/catalogs/${c.id}/detail`,undefined,undefined,'bob')).status,403);
   const rows=await authenticated(f.db,{sessionHash:hash('bob'),tenantId:f.ids.b,requestId:'rls'},sql=>sql.query('SELECT * FROM app.catalog_artworks'));assert.equal(rows.rows.length,0);
  });
  const imageA=randomUUID(),imageB=randomUUID(),privateImage=randomUUID();
  for(const m of [imageA,imageB,privateImage])await f.pg.query("INSERT INTO app.media(tenant_id,id,name,object_key,mime_type,byte_size,checksum_sha256,state,purpose,space_id) VALUES($1,$2,'image.webp',$3,'image/webp',3,$4,'ready','artwork',$5)",[f.ids.a,m,`tenants/${f.ids.a}/private/${m}/test`,'a'.repeat(64),m===privateImage?f.ids.space:null]);
  await t.test('image order, display and banner are atomic and private room images cannot escape',async()=>{
   const order={mediaIds:[imageB,imageA],displayMediaId:imageA,bannerMediaId:imageB};
   const response=await req(`${base}/artworks/${artA.id}/media-order`,order,1);assert.equal(response.status,200,await response.clone().text());const row=await response.json();assert.deepEqual(row.media_ids,order.mediaIds);assert.equal(row.display_media_id,imageA);assert.equal(row.banner_media_id,imageB);
   assert.equal((await req(`${base}/artworks/${artA.id}/media-order`,order,1)).status,409);
   assert.equal((await req(`${base}/artworks/${artA.id}/media-order`,{mediaIds:[privateImage],displayMediaId:privateImage,bannerMediaId:privateImage},2)).status,409);
   assert.equal((await req(`${base}/catalogs/${c.id}/design`,{...draft,design:{logo:`/api/files/${privateImage}`}},3)).status,404);
  });
  await t.test('same-origin file delivery requires session, tenant and room access; provider context is identity-bound',async()=>{
   assert.equal((await req(`${base}/media/${imageA}/content`)).status,200);
   assert.equal((await req(`${base}/media/${privateImage}/content`)).status,404);
   const access=await(await req('/api/provider/access',{tenantId:f.ids.a,reason:'Testing scoped file access'},undefined,'provider')).json();
   assert.equal((await req(`${base}/media/${privateImage}/content?access=${access.id}`,undefined,undefined,'provider')).status,200);
   assert.equal((await req(`${base}/media/${privateImage}/content?access=${access.id}`,undefined,undefined,'alice')).status,403);
   assert.equal((await req(`${base}/media/${imageA}/content`,undefined,undefined,'forged')).status,401);
  });
  await t.test('direct messages keep exactly their original participants',async()=>{
   await f.pg.query("INSERT INTO control.memberships(tenant_id,user_id,role) VALUES($1,$2,'staff')",[f.ids.a,f.ids.bob]);
   const direct=await(await req(`${base}/spaces`,{title:'One to one',kind:'direct',participants:[f.ids.alice,f.ids.staff]})).json();
   assert.equal((await req(`${base}/spaces/${direct.id}/members`,{userId:f.ids.bob,role:'member'})).status,409);
   assert.equal((await f.pg.query('SELECT * FROM security.space_grants WHERE space_id=$1',[direct.id])).rows.length,2);
   assert.equal((await req(`${base}/spaces/${direct.id}/members`,{userId:f.ids.staff,role:'remove'})).status,409);
  });
 }finally{await f.close();}
});
test('verification retries remove quarantine after finalization without reprocessing or charging twice',async()=>{
 const f=await fixture(),objects=new Map<string,Uint8Array>();let failed=false,puts=0;
 const store:ObjectStore={async uploadUrl(k){return `https://storage.test/${k}`;},async downloadUrl(){return '';},async head(){return {bytes:0,mime:''};},async read(k){return objects.get(k)!;},async put(k,b){puts++;objects.set(k,b);},async remove(k){if(!failed){failed=true;throw Error('temporary storage failure');}objects.delete(k);}};
 const actor=<T>(fn:Parameters<typeof authenticated<T>>[2])=>authenticated(f.db,{sessionHash:hash('alice'),tenantId:f.ids.a,requestId:'retry'},fn);
 try{
  const bytes=await sharp({create:{width:20,height:20,channels:3,background:'#aabbcc'}}).png().toBuffer();
  const uploaded=await actor(sql=>media.initiate(sql,f.ids.a,{name:'image.png',mime:'image/png',bytes:bytes.length,checksum:hash(bytes),purpose:'artwork'},store));
  const key=(await f.pg.query<any>('SELECT object_key FROM app.media WHERE id=$1',[uploaded.id])).rows[0]!.object_key;objects.set(key,bytes);
  const job=await actor(sql=>media.complete(sql,f.ids.a,uploaded.id));await runOne(f.jobs,{'media.verify':verifyMedia(store)},()=>{});
  let file=(await f.pg.query<any>('SELECT * FROM app.media WHERE id=$1',[uploaded.id])).rows[0]!;assert.equal(file.state,'ready');assert.equal(file.quarantine_key,key);assert.ok(objects.has(key));
  const charged=(await f.pg.query<any>("SELECT value FROM app.usage_counters WHERE tenant_id=$1 AND metric='storage'",[f.ids.a])).rows[0]!.value;
  await f.pg.query("UPDATE delivery.jobs SET available_at=now()-interval '1 second' WHERE id=$1",[job.jobId]);await runOne(f.jobs,{'media.verify':verifyMedia(store)},()=>{});
  file=(await f.pg.query<any>('SELECT * FROM app.media WHERE id=$1',[uploaded.id])).rows[0]!;assert.equal(file.quarantine_key,null);assert.equal(objects.has(key),false);assert.equal(puts,1);
  assert.equal((await f.pg.query<any>("SELECT value FROM app.usage_counters WHERE tenant_id=$1 AND metric='storage'",[f.ids.a])).rows[0]!.value,charged);
  assert.equal((await f.pg.query<any>('SELECT status FROM delivery.jobs WHERE id=$1',[job.jobId])).rows[0]!.status,'succeeded');
 }finally{await f.close();}
});

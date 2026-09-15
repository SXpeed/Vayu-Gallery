import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fixture } from './helpers.js';
import { authenticated } from '../src/core/database.js';
import { hash } from '../src/core/crypto.js';
import { runOne } from '../src/modules/jobs/service.js';
import { verifyMedia } from '../src/modules/jobs/media.js';
import { generateCatalog } from '../src/modules/jobs/catalog.js';
import * as media from '../src/modules/storage/service.js';
import { create } from '../src/modules/gallery/service.js';
import { generate } from '../src/modules/catalogs/service.js';
import type { ObjectStore } from '../src/modules/storage/s3.js';

export function memoryStorage(){
 const objects=new Map<string,Uint8Array>();
 const store:ObjectStore={async uploadUrl(k){return `https://storage.test/upload/${k}`;},async downloadUrl(k){return `https://storage.test/download/${k}`;},async head(k){return {bytes:objects.get(k)?.byteLength||0,mime:'image/png'};},async read(k,max){const bytes=objects.get(k);if(!bytes)throw new Error('MISSING_OBJECT');if(bytes.byteLength>max)throw new Error('OBJECT_TOO_LARGE');return bytes;},async put(k,b){objects.set(k,b);},async remove(k){objects.delete(k);}};
 return {objects,store};
}
test('durable job leases, private image processing and catalog generation',async t=>{
 const f=await fixture(),{pg,db,jobs,ids}=f,{objects,store}=memoryStorage();
 const actor=<T>(fn:Parameters<typeof authenticated<T>>[2])=>authenticated(db,{sessionHash:hash('alice'),tenantId:ids.a,requestId:'test-job'},fn);
 try {
   let imageId:string;
   await t.test('quarantined images are decoded, sanitized, accounted and moved to a private key',async()=>{
     const bytes=await sharp({create:{width:100,height:80,channels:3,background:'#987654'}}).png().toBuffer();
     const intent=await actor(sql=>media.initiate(sql,ids.a,{name:'art.png',mime:'image/png',bytes:bytes.length,checksum:hash(bytes),purpose:'artwork'},store));imageId=intent.id;
     const file=(await pg.query<any>('SELECT * FROM app.media WHERE id=$1',[imageId])).rows[0]!;objects.set(file.object_key,bytes);
     await assert.rejects(actor(sql=>media.download(sql,ids.a,imageId,store)),/not found/);
     await actor(sql=>media.complete(sql,ids.a,imageId));
     assert.equal(await runOne(jobs,{'media.verify':verifyMedia(store)}),true);
     const ready=(await pg.query<any>('SELECT * FROM app.media WHERE id=$1',[imageId])).rows[0]!;
     assert.equal(ready.state,'ready');assert.equal(ready.mime_type,'image/webp');assert.ok(ready.object_key.startsWith(`tenants/${ids.a}/private/`));assert.equal(objects.has(file.object_key),false);
     assert.equal(Number(ready.byte_size),objects.get(ready.object_key)!.length);
     assert.equal((await actor(sql=>media.download(sql,ids.a,imageId,store))).expiresIn,60);
   });
   await t.test('the full existing catalog renderer runs asynchronously and saves a durable PDF version',async()=>{
     const art=await actor(sql=>create(sql,ids.a,'artworks',{title:'Quiet light',inventory_number:'ART-001',description:'Oil on canvas'}));
     await actor(sql=>sql.query('SELECT security.attach_artwork_media($1,$2,$3,true,true)',[ids.a,art.id,imageId]));
     const catalog=await actor(sql=>create(sql,ids.a,'catalogs',{title:'September collection',source:'generated',design:{backgroundMode:'linear',background:'#f8f2e5',background2:'#cbd9cb',logoSize:22,showPrice:false,productsPerPage:2,template:'split'}}));
     const job=await actor(sql=>generate(sql,ids.a,catalog.id,1,{artworkIds:[art.id]}));
     const repeat=await actor(sql=>generate(sql,ids.a,catalog.id,1,{artworkIds:[art.id]}));assert.equal(repeat.jobId,job.jobId);
     const log:unknown[]=[];await runOne(jobs,{'catalog.generate':generateCatalog(store)},e=>log.push(e));
     const result=(await pg.query<any>('SELECT status,last_error_code FROM delivery.jobs WHERE id=$1',[job.jobId])).rows[0]!;
     assert.equal(result.status,'succeeded',JSON.stringify(log));
     const file=(await pg.query<any>('SELECT * FROM app.media WHERE id=$1',[job.jobId])).rows[0]!;
     assert.equal(Buffer.from(objects.get(file.object_key)!.subarray(0,5)).toString(),'%PDF-');
     assert.equal((await pg.query('SELECT * FROM app.catalog_versions WHERE catalog_id=$1',[catalog.id])).rows.length,1);
     const originalVersion=(await pg.query<any>('SELECT version FROM app.catalogs WHERE id=$1',[catalog.id])).rows[0]!.version;
     assert.equal(originalVersion,3); // queued then completed
   });
   await t.test('API users cannot claim queue work or read another gallery job',async()=>{
     await assert.rejects(actor(sql=>sql.query('SELECT * FROM security.claim_job()')),/permission denied/);
     const rows=await authenticated(db,{sessionHash:hash('bob'),tenantId:ids.b,requestId:'job-read'},sql=>sql.query('SELECT * FROM delivery.jobs'));
     assert.equal(rows.rows.length,0);
   });
   await t.test('expired leases are fenced and retries retain their idempotency key',async()=>{
     const id=(await actor(sql=>sql.query("SELECT security.enqueue($1,'email.send','{}','retry-test') AS id",[ids.a]))).rows[0]!.id;
     const first=await jobs.transaction(async sql=>(await sql.query('SELECT * FROM security.claim_job()')).rows[0]!);
     await pg.query("UPDATE delivery.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);
     const second=await jobs.transaction(async sql=>(await sql.query('SELECT * FROM security.claim_job()')).rows[0]!);
     assert.notEqual(first.lease_token,second.lease_token);
     assert.equal((await jobs.transaction(sql=>sql.query('SELECT security.finish_job($1,$2,NULL) AS ok',[id,first.lease_token]))).rows[0]!.ok,false);
     assert.equal((await jobs.transaction(sql=>sql.query('SELECT security.finish_job($1,$2,NULL) AS ok',[id,second.lease_token]))).rows[0]!.ok,true);
   });
   await t.test('workers without a valid tenant lease cannot access business data',async()=>{
     assert.equal((await jobs.transaction(sql=>sql.query('SELECT * FROM app.artworks'))).rows.length,0);
     await assert.rejects(jobs.transaction(sql=>sql.query("INSERT INTO app.artists(tenant_id,name) VALUES($1,'Forged worker')",[ids.a])),/row-level security/);
   });
 }finally{await f.close();}
});

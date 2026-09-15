import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {fixture} from './helpers.js';
import {createApp} from '../src/http/app.js';
import {readConfig} from '../src/core/config.js';
import {hash} from '../src/core/crypto.js';
import {runOne} from '../src/modules/jobs/service.js';
import {generateCatalog} from '../src/modules/jobs/catalog.js';
import type {ObjectStore} from '../src/modules/storage/s3.js';
import {exportChecks} from '../../shared/catalog-editor.mjs';
import {MAX_CATALOG_PAGES,normalizeDesign,catalogPages} from '../../shared/catalog-design.mjs';

const config=readConfig({NODE_ENV:'test',APP_ORIGIN:'http://localhost:4180',DATABASE_URL:'postgresql://vayu_api@localhost/test',AUTH_DATABASE_URL:'postgresql://vayu_identity@localhost/test',OIDC_ISSUER:'https://identity.test',OIDC_CLIENT_ID:'test',OIDC_CLIENT_SECRET:'test-client-secret',OIDC_MFA_ACR:'urn:test:aal2',TOKEN_ENCRYPTION_KEY:'test-only-encryption-secret-at-least-32',STORAGE_ENDPOINT:'https://storage.test',STORAGE_BUCKET:'test',STORAGE_ACCESS_KEY_ID:'test-access',STORAGE_SECRET_ACCESS_KEY:'test-only-storage-secret'});

test('production continuation designs remain scoped and generate complete immutable PDF editions',async t=>{
 const f=await fixture(),objects=new Map<string,Uint8Array>();let reads=0,puts=0;
 const store:ObjectStore={async uploadUrl(){return '';},async downloadUrl(){return '';},async head(key){return {bytes:objects.get(key)?.length||0,mime:'image/png'};},async read(key,max){reads++;const bytes=objects.get(key);assert.ok(bytes,`Missing fixture object ${key}`);assert.ok(bytes.length<=max);return bytes;},async put(key,bytes){puts++;objects.set(key,bytes);},async remove(key){objects.delete(key);}};
 const app=createApp({config,db:f.db,identity:{async begin(){throw Error();},async callback(){throw Error();}},storage:store,log:()=>{}});
 const base=`/api/galleries/${f.ids.a}`;
 const request=(url:string,body?:unknown,version?:number,user='alice')=>app.request(`${config.APP_ORIGIN}${url}`,{method:body===undefined?'GET':'POST',headers:{cookie:`vayu-session=${user}`,Origin:config.APP_ORIGIN,'Content-Type':'application/json','X-CSRF-Token':'csrf',...(version?{'If-Match':`"${version}"`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const json=async(response:Response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response.json();};
 const seedImages=async(count:number,tenant=f.ids.a)=>{
  const bytes=await sharp({create:{width:24,height:18,channels:3,background:'#78906a'}}).png().toBuffer();
  const ids=Array.from({length:count},()=>randomUUID());
  for(const id of ids){const key=`tenants/${tenant}/private/${id}/image.png`;objects.set(key,bytes);await f.pg.query("INSERT INTO app.media(tenant_id,id,name,object_key,mime_type,byte_size,checksum_sha256,state,purpose) VALUES($1,$2,'image.png',$3,'image/png',$4,$5,'ready','artwork')",[tenant,id,key,bytes.length,hash(bytes)]);}
  return ids;
 };
 const attach=async(artId:string,imageIds:string[],offset=0)=>f.pg.query('INSERT INTO app.artwork_media(tenant_id,artwork_id,media_id,position) SELECT $1,$2,id,ordinality::integer-1+$4 FROM unnest($3::uuid[]) WITH ORDINALITY AS selected(id,ordinality)',[f.ids.a,artId,imageIds,offset]);
 const createArt=async(name:string)=>json(await request(`${base}/artworks`,{title:name,inventory_number:name}),201);
 const createCatalog=async(title:string)=>json(await request(`${base}/catalogs`,{title,source:'generated',design:{}}),201);
 try{
  await t.test('normalized continuation settings survive drafts and generate every additional page',async()=>{
   const art=await createArt('Continuation artwork'),imageIds=await seedImages(3);await attach(art.id,imageIds);
   const c=await createCatalog('Detail views');
   const draft={title:c.title,description:'A complete set of views',artworkIds:[art.id],design:{imagesPerProduct:1,includeCover:true,showTitle:false,continuations:{[art.id]:{enabled:true,layout:'single',showTitle:true,unknownObjectKey:'tenants/another-gallery/private/object',sources:['https://untrusted.test/image.png']}}}};
   await json(await request(`${base}/catalogs/${c.id}/draft`,draft,1));
   const recovered=await json(await request(`${base}/catalogs/${c.id}/draft`));
   assert.deepEqual(recovered.draft.data.design.continuations[art.id],{enabled:true,layout:'single',showTitle:true});
   const saved=await json(await request(`${base}/catalogs/${c.id}/design`,draft,1));
   assert.deepEqual(saved.design.continuations,recovered.draft.data.design.continuations);
   assert.deepEqual(saved.artworks[0].media_ids,imageIds);
   const queued=await json(await request(`${base}/catalogs/${c.id}/generate`,{artworkIds:[art.id]},saved.version),202);
   const snapshot=(await f.pg.query<any>('SELECT payload FROM delivery.jobs WHERE id=$1',[queued.jobId])).rows[0]!.payload;
   assert.deepEqual(snapshot.design.continuations[art.id],{enabled:true,layout:'single',showTitle:true});
   assert.equal(snapshot.design.showTitle,false);
   // A later edit does not replace the queued design snapshot.
   const current=await json(await request(`${base}/catalogs/${c.id}/detail`));
   await json(await request(`${base}/catalogs/${c.id}/design`,{...draft,design:{...draft.design,continuations:{[art.id]:{enabled:false,layout:'grid',showTitle:false}}}},current.version));
   await runOne(f.jobs,{'catalog.generate':generateCatalog(store)});
   const job=(await f.pg.query<any>('SELECT status,last_error_code FROM delivery.jobs WHERE id=$1',[queued.jobId])).rows[0]!;
   assert.equal(job.status,'succeeded',JSON.stringify(job));
   const file=(await f.pg.query<any>('SELECT object_key FROM app.media WHERE id=$1',[queued.jobId])).rows[0]!;
   const pdf=Buffer.from(objects.get(file.object_key)!);
   assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
   assert.equal([...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length,4,'cover, main image and two continuation pages');
   const edition=(await f.pg.query<any>('SELECT design FROM app.catalog_versions WHERE catalog_id=$1',[c.id])).rows[0]!;
   assert.deepEqual(edition.design.continuations[art.id],{enabled:true,layout:'single',showTitle:true});
   const final=await json(await request(`${base}/catalogs/${c.id}/detail`));
   assert.equal(final.design.continuations[art.id].enabled,false);
  });
  await t.test('continuation settings cannot bring another gallery artwork or media into the catalog',async()=>{
   const foreign=await json(await request(`/api/galleries/${f.ids.b}/artworks`,{title:'Other gallery artwork',inventory_number:'OTHER'},undefined,'bob'),201);
   const foreignImage=(await seedImages(1,f.ids.b))[0]!;
   const own=await createArt('Local artwork'),c=await createCatalog('Scoped detail views');
   const selected={title:c.title,artworkIds:[foreign.id],design:{continuations:{[foreign.id]:{enabled:true,layout:'single',showTitle:true}}}};
   assert.equal((await request(`${base}/catalogs/${c.id}/design`,selected,1)).status,404);
   assert.equal((await request(`${base}/catalogs/${c.id}/generate`,{artworkIds:[foreign.id]},1)).status,404);
   const imageDesign={...selected,artworkIds:[own.id],design:{continuations:{[own.id]:{enabled:true,layout:'single',showTitle:true}},selectedImages:{[own.id]:[`/api/files/${foreignImage}`]}}};
   assert.equal((await request(`${base}/catalogs/${c.id}/design`,imageDesign,1)).status,404);
   const persisted=await json(await request(`${base}/catalogs/${c.id}/detail`));assert.equal(persisted.version,1);assert.deepEqual(persisted.artworkIds,[]);
  });
  await t.test('page budget is checked again by the worker when artwork images grow after enqueue',async()=>{
   const imageIds=await seedImages(30),arts=[];
   for(let i=0;i<7;i++){const art=await createArt(`Budget artwork ${i}`);arts.push(art);await attach(art.id,imageIds.slice(0,27));}
   const ids=arts.map(a=>a.id),continuations=Object.fromEntries(ids.map(id=>[id,{enabled:true,layout:'single',showTitle:true}]));
   const c=await createCatalog('Growing collection'),form={title:c.title,artworkIds:ids,design:{imagesPerProduct:1,includeCover:true,continuations}};
   const saved=await json(await request(`${base}/catalogs/${c.id}/design`,form,1));
   const queued=await json(await request(`${base}/catalogs/${c.id}/generate`,{artworkIds:ids},saved.version),202);
   for(const art of arts)await attach(art.id,imageIds.slice(27),27);
   const before={reads,puts};await runOne(f.jobs,{'catalog.generate':generateCatalog(store)});
   const job=(await f.pg.query<any>('SELECT status,last_error_code FROM delivery.jobs WHERE id=$1',[queued.jobId])).rows[0]!;
   assert.equal(job.last_error_code,'CATALOG_PAGE_LIMIT');assert.notEqual(job.status,'succeeded');
   assert.equal(reads,before.reads,'reject before downloading artwork bytes');assert.equal(puts,before.puts,'reject before writing a PDF');
   assert.equal((await f.pg.query('SELECT * FROM app.catalog_versions WHERE catalog_id=$1',[c.id])).rows.length,0);
   const previewArts=arts.map(art=>({...art,images:imageIds.map(id=>`/api/files/${id}`)}));
   assert.equal(catalogPages(normalizeDesign(form.design),previewArts).length,211);
   assert.ok(exportChecks(form,previewArts).some(check=>check.severity==='error'&&check.message.includes(String(MAX_CATALOG_PAGES))));
   const oversized=await createCatalog('Oversized collection');
   const oversizedSaved=await json(await request(`${base}/catalogs/${oversized.id}/design`,{...form,title:oversized.title},1));
   const usageBefore=(await f.pg.query<any>("SELECT value FROM app.usage_counters WHERE tenant_id=$1 AND metric='catalogs'",[f.ids.a])).rows;
   const jobsBefore=(await f.pg.query('SELECT id FROM delivery.jobs')).rows.length;
   const rejected=await request(`${base}/catalogs/${oversized.id}/generate`,{artworkIds:ids},oversizedSaved.version);
   const body=await json(rejected,422);assert.equal(body.error.code,'CATALOG_PAGE_LIMIT');
   assert.equal((await f.pg.query('SELECT id FROM delivery.jobs')).rows.length,jobsBefore);
   assert.deepEqual((await f.pg.query<any>("SELECT value FROM app.usage_counters WHERE tenant_id=$1 AND metric='catalogs'",[f.ids.a])).rows,usageBefore);
   const after=await json(await request(`${base}/catalogs/${oversized.id}/detail`));assert.equal(after.version,oversizedSaved.version);assert.equal(after.status,'draft');
   const boundary={...form,title:oversized.title,design:{...form.design,selectedImages:{[ids.at(-1)!]:imageIds.slice(0,19).map(id=>`/api/files/${id}`)}}};
   assert.equal(catalogPages(normalizeDesign(boundary.design),previewArts).length,MAX_CATALOG_PAGES);
   assert.equal(exportChecks(boundary,previewArts).some(check=>check.severity==='error'),false);
   const boundarySaved=await json(await request(`${base}/catalogs/${oversized.id}/design`,boundary,after.version));
   await json(await request(`${base}/catalogs/${oversized.id}/generate`,{artworkIds:ids},boundarySaved.version),202);
  });
 }finally{await f.close();}
});

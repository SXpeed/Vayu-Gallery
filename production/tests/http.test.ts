import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createApp } from '../src/http/app.js';
import type { Config } from '../src/core/config.js';
import type { ObjectStore } from '../src/modules/storage/s3.js';
export const testConfig:Config={NODE_ENV:'test',APP_ORIGIN:'http://localhost:4180',PORT:4180,DATABASE_URL:'postgresql://vayu_api@localhost/vayu_test',AUTH_DATABASE_URL:'postgresql://vayu_identity@localhost/vayu_test',OIDC_ISSUER:'https://identity.test',OIDC_CLIENT_ID:'vayu-test',OIDC_CLIENT_SECRET:'0123456789abcdef',OIDC_MFA_ACR:['urn:test:aal2'],TOKEN_ENCRYPTION_KEY:'test-only-secret-with-at-least-32-characters',STORAGE_ENDPOINT:'https://storage.test',STORAGE_REGION:'auto',STORAGE_BUCKET:'test',STORAGE_ACCESS_KEY_ID:'test-test',STORAGE_SECRET_ACCESS_KEY:'test-only-storage-secret'};
const storage:ObjectStore={async uploadUrl(){throw new Error('Not used');},async downloadUrl(){throw new Error('Not used');},async head(){throw new Error('Not used');},async read(){throw new Error('Not used');},async put(){throw new Error('Not used');},async remove(){throw new Error('Not used');}};
test('HTTP authorization, validation, concurrency controls and safe website publication',async t=>{
 const f=await fixture(),logs:unknown[]=[];
 const app=createApp({config:testConfig,db:f.db,identity:{async begin(){throw new Error('Not used');},async callback(){throw new Error('Not used');}},storage,log:e=>logs.push(e)});
 const request=(path:string,method='GET',data?:unknown,extra:Record<string,string>={})=>app.request(`http://localhost:4180${path}`,{method,headers:{cookie:'vayu-session=alice','Origin':testConfig.APP_ORIGIN,'Content-Type':'application/json','X-CSRF-Token':'csrf',...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const base=`/api/galleries/${f.ids.a}`;
 try{
   await t.test('production API has no sample login or client-selected identity endpoint',async()=>{
     assert.equal((await request('/api/login','POST',{userId:f.ids.alice})).status,404);
     const response=await request('/api/session','GET',undefined,{cookie:'vayu-session=forged'});assert.equal(response.status,401);
   });
   await t.test('cross-origin writes and missing CSRF are blocked before data changes',async()=>{
     assert.equal((await request(`${base}/artists`,'POST',{name:'Denied'},{Origin:'https://evil.test'})).status,403);
     assert.equal((await request(`${base}/artists`,'POST',{name:'Denied'},{'X-CSRF-Token':''})).status,403);
   });
   let artist:any;
   await t.test('real resource endpoints enforce validation and optimistic concurrency',async()=>{
     const created=await request(`${base}/artists`,'POST',{name:'Local artist'});assert.equal(created.status,201);artist=await created.json();
     assert.equal((await request(`${base}/artists/${artist.id}`,'PATCH',{name:'First edit'},{'If-Match':'1'})).status,200);
     assert.equal((await request(`${base}/artists/${artist.id}`,'PATCH',{name:'Lost update'},{'If-Match':'1'})).status,409);
     assert.equal((await request(`${base}/artists`,'POST',{name:'Bad',tenant_id:f.ids.b})).status,422);
     assert.equal((await request(`/api/galleries/${f.ids.b}/artists`)).status,403);
   });
   await t.test('public websites expose only an immutable, explicitly selected release',async()=>{
     const artwork=await (await request(`${base}/artworks`,'POST',{title:'Public artwork',inventory_number:'SECRET-STOCK-1',artist_id:artist.id,description:'Public description',price_minor:500000})).json();
     const draft=await request(`${base}/website_drafts`,'POST',{title:'Gallery home',slug:'home',seo:{title:'Our art',description:'Explore the gallery'},content:[{type:'heading',text:'<script>alert(1)</script>'},{type:'artworks',title:'Selected works'}]});assert.equal(draft.status,201);const draftBody=await draft.json();
     assert.equal((await request('/api/public/sites/gallery-a')).status,404);
     assert.equal((await request(`${base}/website/artworks/${artwork.id}`,'POST',{visible:true,showPrice:false})).status,200);
     assert.equal((await request(`${base}/website/publish`,'POST',{})).status,200);
     const publicSite=await (await request('/api/public/sites/gallery-a')).json();
     assert.equal(publicSite.content.artworks[0].priceMinor,null);
     assert.equal(JSON.stringify(publicSite).includes('SECRET-STOCK-1'),false);
     assert.equal(JSON.stringify(publicSite).includes('contact_id'),false);
     const html=await (await request('/site/gallery-a/home')).text();assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));assert.equal(html.includes('<script>alert(1)</script>'),false);
     await request(`${base}/website_drafts/${draftBody.id}`,'PATCH',{title:'Not yet public'},{'If-Match':'1'});
     const unchanged=await (await request('/api/public/sites/gallery-a')).json();assert.equal(unchanged.content.pages[0].title,'Gallery home');
   });
   await t.test('security headers and logs exclude session values, request content and signed URLs',async()=>{
     const response=await request('/api/session');assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.ok(response.headers.get('Content-Security-Policy')?.includes("frame-ancestors 'none'"));
     assert.equal(JSON.stringify(logs).includes('vayu-session'),false);assert.equal(JSON.stringify(logs).includes('SECRET-STOCK-1'),false);
   });
 }finally{await f.close();}
});

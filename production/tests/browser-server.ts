// Explicitly launched, loopback-only integration fixture. Never imported by either runtime entry point.
import {serve} from '@hono/node-server';
import {Hono} from 'hono';
import {setCookie} from 'hono/cookie';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fixture} from './helpers.js';
import {hash} from '../src/core/crypto.js';
import {createApp} from '../src/http/app.js';
import {installWeb} from '../src/http/web.js';
import {readConfig} from '../src/core/config.js';
import {runOne} from '../src/modules/jobs/service.js';
import {generateCatalog} from '../src/modules/jobs/catalog.js';
import {verifyMedia} from '../src/modules/jobs/media.js';
import type {ObjectStore} from '../src/modules/storage/s3.js';
if(process.env.VAYU_BROWSER_TEST!=='1')throw new Error('Explicit VAYU_BROWSER_TEST=1 is required');
const f=await fixture(),objects=new Map<string,Uint8Array>(),intents=new Map<string,string>();
const config=readConfig({NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:4183',PORT:'4183',DATABASE_URL:'postgresql://vayu_api@localhost/test',AUTH_DATABASE_URL:'postgresql://vayu_identity@localhost/test',OIDC_ISSUER:'https://identity.test',OIDC_CLIENT_ID:'test',OIDC_CLIENT_SECRET:'test-client-secret',OIDC_MFA_ACR:'urn:test:aal2',TOKEN_ENCRYPTION_KEY:'test-only-encryption-secret-at-least-32',STORAGE_ENDPOINT:'https://storage.test',STORAGE_BUCKET:'test',STORAGE_ACCESS_KEY_ID:'test-access',STORAGE_SECRET_ACCESS_KEY:'test-only-storage-secret'});
const store:ObjectStore={async uploadUrl(k){const token=randomUUID();intents.set(token,k);return `${config.APP_ORIGIN}/test-upload/${token}`;},async downloadUrl(k){const token=randomUUID();intents.set(token,k);return `${config.APP_ORIGIN}/test-download/${token}`;},async head(k){return {bytes:objects.get(k)?.length||0,mime:'image/webp'};},async read(k,max){const value=objects.get(k);if(!value||value.length>max)throw Error('Unavailable file');return value;},async put(k,b){objects.set(k,b);},async remove(k){objects.delete(k);}};
await f.pg.query("UPDATE control.organizations SET name='Integration test gallery' WHERE id=$1",[f.ids.a]);
const artworkIds=[randomUUID(),randomUUID()],catalogId=randomUUID();
await f.pg.query("INSERT INTO app.artworks(tenant_id,id,title,inventory_number,description,medium,currency,price_minor) VALUES($1,$2,'Quiet Light','TEST-001','Oil on linen, a study in light and space.','Oil on linen','INR',1250000),($1,$3,'Tidal Forms','TEST-002','An exploration of form and texture.','Sculpture','INR',NULL)",[f.ids.a,...artworkIds]);
// Known local test images are seeded only into this fixture's ephemeral database and memory store.
const sampleImages=await Promise.all(['test-artwork.png','test-detail.png'].map(async name=>({name,bytes:new Uint8Array(await readFile(new URL(`./assets/${name}`,import.meta.url)))})));
let storedBytes=0;
for(const artworkId of artworkIds){
 const mediaIds:string[]=[];
 for(const [position,image] of [...sampleImages,...sampleImages,...sampleImages].entries()){
  const mediaId=randomUUID(),checksum=hash(image.bytes),key=`tenants/${f.ids.a}/private/${mediaId}/${checksum}`;
  objects.set(key,image.bytes);mediaIds.push(mediaId);storedBytes+=image.bytes.length;
  await f.pg.query("INSERT INTO app.media(tenant_id,id,name,object_key,mime_type,byte_size,uploaded_byte_size,checksum_sha256,state,purpose,uploaded_at,verified_at,created_by) VALUES($1,$2,$3,$4,'image/png',$5,$5,$6,'ready','artwork',now(),now(),$7)",[f.ids.a,mediaId,image.name,key,image.bytes.length,checksum,f.ids.alice]);
  await f.pg.query('INSERT INTO app.artwork_media(tenant_id,artwork_id,media_id,position) VALUES($1,$2,$3,$4)',[f.ids.a,artworkId,mediaId,position]);
 }
 await f.pg.query('UPDATE app.artworks SET display_media_id=$1,banner_media_id=$2 WHERE tenant_id=$3 AND id=$4',[mediaIds[0],mediaIds[1],f.ids.a,artworkId]);
}
await f.pg.query("INSERT INTO app.usage_counters(tenant_id,metric,period,value) VALUES($1,'storage','all',$2)",[f.ids.a,storedBytes]);
await f.pg.query("INSERT INTO app.catalogs(tenant_id,id,title,source,design) VALUES($1,$2,'Autumn collection','generated','{\"template\":\"minimal\",\"logoSize\":26,\"showPrice\":false}')",[f.ids.a,catalogId]);
for(const [position,artworkId] of artworkIds.entries())await f.pg.query('INSERT INTO app.catalog_artworks(tenant_id,catalog_id,artwork_id,position) VALUES($1,$2,$3,$4)',[f.ids.a,catalogId,artworkId,position]);
const app=new Hono();
app.use('/',async(c,next)=>{setCookie(c,'vayu-session','alice',{httpOnly:true,sameSite:'Lax',path:'/'});setCookie(c,'vayu-csrf','csrf',{sameSite:'Lax',path:'/'});await next();});
app.put('/test-upload/:token',async c=>{const key=intents.get(c.req.param('token'));if(!key)return c.notFound();objects.set(key,new Uint8Array(await c.req.arrayBuffer()));intents.delete(c.req.param('token'));return c.body(null,204);});
app.get('/test-download/:token',async c=>{const key=intents.get(c.req.param('token')),bytes=key&&objects.get(key);if(!bytes)return c.notFound();c.header('Content-Type','application/pdf');return c.body(bytes as Uint8Array<ArrayBuffer>);});
const api=createApp({config,db:f.db,storage:store,identity:{async begin(){throw Error('Test harness only');},async callback(){throw Error('Test harness only');}},log:()=>{}});
installWeb(api,fileURLToPath(new URL('../dist/web/',import.meta.url)));app.route('/',api);
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:4183});let active=true;
async function work(){while(active){await runOne(f.jobs,{'catalog.generate':generateCatalog(store),'media.verify':verifyMedia(store)},()=>{});await new Promise(resolve=>setTimeout(resolve,200));}}
const worker=work();
async function close(){active=false;server.close();await worker;await f.close();}
process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
console.log('Ephemeral integration fixture: http://127.0.0.1:4183 (no production services)');

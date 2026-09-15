import {test} from 'node:test';
import assert from 'node:assert/strict';
import {documentScanner} from '../src/modules/storage/document-scanner.js';
import {fixture} from './helpers.js';
import {authenticated} from '../src/core/database.js';
import {hash} from '../src/core/crypto.js';
import {runOne} from '../src/modules/jobs/service.js';
import {verifyMedia} from '../src/modules/jobs/media.js';
import * as media from '../src/modules/storage/service.js';
import type {ObjectStore} from '../src/modules/storage/s3.js';
import {jsPDF} from 'jspdf';
test('configured PDF verifier sends only bytes with bounded, authenticated, non-redirected requests',async()=>{
 const bytes=new TextEncoder().encode('%PDF-test');let calls=0;
 const scanner=documentScanner('https://scanner.test/v1/pdf','test-only-scanner-token',async(url,options)=>{calls++;assert.equal(String(url),'https://scanner.test/v1/pdf');assert.equal(options?.redirect,'error');assert.ok(options?.signal);assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer test-only-scanner-token');assert.equal(options?.body,bytes);return Response.json({verdict:'clean'});});
 assert.equal(await scanner.scanPdf(bytes),'clean');assert.equal(calls,1);
 assert.throws(()=>documentScanner('http://scanner.test','token'),/Invalid/);
 assert.throws(()=>documentScanner('https://user:secret@scanner.test','token'),/Invalid/);
});
test('scanner refuses outages, malformed answers, oversized replies and missing JSON content types',async()=>{
 for(const response of [new Response('',{status:503}),Response.json({verdict:'unknown'}),Response.json({verdict:'clean',extra:'unexpected'}),new Response('{bad',{headers:{'Content-Type':'application/json'}}),Response.json({verdict:'clean',padding:'x'.repeat(1100)}),new Response('{"verdict":"clean"}')]){
  const scanner=documentScanner('https://scanner.test','test-only-token',async()=>response);await assert.rejects(scanner.scanPdf(new Uint8Array()),/DOCUMENT_SCANNER/);
 }
 const infected=documentScanner('https://scanner.test','test-only-token',async()=>Response.json({verdict:'infected'}));assert.equal(await infected.scanPdf(new Uint8Array()),'infected');
});
test('a verified uploaded PDF becomes a private saved catalog edition',async()=>{
 const f=await fixture(),objects=new Map<string,Uint8Array>();
 const store:ObjectStore={async uploadUrl(k){return `https://storage.test/${k}`;},async downloadUrl(){return '';},async head(){return {bytes:0,mime:''};},async read(k){return objects.get(k)!;},async put(k,b){objects.set(k,b);},async remove(k){objects.delete(k);}};
 const actor=<T>(fn:Parameters<typeof authenticated<T>>[2])=>authenticated(f.db,{sessionHash:hash('alice'),tenantId:f.ids.a,requestId:'pdf-upload'},fn);
 try{
  const pdf=new jsPDF();pdf.text('Uploaded catalog edition',20,20);const bytes=new Uint8Array(pdf.output('arraybuffer'));
  const intent=await actor(sql=>media.initiate(sql,f.ids.a,{name:'catalog.pdf',mime:'application/pdf',bytes:bytes.length,checksum:hash(bytes),purpose:'catalog'},store));
  const key=(await f.pg.query<any>('SELECT object_key FROM app.media WHERE id=$1',[intent.id])).rows[0]!.object_key;objects.set(key,bytes);
  await actor(sql=>media.complete(sql,f.ids.a,intent.id));const scanner=documentScanner('https://scanner.test','test-only-token',async()=>Response.json({verdict:'clean'}));
  await runOne(f.jobs,{'media.verify':verifyMedia(store,scanner)},()=>{});
  const c=await actor(async sql=>(await sql.query("INSERT INTO app.catalogs(tenant_id,title,source) VALUES($1,'Uploaded edition','uploaded') RETURNING id",[f.ids.a])).rows[0]!);
  await actor(sql=>sql.query('SELECT security.attach_catalog_pdf($1,$2,$3)',[f.ids.a,c.id,intent.id]));
  const versions=await actor(sql=>sql.query('SELECT media_id,version_number FROM app.catalog_versions WHERE catalog_id=$1',[c.id]));assert.equal(versions.rows[0]?.media_id,intent.id);assert.equal(versions.rows[0]?.version_number,1);
  const file=(await f.pg.query<any>('SELECT * FROM app.media WHERE id=$1',[intent.id])).rows[0]!;assert.equal(file.state,'ready');assert.equal(file.mime_type,'application/pdf');assert.equal(file.quarantine_key,null);assert.deepEqual(objects.get(file.object_key),bytes);
 }finally{await f.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.js';
import {createApp} from '../src/http/app.js';
import {readConfig} from '../src/core/config.js';
import type {ObjectStore} from '../src/modules/storage/s3.js';
import {totals,draftInput} from '../src/modules/invoices/service.js';

const config=readConfig({NODE_ENV:'test',APP_ORIGIN:'http://localhost:4180',DATABASE_URL:'postgresql://vayu_api@localhost/test',AUTH_DATABASE_URL:'postgresql://vayu_identity@localhost/test',OIDC_ISSUER:'https://identity.test',OIDC_CLIENT_ID:'test',OIDC_CLIENT_SECRET:'test-client-secret',OIDC_MFA_ACR:'urn:test:aal2',TOKEN_ENCRYPTION_KEY:'test-only-encryption-secret-at-least-32',STORAGE_ENDPOINT:'https://storage.test',STORAGE_BUCKET:'test',STORAGE_ACCESS_KEY_ID:'test-access',STORAGE_SECRET_ACCESS_KEY:'test-only-storage-secret'});
const storage:ObjectStore={async uploadUrl(){throw Error('Not used');},async downloadUrl(){throw Error('Not used');},async read(){throw Error('Not used');},async head(){throw Error('Not used');},async put(){throw Error('Not used');},async remove(){throw Error('Not used');}};

test('invoice money calculation uses exact minor-unit rounding and rejects unsupported totals',()=>{
 const draft=draftInput.parse({documentType:'invoice',currency:'INR',items:[{description:'A',quantity:2,unitPriceMinor:1999,taxRateBps:1800},{description:'B',quantity:1,unitPriceMinor:1,taxRateBps:5000}]});
 assert.deepEqual(totals(draft.items),{subtotalMinor:3999,taxMinor:721,totalMinor:4720});
 assert.throws(()=>totals([{description:'Too large',artworkId:null,quantity:10000,unitPriceMinor:1_000_000_000_000,taxRateBps:10000}]));
 assert.throws(()=>draftInput.parse({...draft,items:[{description:'Fraction',quantity:1,unitPriceMinor:1.5}]}));
});

test('production invoices preserve parties, immutable issued snapshots, PI semantics and tenant security',async t=>{
 const f=await fixture();const app=createApp({config,db:f.db,identity:{async begin(){throw Error('Not used');},async callback(){throw Error('Not used');}},storage,log:()=>{}});
 const base=`/api/galleries/${f.ids.a}`;
 const req=(path:string,method='GET',body?:unknown,version?:number,user='alice',extra:Record<string,string>={})=>app.request(`http://localhost:4180${path}`,{method,headers:{cookie:`vayu-session=${user}`,Origin:config.APP_ORIGIN,'Content-Type':'application/json','X-CSRF-Token':'csrf',...(version?{'If-Match':`"${version}"`}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const read=async(response:Response,expected=200)=>{assert.equal(response.status,expected,await response.clone().text());return response.json();};
 let pi:any,invoice:any,contact:any,artwork:any;
 const draft={documentType:'proforma',currency:'INR',sellerName:'Gallery A',sellerAddress:'Gallery road 1\nMumbai 400001',sellerGstin:'27ABCDE1234F1Z5',customerName:'Collector One',customerAddress:'Collector street 8\nPune 411001',customerGstin:'',notes:'Original terms',dueAt:'2026-12-31',items:[{description:'Original artwork title',quantity:2,unitPriceMinor:1999,taxRateBps:1800}]};
 try {
  await t.test('real customer/artwork selectors return scoped addresses and optional GSTIN',async()=>{
   contact=await read(await req(`${base}/contacts`,'POST',{name:'Collector One',kind:'collector',address:{line1:'Collector street 8',city:'Pune',postalCode:'411001'},gstin:''}),201);
   artwork=await read(await req(`${base}/artworks`,'POST',{title:'Original artwork title',inventory_number:'INVOICE-1',price_minor:1999,currency:'INR'}),201);
   const otherBase=`/api/galleries/${f.ids.b}`;
   await read(await req(`${otherBase}/contacts`,'POST',{name:'Hidden customer'},undefined,'bob'),201);
   const options=await read(await req(`${base}/invoices/options`));assert.equal(options.contacts.length,1);assert.equal(options.contacts[0].name,'Collector One');assert.equal(options.contacts[0].address,'Collector street 8\nPune, 411001');assert.equal(options.contacts[0].gstin,'');assert.equal(options.artworks[0].priceMinor,1999);assert.equal(options.seller.sellerName,'Gallery A');
  });
  await t.test('draft PI is editable with If-Match and exact totals but is never payable',async()=>{
   pi=await read(await req(`${base}/invoices`,'POST',{...draft,customerId:contact.id,items:[{...draft.items[0],artworkId:artwork.id}]}),201);
   assert.equal(pi.number,null);assert.equal(pi.status,'draft');assert.equal(pi.payable,false);assert.equal(pi.contributesToSales,false);assert.equal(pi.totalMinor,4718);assert.equal(pi.taxMinor,720);
   assert.equal((await req(`${base}/invoices/${pi.id}`,'PATCH',draft)).status,422);
   const old=pi.version;pi=await read(await req(`${base}/invoices/${pi.id}`,'PATCH',{...draft,customerId:contact.id,notes:'Saved draft',items:[{...draft.items[0],artworkId:artwork.id}]},old));
   assert.equal((await req(`${base}/invoices/${pi.id}`,'PATCH',draft,old)).status,409);
  });
  await t.test('issuing freezes seller/customer address, GSTIN, description and price snapshots',async()=>{
   pi=await read(await req(`${base}/invoices/${pi.id}/issue`,'POST',{},pi.version));assert.match(pi.number,/^PI-\d{4}-000001$/);assert.equal(pi.status,'issued');assert.equal(pi.payable,false);
   await read(await req(`${base}/contacts/${contact.id}`,'PATCH',{name:'Updated customer',address:{line1:'Changed address'},gstin:'27ABCDE1234F1Z5'},contact.version));
   await read(await req(`${base}/artworks/${artwork.id}`,'PATCH',{title:'Changed artwork title',price_minor:9000},artwork.version));
   const reloaded=await read(await req(`${base}/invoices/${pi.id}`));assert.equal(reloaded.customerName,'Collector One');assert.equal(reloaded.customerAddress,draft.customerAddress);assert.equal(reloaded.customerGstin,'');assert.equal(reloaded.sellerGstin,draft.sellerGstin);assert.equal(reloaded.items[0].description,'Original artwork title');assert.equal(reloaded.items[0].unitPriceMinor,1999);
   assert.equal((await req(`${base}/invoices/${pi.id}`,'PATCH',{...draft,notes:'Tampered'},pi.version)).status,403);
   await assert.rejects(f.pg.query("UPDATE app.invoices SET seller_name='Tampered' WHERE tenant_id=$1 AND id=$2",[f.ids.a,pi.id]),/immutable/);
   await assert.rejects(f.pg.query("UPDATE app.invoice_items SET description='Tampered' WHERE tenant_id=$1 AND invoice_id=$2",[f.ids.a,pi.id]),/immutable/);
  });
  await t.test('PI cannot become paid or create orders, payments or sold inventory',async()=>{
   await assert.rejects(f.pg.query("UPDATE app.invoices SET status='paid' WHERE tenant_id=$1 AND id=$2",[f.ids.a,pi.id]),/proforma_not_payable/);
   assert.equal((await f.pg.query<{n:number}>('SELECT count(*)::integer AS n FROM app.orders')).rows[0]!.n,0);
   assert.equal((await f.pg.query<{n:number}>('SELECT count(*)::integer AS n FROM app.payments')).rows[0]!.n,0);
   assert.equal((await f.pg.query<{status:string}>('SELECT status FROM app.artworks WHERE tenant_id=$1 AND id=$2',[f.ids.a,artwork.id])).rows[0]!.status,'available');
  });
  await t.test('conversion creates exactly one independent invoice draft and issues under its own numbering',async()=>{
   invoice=await read(await req(`${base}/invoices/${pi.id}/convert`,'POST',{},pi.version));assert.equal(invoice.documentType,'invoice');assert.equal(invoice.proformaId,pi.id);assert.equal(invoice.status,'draft');assert.equal(invoice.number,null);assert.equal(invoice.payable,false);assert.equal(invoice.totalMinor,pi.totalMinor);
   const retry=await read(await req(`${base}/invoices/${pi.id}/convert`,'POST',{},pi.version));assert.equal(retry.id,invoice.id);
   const source=await read(await req(`${base}/invoices/${pi.id}`));assert.equal(source.convertedInvoiceId,invoice.id);assert.equal(source.status,'issued');
   invoice=await read(await req(`${base}/invoices/${invoice.id}/issue`,'POST',{},invoice.version));assert.match(invoice.number,/^INV-\d{4}-000001$/);assert.equal(invoice.payable,true);assert.equal(invoice.contributesToSales,true);
   const retryAfterIssue=await read(await req(`${base}/invoices/${pi.id}/convert`,'POST',{},pi.version));assert.equal(retryAfterIssue.id,invoice.id);assert.equal(retryAfterIssue.status,'issued');
   const rows=await f.pg.query<{n:number}>('SELECT count(*)::integer AS n FROM app.invoices WHERE tenant_id=$1 AND proforma_id=$2',[f.ids.a,pi.id]);assert.equal(rows.rows[0]!.n,1);
  });
  await t.test('list filtering, stable cursor pagination and admin audit separate invoices from PI',async()=>{
   const onlyPI=await read(await req(`${base}/invoices?documentType=proforma`));assert.deepEqual(onlyPI.items.map((r:any)=>r.id),[pi.id]);assert.equal(onlyPI.items[0].contributesToSales,false);
   const page=await read(await req(`${base}/invoices?limit=1`));assert.ok(page.next);const next=await read(await req(`${base}/invoices?limit=1&${new URLSearchParams(page.next)}`));assert.notEqual(page.items[0].id,next.items[0].id);
   const audit=await read(await req(`${base}/audit`));assert.ok(audit.items.some((row:any)=>row.action==='proforma.converted'));assert.ok(audit.items.some((row:any)=>row.action==='invoice.issued'));
  });
  await t.test('cross-tenant references roll back creation and reveal no document details',async()=>{
   const foreignContact=(await f.pg.query<{id:string}>('SELECT id FROM app.contacts WHERE tenant_id=$1',[f.ids.b])).rows[0]!.id;
   const before=(await f.pg.query<{n:number}>('SELECT count(*)::integer AS n FROM app.invoices')).rows[0]!.n;
   assert.equal((await req(`${base}/invoices`,'POST',{...draft,customerId:foreignContact})).status,409);
   assert.equal((await req(`${base}/invoices`,'POST',{...draft,items:[{...draft.items[0],artworkId:randomUUID()}]})).status,409);
   assert.equal((await f.pg.query<{n:number}>('SELECT count(*)::integer AS n FROM app.invoices')).rows[0]!.n,before);
   assert.equal((await req(`/api/galleries/${f.ids.b}/invoices/${invoice.id}`,'GET',undefined,undefined,'bob')).status,404);
   assert.equal((await req(`${base}/invoices/${invoice.id}`,'GET',undefined,undefined,'bob')).status,403);
   assert.equal((await req(`${base}/invoices`,'POST',{...draft,tenant_id:f.ids.b})).status,422);
   assert.equal((await req(`${base}/invoices`,'POST',draft,undefined,'alice',{'X-CSRF-Token':''})).status,403);
  });
  await t.test('viewer and collector permissions cannot issue, convert or create financial records',async()=>{
   await f.pg.query("UPDATE control.memberships SET role='viewer' WHERE tenant_id=$1 AND user_id=$2",[f.ids.a,f.ids.staff]);
   assert.equal((await req(`${base}/invoices/${invoice.id}`,'GET',undefined,undefined,'staff')).status,200);
   assert.equal((await req(`${base}/invoices`,'POST',draft,undefined,'staff')).status,403);
   assert.equal((await req(`${base}/invoices/${pi.id}/convert`,'POST',{},pi.version,'staff')).status,403);
   await f.pg.query("UPDATE control.memberships SET role='collector' WHERE tenant_id=$1 AND user_id=$2",[f.ids.a,f.ids.staff]);
   assert.equal((await req(`${base}/invoices`,'GET',undefined,undefined,'staff')).status,403);
   assert.equal((await req(`${base}/invoices/options`,'GET',undefined,undefined,'staff')).status,403);
   await f.pg.query("UPDATE control.memberships SET role='staff' WHERE tenant_id=$1 AND user_id=$2",[f.ids.a,f.ids.staff]);
  });
  await t.test('provider access requires the matching fresh scoped session and is audited',async()=>{
   assert.equal((await req(`${base}/invoices/${pi.id}`,'GET',undefined,undefined,'provider')).status,403);
   const access=await read(await req('/api/provider/access','POST',{tenantId:f.ids.a,reason:'Review invoice setup'},undefined,'provider'),201);
   const response=await req(`${base}/invoices/${pi.id}`,'GET',undefined,undefined,'provider',{'X-Provider-Access':access.id});assert.equal(response.status,200);
   assert.equal((await req(`${base}/invoices/${pi.id}`,'GET',undefined,undefined,'bob',{'X-Provider-Access':access.id})).status,403);
   await read(await req(`/api/provider/access/${access.id}/close`,'POST',{},undefined,'provider'));
   assert.equal((await req(`${base}/invoices/${pi.id}`,'GET',undefined,undefined,'provider',{'X-Provider-Access':access.id})).status,403);
   assert.ok((await f.pg.query("SELECT id FROM control.audit_events WHERE action='provider.request' AND entity_id=$1",[f.ids.a])).rows.length>0);
  });
  await t.test('validation prevents incomplete issue and rejects malformed money, GSTIN and dates',async()=>{
   for(const invalid of [
    {...draft,sellerGstin:'not-a-gstin'}, {...draft,customerGstin:'27ABCDE1234F1Z!'},
    {...draft,dueAt:'2026-02-30'}, {...draft,items:[{...draft.items[0],taxRateBps:10001}]},
    {...draft,items:[{...draft.items[0],quantity:1.5}]},
    {...draft,items:[{...draft.items[0],quantity:10000,unitPriceMinor:1_000_000_000_000}]}
   ])assert.equal((await req(`${base}/invoices`,'POST',invalid)).status,422);
   let incomplete=await read(await req(`${base}/invoices`,'POST',{...draft,sellerAddress:'',customerAddress:'',items:[]}),201);
   assert.equal((await req(`${base}/invoices/${incomplete.id}/issue`,'POST',{},incomplete.version)).status,409);
   const unchanged=await read(await req(`${base}/invoices/${incomplete.id}`));assert.equal(unchanged.status,'draft');assert.equal(unchanged.number,null);assert.equal(unchanged.version,incomplete.version);
   incomplete=await read(await req(`${base}/invoices/${incomplete.id}`,'PATCH',{...draft,sellerGstin:draft.sellerGstin.toLowerCase()},incomplete.version));
   assert.equal(incomplete.sellerGstin,draft.sellerGstin);
   incomplete=await read(await req(`${base}/invoices/${incomplete.id}/issue`,'POST',{},incomplete.version));assert.match(incomplete.number,/^PI-\d{4}-000002$/);
   assert.equal((await req(`${base}/invoices/${incomplete.id}/issue`,'POST',{},incomplete.version)).status,403);
  });
  await t.test('issued item insertion/deletion and runtime SQL bypasses are denied',async()=>{
   await assert.rejects(f.pg.query('DELETE FROM app.invoice_items WHERE tenant_id=$1 AND invoice_id=$2',[f.ids.a,pi.id]),/immutable/);
   await assert.rejects(f.pg.query("INSERT INTO app.invoice_items(tenant_id,invoice_id,position,description,quantity,unit_price_minor,subtotal_minor,tax_minor,total_minor) VALUES($1,$2,1,'Injected',1,1,1,0,1)",[f.ids.a,pi.id]),/immutable/);
   const grants=await f.pg.query<{api_insert:boolean;api_update:boolean;jobs_save:boolean;identity_save:boolean;api_save:boolean}>(`SELECT
    has_table_privilege('vayu_api','app.invoices','INSERT') AS api_insert,
    has_table_privilege('vayu_api','app.invoice_items','UPDATE') AS api_update,
    has_function_privilege('vayu_jobs','security.save_invoice(uuid,uuid,integer,jsonb)','EXECUTE') AS jobs_save,
    has_function_privilege('vayu_identity','security.save_invoice(uuid,uuid,integer,jsonb)','EXECUTE') AS identity_save,
    has_function_privilege('vayu_api','security.save_invoice(uuid,uuid,integer,jsonb)','EXECUTE') AS api_save`);
   assert.deepEqual(grants.rows[0],{api_insert:false,api_update:false,jobs_save:false,identity_save:false,api_save:true});
  });
  await t.test('keyset pages retain PostgreSQL sub-millisecond ordering for invoices and selectors',async()=>{
   const upper=randomUUID(),lower=randomUUID(),upperContact=randomUUID(),lowerContact=randomUUID();
   await f.pg.query(`INSERT INTO app.invoices(tenant_id,id,document_type,currency,total_minor,created_at)
    VALUES($1,$2,'invoice','INR',0,'2099-01-01T00:00:00.000900Z'),($1,$3,'invoice','INR',0,'2099-01-01T00:00:00.000100Z')`,[f.ids.a,upper,lower]);
   await f.pg.query(`INSERT INTO app.contacts(tenant_id,id,name,created_at)
    VALUES($1,$2,'Cursor upper','2099-01-01T00:00:00.000900Z'),($1,$3,'Cursor lower','2099-01-01T00:00:00.000100Z')`,[f.ids.a,upperContact,lowerContact]);
   const first=await read(await req(`${base}/invoices?limit=1`));assert.equal(first.items[0].id,upper);assert.equal(first.next.before,'2099-01-01T00:00:00.000900Z');
   const second=await read(await req(`${base}/invoices?limit=1&${new URLSearchParams(first.next)}`));assert.equal(second.items[0].id,lower);
   const contacts=await read(await req(`${base}/invoices/options?kind=contacts&limit=1&q=Cursor`));assert.equal(contacts.contacts[0].id,upperContact);
   const contactPage=await read(await req(`${base}/invoices/options?limit=1&q=Cursor&${new URLSearchParams(contacts.contactsNext)}`));assert.equal(contactPage.contacts[0].id,lowerContact);
   assert.equal((await req(`${base}/invoices/options?limit=1&after=${upperContact}&before=${contacts.contactsNext.before}`)).status,422);
  });
 }finally{await f.close();}
});

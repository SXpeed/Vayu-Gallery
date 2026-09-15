import test from 'node:test';
import assert from 'node:assert/strict';
import {makeSeed} from '../server/seed.mjs';
import {act,visibleState} from '../server/domain.mjs';
import {documentLabel,isProforma,formatPartyAddress,normalizeGstin,validGstin} from '../shared/invoicing.mjs';
import {createAppServer} from '../server/server.mjs';

const sellerGstin='27ABCDE1234F1Z5',buyerGstin='29ABCDE5678G1Z2';
const save=(s,u,entity,data,entityId)=>act(s,u,{action:'save',entity,entityId,data});
const action=(s,u,name,r,data={})=>act(s,u,{action:name,entity:'invoices',entityId:r.id,data});
function fixture(){const s=makeSeed();return {s,u:s.users[0],other:s.users[3],member:s.users[1],guest:s.users[2]};}
function draft(s,u,data={}){return save(s,u,'invoices',{title:'PI-2026-001',documentType:'proforma',customerId:'c1',artworkIds:['a1'],taxRate:5,sellerName:'Snapshot Gallery',sellerAddress:'7 Gallery Lane\nMumbai, Maharashtra, 400001\nIndia',sellerGstin,customerGstin:buyerGstin,...data});}

test('document helpers distinguish PI and legacy invoices and format structured party addresses',()=>{
  assert.equal(documentLabel({documentType:'proforma'}),'Proforma Invoice');assert.equal(documentLabel('invoice'),'Invoice');assert.equal(documentLabel({}),'Invoice');assert.equal(isProforma('proforma'),true);assert.equal(isProforma({}),false);
  assert.equal(formatPartyAddress({address:' 12 Palm Avenue ',city:'Mumbai',region:'MH',postal:'400001',country:'India'}),'12 Palm Avenue\nMumbai, MH, 400001\nIndia');assert.equal(formatPartyAddress('  Existing address\nIndia '),'Existing address\nIndia');assert.equal(formatPartyAddress(undefined),'');
  assert.equal(normalizeGstin(' 27abcde1234f1z5 '),sellerGstin);assert.ok(validGstin(sellerGstin));assert.ok(validGstin(''));assert.equal(validGstin('not-gstin'),false);
});

test('new and legacy ordinary invoices default to invoice while PI remains explicit',()=>{
  const {s,u}=fixture(),r=save(s,u,'invoices',{title:'INV-new',customerId:'c1',artworkIds:['a1']});assert.equal(r.documentType,'invoice');assert.equal(r.status,'Draft');assert.equal(visibleState(s,u).invoices.find(i=>i.id==='inv1').documentType,'invoice');
  assert.equal(draft(s,u).documentType,'proforma');
});

test('GSTIN is optional, normalized, bounded and rejects malformed values on contacts and documents',()=>{
  const {s,u}=fixture();const c=save(s,u,'customers',{gstin:' 27abcde1234f1z5 '},'c1');assert.equal(c.gstin,sellerGstin);
  assert.equal(draft(s,u,{sellerGstin:'',customerGstin:''}).sellerGstin,'');
  for(const value of ['ABC','27ABCDE1234F1Z5extra','27ABCDE1234F1X5',' '.repeat(100),null,{}]){
    assert.throws(()=>save(s,u,'customers',{gstin:value},'c1'),/GSTIN/);
    assert.throws(()=>draft(s,u,{title:'PI-invalid',sellerGstin:value}),/GSTIN/);
  }
  assert.throws(()=>draft(s,u,{documentType:'tax'}),/Choose Invoice/);
  assert.throws(()=>draft(s,u,{sellerName:'x'.repeat(201)}),/sellerName/);assert.throws(()=>draft(s,u,{customerAddress:'x'.repeat(2001)}),/customerAddress/);
});

test('party details and artwork terms are snapshots and later unrelated draft edits retain them',()=>{
  const {s,u}=fixture();save(s,u,'customers',{gstin:buyerGstin},'c1');const r=draft(s,u),initial=structuredClone(r);
  save(s,u,'customers',{title:'Changed contact',address:'New street',city:'Pune',gstin:sellerGstin},'c1');save(s,u,'artworks',{title:'Renamed artwork',price:1},'a1');s.workspaces[0].name='New gallery name';
  const edited=save(s,u,'invoices',{title:'PI-retitled'},r.id);for(const key of ['sellerName','sellerAddress','sellerGstin','customerName','customerAddress','customerGstin','items','subtotal','total'])assert.deepEqual(edited[key],initial[key]);
  const changedCustomer=save(s,u,'invoices',{customerId:'c2'},r.id);assert.equal(changedCustomer.customerName,'Arjun Nair');assert.match(changedCustomer.customerAddress,/Garden Road/);
});

test('drafts allow incomplete party fields but both document kinds require complete names and addresses before issue',()=>{
  for(const documentType of ['invoice','proforma'])for(const field of ['sellerName','sellerAddress','customerName','customerAddress']){
    const {s,u}=fixture(),r=draft(s,u,{documentType,[field]:''}),count=s.audit.length;
    assert.equal(r.status,'Draft');assert.throws(()=>action(s,u,'invoice.issue',r),/before issuing/);assert.equal(r.status,'Draft');assert.equal(s.audit.length,count);
    const complete=save(s,u,'invoices',{[field]:'Explicit missing detail'},r.id);action(s,u,'invoice.issue',complete);assert.equal(complete.status,'Issued');assert.equal(complete.issuedBy,u.id);assert.ok(complete.issuedAt);
  }
});

test('issued invoices and PI freeze identity, address, GSTIN, items and amounts',()=>{
  for(const documentType of ['invoice','proforma']){
    const {s,u}=fixture(),r=draft(s,u,{documentType});action(s,u,'invoice.issue',r);const snapshot=structuredClone(r);
    save(s,u,'customers',{title:'Changed',address:'Later address',gstin:''},'c1');save(s,u,'artworks',{price:1},'a1');
    for(const data of [{sellerAddress:'Changed'},{customerGstin:''},{taxRate:99},{documentType:documentType==='invoice'?'proforma':'invoice'}])assert.throws(()=>save(s,u,'invoices',data,r.id),/Only draft/);
    assert.deepEqual(r,snapshot);const event=s.audit.find(e=>e.entityId===r.id&&e.action==='invoice.issue');assert.deepEqual(event.changes.find(c=>c.field==='status'),{field:'status',before:'Draft',after:'Issued'});
  }
});

test('document numbers are unique across invoice kinds, case variants and trash within a tenant',()=>{
  const {s,u,other}=fixture(),r=draft(s,u);
  assert.throws(()=>draft(s,u,{title:' pi-2026-001 ',documentType:'invoice'}),e=>e.status===409);
  action(s,u,'trash',r);assert.throws(()=>draft(s,u),e=>e.status===409);action(s,u,'restore',r);
  s.workspaces[1].plan='Business';const c=save(s,other,'customers',{title:'Other contact',address:'Other address'}),a=save(s,other,'artworks',{title:'Other artwork',price:5});
  const independent=save(s,other,'invoices',{title:r.title,customerId:c.id,artworkIds:[a.id],sellerAddress:'Other studio'});assert.equal(independent.workspaceId,'other');
});

test('PI cannot request or complete payment, restore a legacy request, arrange delivery or mark inventory sold',()=>{
  for(const status of ['Draft','Issued']){
    const {s,u}=fixture(),r=draft(s,u);if(status==='Issued')action(s,u,'invoice.issue',r);
    assert.throws(()=>save(s,u,'payments',{title:'Forbidden',invoiceId:r.id}),/Proforma/);
    assert.throws(()=>save(s,u,'deliveries',{title:'Forbidden delivery',invoiceId:r.id}),/Proforma/);
    const legacy={id:'legacy-pi-payment',workspaceId:u.workspaceId,invoiceId:r.id,title:'Legacy payment',amount:r.total,status:'Pending'};s.payments.push(legacy);const count=s.audit.length;
    assert.throws(()=>act(s,u,{action:'payment.simulate',entityId:legacy.id}),/Proforma/);assert.equal(s.artworks[0].status,'Available');assert.equal(legacy.status,'Pending');assert.equal(s.audit.length,count);
    legacy.deletedAt=new Date().toISOString();assert.throws(()=>act(s,u,{action:'restore',entity:'payments',entityId:legacy.id}),/Proforma/);assert.ok(legacy.deletedAt);
  }
});

test('ordinary draft invoices cannot bypass issue validation via a payment request',()=>{
  const {s,u}=fixture(),r=draft(s,u,{documentType:'invoice',sellerAddress:''});assert.throws(()=>save(s,u,'payments',{title:'Bypass',invoiceId:r.id}),/Issue the invoice/);assert.equal(s.payments.length,1);
});

test('PI conversion is idempotent, preserves quoted snapshots, links both records and audits both sides',()=>{
  const {s,u}=fixture(),pi=draft(s,u);assert.throws(()=>action(s,u,'invoice.convert',pi),/Issue the Proforma/);action(s,u,'invoice.issue',pi);const snapshot=structuredClone(pi);
  save(s,u,'customers',{title:'Later name',address:'Later address',gstin:''},'c1');save(s,u,'artworks',{title:'Later title',price:1},'a1');
  const invoice=act(s,u,{action:'invoice.convert',entityId:pi.id,data:{title:'INV-from-PI',total:1,sourceProformaId:'forged'}},'conversion-request');
  assert.equal(invoice.documentType,'invoice');assert.equal(invoice.status,'Draft');assert.equal(pi.status,'Converted');assert.equal(pi.convertedInvoiceId,invoice.id);assert.equal(invoice.sourceProformaId,pi.id);assert.equal(invoice.issuedAt,undefined);
  for(const key of ['sellerName','sellerAddress','sellerGstin','customerName','customerAddress','customerGstin','artworkIds','items','subtotal','taxRate','total'])assert.deepEqual(invoice[key],snapshot[key]);
  const auditCount=s.audit.length,invoiceCount=s.invoices.length;assert.equal(action(s,u,'invoice.convert',pi,{title:'Should not duplicate'}).id,invoice.id);assert.equal(s.invoices.length,invoiceCount);assert.equal(s.audit.length,auditCount);
  assert.equal(s.audit.filter(e=>e.requestId==='conversion-request').length,2);assert.equal(s.artworks[0].status,'Available');
  const edited=save(s,u,'invoices',{sellerAddress:'Updated draft address'},invoice.id);assert.equal(edited.items[0].price,85000);assert.equal(pi.sellerAddress,snapshot.sellerAddress);
  assert.throws(()=>save(s,u,'invoices',{documentType:'proforma'},invoice.id),/converted invoice/);
});

test('converted draft invoice can issue and complete the normal sale while its source PI stays non-payable',()=>{
  const {s,u}=fixture(),pi=draft(s,u);action(s,u,'invoice.issue',pi);const invoice=action(s,u,'invoice.convert',pi);action(s,u,'invoice.issue',invoice);
  const payment=save(s,u,'payments',{title:'Invoice payment',invoiceId:invoice.id});act(s,u,{action:'payment.simulate',entityId:payment.id});assert.equal(invoice.status,'Paid');assert.equal(pi.status,'Converted');assert.equal(s.artworks[0].status,'Sold');assert.equal(action(s,u,'invoice.convert',pi).id,invoice.id);
  assert.throws(()=>save(s,u,'payments',{title:'PI still forbidden',invoiceId:pi.id}),/Proforma/);
});

test('issued and conversion-linked documents are retained while unissued standalone drafts can be removed',()=>{
  const {s,u}=fixture(),pi=draft(s,u);action(s,u,'invoice.issue',pi);assert.throws(()=>action(s,u,'trash',pi),/must be retained/);const invoice=action(s,u,'invoice.convert',pi);
  for(const r of [pi,invoice]){assert.throws(()=>action(s,u,'trash',r),/must be retained/);r.deletedAt=new Date().toISOString();assert.throws(()=>action(s,u,'purge',r),/must be retained/);delete r.deletedAt;}
  const free=draft(s,u,{title:'PI-unused'});action(s,u,'trash',free);action(s,u,'purge',free);assert.ok(!s.invoices.some(r=>r.id===free.id));
});

test('conversion errors are atomic and cross-tenant users cannot issue, convert, link or pay another tenant document',()=>{
  const {s,u,other,guest}=fixture(),pi=draft(s,u);action(s,u,'invoice.issue',pi);s.workspaces[1].plan='Business';
  for(const name of ['invoice.issue','invoice.convert'])assert.throws(()=>action(s,other,name,pi),e=>e.status===404);
  assert.throws(()=>action(s,guest,'invoice.convert',pi),e=>e.status===403);
  assert.throws(()=>save(s,other,'payments',{title:'Other tenant',invoiceId:pi.id}),e=>e.status===404);
  const before=structuredClone(pi),count=s.invoices.length;assert.throws(()=>action(s,u,'invoice.convert',pi,{title:'INV-2026-001'}),e=>e.status===409);assert.deepEqual(pi,before);assert.equal(s.invoices.length,count);
  s.artworks[0].status='Sold';assert.throws(()=>action(s,u,'invoice.convert',pi),/already sold/);assert.deepEqual(pi,before);assert.equal(s.invoices.length,count);
});

test('concurrent HTTP conversion requests produce exactly one linked invoice and preserve the issued snapshot',async t=>{
  const server=createAppServer({memory:true});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const base=`http://127.0.0.1:${server.address().port}`;let cookie='';
  const request=async(path,body)=>{const response=await fetch(`${base}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const json=await response.json();assert.equal(response.status,200,JSON.stringify(json));return json;};
  await request('login',{userId:'admin'});const pi=(await request('action',{action:'save',entity:'invoices',data:{title:'PI-concurrent',documentType:'proforma',customerId:'c1',artworkIds:['a1'],sellerAddress:'7 Gallery Lane',sellerGstin}})).result;
  await request('action',{action:'invoice.issue',entityId:pi.id});const responses=await Promise.all(Array.from({length:8},()=>request('action',{action:'invoice.convert',entityId:pi.id})));assert.equal(new Set(responses.map(r=>r.result.id)).size,1);
  const state=await request('state');assert.equal(state.invoices.filter(i=>i.sourceProformaId===pi.id).length,1);assert.equal(state.audit.filter(e=>e.action==='invoice.convert'&&e.entityId===pi.id).length,1);assert.equal(state.invoices.find(i=>i.id===pi.id).sellerAddress,'7 Gallery Lane');
});

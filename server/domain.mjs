import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { plans } from './seed.mjs';
import {isProvider,publicIdentity,catalogPlans,effectivePlan,pendingInvitations,seatUsage} from './access.mjs';
import {normalizeDesign,validImageSource,productImages,designImageSources} from '../shared/catalog-design.mjs';
import {isProforma,formatPartyAddress,normalizeGstin,validGstin} from '../shared/invoicing.mjs';

export class AppError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
export const id = () => randomUUID();
export const tokenDigest = token => createHash('sha256').update(String(token)).digest('hex');
const fail = (condition, message, status = 400) => { if (!condition) throw new AppError(message, status); };
const admin = u => fail(u.role === 'admin', 'Only workspace admins can perform this action.', 403);
const staff = u => fail(u.role !== 'guest', 'Guest access is limited to invited private rooms.', 403);
export const entities = ['artworks','collections','catalogs','customers','inquiries','tasks','reservations','invoices','payments','deliveries','conversations','rooms'];
const featureName = { artworks: 'inventory' };
const fields = {
  artworks: ['title','artist','medium','dimensions','price','image','images','bannerImage','location','description','year'],
  collections: ['title','description','artworkIds'],
  catalogs: ['title','description','artworkIds','theme','customerId','inquiryId','design'],
  customers: ['title','email','phone','address','city','region','postal','country','notes','gstin'],
  inquiries: ['title','customerId','artworkIds','status','source','assignee','notes','address','city','region','postal','country','attachments'],
  tasks: ['title','inquiryId','assignee','dueAt','status'],
  reservations: ['title','artworkId','customerId','inquiryId','expiresAt'],
  invoices: ['title','customerId','inquiryId','artworkIds','taxRate','documentType','sellerName','sellerAddress','sellerGstin','customerName','customerAddress','customerGstin'],
  payments: ['title','invoiceId'],
  deliveries: ['title','invoiceId','status','tracking','address','notes','attachments'],
  conversations: ['title','kind','memberIds'],
  rooms: ['title','description','memberIds','artworkIds','catalogIds','attachments','status']
};
const arrayFields = new Set(['artworkIds','memberIds','catalogIds','attachments','images']);
const dateFields = new Set(['dueAt','expiresAt']);
function clean(type, input) {
  const out = {};
  for (const k of fields[type] || []) if (Object.hasOwn(input, k)) {
    const v = input[k];
    if(k==='design'){fail(v&&typeof v==='object'&&!Array.isArray(v),'Invalid catalog design.');out[k]=normalizeDesign(v,input.theme);}
    else if (arrayFields.has(k)) { fail(Array.isArray(v) && v.length <= (k==='images'?30:500) && v.every(x => typeof x === 'string'), `Invalid ${k}.`); out[k] = [...new Set(v)]; }
    else if (['price','taxRate'].includes(k)) { fail(Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= (k === 'taxRate' ? 100 : 1e10), `Invalid ${k}.`); out[k] = Number(v); }
    else if (['gstin','sellerGstin','customerGstin'].includes(k)) {fail(typeof v==='string'&&v.length<=30&&validGstin(v),`Enter a valid 15-character GSTIN for ${k}, or leave it empty.`);out[k]=normalizeGstin(v);}
    else if (k==='documentType') {fail(['invoice','proforma'].includes(v),'Choose Invoice or Proforma Invoice.');out[k]=v;}
    else if (['sellerName','customerName','sellerAddress','customerAddress'].includes(k)) {fail(typeof v==='string'&&v.length<=(k.endsWith('Address')?2000:200),`Invalid ${k}.`);out[k]=v.trim();}
    else { fail(typeof v === 'string' && v.length <= 10000, `Invalid ${k}.`); out[k] = v.trim(); }
    if (dateFields.has(k) && out[k]) fail(Number.isFinite(Date.parse(out[k])), `Invalid ${k}.`);
  }
  return out;
}
export function record(s, u, type, rid, includeDeleted = false) {
  const r = s[type]?.find(x => x.id === rid && x.workspaceId === u.workspaceId && (includeDeleted || !x.deletedAt));
  fail(r, 'Record not found in this workspace.', 404);
  if (['rooms','conversations'].includes(type)) fail(isProvider(u)||r.memberIds.includes(u.id), 'You are not a participant in this private space.', 403);
  return r;
}
function workspace(s, u) { return s.workspaces.find(w => w.id === u.workspaceId); }
const partyFields=['sellerName','sellerAddress','sellerGstin','customerName','customerAddress','customerGstin'];
function invoiceParties(s,u,r,old,input={}) {
  const seller=workspace(s,u),customer=r.customerId?record(s,u,'customers',r.customerId):{};
  const values={sellerName:seller.name||'',sellerAddress:formatPartyAddress(seller),sellerGstin:normalizeGstin(seller.gstin||''),customerName:customer.title||'',customerAddress:formatPartyAddress(customer),customerGstin:normalizeGstin(customer.gstin||'')};
  for(const key of partyFields){if(Object.hasOwn(input,key))values[key]=r[key];else if(old&&Object.hasOwn(old,key)&&(!key.startsWith('customer')||old.customerId===r.customerId))values[key]=old[key];}
  return clean('invoices',values);
}
function uniqueDocumentNumber(s,u,r) {
  fail(typeof r.title==='string'&&r.title.trim().length>0&&r.title.length<=100,'Enter a document number under 100 characters.');
  fail(!s.invoices.some(x=>x.workspaceId===u.workspaceId&&x.id!==r.id&&x.title.trim().toLowerCase()===r.title.trim().toLowerCase()),'This document number is already used in this workspace.',409);
}
function nextInvoiceNumber(s,u) {
  const prefix=`INV-${new Date().getFullYear()}-`;let sequence=1;
  const used=new Set(s.invoices.filter(x=>x.workspaceId===u.workspaceId).map(x=>x.title.trim().toLowerCase()));
  while(used.has(`${prefix}${String(sequence).padStart(4,'0')}`.toLowerCase()))sequence++;
  return `${prefix}${String(sequence).padStart(4,'0')}`;
}
function completeInvoiceParties(r) {
  for(const key of ['sellerName','sellerAddress','customerName','customerAddress'])fail(typeof r[key]==='string'&&r[key].trim()&&r[key].length<=(key.endsWith('Address')?2000:200),`Add the ${key.startsWith('seller')?'seller':'customer'} ${key.endsWith('Name')?'name':'address'} before issuing this document.`);
  for(const key of ['sellerGstin','customerGstin'])fail(validGstin(r[key]??''),`Enter a valid ${key.startsWith('seller')?'seller':'customer'} GSTIN, or leave it empty.`);
}
function payableInvoice(inv) {
  fail(!isProforma(inv),'A Proforma Invoice cannot receive payments. Convert it to an invoice first.',409);
  fail(inv.status==='Issued','Issue the invoice before creating or completing a payment request.',409);
  completeInvoiceParties(inv);
}
function retainInvoice(s,u,r) {
  fail(r.status==='Draft'&&!r.issuedAt&&!r.sourceProformaId&&!r.convertedInvoiceId&&!s.invoices.some(x=>x.workspaceId===u.workspaceId&&(x.sourceProformaId===r.id||x.convertedInvoiceId===r.id)),'Issued or converted documents must be retained.');
  fail(!s.payments.some(p=>p.workspaceId===u.workspaceId&&p.invoiceId===r.id),'An invoice with payment records must be retained.');
}
export function usage(s, u) {
  const w = workspace(s,u);
  return { seats: seatUsage(s,u.workspaceId).active + seatUsage(s,u.workspaceId).reserved,
    artworks: s.artworks.filter(x => x.workspaceId === u.workspaceId && !x.deletedAt).length,
    catalogs: s.catalogs.filter(x => x.workspaceId === u.workspaceId && !x.deletedAt).length,
    rooms: s.rooms.filter(x => x.workspaceId === u.workspaceId && !x.deletedAt && x.status !== 'Archived').length,
    storageMB: s.files.filter(x => x.workspaceId === u.workspaceId).reduce((n,x) => n + x.size,0) / 1024 / 1024,
    generations: w.generationMonth === new Date().toISOString().slice(0,7) ? w.generations : 0 };
}
function entitled(s,u,type) {
  const w = workspace(s,u);
  if(isProvider(u))return;
  fail(w.status!=='suspended','This organization is suspended. Contact the provider.',403);
  fail(w.subscription === 'active', 'Membership is inactive. An admin can activate a simulated plan in Membership.',403);
  fail((type==='audit'||effectivePlan(s,w).features.includes(featureName[type] || type)), `Your ${w.plan} plan does not include this feature.`,403);
}
function quota(s,u,key,additional=1) { fail(usage(s,u)[key] + additional <= effectivePlan(s,workspace(s,u))[key], `Your plan's ${key} limit has been reached. Upgrade or reduce usage.`,409); }
function allowed(s,u,type) { const w=workspace(s,u);return isProvider(u)||(w.status!=='suspended'&&w.subscription==='active'&&(type==='audit'||effectivePlan(s,w).features.includes(featureName[type]||type))); }
function auditValue(value) {
  if (Array.isArray(value)) return value.length > 20 ? `[${value.length} entries]` : value;
  return typeof value === 'string' && value.length > 300 ? value.slice(0,300) + '…' : value ?? null;
}
export function log(s,u,action,type,r,before = null,requestId=id()) {
  const omit = new Set(['updatedAt','createdAt','workspaceId','data','passwordHash','passwordSalt','token','text','readBy','revisions','accessId']);
  const changes = Object.keys({...before,...r}).filter(k => !omit.has(k) && JSON.stringify(before?.[k]) !== JSON.stringify(r?.[k])).map(field => ({field,before:auditValue(before?.[field]),after:auditValue(r?.[field])}));
  s.audit.push({id:id(),workspaceId:u.workspaceId,actorId:u.id,actorName:u.name,actorType:isProvider(u)?'provider':u.id==='system'?'system':'organization',providerAccessId:isProvider(u)?u.accessId:undefined,reason:isProvider(u)?u.reason:undefined,action,entity:type,entityId:r?.id,title:r?.title || type,at:new Date().toISOString(),changes,outcome:'success',requestId});
}
function notify(s,u,userIds,title,route,targetId) {
  for (const userId of new Set(userIds)) if (userId !== u.id) s.notifications.push({ id:id(), workspaceId:u.workspaceId,userId,title,route,targetId,read:false,createdAt:new Date().toISOString() });
}
function userRef(s,u,uid,guests = false) { fail(s.users.some(x => x.id === uid && x.workspaceId === u.workspaceId && !x.disabled && (guests || x.role !== 'guest')), 'Invalid workspace member.'); }
function validate(s,u,type,r,old) {
  fail(r.title?.length > 0, 'A name or title is required.');
  if (r.customerId) record(s,u,'customers',r.customerId);
  if (r.inquiryId) record(s,u,'inquiries',r.inquiryId);
  if (r.invoiceId) record(s,u,'invoices',r.invoiceId);
  if (r.artworkId) record(s,u,'artworks',r.artworkId);
  if (r.assignee) userRef(s,u,r.assignee);
  for (const aid of r.artworkIds || []) record(s,u,'artworks',aid);
  for (const cid of r.catalogIds || []) record(s,u,'catalogs',cid);
  for (const fid of r.attachments || []) {record(s,u,'files',fid);fail(canReadFile(s,u,fid),'You cannot attach a file you cannot access.',403);}
  const checkImage=src=>{fail(validImageSource(src),'Upload an image using the image picker.');if(src.startsWith('/api/files/')){const f=record(s,u,'files',src.split('/').pop());fail(f.mime.startsWith('image/')&&canReadFile(s,u,f.id),'You cannot use this private file as an artwork image.',403);}};
  if (type === 'artworks') { fail(Number.isFinite(r.price) && r.price >= 0,'Enter a valid price.');productImages(r).forEach(checkImage);if(r.images){fail(!r.image||r.images.includes(r.image),'Choose a display image from the product gallery.');fail(!r.bannerImage||r.images.includes(r.bannerImage),'Choose a banner image from the product gallery.');} }
  if (type === 'inquiries') { fail(r.customerId,'Select a customer.'); fail(['New','Contacted','Interested','Converted','Closed'].includes(r.status), 'Invalid inquiry status.'); }
  if (type === 'tasks') { fail(r.dueAt && r.assignee,'A due date and assignee are required.'); fail(['Open','Done'].includes(r.status),'Invalid task status.'); }
  if (type === 'deliveries') {fail(['Packing','Dispatched','Delivered','Installed'].includes(r.status),'Invalid delivery status.');if(r.invoiceId)fail(!isProforma(record(s,u,'invoices',r.invoiceId)),'Convert the Proforma Invoice before arranging delivery.',409);}
  if (type === 'catalogs') {fail(['Ivory','Charcoal','Clay'].includes(r.theme),'Choose a catalog theme.');designImageSources(r.design).forEach(checkImage);for(const [aid,urls] of Object.entries(r.design?.selectedImages||{})){const art=record(s,u,'artworks',aid);fail(urls.every(src=>productImages(art).includes(src)),'Choose catalog photos from the product gallery.');}}
  if (['rooms','conversations'].includes(type)) {
    fail(Array.isArray(r.memberIds) && (isProvider(u)?r.memberIds.length>0:r.memberIds.includes(u.id)),isProvider(u)?'Select at least one organization participant.':'You must remain a member.');
    r.memberIds.forEach(uid => userRef(s,u,uid,type === 'rooms'));
    if(type === 'rooms') fail(['Active','Archived'].includes(r.status), 'Invalid room status.');
    if (type === 'conversations') { fail(['direct','group'].includes(r.kind),'Invalid conversation type.'); fail(r.memberIds.length >= 2,'Select at least one other member.'); if(r.kind === 'direct') fail(r.memberIds.length === 2,'A direct conversation has exactly two participants.'); if(old) fail(old.kind === r.kind,'Conversation type cannot be changed.'); }
    if(old) fail(old.createdBy === u.id || u.role === 'admin','Only the room/group owner or an admin participant can change membership.',403);
  }
}
export function visibleState(s,u) {
  const w = workspace(s,u), guest = u.role === 'guest';
  const out = {user:publicIdentity(u),workspace:w,plans:{...catalogPlans(s),[w.plan]:effectivePlan(s,w)},usage:usage(s,u),teamUsage:seatUsage(s,u.workspaceId),users:s.users.filter(x=>x.workspaceId===u.workspaceId).map(publicIdentity),provider:isProvider(u)?{id:u.id,name:u.name,role:u.providerRole,accessId:u.accessId}:null,providerActors:(s.providerAccounts||[]).map(p=>({id:p.id,name:p.name,initials:p.initials})),serverTime:new Date().toISOString()};
  out.invitations=u.role==='admin'?pendingInvitations(s,u.workspaceId).map(({tokenHash,...i})=>i):[];
  out.messageRevisions=isProvider(u)?(s.messageRevisions||[]).filter(r=>r.workspaceId===u.workspaceId):[];
  const rooms = s.rooms.filter(x => x.workspaceId === u.workspaceId && !x.deletedAt && (isProvider(u)||x.memberIds.includes(u.id)) && allowed(s,u,'rooms'));
  const conversations = guest ? [] : s.conversations.filter(x=>x.workspaceId === u.workspaceId && !x.deletedAt && (isProvider(u)||x.memberIds.includes(u.id)) && allowed(s,u,'conversations'));
  if(guest){const known=new Set([u.id,...rooms.flatMap(r=>r.memberIds)]);out.users=out.users.filter(x=>known.has(x.id)).map(x=>x.id===u.id?x:{id:x.id,name:x.name,initials:x.initials,role:x.role,workspaceId:x.workspaceId});}
  for (const type of entities) out[type] = guest ? [] : s[type].filter(x=>x.workspaceId===u.workspaceId && !x.deletedAt && allowed(s,u,type));
  out.invoices=out.invoices.map(r=>({...r,documentType:r.documentType||'invoice'}));
  out.rooms = rooms; out.conversations = conversations;
  if(guest) {
    out.artworks = s.artworks.filter(x=>x.workspaceId===u.workspaceId && !x.deletedAt && rooms.some(r=>r.artworkIds.includes(x.id))).map(({price,location,...x})=>x);
    out.catalogs = s.catalogs.filter(x=>x.workspaceId===u.workspaceId && !x.deletedAt && rooms.some(r=>r.catalogIds.includes(x.id)));
  }
  out.messages = s.messages.filter(x=>x.workspaceId===u.workspaceId && (x.containerType==='rooms' ? rooms : conversations).some(r=>r.id===x.containerId));
  out.approvals = s.approvals.filter(x=>x.workspaceId===u.workspaceId && rooms.some(r=>r.id===x.roomId));
  out.files = s.files.filter(x=>x.workspaceId===u.workspaceId && canReadFile(s,u,x.id)).map(({data,...x})=>x);
  out.notifications = s.notifications.filter(x=>x.workspaceId===u.workspaceId && x.userId===u.id);
  out.drafts = s.drafts.filter(x=>x.workspaceId===u.workspaceId && x.userId===u.id);
  out.shares = !guest && allowed(s,u,'catalogs') ? s.shares.filter(x=>x.workspaceId===u.workspaceId) : [];
  out.audit = u.role === 'admin' && allowed(s,u,'audit') ? s.audit.filter(x=>x.workspaceId===u.workspaceId).slice(-2000).reverse() : [];
  out.trash = u.role === 'admin' ? entities.flatMap(type=>s[type].filter(x=>x.workspaceId===u.workspaceId && x.deletedAt && (!['rooms','conversations'].includes(type) || isProvider(u) || x.memberIds.includes(u.id))).map(x=>({...x,entity:type}))) : [];
  if(!isProvider(u))out.audit=out.audit.map(e=>{let space=['rooms','conversations'].includes(e.entity)?s[e.entity].find(r=>r.id===e.entityId):null;if(e.entity==='messages'){const m=s.messages.find(m=>m.id===e.entityId);space=m&&s[m.containerType]?.find(r=>r.id===m.containerId);}if(e.entity==='approvals'){const a=s.approvals.find(a=>a.id===e.entityId);space=a&&s.rooms.find(r=>r.id===a.roomId);}return space&&!space.memberIds.includes(u.id)?{...e,title:'Private space activity',entityId:undefined,changes:[]}:e;});
  return out;
}
export function canReadFile(s,u,fid) {
  const f = s.files.find(x=>x.id===fid && x.workspaceId===u.workspaceId); if(!f) return false;
  if(isProvider(u))return true;
  if(workspace(s,u).status==='suspended')return false;
  const privateLinked=s.messages.some(m=>m.fileId===fid&&!m.deletedAt)||(s.messageRevisions||[]).some(m=>m.fileId===fid)||s.rooms.some(r=>r.attachments?.includes(fid));
  if(f.createdBy===u.id&&!privateLinked) return true;
  if(s.rooms.some(r=>r.workspaceId===u.workspaceId && !r.deletedAt && allowed(s,u,'rooms') && r.memberIds.includes(u.id) && (r.attachments.includes(fid) || s.messages.some(m=>m.containerType==='rooms' && m.containerId===r.id && !m.deletedAt && m.fileId===fid)))) return true;
  if(u.role!=='guest'&&s.conversations.some(r=>r.workspaceId===u.workspaceId && !r.deletedAt && allowed(s,u,'conversations') && r.memberIds.includes(u.id) && s.messages.some(m=>m.containerType==='conversations' && m.containerId===r.id && !m.deletedAt && m.fileId===fid))) return true;
  if(s.catalogs.some(c=>c.workspaceId===u.workspaceId && !c.deletedAt && c.versions.some(v=>v.fileId===fid) && (u.role!=='guest' && allowed(s,u,'catalogs') || s.rooms.some(r=>r.workspaceId===u.workspaceId && !r.deletedAt && allowed(s,u,'rooms') && r.memberIds.includes(u.id) && r.catalogIds.includes(c.id))))) return true;
  if(s.artworks.some(a=>a.workspaceId===u.workspaceId && !a.deletedAt && productImages(a).includes(`/api/files/${fid}`) && (u.role!=='guest'&&allowed(s,u,'artworks') || s.rooms.some(r=>r.workspaceId===u.workspaceId&&!r.deletedAt&&allowed(s,u,'rooms')&&r.memberIds.includes(u.id)&&r.artworkIds.includes(a.id)))))return true;
  if(s.catalogs.some(c=>c.workspaceId===u.workspaceId&&!c.deletedAt&&designImageSources(c.design).includes(`/api/files/${fid}`)&&(u.role!=='guest'&&allowed(s,u,'catalogs')||s.rooms.some(r=>r.workspaceId===u.workspaceId&&!r.deletedAt&&allowed(s,u,'rooms')&&r.memberIds.includes(u.id)&&r.catalogIds.includes(c.id)))))return true;
  return u.role!=='guest' && ['inquiries','deliveries'].some(type=>allowed(s,u,type) && s[type].some(r=>r.workspaceId===u.workspaceId && !r.deletedAt && r.attachments?.includes(fid)));
}
export function expireReservations(s) {
  for(const r of s.reservations) if(!r.deletedAt && r.status==='Active' && Date.parse(r.expiresAt)<=Date.now()) {
    const before={...r}; r.status='Expired'; const art=s.artworks.find(a=>a.id===r.artworkId && a.workspaceId===r.workspaceId); if(art?.status==='Reserved'){const previous={...art};art.status='Available';log(s,{id:'system',name:'Reservation scheduler',workspaceId:r.workspaceId},'artwork.released','artworks',art,previous);}
    log(s,{id:'system',name:'Reservation scheduler',workspaceId:r.workspaceId},'reservation.expired','reservations',r,before);
  }
  const today=new Date().toISOString().slice(0,10);
  for(const t of s.tasks)if(!t.deletedAt&&t.status==='Open'&&t.dueAt<=today&&t.assignee&&!s.notifications.some(n=>n.reminderKey===`${t.id}:${today}`)) {
    s.notifications.push({id:id(),workspaceId:t.workspaceId,userId:t.assignee,title:`${t.dueAt<today?'Overdue':'Due today'}: ${t.title}`,route:'tasks',targetId:t.id,read:false,reminderKey:`${t.id}:${today}`,createdAt:new Date().toISOString()});
  }
}

export function act(s,u,input,requestId = id()) {
  fail(u && !u.disabled,'Please sign in.',401);
  const { action, entity:type, entityId:rid, data = {} } = input;
  const at = new Date().toISOString();
  fail(isProvider(u)||workspace(s,u)?.status!=='suspended','This organization is suspended. Contact the provider.',403);
  if(action?.startsWith('membership.')&&workspace(s,u).ownerId)fail(isProvider(u)||workspace(s,u).ownerId===u.id,'Only the organization owner can manage its subscription.',403);
  if (action === 'save') {
    staff(u); fail(entities.includes(type),'Unsupported record type.'); entitled(s,u,type);
    const old = rid ? record(s,u,type,rid) : null;
    if(old && ['payments','reservations'].includes(type)) throw new AppError('Use the dedicated payment or reservation actions.');
    if(!old && ['artworks','catalogs','rooms'].includes(type)) quota(s,u,type);
    const defaults = { artworks:{status:'Available',price:0}, collections:{artworkIds:[]}, catalogs:{artworkIds:[],versions:[],theme:'Ivory',source:'Studio draft'}, inquiries:{status:'New',artworkIds:[],attachments:[],source:'Walk-in'},tasks:{status:'Open'},rooms:{memberIds:isProvider(u)?[]:[u.id],artworkIds:[],catalogIds:[],attachments:[],status:'Active'},conversations:{memberIds:isProvider(u)?[]:[u.id],kind:'group'},deliveries:{status:'Packing',attachments:[]} };
    const r = { ...(defaults[type]||{}),...old,...clean(type,data),id:old?.id||id(),workspaceId:u.workspaceId,createdBy:old?.createdBy||u.id,createdAt:old?.createdAt||at,updatedAt:at };
    validate(s,u,type,r,old);
    if(type==='reservations') {
      fail(Date.parse(r.expiresAt)>Date.now(),'Reservation expiry must be in the future.');
      const art=record(s,u,'artworks',r.artworkId); fail(art.status==='Available','This artwork is no longer available.',409); fail(r.customerId,'Select a customer.');
      art.status='Reserved'; r.status='Active'; log(s,u,'artwork.reserved','artworks',art,{...art,status:'Available'},requestId);
    }
    if(type==='invoices') {
      if(old) fail(old.status==='Draft','Only draft invoices can be edited.');
      if(old) fail(!s.payments.some(p=>p.workspaceId===u.workspaceId&&!p.deletedAt&&p.invoiceId===old.id),'Remove the pending payment request before changing this invoice.');
      r.documentType=r.documentType||'invoice';if(old?.sourceProformaId)fail(r.documentType==='invoice','A converted invoice cannot become a Proforma Invoice.');
      uniqueDocumentNumber(s,u,r);
      fail(r.customerId && r.artworkIds?.length,'Select a customer and at least one artwork.');
      Object.assign(r,invoiceParties(s,u,r,old,data));
      r.items=r.artworkIds.map(aid=>{const a=record(s,u,'artworks',aid);fail(a.status!=='Sold','A sold artwork cannot be added to an invoice.');const saved=old?.items?.find(item=>item.artworkId===aid);return saved?{...saved}:{artworkId:a.id,title:a.title,price:a.price};});
      r.subtotal=r.items.reduce((n,x)=>n+x.price,0);r.total=Math.round(r.subtotal*(1+(r.taxRate||0)/100)*100)/100;r.status='Draft';
    }
    if(type==='payments') {
      admin(u); const inv=record(s,u,'invoices',r.invoiceId); payableInvoice(inv);
      fail(!s.payments.some(p=>p.workspaceId===u.workspaceId && !p.deletedAt && p.invoiceId===inv.id && p.status==='Pending'),'An active payment request already exists.',409);
      r.amount=inv.total; r.status='Pending';r.method='Local simulation';
    }
    if(type==='conversations' && !old && r.kind==='direct') {
      const existing=s.conversations.find(c=>c.workspaceId===u.workspaceId&&!c.deletedAt&&c.kind==='direct'&&c.memberIds.length===2&&c.memberIds.every(x=>r.memberIds.includes(x)));
      if(existing) return existing;
    }
    if(type==='rooms' && old?.status==='Archived' && r.status==='Active') quota(s,u,'rooms');
    if(old) s[type][s[type].indexOf(old)]=r;else s[type].push(r);
    log(s,u,`${type}.${old?'edited':'created'}`,type,r,old,requestId);
    if(['rooms','conversations'].includes(type)) notify(s,u,r.memberIds.filter(x=>!old?.memberIds.includes(x)),`You were invited to ${r.title}`,type,r.id);
    if(['tasks','inquiries'].includes(type) && r.assignee && r.assignee!==old?.assignee) notify(s,u,[r.assignee],`Assigned to you: ${r.title}`,type,r.id);
    return r;
  }
  if(action==='trash' || action==='restore' || action==='purge') {
    staff(u); fail(entities.includes(type),'Unsupported record type.');
    const r=record(s,u,type,rid,true),before={...r};
    if(action!=='trash') admin(u);
    else { entitled(s,u,type); if(['payments','invoices'].includes(type)) admin(u); }
    if(['rooms','conversations'].includes(type)) fail(r.createdBy===u.id || u.role==='admin','Only the space owner or admin participant can delete it.',403);
    if(action==='restore') {
      fail(r.deletedAt,'This record is not in trash.');if(['artworks','catalogs','rooms'].includes(type))quota(s,u,type);
      try{validate(s,u,type,r,null);}catch(e){throw new AppError(`Cannot restore this record: ${e.message} Restore its linked records first.`,409);}
      if(type==='invoices')uniqueDocumentNumber(s,u,r);
      if(type==='payments') {const inv=record(s,u,'invoices',r.invoiceId);payableInvoice(inv);fail(r.amount===inv.total,'This payment request no longer matches an unpaid invoice.',409);fail(!s.payments.some(p=>p.id!==r.id&&p.workspaceId===u.workspaceId&&!p.deletedAt&&p.invoiceId===r.invoiceId&&p.status==='Pending'),'An active payment request already exists.',409);}
      delete r.deletedAt;
    }
    else if(action==='purge') { fail(r.deletedAt,'Move the record to trash first.');if(type==='invoices')retainInvoice(s,u,r);if(type==='payments')fail(r.status!=='Paid','Paid records must be retained.');s[type]=s[type].filter(x=>x.id!==r.id); }
    else {
      if(type==='artworks')fail(r.status==='Available','Reserved or sold artwork cannot be deleted.');
      if(type==='invoices')retainInvoice(s,u,r);
      if(type==='payments')fail(r.status!=='Paid','Paid records must be retained.');
      if(type==='customers')fail(!['inquiries','invoices','reservations'].some(t=>s[t].some(x=>x.workspaceId===u.workspaceId&&!x.deletedAt&&x.customerId===r.id)),'This customer has linked records. Retain the customer history.');
      if(type==='reservations' && r.status==='Active') { const a=record(s,u,'artworks',r.artworkId),previous={...a};a.status='Available';r.status='Cancelled';log(s,u,'artwork.released','artworks',a,previous,requestId); }
      r.deletedAt=at;
    }
    if(type==='catalogs')s.shares.filter(x=>x.catalogId===r.id).forEach(x=>x.revokedAt=at);
    if(action==='purge') {
      if(type==='catalogs') {const fids=r.versions.map(v=>v.fileId);const used=fid=>s.catalogs.some(c=>c.versions.some(v=>v.fileId===fid))||s.artworks.some(a=>productImages(a).includes(`/api/files/${fid}`))||s.catalogs.some(c=>designImageSources(c.design).includes(`/api/files/${fid}`))||['rooms','inquiries','deliveries'].some(t=>s[t].some(x=>x.attachments?.includes(fid)))||s.messages.some(m=>m.fileId===fid)||(s.messageRevisions||[]).some(m=>m.fileId===fid)||s.drafts.some(d=>d.data.attachments?.includes(fid)||d.data.image===`/api/files/${fid}`);s.files=s.files.filter(f=>!fids.includes(f.id)||used(f.id));s.shares=s.shares.filter(x=>x.catalogId!==r.id);}
      if(['rooms','conversations'].includes(type)){s.messages=s.messages.filter(m=>m.containerType!==type||m.containerId!==r.id);s.approvals=s.approvals.filter(a=>a.roomId!==r.id);}
    }
    log(s,u,`${type}.${action}`,type,r,before,requestId); return {id:r.id};
  }
  if(action==='catalog.version') {
    staff(u);entitled(s,u,'catalogs'); const r=record(s,u,'catalogs',rid),f=record(s,u,'files',data.fileId);fail(f.mime==='application/pdf','Catalog files must be PDFs.');
    fail((isProvider(u)||f.createdBy===u.id)&&canReadFile(s,u,f.id),'Use an accessible file you uploaded.',403);const before=structuredClone(r);
    if(data.generated) {quota(s,u,'generations');const w=workspace(s,u),month=at.slice(0,7);if(w.generationMonth!==month){w.generationMonth=month;w.generations=0;}w.generations++;}
    const v={id:id(),fileId:f.id,number:r.versions.length+1,createdAt:at,createdBy:u.id,source:data.generated?'Generated':'Uploaded',snapshot:{title:r.title,description:r.description,theme:r.theme,design:structuredClone(r.design||{}),artworks:r.artworkIds.map(aid=>{const a=record(s,u,'artworks',aid);return {title:a.title,artist:a.artist,description:a.description,price:a.price,dimensions:a.dimensions,medium:a.medium,images:productImages(a),image:a.image,bannerImage:a.bannerImage};})}};
    r.versions.push(v);r.source=v.source;r.updatedAt=at;
    log(s,u,`catalog.${data.generated?'generated':'uploaded'}`,'catalogs',r,before,requestId); return v;
  }
  if(action==='share.create') {
    staff(u);entitled(s,u,'catalogs');const c=record(s,u,'catalogs',rid);const v=c.versions.find(v=>v.id===data.versionId)||c.versions.at(-1);fail(v,'Generate or upload a saved version first.');
    fail(Number(data.days)>0&&Number(data.days)<=90,'Choose an expiry between 1 and 90 days.');
    const r={id:id(),workspaceId:u.workspaceId,catalogId:c.id,versionId:v.id,fileId:v.fileId,token:randomBytes(24).toString('hex'),expiresAt:new Date(Date.now()+Number(data.days)*86400000).toISOString(),createdBy:u.id,createdAt:at};
    s.shares.push(r);log(s,u,'catalog.share_created','shares',{...r,title:c.title},null,requestId);return r;
  }
  if(action==='share.revoke') {staff(u);const r=record(s,u,'shares',rid);r.revokedAt=at;log(s,u,'catalog.share_revoked','shares',r,null,requestId);return r;}
  if(action==='message.send' || action==='message.edit' || action==='message.delete' || action==='message.read') {
    fail(['rooms','conversations'].includes(type),'Invalid conversation.');if(type==='conversations')staff(u);entitled(s,u,type);
    const c=record(s,u,type,rid);fail(isProvider(u)||c.status!=='Archived','This room is archived.');
    if(action==='message.read') {if(isProvider(u)){log(s,u,'provider.conversation_viewed',type,c,null,requestId);return {ok:true};}s.messages.filter(m=>m.containerType===type&&m.containerId===rid).forEach(m=>{if(!m.readBy.includes(u.id))m.readBy.push(u.id);});return {ok:true};}
    if(action!=='message.send') {
      const m=record(s,u,'messages',data.messageId);fail(m.containerId===rid&&m.containerType===type&&(isProvider(u)||m.senderId===u.id),'You can only change your own messages here.',403);
      fail(!m.deletedAt,'This message is already deleted.');
      if(action==='message.edit')fail(typeof data.text==='string'&&data.text.trim()&&data.text.length<=5000,'Enter a message under 5,000 characters.');
      s.messageRevisions||=[];s.messageRevisions.push({id:id(),workspaceId:u.workspaceId,messageId:m.id,text:m.text,fileId:m.fileId,senderId:m.senderId,editedBy:u.id,editorName:u.name,actorType:isProvider(u)?'provider':'organization',action,at});
      if(isProvider(u)){m.providerEditedBy=u.id;m.providerEditorName=u.name;}
      if(action==='message.delete'){m.text='';delete m.fileId;m.deletedAt=at;}else {fail(typeof data.text==='string'&&data.text.trim()&&data.text.length<=5000,'Enter a message under 5,000 characters.');m.text=data.text.trim();m.editedAt=at;}
      log(s,u,action,'messages',{id:m.id,title:c.title},null,requestId);return m;
    }
    fail((typeof data.text==='string'&&data.text.trim()&&data.text.length<=5000)||data.fileId,'Write a message or attach a file.');
    if(data.fileId){const f=record(s,u,'files',data.fileId);fail((isProvider(u)||f.createdBy===u.id)&&canReadFile(s,u,f.id),'Use your own accessible uploaded file.',403);}
    if(data.replyTo)fail(s.messages.some(m=>m.id===data.replyTo&&m.containerId===rid&&m.containerType===type),'Reply target not found.');
    const r={id:id(),workspaceId:u.workspaceId,containerType:type,containerId:rid,senderId:u.id,senderName:u.name,senderType:isProvider(u)?'provider':'organization',text:String(data.text||'').slice(0,5000),fileId:data.fileId||null,replyTo:data.replyTo||null,createdAt:at,readBy:[u.id]};s.messages.push(r);
    notify(s,u,c.memberIds,`New message in ${c.title}`,type,rid);log(s,u,'message.sent','messages',{id:r.id,title:c.title},null,requestId);return r;
  }
  if(action==='room.approve') {
    entitled(s,u,'rooms');const r=record(s,u,'rooms',rid);fail(r.status==='Active','This room is archived.');fail(r.artworkIds.includes(data.artworkId),'Artwork is not shared in this room.');fail(['Shortlisted','Approved','Not selected'].includes(data.status),'Invalid selection.');
    let a=s.approvals.find(x=>x.roomId===rid&&x.artworkId===data.artworkId&&x.userId===u.id);const before=a?{...a}:null;
    if(!a){a={id:id(),workspaceId:u.workspaceId,roomId:rid,artworkId:data.artworkId,userId:u.id};s.approvals.push(a);}a.status=data.status;a.updatedAt=at;
    log(s,u,'room.selection_updated','approvals',a,before,requestId);notify(s,u,r.memberIds,`${u.name} updated an artwork selection`,'rooms',rid);return a;
  }
  if(action==='reservation.cancel') {staff(u);entitled(s,u,'reservations');const r=record(s,u,'reservations',rid);fail(r.status==='Active','Reservation is no longer active.');const before={...r};r.status='Cancelled';const art=record(s,u,'artworks',r.artworkId),previous={...art};art.status='Available';log(s,u,'artwork.released','artworks',art,previous,requestId);log(s,u,action,'reservations',r,before,requestId);return r;}
  if(action==='invoice.issue') {
    staff(u);entitled(s,u,'invoices');const r=record(s,u,'invoices',rid);fail(r.status==='Draft','Only a draft can be issued.');
    const candidate={...r,documentType:r.documentType||'invoice',...invoiceParties(s,u,r,r)};uniqueDocumentNumber(s,u,candidate);completeInvoiceParties(candidate);
    fail(candidate.customerId&&candidate.artworkIds?.length&&candidate.items?.length===candidate.artworkIds.length,'Select a customer and at least one artwork before issuing.');
    validate(s,u,'invoices',candidate,r);for(const aid of candidate.artworkIds)fail(record(s,u,'artworks',aid).status!=='Sold','An artwork on this document has already sold.',409);
    const before=structuredClone(r);Object.assign(r,candidate,{status:'Issued',issuedAt:at,issuedBy:u.id,updatedAt:at});log(s,u,action,'invoices',r,before,requestId);return r;
  }
  if(action==='invoice.convert') {
    staff(u);entitled(s,u,'invoices');const source=record(s,u,'invoices',rid);fail(isProforma(source),'Only a Proforma Invoice can be converted.');
    if(source.convertedInvoiceId){const existing=record(s,u,'invoices',source.convertedInvoiceId,true);fail(!isProforma(existing)&&existing.sourceProformaId===source.id,'The conversion link is invalid.',409);fail(!existing.deletedAt,'Restore the linked invoice before continuing.',409);return existing;}
    fail(source.status==='Issued','Issue the Proforma Invoice before converting it.');completeInvoiceParties(source);
    const title=Object.hasOwn(data,'title')?data.title:nextInvoiceNumber(s,u);
    const converted={id:id(),workspaceId:u.workspaceId,createdBy:u.id,createdAt:at,updatedAt:at,title,documentType:'invoice',status:'Draft',sourceProformaId:source.id,customerId:source.customerId,inquiryId:source.inquiryId||'',artworkIds:[...source.artworkIds],items:structuredClone(source.items),subtotal:source.subtotal,taxRate:source.taxRate||0,total:source.total,...Object.fromEntries(partyFields.map(key=>[key,source[key]||'']))};
    uniqueDocumentNumber(s,u,converted);converted.title=converted.title.trim();validate(s,u,'invoices',converted,null);for(const aid of converted.artworkIds)fail(record(s,u,'artworks',aid).status!=='Sold','An artwork on this Proforma Invoice has already sold.',409);
    const before=structuredClone(source);s.invoices.push(converted);Object.assign(source,{convertedInvoiceId:converted.id,convertedAt:at,convertedBy:u.id,status:'Converted',updatedAt:at});
    log(s,u,'invoice.created_from_proforma','invoices',converted,null,requestId);log(s,u,action,'invoices',source,before,requestId);return converted;
  }
  if(action==='payment.simulate') {
    admin(u);entitled(s,u,'payments');const p=record(s,u,'payments',rid),inv=record(s,u,'invoices',p.invoiceId);fail(!isProforma(inv),'A Proforma Invoice cannot receive payments. Convert it to an invoice first.',409);if(p.status==='Paid')return p;
    payableInvoice(inv);fail(p.amount===inv.total,'The payment request amount no longer matches the invoice.',409);
    for(const aid of inv.artworkIds){const a=record(s,u,'artworks',aid),previous={...a};fail(a.status!=='Sold','Artwork was sold on another invoice.',409);const active=s.reservations.find(r=>r.workspaceId===u.workspaceId&&!r.deletedAt&&r.artworkId===aid&&r.status==='Active');fail(!active||active.customerId===inv.customerId,'Artwork is reserved for another customer.',409);if(active){const prior={...active};active.status='Completed';log(s,u,'reservation.completed','reservations',active,prior,requestId);}a.status='Sold';log(s,u,'artwork.sold','artworks',a,previous,requestId);}
    const beforePayment={...p},beforeInvoice={...inv};p.status='Paid';p.verifiedAt=at;p.method='Simulated payment — no money moved';inv.status='Paid';
    log(s,u,'invoice.paid','invoices',inv,beforeInvoice,requestId);
    if(inv.inquiryId){const inquiry=record(s,u,'inquiries',inv.inquiryId),prior={...inquiry};inquiry.status='Converted';log(s,u,'inquiry.converted','inquiries',inquiry,prior,requestId);}
    log(s,u,action,'payments',p,beforePayment,requestId);return p;
  }
  if(action==='notification.read') {const n=record(s,u,'notifications',rid);fail(n.userId===u.id,'Not your notification.',403);n.read=true;return n;}
  if(action==='draft.save'||action==='draft.delete') {
    staff(u);fail(entities.includes(type),'Invalid draft.');entitled(s,u,type);
    const key=`${u.workspaceId}:${u.id}:${type}:${rid||'new'}`;s.drafts=s.drafts.filter(d=>!(d.workspaceId===u.workspaceId&&d.userId===u.id&&d.entity===type&&(d.entityId||null)===(rid||null)));
    if(action==='draft.save')s.drafts.push({id:id(),key,workspaceId:u.workspaceId,userId:u.id,entity:type,entityId:rid||null,data:clean(type,data),updatedAt:at});return {ok:true};
  }
  if(action==='membership.change') {
    admin(u);fail(catalogPlans(s)[data.plan],'Invalid plan.');const w=workspace(s,u),before={...w};
    w.plan=data.plan;w.planVersionId=catalogPlans(s)[data.plan].id;delete w.allowanceOverride;w.subscription='active';w.renewalAt=new Date(Date.now()+30*86400000).toISOString();
    log(s,u,'membership.simulated_plan_change','workspaces',w,before,requestId);return w;
  }
  if(action==='organization.transfer') {fail(isProvider(u),'Provider access is required.',403);const w=workspace(s,u),owner=s.users.find(x=>x.id===data.ownerId&&x.workspaceId===w.id&&!x.disabled&&x.role==='admin');fail(owner,'Choose an active organization administrator.');const before={...w};w.ownerId=owner.id;log(s,u,'provider.ownership_transferred','workspaces',w,before,requestId);return w;}
  if(action==='membership.cancel') {admin(u);const w=workspace(s,u);w.subscription='cancelled';log(s,u,'membership.simulated_cancellation','workspaces',w,null,requestId);return w;}
  if(action==='membership.event') {admin(u);fail(['renewed','payment_failed'].includes(data.event),'Invalid billing event.');const w=workspace(s,u),before={...w};w.subscription=data.event==='renewed'?'active':'past_due';if(data.event==='renewed')w.renewalAt=new Date(Date.now()+30*86400000).toISOString();log(s,u,`membership.simulated_${data.event}`,'workspaces',w,before,requestId);return w;}
  if(action==='member.add') {
    admin(u);fail(isProvider(u)||workspace(s,u).subscription==='active','Activate membership first.',403);fail(['admin','member','guest'].includes(data.role),'Invalid role.');if(data.role!=='guest')quota(s,u,'seats');else fail(seatUsage(s,u.workspaceId).guests+seatUsage(s,u.workspaceId).reservedGuests<effectivePlan(s,workspace(s,u)).guests,'Your plan guest limit has been reached.',409);
    fail(typeof data.name==='string'&&data.name.trim()&&data.name.length<=100,'Enter a name.');fail(typeof data.email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email),'Enter a valid email.');
    fail(!s.users.some(x=>x.email.toLowerCase()===data.email.toLowerCase()),'This sample email is already registered.');
    const r={id:id(),workspaceId:u.workspaceId,name:data.name.trim(),email:data.email.toLowerCase(),role:data.role,initials:data.name.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase()};s.users.push(r);log(s,u,'member.added_locally','users',{...r,title:r.name},null,requestId);return r;
  }
  if(action==='member.update') {
    admin(u);const r=record(s,u,'users',rid);fail(r.id!==u.id,'You cannot change your own access.');fail(r.id!==workspace(s,u).ownerId||isProvider(u),'Only the provider can change the organization owner’s access.',403);fail(r.id!==workspace(s,u).ownerId||(!data.disabled&&data.role==='admin'),'Transfer organization ownership before disabling or demoting its owner.');fail(['admin','member','guest'].includes(data.role),'Invalid role.');const before={...r};
    if((r.role==='guest'||r.disabled)&&data.role!=='guest'&&!data.disabled)quota(s,u,'seats');if((r.role!=='guest'||r.disabled)&&data.role==='guest'&&!data.disabled)fail(seatUsage(s,u.workspaceId).guests+seatUsage(s,u.workspaceId).reservedGuests<effectivePlan(s,workspace(s,u)).guests,'Your plan guest limit has been reached.',409);if(data.name!==undefined){fail(typeof data.name==='string'&&data.name.trim()&&data.name.length<=100,'Enter a name.');r.name=data.name.trim();r.initials=r.name.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase();}r.role=data.role;r.disabled=!!data.disabled;log(s,u,'member.permissions_changed','users',{...r,title:r.name},before,requestId);return r;
  }
  if(action==='invitation.create') {
    admin(u);fail(isProvider(u)||workspace(s,u).subscription==='active','Activate membership first.',403);
    fail(['admin','member','guest'].includes(data.role),'Invalid organization role.');
    fail(typeof data.name==='string'&&data.name.trim()&&data.name.length<=100,'Enter a name.');
    fail(typeof data.email==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email),'Enter a valid email.');
    fail(!s.users.some(x=>x.email.toLowerCase()===data.email.toLowerCase()),'This email already belongs to a local identity.');
    fail(!pendingInvitations(s,u.workspaceId).some(i=>i.email===data.email.toLowerCase()),'An invitation is already pending for this email.',409);
    if(data.role!=='guest')quota(s,u,'seats');else fail(seatUsage(s,u.workspaceId).guests+seatUsage(s,u.workspaceId).reservedGuests<effectivePlan(s,workspace(s,u)).guests,'Your plan guest limit has been reached.',409);
    s.invitations||=[];const token=randomBytes(24).toString('hex');
    const r={id:id(),workspaceId:u.workspaceId,name:data.name.trim(),email:data.email.toLowerCase(),role:data.role,status:'pending',tokenHash:tokenDigest(token),createdBy:u.id,createdAt:at,expiresAt:new Date(Date.now()+7*86400000).toISOString()};
    s.invitations.push(r);log(s,u,'invitation.created','invitations',{id:r.id,title:r.email,role:r.role,expiresAt:r.expiresAt},null,requestId);const{tokenHash,...out}=r;return {...out,token};
  }
  if(action==='invitation.cancel') {admin(u);const r=record(s,u,'invitations',rid);fail(r.status==='pending','Invitation is no longer pending.');r.status='cancelled';log(s,u,'invitation.cancelled','invitations',{id:r.id,title:r.email},null,requestId);return {ok:true};}
  if(action==='bulk.import') {
    admin(u);entitled(s,u,'import');fail(Array.isArray(data.rows)&&data.rows.length>0&&data.rows.length<=200,'Import between 1 and 200 rows.');quota(s,u,'artworks',data.rows.length);
    const rows=data.rows.map(row=>act(s,u,{action:'save',entity:'artworks',data:{title:String(row.title||''),artist:String(row.artist||''),medium:String(row.medium||''),dimensions:String(row.dimensions||''),price:Number(row.price),location:String(row.location||''),description:String(row.description||''),image:'/art/quiet.svg'}},requestId));log(s,u,'inventory.bulk_imported','artworks',{id:id(),title:`${rows.length} artworks`},null,requestId);return {count:rows.length};
  }
  if(action==='bulk.location') {staff(u);entitled(s,u,'artworks');fail(Array.isArray(data.ids)&&data.ids.length>0&&data.ids.length<=200,'Select 1–200 artworks.');fail(typeof data.location==='string'&&data.location.trim()&&data.location.length<=200,'Enter a location.');const rows=data.ids.map(aid=>record(s,u,'artworks',aid));for(const r of rows){const before={...r};r.location=data.location.trim();r.updatedAt=at;log(s,u,'artwork.location_updated','artworks',r,before,requestId);}return {count:rows.length};}
  throw new AppError('Unknown action.');
}

export function upload(s,u,{name,mime,data}) {
  fail(isProvider(u)||(workspace(s,u).status!=='suspended'&&workspace(s,u).subscription==='active'),'Activate membership first.',403);
  if(u.role==='guest')fail(s.rooms.some(r=>r.workspaceId===u.workspaceId&&!r.deletedAt&&r.memberIds.includes(u.id)&&r.status==='Active')&&allowed(s,u,'rooms'),'You need an active invited room.',403);
  fail(typeof name==='string'&&name.length>0&&name.length<200,'Invalid file name.');
  fail(['application/pdf','image/jpeg','image/png','image/webp'].includes(mime),'Use a PDF, JPEG, PNG, or WebP file.');
  fail(typeof data==='string'&&data.length<=14e6&&/^[A-Za-z0-9+/]*={0,2}$/.test(data),'Invalid file data.');
  const bytes=Buffer.from(data,'base64');fail(bytes.length>0&&bytes.length<=10*1024*1024,'Files must be between 1 byte and 10 MB.');
  const valid = mime==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';fail(valid,'The file content does not match its type.');
  quota(s,u,'storageMB',bytes.length/1024/1024);
  const r={id:id(),workspaceId:u.workspaceId,name:name.replace(/[\\/\r\n]/g,'_'),mime,size:bytes.length,data,createdBy:u.id,createdAt:new Date().toISOString()};s.files.push(r);log(s,u,'file.uploaded','files',{...r,title:r.name});const{data:_,...meta}=r;return meta;
}

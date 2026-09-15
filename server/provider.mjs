import {AppError,act,id,log,usage,tokenDigest} from './domain.mjs';
import {initializePlatform,providerIdentity,providerPrincipal,publicIdentity,effectivePlan,catalogPlans,seatUsage,pendingInvitations} from './access.mjs';

const requireValue=(ok,message,status=400)=>{if(!ok)throw new AppError(message,status);};
const limitKeys=['seats','guests','artworks','catalogs','storageMB','rooms','generations'];
const featureKeys=['inventory','collections','catalogs','customers','inquiries','tasks','invoices','payments','reservations','deliveries','reports','conversations','rooms','audit','import'];
const text=(v,max=100)=>typeof v==='string'&&v.trim().length>0&&v.trim().length<=max;
function provider(s,identity){const p=providerIdentity(s,identity?.id);requireValue(p,'Provider access is required.',403);return p;}
function audit(s,p,action,row,before=null,workspaceId='platform'){
  const principal=workspaceId==='platform'?{...p,workspaceId,role:'admin'}:providerPrincipal(s,p,workspaceId,'console','Provider organization management');
  log(s,principal,action,workspaceId==='platform'?'platform':'workspaces',row,before);
  Object.assign(s.audit.at(-1),{actorType:'provider'});
}
function limits(data,partial=false){const result={};for(const key of limitKeys){if(partial&&!Object.hasOwn(data,key))continue;requireValue(Number.isFinite(data[key])&&Number.isInteger(data[key])&&data[key]>=(key==='seats'?1:0)&&data[key]<=1000000,`Enter a valid ${key} allowance.`);result[key]=data[key];}return result;}
export function providerState(s,identity){
  const p=provider(s,identity);
  return {kind:'provider',user:publicIdentity(p),organizations:s.workspaces.map(w=>({
    ...w,owner:s.users.find(u=>u.id===w.ownerId)?.name||'Owner not assigned',
    usage:usage(s,{workspaceId:w.id}),team:seatUsage(s,w.id),limits:effectivePlan(s,w),
    employeeCount:s.users.filter(u=>u.workspaceId===w.id&&!u.disabled&&u.role!=='guest').length,
    messageCount:s.messages.filter(m=>m.workspaceId===w.id&&!m.deletedAt).length
  })),plans:catalogPlans(s),planVersions:s.planVersions,accounts:s.providerAccounts.map(publicIdentity),
  audit:s.audit.slice(-2000).reverse().map(e=>({...e,organization:s.workspaces.find(w=>w.id===e.workspaceId)?.name||'Platform'})),
  serverTime:new Date().toISOString()};
}
export function providerAction(s,identity,{action,entityId,data={}}){
  const p=provider(s,identity);
  if(action==='organization.create'){
    requireValue(text(data.name),'Enter an organization name.');
    requireValue(text(data.ownerName),'Enter the owner’s name.');
    requireValue(typeof data.email==='string'&&/^\S+@\S+\.\S+$/.test(data.email),'Enter a valid owner email.');
    requireValue(!s.users.some(u=>u.email.toLowerCase()===data.email.toLowerCase()),'This email is already registered.');
    const plan=catalogPlans(s)[data.plan];requireValue(plan,'Choose a plan.');
    const wid=id(),owner={id:id(),workspaceId:wid,name:data.ownerName.trim(),email:data.email.toLowerCase(),role:'admin',initials:data.ownerName.trim().split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase()};
    const w={id:wid,name:data.name.trim(),ownerId:owner.id,kind:['Studio','Store','Organization'].includes(data.kind)?data.kind:'Organization',plan:plan.name,planVersionId:plan.id,status:'active',subscription:'active',generations:0,generationMonth:new Date().toISOString().slice(0,7),createdAt:new Date().toISOString()};
    s.workspaces.push(w);s.users.push(owner);audit(s,p,'provider.organization_created',w,null,w.id);return w;
  }
  if(action==='organization.update'){
    const w=s.workspaces.find(w=>w.id===entityId);requireValue(w,'Organization not found.',404);const before=structuredClone(w);
    requireValue(text(data.reason,500),'Enter a reason for this change.');
    if(data.name!==undefined){requireValue(text(data.name),'Enter an organization name.');w.name=data.name.trim();}
    if(data.status!==undefined){requireValue(['active','suspended'].includes(data.status),'Invalid organization status.');w.status=data.status;}
    if(data.subscription!==undefined){requireValue(['active','pending','past_due','cancelled'].includes(data.subscription),'Invalid subscription status.');w.subscription=data.subscription;}
    if(data.planVersionId!==undefined){const plan=s.planVersions.find(p=>p.id===data.planVersionId);requireValue(plan,'Plan version not found.');w.plan=plan.name;w.planVersionId=plan.id;}
    if(data.ownerId!==undefined){const owner=s.users.find(u=>u.id===data.ownerId&&u.workspaceId===w.id&&!u.disabled&&u.role==='admin');requireValue(owner,'Choose an active organization admin as owner.');w.ownerId=owner.id;}
    if(data.clearOverride)delete w.allowanceOverride;
    else if(data.limits){requireValue(!data.expiresAt||Number.isFinite(Date.parse(data.expiresAt))&&Date.parse(data.expiresAt)>Date.now(),'Override expiry must be in the future.');w.allowanceOverride={limits:limits(data.limits,true),reason:data.reason.trim(),expiresAt:data.expiresAt||null,grantedBy:p.id,at:new Date().toISOString()};}
    w.updatedAt=new Date().toISOString();audit(s,p,'provider.organization_updated',{...w,reason:data.reason.trim()},before,w.id);return w;
  }
  if(action==='plan.save'){
    const old=s.planVersions.find(v=>v.id===entityId);requireValue(old,'Plan not found.',404);
    requireValue(text(data.reason,500),'Enter a reason for the plan change.');
    const nextLimits=limits(data);requireValue(Array.isArray(data.features)&&data.features.every(f=>featureKeys.includes(f)),'Invalid plan features.');
    const version=Math.max(...s.planVersions.filter(v=>v.name===old.name).map(v=>v.version))+1;
    const plan={id:id(),name:old.name,version,...nextLimits,features:[...new Set([...data.features,'audit'])],current:true,createdAt:new Date().toISOString()};
    s.planVersions.filter(v=>v.name===old.name).forEach(v=>v.current=false);s.planVersions.push(plan);
    audit(s,p,'provider.plan_version_created',{...plan,title:`${plan.name} · version ${version}`,reason:data.reason},old);return plan;
  }
  if(action==='provider.add'){
    requireValue(p.providerRole==='owner','Only the provider owner can manage provider staff.',403);
    requireValue(text(data.name)&&typeof data.email==='string'&&/^\S+@\S+\.\S+$/.test(data.email),'Enter a name and valid email.');
    requireValue(!s.providerAccounts.some(u=>u.email.toLowerCase()===data.email.toLowerCase()),'Provider email already exists.');
    const user={id:id(),name:data.name.trim(),email:data.email.toLowerCase(),providerRole:'super_admin',initials:data.name.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase()};s.providerAccounts.push(user);audit(s,p,'provider.account_created',{...user,title:user.name});return publicIdentity(user);
  }
  if(action==='provider.update'){
    requireValue(p.providerRole==='owner','Only the provider owner can manage provider staff.',403);
    const user=s.providerAccounts.find(u=>u.id===entityId);requireValue(user&&user.id!==p.id&&user.providerRole!=='owner','The provider owner cannot be disabled here.');
    const before={...user};requireValue(typeof data.disabled==='boolean','Choose an access status.');user.disabled=data.disabled;audit(s,p,'provider.account_updated',{...user,title:user.name},before);return publicIdentity(user);
  }
  throw new AppError('Unknown provider action.');
}
export function invitationInfo(s,token){
  const inv=s.invitations.find(i=>i.tokenHash===tokenDigest(token)&&i.status==='pending'&&Date.parse(i.expiresAt)>Date.now());
  requireValue(inv,'This invitation has expired, was cancelled or has already been used.',404);
  const w=s.workspaces.find(w=>w.id===inv.workspaceId);requireValue(w&&w.status!=='suspended'&&w.subscription==='active','This organization cannot accept members right now.',403);
  return {inv,w};
}
export function acceptInvitation(s,token){
  const{inv,w}=invitationInfo(s,token),seats=seatUsage(s,w.id),plan=effectivePlan(s,w);
  requireValue(inv.role==='guest'?seats.guests+seats.reservedGuests<=plan.guests:seats.active+seats.reserved<=plan.seats,'The organization is over its current plan allowance. Ask an admin to resolve it.',409);
  requireValue(!s.users.some(u=>u.email.toLowerCase()===inv.email),'This email already belongs to an identity.',409);
  const user={id:id(),name:inv.name,email:inv.email,role:inv.role,workspaceId:w.id,initials:inv.name.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase()};
  s.users.push(user);inv.status='accepted';inv.acceptedAt=new Date().toISOString();inv.acceptedBy=user.id;
  log(s,user,'invitation.accepted','invitations',{id:inv.id,title:inv.email});return user;
}

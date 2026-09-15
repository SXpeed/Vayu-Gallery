import { plans } from './seed.mjs';

// This marker can only be minted by the server. JSON role flags never grant provider access.
const providerContext = Symbol('verified-provider-context');
export const isProvider = user => user?.[providerContext] === true;
export const publicIdentity = ({passwordHash,passwordSalt,token,...user}) => user;
export function initializePlatform(s) {
  s.providerAccounts ||= [{id:'provider-owner',name:'Vayu Provider',email:'provider@example.test',providerRole:'owner',initials:'VP'}];
  s.planVersions ||= Object.entries(plans).map(([name,limits])=>({id:`initial-${name}`,name,version:1,...structuredClone(limits),guests:25,createdAt:new Date().toISOString(),current:true}));
  s.invitations ||= [];
  s.messageRevisions ||= [];
  for(const w of s.workspaces) {
    w.status ||= 'active';
    w.ownerId ||= s.users.find(u=>u.workspaceId===w.id&&u.role==='admin'&&!u.disabled)?.id;
    w.planVersionId ||= s.planVersions.find(p=>p.name===w.plan&&p.current)?.id;
  }
  s.schema = Math.max(s.schema||1,2);
  return s;
}
export function providerIdentity(s,id) {return s.providerAccounts?.find(p=>p.id===id&&!p.disabled&&['owner','super_admin'].includes(p.providerRole));}
export function providerPrincipal(s,identity,workspaceId,accessId,reason='Organization management') {
  const p=providerIdentity(s,identity?.id),w=s.workspaces.find(w=>w.id===workspaceId);
  if(!p||!w)return null;
  return {...publicIdentity(p),role:'admin',workspaceId,accessId,reason,[providerContext]:true};
}
export function catalogPlans(s) {
  return s.planVersions ? Object.fromEntries(s.planVersions.filter(p=>p.current).map(p=>[p.name,p])) : plans;
}
export function effectivePlan(s,w) {
  const base=s.planVersions?.find(p=>p.id===w?.planVersionId)||catalogPlans(s)[w?.plan]||plans.Starter;
  const override=w?.allowanceOverride;
  return {...base,guests:base.guests??25,...(override&&(!override.expiresAt||Date.parse(override.expiresAt)>Date.now())?override.limits:{})};
}
export function pendingInvitations(s,workspaceId) {return (s.invitations||[]).filter(i=>i.workspaceId===workspaceId&&i.status==='pending'&&Date.parse(i.expiresAt)>Date.now());}
export function seatUsage(s,workspaceId) {
  const members=s.users.filter(u=>u.workspaceId===workspaceId&&!u.disabled),pending=pendingInvitations(s,workspaceId);
  return {active:members.filter(u=>u.role!=='guest').length,reserved:pending.filter(i=>i.role!=='guest').length,guests:members.filter(u=>u.role==='guest').length,reservedGuests:pending.filter(i=>i.role==='guest').length};
}

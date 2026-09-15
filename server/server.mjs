import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeSeed, plans } from './seed.mjs';
import {initializePlatform,providerIdentity,providerPrincipal,isProvider,publicIdentity,catalogPlans} from './access.mjs';
import {providerState,providerAction,invitationInfo,acceptInvitation} from './provider.mjs';
import { act, AppError, visibleState, canReadFile, upload, expireReservations, log, id } from './domain.mjs';

export function createAppServer({ root, fallback, memory = false } = {}) {
  const folder=path.join(root||process.cwd(),'.local-data');if(!memory)mkdirSync(path.join(folder,'backups'),{recursive:true});
  const db=new DatabaseSync(memory?':memory:':path.join(folder,'vayu.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);');
  const get=()=>initializePlatform(JSON.parse(db.prepare('SELECT document FROM state WHERE id=1').get().document));
  const save=s=>db.prepare('INSERT OR REPLACE INTO state(id,document) VALUES(1,?)').run(JSON.stringify(s));
  if(!db.prepare('SELECT id FROM state').get())save(makeSeed());
  save(get());
  const sessions=new Map();
  const timer=setInterval(()=>{const s=get();const old=s.audit.length+s.notifications.length;expireReservations(s);if(s.audit.length+s.notifications.length!==old)save(s);},30000);timer.unref();
  const send=(res,status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(data));};
  const json=async req=>{let str='';for await(const b of req){str+=b;if(str.length>15e6)throw new AppError('Request exceeds the 10 MB file limit.',413);}try{return JSON.parse(str||'{}');}catch{throw new AppError('Invalid JSON.');}};
  const setSession=(res,userId,kind='organization')=>{const token=randomBytes(32).toString('hex');sessions.set(token,{userId,kind,accessId:randomBytes(16).toString('hex'),expires:Date.now()+8*3600000});res.setHeader('Set-Cookie',`vayu_local_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);};
  const backup=s=>{if(memory)return 'memory-backup';const name=`backup-${Date.now()}-${randomBytes(3).toString('hex')}.json`;writeFileSync(path.join(folder,'backups',name),JSON.stringify(s));return name;};
  if(!memory)backup(get());
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(!url.pathname.startsWith('/api/'))return fallback?fallback(req,res,()=>{res.writeHead(404);res.end('Not found');}):send(res,404,{error:'Not found'});
    let u=null,s=null;
    try {
      // Local service never accepts cross-origin writes and never binds a public interface.
      const origin=req.headers.origin;
      if(origin && new URL(origin).host!==req.headers.host)throw new AppError('Cross-origin access is not allowed.',403);
      // Parse before reading state: mutations below run synchronously against the latest snapshot.
      // Reading before awaiting a request body would let concurrent writes overwrite each other.
      const payload=req.method==='POST'?await json(req):undefined;
      s=get();expireReservations(s);
      const token=(req.headers.cookie||'').split('; ').find(x=>x.startsWith('vayu_local_session='))?.split('=')[1];
      const session=sessions.get(token);
      const providerMode=session?.kind==='provider'&&session.expires>Date.now();
      const identity=session&&session.expires>Date.now()?(providerMode?providerIdentity(s,session.userId):s.users.find(x=>x.id===session.userId&&!x.disabled)):null;
      u=providerMode&&session.workspaceId&&identity?providerPrincipal(s,identity,session.workspaceId,session.accessId):identity;
      const currentState=()=>({...providerMode&&!session.workspaceId?providerState(s,identity):visibleState(s,u),apiScope:session.accessId});
      if(url.pathname==='/api/session'&&req.method==='GET')return send(res,200,{user:u?publicIdentity(u):null,provider:!!providerMode,demo:true,profiles:s.users.filter(x=>!x.disabled).map(({id,name,role,workspaceId})=>({id,name,role,workspaceId})),providerProfiles:s.providerAccounts.filter(x=>!x.disabled).map(publicIdentity),plans:catalogPlans(s)});
      if(url.pathname==='/api/login'&&req.method==='POST') {
        const body=payload;const user=s.users.find(x=>x.id===body.userId&&!x.disabled);if(!user)throw new AppError('Sample profile not found.',404);setSession(res,user.id);log(s,user,'session.demo_login','users',{id:user.id,title:user.name});save(s);return send(res,200,{ok:true});
      }
      if(url.pathname==='/api/provider/login'&&req.method==='POST') {const p=providerIdentity(s,payload.userId);if(!p)throw new AppError('Provider sample profile not found.',404);setSession(res,p.id,'provider');log(s,{...p,workspaceId:'platform'},'provider.demo_login','platform',{id:p.id,title:p.name});s.audit.at(-1).actorType='provider';save(s);return send(res,200,{ok:true});}
      if(url.pathname==='/api/invitation'&&req.method==='POST') {const {inv,w}=invitationInfo(s,payload.token);return send(res,200,{name:inv.name,email:inv.email,role:inv.role,organization:w.name,expiresAt:inv.expiresAt});}
      if(url.pathname==='/api/invitation/accept'&&req.method==='POST') {const user=acceptInvitation(s,payload.token);save(s);setSession(res,user.id);return send(res,200,{ok:true});}
      if(url.pathname==='/api/register'&&req.method==='POST') {
        const body=payload;if(!body.name?.trim()||!body.workspace?.trim()||!/^\S+@\S+\.\S+$/.test(body.email)||!catalogPlans(s)[body.plan])throw new AppError('Enter a name, email, workspace, and plan.');
        if(s.users.some(x=>x.email.toLowerCase()===body.email.toLowerCase()))throw new AppError('That sample email is already registered.');
        const wid=id(),user={id:id(),name:body.name.slice(0,100),email:body.email.toLowerCase(),workspaceId:wid,role:'admin',initials:body.name.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase()};
        s.workspaces.push({id:wid,name:body.workspace.slice(0,100),ownerId:user.id,status:'active',plan:body.plan,planVersionId:catalogPlans(s)[body.plan].id,subscription:'pending',generations:0,generationMonth:new Date().toISOString().slice(0,7)});s.users.push(user);log(s,user,'workspace.created','workspaces',{id:wid,title:body.workspace});save(s);setSession(res,user.id);return send(res,200,{ok:true});
      }
      if(url.pathname==='/api/logout'&&req.method==='POST'){sessions.delete(token);res.setHeader('Set-Cookie','vayu_local_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(res,200,{ok:true});}
      const shared=url.pathname.match(/^\/api\/shared\/([a-f0-9]{48})$/);
      if(shared&&req.method==='GET') {
        const share=s.shares.find(x=>x.token===shared[1]&&!x.revokedAt&&Date.parse(x.expiresAt)>Date.now());const cat=share&&s.workspaces.some(w=>w.id===share.workspaceId&&w.status!=='suspended')&&s.catalogs.find(c=>c.id===share.catalogId&&!c.deletedAt);
        const file=cat&&s.files.find(f=>f.id===share.fileId&&f.workspaceId===share.workspaceId);if(!file)throw new AppError('This catalog link has expired or was revoked.',404);
        const bytes=Buffer.from(file.data,'base64');res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':bytes.length,'Content-Disposition':'inline; filename="catalog.pdf"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});return res.end(bytes);
      }
      if(!u)throw new AppError('Sign in to a local sample profile.',401);
      if(url.pathname.startsWith('/api/provider/')) {
        if(!providerMode||!identity)throw new AppError('Provider access is required.',403);
        if(req.method==='POST'&&req.headers['x-vayu-context']!==session.accessId)throw new AppError('Your organization context changed. Refresh and retry.',409);
        if(url.pathname==='/api/provider/state'&&req.method==='GET')return send(res,200,{...providerState(s,identity),apiScope:session.accessId});
        if(url.pathname==='/api/provider/action'&&req.method==='POST'){const result=providerAction(s,identity,payload);save(s);return send(res,200,{result,state:{...providerState(s,identity),apiScope:session.accessId}});}
        if(url.pathname==='/api/provider/enter'&&req.method==='POST'){
          if(!s.workspaces.some(w=>w.id===payload.workspaceId))throw new AppError('Organization not found.',404);
          session.workspaceId=payload.workspaceId;session.accessId=randomBytes(16).toString('hex');u=providerPrincipal(s,identity,session.workspaceId,session.accessId);
          log(s,u,'provider.organization_entered','workspaces',{id:u.workspaceId,title:s.workspaces.find(w=>w.id===u.workspaceId).name});save(s);return send(res,200,{state:currentState()});
        }
        if(url.pathname==='/api/provider/exit'&&req.method==='POST'){if(session.workspaceId)log(s,u,'provider.organization_left','workspaces',{id:session.workspaceId,title:'Provider console'});delete session.workspaceId;session.accessId=randomBytes(16).toString('hex');save(s);return send(res,200,{state:currentState()});}
        throw new AppError('Provider endpoint not found.',404);
      }
      if(providerMode&&!session.workspaceId&&url.pathname!=='/api/state')throw new AppError('Select an organization in the provider console.',400);
      if(providerMode&&req.method==='POST'&&req.headers['x-vayu-context']!==session.accessId)throw new AppError('Your organization context changed. Refresh and retry.',409);
      if(!providerMode&&s.workspaces.find(w=>w.id===u.workspaceId)?.status==='suspended'&&url.pathname!=='/api/state')throw new AppError('This organization is suspended. Contact the provider.',403);
      if(url.pathname==='/api/state'&&req.method==='GET') {if(isProvider(u))log(s,u,'provider.organization_data_viewed','workspaces',{id:u.workspaceId,title:'Organization records'});save(s);return send(res,200,currentState());}
      if(url.pathname==='/api/action'&&req.method==='POST') {const result=act(s,u,payload);save(s);return send(res,200,{result,state:currentState()});}
      if(url.pathname==='/api/upload'&&req.method==='POST') {const result=upload(s,u,payload);save(s);return send(res,200,result);}
      const fileMatch=url.pathname.match(/^\/api\/files\/([a-z0-9-]+)$/);
      if(fileMatch&&req.method==='GET') {
        if(!canReadFile(s,u,fileMatch[1]))throw new AppError('File not found or access denied.',404);
        const file=s.files.find(f=>f.id===fileMatch[1]);const bytes=Buffer.from(file.data,'base64');
        log(s,u,'file.accessed','files',{id:file.id,title:file.name});save(s);
        res.writeHead(200,{'Content-Type':file.mime,'Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`${url.searchParams.has('download')?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`});return res.end(bytes);
      }
      if(url.pathname==='/api/export'&&req.method==='GET') {
        if(u.role!=='admin')throw new AppError('Only admins can export workspace data.',403);
        log(s,u,'workspace.exported','workspaces',{id:u.workspaceId,title:'Workspace data export'});save(s);const out=visibleState(s,u);delete out.plans;
        return send(res,200,out,{'Content-Disposition':'attachment; filename="vayu-workspace-export.json"'});
      }
      if(url.pathname==='/api/backups'&&req.method==='GET') {
        if(u.role!=='admin')throw new AppError('Only admins can access backups.',403);
        const rows=memory?[]:readdirSync(path.join(folder,'backups')).filter(n=>/^backup-\d+-[a-f0-9]+\.json$/.test(n)).map(name=>({name,createdAt:new Date(Number(name.split('-')[1])).toISOString()})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));return send(res,200,rows);
      }
      if(url.pathname==='/api/backups'&&req.method==='POST') {if(u.role!=='admin')throw new AppError('Only admins can create backups.',403);const name=backup(s);log(s,u,'backup.created','workspaces',{id:u.workspaceId,title:name});save(s);return send(res,200,{name});}
      if(url.pathname==='/api/backups/restore'&&req.method==='POST') {
        if(u.role!=='admin')throw new AppError('Only admins can restore backups.',403);const {name}=payload;
        if(memory||!/^backup-\d+-[a-f0-9]+\.json$/.test(name)||!existsSync(path.join(folder,'backups',name)))throw new AppError('Backup not found.',404);
        const old=JSON.parse(readFileSync(path.join(folder,'backups',name),'utf8'));if(!old.workspaces.some(w=>w.id===u.workspaceId))throw new AppError('This backup predates your workspace.');
        backup(s);
        const privateAccess=new Map([...s.rooms,...s.conversations].filter(x=>x.workspaceId===u.workspaceId).map(x=>[x.id,{memberIds:x.memberIds,deletedAt:x.deletedAt,status:x.status}]));
        for(const key of Object.keys(s))if(Array.isArray(s[key])&&!['audit','users','workspaces','providerAccounts','planVersions','invitations','messageRevisions'].includes(key)) {
          const restored=(old[key]||[]).filter(x=>x.workspaceId===u.workspaceId).map(x=>{
            if(['rooms','conversations'].includes(key)) {const access=privateAccess.get(x.id);return {...x,memberIds:access?.memberIds||[],deletedAt:access?.deletedAt||(!access?new Date().toISOString():x.deletedAt),...(access?.status?{status:access.status}:{})};}
            // Recovery never republishes bearer links. Admins can create fresh links deliberately.
            if(key==='shares')return {...x,revokedAt:new Date().toISOString()};
            return x;
          });
          s[key]=[...s[key].filter(x=>x.workspaceId!==u.workspaceId),...restored];
        }
        // Do not restore permissions, active memberships, or erase audit history.
        log(s,u,'backup.restored','workspaces',{id:u.workspaceId,title:name});save(s);return send(res,200,{ok:true});
      }
      throw new AppError('Endpoint not found.',404);
    } catch(e) {
      if(u&&s) {const fresh=get();fresh.audit.push({id:id(),workspaceId:u.workspaceId,actorId:u.id,actorName:u.name,action:'request.rejected',entity:'system',title:e.message,at:new Date().toISOString(),changes:[],outcome:'failed',requestId:id()});save(fresh);}
      send(res,e.status||500,{error:e.status?e.message:'Local service error. Please retry.'});if(!e.status)console.error(e);
    }
  });
  server.on('close',()=>{clearInterval(timer);db.close();});return server;
}

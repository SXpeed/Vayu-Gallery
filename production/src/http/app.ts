import { Hono, type Context } from 'hono';
import { getCookie,setCookie,deleteCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { z,ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Config } from '../core/config.js';
import { type Database,type SQL,type Scope,authenticated,rateLimit,setScope } from '../core/database.js';
import { hash,token,encrypt } from '../core/crypto.js';
import { AppError,requireValue } from '../core/errors.js';
import type { IdentityService } from '../modules/auth/service.js';
import type { ObjectStore } from '../modules/storage/s3.js';
import * as media from '../modules/storage/service.js';
import * as gallery from '../modules/gallery/service.js';
import { isResource,resources } from '../modules/gallery/resources.js';
import { generate } from '../modules/catalogs/service.js';
import { renderWebsite } from '../modules/website/render.js';
import { domainToASCII } from 'node:url';
import { registerCatalogRoutes,type CatalogTenant } from './catalog-routes.js';
import { registerInvoiceRoutes } from './invoice-routes.js';

export interface Dependencies {config:Config;db:Database;identity:IdentityService;storage:ObjectStore;log?:(event:Record<string,unknown>)=>void}
type Env={Variables:{requestId:string}};
const uuid=(s:string|undefined)=>z.uuid().parse(s);
const version=(c:Context)=>z.coerce.number().int().positive().parse(c.req.header('If-Match')?.replace(/^"|"$/g,''));
const mutation=(method:string)=>!['GET','HEAD','OPTIONS'].includes(method);
const json=async(c:Context)=>{try{return await c.req.json();}catch{throw new AppError('INVALID_JSON','Supply a valid JSON body');}};

export function createApp({config,db,identity,storage,log=event=>process.stdout.write(`${JSON.stringify(event)}\n`)}:Dependencies) {
 const app=new Hono<Env>();
 const secure=config.APP_ORIGIN.startsWith('https:'),sessionName=secure?'__Host-vayu-session':'vayu-session',csrfName=secure?'__Host-vayu-csrf':'vayu-csrf',loginName=secure?'__Host-vayu-login':'vayu-login';
 const cookie={httpOnly:true,secure,sameSite:'Lax' as const,path:'/' as const};
 const scope=(c:Context,tenantId?:string):Scope=>({sessionHash:hash(getCookie(c,sessionName)||''),requestId:c.get('requestId'),tenantId,
   providerAccessId:c.req.header('X-Provider-Access')?uuid(c.req.header('X-Provider-Access')):undefined,
   ...(mutation(c.req.method)?{csrfHash:hash(c.req.header('X-CSRF-Token')||'')}:{})});
 const tenant:CatalogTenant=(c,fn,options)=>{const t=uuid(c.req.param('tenant'));return authenticated(db,{...scope(c,t),...(options?.providerAccessId?{providerAccessId:uuid(options.providerAccessId)}:{})},sql=>fn(sql,t));};
 app.use('*',secureHeaders({contentSecurityPolicy:{defaultSrc:["'none'"],styleSrc:["'self'","'unsafe-inline'"],scriptSrc:["'self'"],imgSrc:["'self'",'data:','blob:'],connectSrc:["'self'",new URL(config.STORAGE_ENDPOINT).origin],fontSrc:["'self'"],baseUri:["'none'"],formAction:["'self'"],frameAncestors:["'none'"]},referrerPolicy:'no-referrer'}));
 app.use('*',async(c,next)=>{
   const id=randomUUID(),start=Date.now();c.set('requestId',id);c.header('X-Request-ID',id);c.header('Cache-Control','no-store');
   try{await next();}finally{log({event:'http.request',requestId:id,method:c.req.method,route:c.req.routePath||'unmatched',status:c.res.status,durationMs:Date.now()-start});}
 });
 app.use('*',bodyLimit({maxSize:1024*1024,onError:c=>c.json({error:{code:'BODY_TOO_LARGE',message:'Request exceeds 1 MB'}},413)}));
 app.use('/api/*',async(c,next)=>{
   if(mutation(c.req.method)) {
     if(c.req.header('Origin')!==config.APP_ORIGIN)throw new AppError('ORIGIN','Request origin denied',403);
     if(!c.req.header('Content-Type')?.startsWith('application/json'))throw new AppError('CONTENT_TYPE','Use application/json');
   }
   if(!c.req.path.startsWith('/api/public/')) {
     const who=await db.transaction(async sql=>{await setScope(sql,scope(c));return (await sql.query('SELECT security.user_id() AS id')).rows[0]?.id;});
     await rateLimit(db,who?`user:${who}`:'anonymous',who?300:1000,60);
   }
   await next();
 });
 app.get('/health/live',c=>c.json({status:'ok'}));
 app.get('/health/ready',async c=>{await db.transaction(sql=>sql.query('SELECT 1'));return c.json({status:'ready'});});
 app.get('/auth/login',async c=>{
   await rateLimit(db,'login-global',1000,60);
   const result=await identity.begin();setCookie(c,loginName,result.browser,{...cookie,maxAge:600});return c.redirect(result.url);
 });
 app.get('/auth/callback',async c=>{
   const callback=new URL(`${config.APP_ORIGIN}/auth/callback`);callback.search=new URL(c.req.url).search;
   const result=await identity.callback(callback,getCookie(c,loginName));
   deleteCookie(c,loginName,{...cookie});setCookie(c,sessionName,result.sessionToken,{...cookie,maxAge:8*3600});
   setCookie(c,csrfName,result.csrf,{...cookie,httpOnly:false,maxAge:8*3600});return c.redirect('/');
 });
 app.get('/api/session',async c=>c.json(await authenticated(db,scope(c),async sql=>(await sql.query('SELECT security.session_info() AS session')).rows[0]!.session)));
 app.post('/api/logout',async c=>{
   await authenticated(db,scope(c),sql=>sql.query('SELECT security.revoke_session()'));
   deleteCookie(c,sessionName,cookie);deleteCookie(c,csrfName,{...cookie,httpOnly:false});return c.json({ok:true});
 });
 app.post('/api/organizations',async c=>{
   const body=z.object({name:z.string().trim().min(2).max(120),slug:z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)}).strict().parse(await json(c));
   return c.json(await authenticated(db,scope(c),async sql=>(await sql.query('SELECT security.create_organization($1,$2) AS id',[body.name,body.slug])).rows[0]),201);
 });
 app.get('/api/provider/organizations',async c=>c.json(await authenticated(db,scope(c),async sql=>{
   if(!(await sql.query('SELECT security.provider() AS allowed')).rows[0]?.allowed)throw new AppError('PROVIDER_MFA','Recent provider MFA is required',403);
   return {items:(await sql.query('SELECT id,name,slug,status,created_at FROM control.organizations ORDER BY created_at DESC LIMIT 100')).rows};
 })));
 app.post('/api/provider/access',async c=>{
   const body=z.object({tenantId:z.uuid(),reason:z.string().trim().min(8).max(500)}).strict().parse(await json(c));
   return c.json(await authenticated(db,scope(c),async sql=>(await sql.query('SELECT security.open_provider_access($1,$2) AS id',[body.tenantId,body.reason])).rows[0]),201);
 });
 app.post('/api/provider/access/:id/close',async c=>{await authenticated(db,scope(c),sql=>sql.query('SELECT security.close_provider_access($1)',[uuid(c.req.param('id'))]));return c.json({ok:true});});
 app.patch('/api/galleries/:tenant/provider-settings',async c=>{
   const body=z.object({name:z.string().trim().min(2).max(120),status:z.enum(['active','suspended','closed']),reason:z.string().trim().min(8).max(500)}).strict().parse(await json(c));
   await tenant(c,(sql,t)=>sql.query('SELECT security.configure_provider_org($1,$2,$3,$4)',[t,body.name,body.status,body.reason]));return c.json({ok:true});
 });
 app.post('/api/galleries/:tenant/trial-plan',async c=>{
   const body=z.object({planVersionId:z.uuid(),reason:z.string().trim().min(8).max(500)}).strict().parse(await json(c));
   await tenant(c,(sql,t)=>sql.query('SELECT security.select_trial_plan($1,$2,$3)',[t,body.planVersionId,body.reason]));return c.json({ok:true});
 });
 app.post('/api/invitations/accept',async c=>{
   const body=z.object({token:z.string().min(32).max(128)}).strict().parse(await json(c));
   return c.json(await authenticated(db,scope(c),async sql=>(await sql.query('SELECT security.accept_invitation($1) AS tenantId',[hash(body.token)])).rows[0]));
 });
 app.get('/api/galleries/:tenant/entitlements',async c=>c.json(await tenant(c,async(sql,t)=>(await sql.query('SELECT security.entitlements($1) AS plan',[t])).rows[0]!.plan)));
 app.get('/api/galleries/:tenant/team',async c=>c.json(await tenant(c,async(sql,t)=>requireValue((await sql.query('SELECT security.team($1) AS team',[t])).rows[0]?.team))));
 app.post('/api/galleries/:tenant/invitations',async c=>{
   const body=z.object({email:z.email().max(254),role:z.enum(['admin','manager','staff','viewer','collector'])}).strict().parse(await json(c));
   return c.json(await tenant(c,async(sql,t)=>{
     const invitationToken=token();const result=(await sql.query('SELECT security.invite_member($1,$2,$3,$4) AS id',[t,body.email,body.role,hash(invitationToken)])).rows[0]!;
     // Invitation credentials are encrypted at rest in the outbox and only supplied to the configured mail transport.
     const job=(await sql.query("SELECT security.enqueue($1,'email.send',$2,$3) AS id",[t,JSON.stringify({template:'invitation',invitationId:result.id,to:body.email,encryptedToken:encrypt(invitationToken,config.TOKEN_ENCRYPTION_KEY)}),`invitation:${result.id}`])).rows[0]!;
     return {id:result.id,deliveryJobId:job.id};
   }),202);
 });
 app.post('/api/galleries/:tenant/invitations/:id/cancel',async c=>{await tenant(c,(sql,t)=>sql.query('SELECT security.cancel_invitation($1,$2)',[t,uuid(c.req.param('id'))]));return c.json({ok:true});});
 app.patch('/api/galleries/:tenant/team/:id',async c=>{
   const body=z.object({role:z.enum(['admin','manager','staff','viewer','collector']),status:z.enum(['active','disabled'])}).strict().parse(await json(c));
   await tenant(c,(sql,t)=>sql.query('SELECT security.update_member($1,$2,$3,$4)',[t,uuid(c.req.param('id')),body.role,body.status]));return c.json({ok:true});
 });
 app.post('/api/galleries/:tenant/owner',async c=>{const body=z.object({userId:z.uuid()}).strict().parse(await json(c));await tenant(c,(sql,t)=>sql.query('SELECT security.transfer_owner($1,$2)',[t,body.userId]));return c.json({ok:true});});
 app.get('/api/galleries/:tenant/audit',async c=>c.json(await tenant(c,async(sql,t)=>{
   const before=z.coerce.number().int().positive().optional().parse(c.req.query('before'));
   return {items:(await sql.query('SELECT * FROM control.audit_events WHERE tenant_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT 100',[t,before||null])).rows};
 })));
 app.get('/api/galleries/:tenant/jobs',async c=>c.json(await tenant(c,async(sql,t)=>({items:(await sql.query('SELECT id,kind,status,attempts,created_at,completed_at,last_error_code FROM delivery.jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',[t])).rows}))));
 app.post('/api/galleries/:tenant/media/uploads',async c=>{const body=media.uploadInput.parse(await json(c));return c.json(await tenant(c,(sql,t)=>{
   if(body.mime==='application/pdf'&&!config.DOCUMENT_SCANNER_URL)throw new AppError('PDF_UPLOAD_UNAVAILABLE','PDF uploads are temporarily unavailable. Please contact your administrator.',503);
   return media.initiate(sql,t,body,storage);
 }),201);});
 app.post('/api/galleries/:tenant/media/:id/complete',async c=>c.json(await tenant(c,(sql,t)=>media.complete(sql,t,uuid(c.req.param('id')))),202));
 app.post('/api/galleries/:tenant/media/:id/download',async c=>c.json(await tenant(c,(sql,t)=>media.download(sql,t,uuid(c.req.param('id')),storage))));
 app.post('/api/galleries/:tenant/artworks/:id/media',async c=>{
   const body=z.object({mediaId:z.uuid(),display:z.boolean().default(false),banner:z.boolean().default(false)}).strict().parse(await json(c));
   await tenant(c,(sql,t)=>sql.query('SELECT security.attach_artwork_media($1,$2,$3,$4,$5)',[t,uuid(c.req.param('id')),body.mediaId,body.display,body.banner]));return c.json({ok:true});
 });
 app.get('/api/galleries/:tenant/artworks/:id/media',async c=>c.json(await tenant(c,async(sql,t)=>({items:(await sql.query('SELECT m.id,m.name,m.mime_type,m.byte_size,am.position FROM app.artwork_media am JOIN app.media m ON m.tenant_id=am.tenant_id AND m.id=am.media_id WHERE am.tenant_id=$1 AND am.artwork_id=$2 ORDER BY am.position',[t,uuid(c.req.param('id'))])).rows}))));
 app.post('/api/galleries/:tenant/catalogs/:id/generate',async c=>{const body=await json(c);return c.json(await tenant(c,(sql,t)=>generate(sql,t,uuid(c.req.param('id')),version(c),body)),202);});
 app.post('/api/galleries/:tenant/catalogs/:id/pdf',async c=>{const body=z.object({mediaId:z.uuid()}).strict().parse(await json(c));await tenant(c,(sql,t)=>sql.query('SELECT security.attach_catalog_pdf($1,$2,$3)',[t,uuid(c.req.param('id')),body.mediaId]));return c.json({ok:true});});
 app.get('/api/galleries/:tenant/catalogs/:id/versions',async c=>c.json(await tenant(c,async(sql,t)=>({items:(await sql.query('SELECT id,media_id,version_number,created_at,created_by FROM app.catalog_versions WHERE tenant_id=$1 AND catalog_id=$2 ORDER BY version_number DESC LIMIT 100',[t,uuid(c.req.param('id'))])).rows}))));
 app.get('/api/galleries/:tenant/spaces',async c=>c.json(await tenant(c,async(sql,t)=>({items:(await sql.query('SELECT * FROM app.spaces WHERE tenant_id=$1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 100',[t])).rows}))));
 app.post('/api/galleries/:tenant/spaces',async c=>{
   const body=z.object({title:z.string().min(1).max(200),kind:z.enum(['direct','group','collector']),participants:z.array(z.uuid()).min(1).max(100).refine(a=>new Set(a).size===a.length)}).strict().parse(await json(c));
   return c.json(await tenant(c,async(sql,t)=>{await gallery.entitlement(sql,t,body.kind==='collector'?'privateRooms':'messaging');return (await sql.query('SELECT security.create_space($1,$2,$3,$4) AS id',[t,body.title,body.kind,body.participants])).rows[0];}),201);
 });
 app.get('/api/galleries/:tenant/spaces/:id/messages',async c=>c.json(await tenant(c,async(sql,t)=>({items:(await sql.query('SELECT id,space_id,body,created_by,created_at,edited_at,deleted_at,version FROM app.messages WHERE tenant_id=$1 AND space_id=$2 ORDER BY created_at DESC,id DESC LIMIT 100',[t,uuid(c.req.param('id'))])).rows}))));
 app.post('/api/galleries/:tenant/spaces/:id/messages',async c=>{
   const body=z.object({body:z.string().trim().min(1).max(20000)}).strict().parse(await json(c));
   return c.json(await tenant(c,async(sql,t)=>{await gallery.entitlement(sql,t,'messaging');return (await sql.query('INSERT INTO app.messages(tenant_id,space_id,body) VALUES($1,$2,$3) RETURNING *',[t,uuid(c.req.param('id')),body.body])).rows[0];}),201);
 });
 app.patch('/api/galleries/:tenant/messages/:id',async c=>{
   const body=z.object({body:z.string().max(20000),deleted:z.boolean().default(false)}).strict().parse(await json(c));
   return c.json(await tenant(c,async(sql,t)=>(await sql.query('SELECT security.edit_message($1,$2,$3,$4,$5) AS message',[t,uuid(c.req.param('id')),body.body,body.deleted,version(c)])).rows[0]!.message));
 });
 app.post('/api/galleries/:tenant/spaces/:id/members',async c=>{
   const body=z.object({userId:z.uuid(),role:z.enum(['member','viewer','remove'])}).strict().parse(await json(c));
   await tenant(c,(sql,t)=>sql.query('SELECT security.manage_space_member($1,$2,$3,$4)',[t,uuid(c.req.param('id')),body.userId,body.role]));return c.json({ok:true});
 });
 app.post('/api/galleries/:tenant/website/artworks/:id',async c=>{
   const body=z.object({visible:z.boolean(),showPrice:z.boolean().default(false)}).strict().parse(await json(c));
   await tenant(c,(sql,t)=>sql.query('SELECT security.set_public_artwork($1,$2,$3,$4)',[t,uuid(c.req.param('id')),body.visible,body.showPrice]));return c.json({ok:true});
 });
 app.post('/api/galleries/:tenant/domains',async c=>{
   const body=z.object({hostname:z.string().max(253).transform(v=>domainToASCII(v.trim().toLowerCase())).refine(v=>/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v)&&!v.endsWith('.local')&&!v.endsWith('.internal')&&!v.endsWith('.localhost'),'Use a public DNS hostname')}).strict().parse(await json(c));
   return c.json(await tenant(c,async(sql,t)=>{
     await gallery.entitlement(sql,t,'customDomains');const challenge=token();
     const domain=(await sql.query('SELECT security.request_domain($1,$2,$3) AS id',[t,body.hostname,hash(challenge)])).rows[0]!;
     return {id:domain.id,record:{type:'TXT',name:`_vayu-challenge.${body.hostname}`,value:challenge},status:'pending'};
   }),201);
 });
 app.post('/api/galleries/:tenant/domains/:id/verify',async c=>c.json(await tenant(c,async(sql,t)=>{
   await gallery.entitlement(sql,t,'customDomains');
   const id=uuid(c.req.param('id'));requireValue((await sql.query('SELECT id FROM app.custom_domains WHERE tenant_id=$1 AND id=$2',[t,id])).rows[0]);
   return (await sql.query("SELECT security.enqueue($1,'domain.verify',$2,$3) AS jobId",[t,JSON.stringify({domainId:id}),`${id}:${new Date().toISOString().slice(0,13)}`])).rows[0];
 }),202));
 app.post('/api/galleries/:tenant/website/publish',async c=>c.json(await tenant(c,async(sql,t)=>{
   await gallery.entitlement(sql,t,'website');
   const drafts=(await sql.query('SELECT title,slug,seo,content,theme FROM app.website_drafts WHERE tenant_id=$1 ORDER BY slug LIMIT 51',[t])).rows;
   if(!drafts.length)throw new AppError('EMPTY_WEBSITE','Add a website page before publishing');
   if(drafts.length>50)throw new AppError('WEBSITE_PAGE_LIMIT','A website release supports up to 50 pages');
   const pages=drafts.map(d=>resources.website_drafts.schema.parse(d));
   return (await sql.query('SELECT security.publish_site($1,$2) AS releaseId',[t,JSON.stringify(pages)])).rows[0];
 })));
 app.get('/api/galleries/:tenant/website/preview',async c=>c.json(await tenant(c,async(sql,t)=>({pages:(await sql.query('SELECT title,slug,seo,content,theme FROM app.website_drafts WHERE tenant_id=$1 ORDER BY slug',[t])).rows}))));
 app.get('/api/public/sites/:slug',async c=>{
   const slug=z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).parse(c.req.param('slug'));
   return c.json(await db.transaction(async sql=>requireValue((await sql.query('SELECT security.public_site($1,NULL) AS site',[slug])).rows[0]?.site)));
 });
 app.get('/api/public/sites/:slug/media/:id',async c=>{
   const file=await db.transaction(async sql=>requireValue((await sql.query('SELECT security.public_media($1,$2) AS media',[c.req.param('slug'),uuid(c.req.param('id'))])).rows[0]?.media));
   const bytes=await storage.read(file.key,Math.min(Number(file.bytes),50*1024*1024));
   c.header('Content-Type',file.mime);c.header('Cache-Control','public, max-age=60');return c.body(bytes as Uint8Array<ArrayBuffer>);
 });
 app.get('/site/:slug/:page?',async c=>{
   const site=await db.transaction(async sql=>requireValue((await sql.query('SELECT security.public_site($1,NULL) AS site',[c.req.param('slug')])).rows[0]?.site));
   const html=requireValue(renderWebsite(site,c.req.param('page')||'',config.APP_ORIGIN));return c.html(html);
 });
 // Closed resource registry: request parameters can never become arbitrary table/column names.
 registerCatalogRoutes(app,{tenant,storage});
 registerInvoiceRoutes(app,{tenant});
 app.get('/api/galleries/:tenant/:resource',async c=>{
   const r=c.req.param('resource');if(!isResource(r))throw new AppError('NOT_FOUND','Endpoint not found',404);
   return c.json(await tenant(c,(sql,t)=>gallery.list(sql,t,r,c.req.query())));
 });
 app.post('/api/galleries/:tenant/:resource',async c=>{
   const r=c.req.param('resource');if(!isResource(r))throw new AppError('NOT_FOUND','Endpoint not found',404);const body=await json(c);
   return c.json(await tenant(c,(sql,t)=>gallery.create(sql,t,r,body)),201);
 });
 app.patch('/api/galleries/:tenant/:resource/:id',async c=>{
   const r=c.req.param('resource');if(!isResource(r))throw new AppError('NOT_FOUND','Endpoint not found',404);const body=await json(c);
   return c.json(await tenant(c,(sql,t)=>gallery.update(sql,t,r,uuid(c.req.param('id')),version(c),body)));
 });
 app.post('/api/galleries/:tenant/:resource/:id/archive',async c=>{
   const r=c.req.param('resource');if(!isResource(r))throw new AppError('NOT_FOUND','Endpoint not found',404);
   const body=z.object({restore:z.boolean().default(false)}).strict().parse(await json(c));
   return c.json(await tenant(c,(sql,t)=>gallery.archive(sql,t,r,uuid(c.req.param('id')),version(c),body.restore)));
 });
 app.onError((error,c)=>{
   if(error instanceof ZodError)return c.json({error:{code:'VALIDATION',message:'Check the supplied fields',fields:error.issues.map(i=>({path:i.path.join('.'),message:i.message}))},requestId:c.get('requestId')},422);
   if(error instanceof AppError){if(error.status===429)c.header('Retry-After','60');return c.json({error:{code:error.code,message:error.message},requestId:c.get('requestId')},error.status);}
   const code=(error as {code?:string}).code;
   if(code&&['42501','23505','23514','23503','40001','22023','22P02'].includes(code))return c.json({error:{code:'OPERATION_REJECTED',message:code==='42501'?'Access denied':'Record, plan limit or version conflict'},requestId:c.get('requestId')},code==='42501'?403:409);
   log({event:'http.error',requestId:c.get('requestId'),code:code||'UNEXPECTED'});
   return c.json({error:{code:'INTERNAL',message:'The operation could not be completed'},requestId:c.get('requestId')},500);
 });
 app.notFound(c=>c.json({error:{code:'NOT_FOUND',message:'Endpoint not found'}},404));
 return app;
}

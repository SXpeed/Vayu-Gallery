import type { Hono,Context } from 'hono';
import { z } from 'zod';
import type { SQL } from '../core/database.js';
import type { ObjectStore } from '../modules/storage/s3.js';
import { AppError,requireValue } from '../core/errors.js';
import { entitlement,list } from '../modules/gallery/service.js';
import { listQuery } from '../modules/gallery/resources.js';
import { artworkDetails } from '../modules/gallery/artworks.js';
import { normalizeDesign,designImageSources } from '../../../shared/catalog-design.mjs';

export type CatalogTenant=<T>(c:Context,fn:(sql:SQL,tenant:string)=>Promise<T>,options?:{providerAccessId?:string})=>Promise<T>;
const id=(s:string|undefined)=>z.uuid().parse(s);
const version=(c:Context)=>z.coerce.number().int().positive().parse(c.req.header('If-Match')?.replace(/^"|"$/g,''));
const designInput=z.object({title:z.string().trim().min(1).max(200),description:z.string().max(20000).default(''),design:z.record(z.string(),z.unknown()),artworkIds:z.array(z.uuid()).max(100).refine(v=>new Set(v).size===v.length)}).strict();
const json=async(c:Context)=>{try{return await c.req.json();}catch{throw new AppError('INVALID_JSON','Supply a valid JSON body');}};

export { artworkDetails } from '../modules/gallery/artworks.js';
export async function catalogDetail(sql:SQL,t:string,c:string) {
 const catalog=requireValue((await sql.query('SELECT * FROM app.catalogs WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL',[t,c])).rows[0]);
 const artworkIds=(await sql.query('SELECT artwork_id FROM app.catalog_artworks WHERE tenant_id=$1 AND catalog_id=$2 ORDER BY position',[t,c])).rows.map(r=>r.artwork_id);
 const versions=(await sql.query('SELECT id,media_id,version_number,created_at,created_by FROM app.catalog_versions WHERE tenant_id=$1 AND catalog_id=$2 ORDER BY version_number DESC LIMIT 100',[t,c])).rows;
 return {...catalog,artworkIds,artworks:await artworkDetails(sql,t,artworkIds),versions};
}
async function checkedDesign(sql:SQL,t:string,input:unknown) {
 const data=designInput.parse(input),design=normalizeDesign(data.design);
 const sources=[...new Set(designImageSources(design))];
 const ids=sources.map(s=>{const match=s.match(/^\/api\/files\/([a-f0-9-]{36})$/);if(!match)throw new AppError('IMAGE_REFERENCE','Use an uploaded gallery image');return id(match[1]);});
 if(ids.length){const files=(await sql.query("SELECT id FROM app.media WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND state='ready' AND deleted_at IS NULL AND space_id IS NULL AND mime_type LIKE 'image/%'",[t,ids])).rows;if(files.length!==ids.length)throw new AppError('IMAGE_UNAVAILABLE','One or more gallery images are unavailable',404);}
 const works=await artworkDetails(sql,t,data.artworkIds);
 if(works.length!==data.artworkIds.length)throw new AppError('ARTWORK_UNAVAILABLE','One or more artworks are unavailable',404);
 return {...data,design};
}
export function registerCatalogRoutes(app:Hono<any>,{tenant,storage}:{tenant:CatalogTenant;storage:ObjectStore}) {
 const base='/api/galleries/:tenant';
 app.get(`${base}/inventory`,async c=>c.json(await tenant(c,async(sql,t)=>{
  const page=await list(sql,t,'artworks',c.req.query());return {...page,items:await artworkDetails(sql,t,page.items.map(r=>r.id))};
 })));
 app.get(`${base}/artworks/:id/detail`,async c=>c.json(await tenant(c,async(sql,t)=>requireValue((await artworkDetails(sql,t,[id(c.req.param('id'))]))[0]))));
 app.post(`${base}/artworks/:id/media-order`,async c=>{
  const body=z.object({mediaIds:z.array(z.uuid()).max(30).refine(v=>new Set(v).size===v.length),displayMediaId:z.uuid().nullable(),bannerMediaId:z.uuid().nullable()}).strict().parse(await json(c));
  return c.json(await tenant(c,async(sql,t)=>{await entitlement(sql,t);const a=id(c.req.param('id'));await sql.query('SELECT security.order_artwork_media($1,$2,$3,$4,$5,$6)',[t,a,body.mediaIds,body.displayMediaId,body.bannerMediaId,version(c)]);return requireValue((await artworkDetails(sql,t,[a]))[0]);}));
 });
 app.get(`${base}/catalog-library`,async c=>c.json(await tenant(c,async(sql,t)=>{
  const {section,...rest}=c.req.query();const selected=z.enum(['library','designer']).default('designer').parse(section),query=listQuery.parse(rest);
  const rows=(await sql.query(`SELECT * FROM app.catalogs c WHERE tenant_id=$1 AND archived_at IS NULL
   AND ($2='designer' OR EXISTS(SELECT FROM app.catalog_versions v WHERE v.tenant_id=c.tenant_id AND v.catalog_id=c.id))
   AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) AND ($5::text IS NULL OR title ILIKE $5)
   ORDER BY created_at DESC,id DESC LIMIT $6`,[t,selected,query.before||null,query.after||null,query.q?`%${query.q.replace(/[\\%_]/g,'\\$&')}%`:null,query.limit+1])).rows;
  const hasMore=rows.length>query.limit;if(hasMore)rows.pop();const last=rows.at(-1);
  const page={items:rows,next:hasMore&&last?{before:new Date(last.created_at).toISOString(),after:last.id}:null};
  const counts=(await sql.query('SELECT catalog_id,count(*)::integer AS versions FROM app.catalog_versions WHERE tenant_id=$1 AND catalog_id=ANY($2::uuid[]) GROUP BY catalog_id',[t,page.items.map(r=>r.id)])).rows;
  return {...page,items:page.items.map(r=>({...r,version_count:counts.find(v=>v.catalog_id===r.id)?.versions||0}))};
 })));
 app.get(`${base}/catalogs/:id/detail`,async c=>c.json(await tenant(c,(sql,t)=>catalogDetail(sql,t,id(c.req.param('id'))))));
 app.post(`${base}/catalogs/:id/design`,async c=>{
  const input=await json(c),expected=version(c);
  return c.json(await tenant(c,async(sql,t)=>{await entitlement(sql,t,'catalogs');const cId=id(c.req.param('id')),data=await checkedDesign(sql,t,input);
   await sql.query('SELECT security.save_catalog($1,$2,$3,$4,$5,$6,$7)',[t,cId,data.title,data.description,JSON.stringify(data.design),data.artworkIds,expected]);return catalogDetail(sql,t,cId);
  }));
 });
 app.get(`${base}/catalogs/:id/draft`,async c=>c.json(await tenant(c,async(sql,t)=>({draft:(await sql.query('SELECT base_version,data,updated_at FROM app.catalog_drafts WHERE tenant_id=$1 AND catalog_id=$2 AND user_id=security.user_id()',[t,id(c.req.param('id'))])).rows[0]||null}))));
 app.post(`${base}/catalogs/:id/draft`,async c=>{
  const input=await json(c),expected=version(c);
  return c.json(await tenant(c,async(sql,t)=>{await entitlement(sql,t,'catalogs');const cId=id(c.req.param('id'));
   const row=requireValue((await sql.query('SELECT version FROM app.catalogs WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE',[t,cId])).rows[0]);
   if(row.version!==expected)throw new AppError('VERSION_CONFLICT','Catalog changed. Reload before restoring or saving this draft.',409);
   const data=await checkedDesign(sql,t,input);
   await sql.query('INSERT INTO app.catalog_drafts(tenant_id,catalog_id,base_version,data) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,catalog_id,user_id) DO UPDATE SET base_version=excluded.base_version,data=excluded.data,updated_at=now()',[t,cId,expected,JSON.stringify(data)]);return {ok:true};
  }));
 });
 app.post(`${base}/catalogs/:id/draft/clear`,async c=>{await tenant(c,(sql,t)=>sql.query('DELETE FROM app.catalog_drafts WHERE tenant_id=$1 AND catalog_id=$2 AND user_id=security.user_id()',[t,id(c.req.param('id'))]));return c.json({ok:true});});
 app.get(`${base}/jobs/:id`,async c=>c.json(await tenant(c,async(sql,t)=>requireValue((await sql.query('SELECT id,kind,status,attempts,last_error_code,created_at,completed_at FROM delivery.jobs WHERE tenant_id=$1 AND id=$2',[t,id(c.req.param('id'))])).rows[0]))));
 app.get(`${base}/media/:id/status`,async c=>c.json(await tenant(c,async(sql,t)=>requireValue((await sql.query('SELECT id,name,mime_type,byte_size,state FROM app.media WHERE tenant_id=$1 AND id=$2',[t,id(c.req.param('id'))])).rows[0]))));
 app.get(`${base}/media/:id/content`,async c=>{
  // The query value selects an existing, user-bound provider access session. It never grants access by itself.
  const access=c.req.query('access');
  const file=await tenant(c,async(sql,t)=>{
   const row=requireValue((await sql.query("SELECT id,object_key,mime_type,byte_size FROM app.media WHERE tenant_id=$1 AND id=$2 AND state='ready' AND deleted_at IS NULL",[t,id(c.req.param('id'))])).rows[0]);
   if(!row.object_key.startsWith(`tenants/${t}/private/`))throw new AppError('FILE_UNVERIFIED','File unavailable',409);
   await sql.query("SELECT security.append_audit($1,'file.view','media',$2)",[t,row.id]);return row;
  },access?{providerAccessId:id(access)}:undefined);
  const bytes=await storage.read(file.object_key,Math.min(Number(file.byte_size),50*1024*1024));
  c.header('Content-Type',file.mime_type);c.header('Content-Disposition',file.mime_type==='application/pdf'?'attachment; filename="catalog.pdf"':'inline');c.header('Cache-Control','no-store');
  return c.body(bytes as Uint8Array<ArrayBuffer>);
 });
}

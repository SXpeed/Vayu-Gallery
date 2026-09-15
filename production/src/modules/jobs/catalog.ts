import { createCanvas,loadImage } from '@napi-rs/canvas';
import { jsPDF } from 'jspdf';
import { randomUUID } from 'node:crypto';
import { createCatalogRenderer } from '../../../../src/catalog-renderer.js';
import { normalizeDesign,catalogPages,pageDimensions,designImageSources,MAX_CATALOG_PAGES } from '../../../../shared/catalog-design.mjs';
import { hash } from '../../core/crypto.js';
import type { ObjectStore } from '../storage/s3.js';
import type { JobHandler } from './service.js';
export function generateCatalog(storage:ObjectStore):JobHandler {
 return async(job,{transaction})=>{
   const t=job.tenant_id,design=normalizeDesign(job.payload.design),catalogId=job.payload.catalogId;
   // Retry after the output transaction committed: never create a second version.
   const prior=await transaction(async sql=>(await sql.query('SELECT id FROM app.media WHERE tenant_id=$1 AND id=$2',[t,job.id])).rows[0]);if(prior)return;
   const works=await transaction(async sql=>(await sql.query(`SELECT a.*,ar.name AS artist,
     coalesce((SELECT jsonb_agg(jsonb_build_object('id',m.id,'key',m.object_key,'bytes',m.byte_size) ORDER BY am.position)
     FROM app.artwork_media am JOIN app.media m ON m.tenant_id=am.tenant_id AND m.id=am.media_id
     WHERE am.tenant_id=a.tenant_id AND am.artwork_id=a.id AND m.state='ready' AND m.deleted_at IS NULL AND m.space_id IS NULL AND m.mime_type LIKE 'image/%'),'[]'::jsonb) AS images
     FROM app.artworks a LEFT JOIN app.artists ar ON ar.tenant_id=a.tenant_id AND ar.id=a.artist_id WHERE a.tenant_id=$1 AND a.id=ANY($2::uuid[]) AND a.archived_at IS NULL`,[t,job.payload.artworkIds])).rows);
   if(works.length!==job.payload.artworkIds.length)throw new Error('ARTWORKS_CHANGED');
   works.sort((a,b)=>job.payload.artworkIds.indexOf(a.id)-job.payload.artworkIds.indexOf(b.id));
   const imageMap=new Map<string,{key:string;bytes:number}>();
   for(const art of works){for(const m of art.images)imageMap.set(`/api/files/${m.id}`,{key:m.key,bytes:Number(m.bytes)});art.images=art.images.map((m:any)=>`/api/files/${m.id}`);art.image=art.display_media_id?`/api/files/${art.display_media_id}`:art.images[0];art.bannerImage=art.banner_media_id?`/api/files/${art.banner_media_id}`:art.image;art.price=Number(art.price_minor||0)/100;}
   // Artwork media can change after admission. Reject oversized jobs before
   // resolving branding, downloading an image, or allocating a canvas/PDF.
   const pages=catalogPages(design,works);
   if(pages.length>MAX_CATALOG_PAGES)throw new Error('CATALOG_PAGE_LIMIT');
   // Branding may reference other gallery media, but never a private room's images.
   for(const source of designImageSources(design)) {
     const id=source.match(/^\/api\/files\/([a-f0-9-]{36})$/)?.[1];if(!id)throw new Error('CATALOG_IMAGE_INVALID');
     if(!imageMap.has(source)) {
       const m=await transaction(async sql=>(await sql.query("SELECT object_key,byte_size FROM app.media WHERE tenant_id=$1 AND id=$2 AND state='ready' AND deleted_at IS NULL AND space_id IS NULL AND mime_type LIKE 'image/%'",[t,id])).rows[0]);
       if(!m)throw new Error('CATALOG_IMAGE_UNAVAILABLE');imageMap.set(source,{key:m.object_key,bytes:Number(m.byte_size)});
     }
   }
   let loadedBytes=0;
   const renderer=createCatalogRenderer({loadFonts:async()=>{},
     formatPrice:art=>{if(art.price_minor===null)return 'Price on request';const formatter=new Intl.NumberFormat('en',{style:'currency',currency:art.currency});return formatter.format(Number(art.price_minor)/10**formatter.resolvedOptions().maximumFractionDigits!);},
     formatDimensions:d=>typeof d==='string'?d:[d.height,d.width,d.depth].filter(Boolean).join(' × ')+(d.unit?` ${d.unit}`:''),
     loadImage:async src=>{
     const m=imageMap.get(src);if(!m||!m.key.startsWith(`tenants/${t}/private/`))throw new Error('CATALOG_IMAGE_UNAVAILABLE');
     loadedBytes+=m.bytes;if(loadedBytes>150*1024*1024)throw new Error('CATALOG_IMAGE_BUDGET');
     return loadImage(await storage.read(m.key,Math.min(m.bytes,50*1024*1024)));
   }});
   const [w,h]=pageDimensions(design),format:[number,number]=[w*.21,h*.21];
   const pdf=new jsPDF({unit:'mm',format,orientation:w>h?'landscape':'portrait'});
   for(let i=0;i<pages.length;i++) {
     const canvas=createCanvas(w,h);await renderer.renderCatalogPage({title:job.payload.title,description:job.payload.description||'',design},works,i,canvas);
     if(i)pdf.addPage(format,w>h?'landscape':'portrait');
     pdf.addImage(canvas.toDataURL('image/jpeg',.9),'JPEG',0,0,format[0],format[1],undefined,'FAST');
   }
   const bytes=new Uint8Array(pdf.output('arraybuffer'));if(bytes.byteLength>50*1024*1024)throw new Error('CATALOG_OUTPUT_BUDGET');
   const key=`tenants/${t}/private/${job.id}/${hash(bytes)}`;await storage.put(key,bytes,'application/pdf');
   await transaction(async sql=>{
     await sql.query('SELECT id FROM app.catalogs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[t,catalogId]);
     await sql.query('SELECT security.charge_job_storage($1,$2)',[t,bytes.byteLength]);
     await sql.query("INSERT INTO app.media(tenant_id,id,name,object_key,mime_type,byte_size,checksum_sha256,state,purpose,verified_at) VALUES($1,$2,$3,$4,'application/pdf',$5,$6,'ready','catalog',now())",[t,job.id,`${job.payload.title}.pdf`,key,bytes.byteLength,hash(bytes)]);
     await sql.query('INSERT INTO app.catalog_versions(tenant_id,catalog_id,media_id,design,version_number) SELECT $1,$2,$3,$4,coalesce(max(version_number),0)+1 FROM app.catalog_versions WHERE tenant_id=$1 AND catalog_id=$2',[t,catalogId,job.id,JSON.stringify(design)]);
     await sql.query("UPDATE app.catalogs SET status='ready' WHERE tenant_id=$1 AND id=$2",[t,catalogId]);
   });
 };
}

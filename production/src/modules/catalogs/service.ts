import { z } from 'zod';
import type { SQL } from '../../core/database.js';
import { AppError,requireValue } from '../../core/errors.js';
import { entitlement } from '../gallery/service.js';
import { artworkDetails,catalogArtwork } from '../gallery/artworks.js';
import { normalizeDesign,catalogPages,MAX_CATALOG_PAGES } from '../../../../shared/catalog-design.mjs';
export const generation=z.object({artworkIds:z.array(z.uuid()).min(1).max(100).refine(ids=>new Set(ids).size===ids.length)}).strict();
export async function generate(sql:SQL,t:string,id:string,expectedVersion:number,input:unknown) {
 const data=generation.parse(input);await entitlement(sql,t,'catalogs');
 const key=`${id}:${expectedVersion}`;
 const prior=(await sql.query("SELECT id,payload FROM delivery.jobs WHERE tenant_id=$1 AND kind='catalog.generate' AND idempotency_key=$2",[t,key])).rows[0];
 if(prior){if(JSON.stringify(prior.payload.artworkIds)!==JSON.stringify(data.artworkIds))throw new AppError('IDEMPOTENCY_CONFLICT','This generation version has different artwork selections',409);return {jobId:prior.id};}
 const catalog=requireValue((await sql.query('SELECT * FROM app.catalogs WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE',[t,id])).rows[0]);
 if(catalog.version!==expectedVersion)throw new AppError('VERSION_CONFLICT','Catalog changed; refresh and retry',409);
 const works=await artworkDetails(sql,t,data.artworkIds);
 if(works.length!==data.artworkIds.length)throw new AppError('ARTWORKS_UNAVAILABLE','One or more artworks are unavailable',404);
 const design=normalizeDesign(catalog.design);
 if(catalogPages(design,works.map(catalogArtwork)).length>MAX_CATALOG_PAGES)throw new AppError('CATALOG_PAGE_LIMIT',`Catalogs can contain at most ${MAX_CATALOG_PAGES} pages. Use fewer continuation pages or select fewer products.`,422);
 await sql.query("SELECT security.reserve_usage($1,'catalogs',to_char(now() AT TIME ZONE 'UTC','YYYY-MM'),1)",[t]);
 const job=(await sql.query("SELECT security.enqueue($1,'catalog.generate',$2,$3) AS id",[t,JSON.stringify({catalogId:id,title:catalog.title,description:catalog.description,design,...data}),key])).rows[0]!;
 await sql.query("UPDATE app.catalogs SET status='queued' WHERE tenant_id=$1 AND id=$2",[t,id]);
 return {jobId:job.id};
}

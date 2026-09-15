import type { SQL } from '../../core/database.js';
import { AppError,requireValue } from '../../core/errors.js';
import { resources,type Resource,listQuery } from './resources.js';

export async function entitlement(sql:SQL,t:string,feature?:string) {
  const row=(await sql.query('SELECT security.entitlements($1) AS plan,security.provider_scope($1) AS provider',[t])).rows[0]!;
  if(!row.plan) throw new AppError('SUBSCRIPTION','Subscription unavailable',403);
  if(!row.provider&&(!row.plan.enabled||feature&&!row.plan.features[feature])) throw new AppError('PLAN_REQUIRED','Your plan does not include this operation',403);
  return row.plan;
}
export async function list(sql:SQL,t:string,resource:Resource,input:unknown) {
  const query=listQuery.parse(input),values:any[]=[t,query.limit+1];
  let where='tenant_id=$1';
  if(resource!=='website_drafts') where+=' AND archived_at IS NULL';
  if(query.after){values.push(query.before,query.after);where+=' AND (created_at,id)<($3::timestamptz,$4::uuid)';}
  if(query.q){values.push(`%${query.q.replace(/[\\%_]/g,'\\$&')}%`);where+=` AND ${['artists','locations','contacts'].includes(resource)?'name':'title'} ILIKE $${values.length}`;}
  const rows=(await sql.query(`SELECT * FROM app.${resource} WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $2`,values)).rows;
  const hasMore=rows.length>query.limit; if(hasMore) rows.pop();
  const last=rows.at(-1);
  return {items:rows,next:hasMore&&last?{before:new Date(last.created_at).toISOString(),after:last.id}:null};
}
export async function create(sql:SQL,t:string,resource:Resource,input:unknown) {
  const spec=resources[resource],data:Record<string,unknown>=spec.schema.parse(input);
  const plan=await entitlement(sql,t,'feature' in spec?spec.feature:undefined);
  if(resource==='artworks') {
    await sql.query('SELECT id FROM control.organizations WHERE id=$1 FOR UPDATE',[t]);
    const used=(await sql.query('SELECT count(*)::integer AS n FROM app.artworks WHERE tenant_id=$1',[t])).rows[0]!.n;
    if(used>=plan.artworkLimit) throw new AppError('ARTWORK_LIMIT','Artwork allowance reached',409);
  }
  const keys=Object.keys(data),values=keys.map(key=>typeof data[key]==='object'&&data[key]!==null?JSON.stringify(data[key]):data[key]);
  const row=(await sql.query(`INSERT INTO app.${resource}(tenant_id,${keys.join(',')}) VALUES($1,${keys.map((_,i)=>`$${i+2}`).join(',')}) RETURNING *`,[t,...values])).rows[0];
  return requireValue(row);
}
export async function update(sql:SQL,t:string,resource:Resource,id:string,version:number,input:unknown) {
  const spec=resources[resource],parsed:Record<string,unknown>=spec.schema.partial().parse(input);
  // Creation defaults must never overwrite fields omitted from a PATCH request.
  const data=Object.fromEntries(Object.keys(input as Record<string,unknown>).map(key=>[key,parsed[key]]));
  await entitlement(sql,t,'feature' in spec?spec.feature:undefined);
  const keys=Object.keys(data);if(!keys.length)throw new AppError('EMPTY_UPDATE','No changes supplied');
  const values=keys.map(key=>typeof data[key]==='object'&&data[key]!==null?JSON.stringify(data[key]):data[key]);
  const row=(await sql.query(`UPDATE app.${resource} SET ${keys.map((key,i)=>`${key}=$${i+4}`).join(',')} WHERE tenant_id=$1 AND id=$2 AND version=$3 RETURNING *`,[t,id,version,...values])).rows[0];
  if(!row)throw new AppError('VERSION_CONFLICT','Record changed or is unavailable. Refresh and retry.',409);
  return row;
}
export async function archive(sql:SQL,t:string,resource:Resource,id:string,version:number,restore=false) {
  if(resource==='website_drafts')throw new AppError('INVALID_OPERATION','Website pages use publishing controls');
  await entitlement(sql,t);
  const row=(await sql.query(`UPDATE app.${resource} SET archived_at=${restore?'NULL':'now()'} WHERE tenant_id=$1 AND id=$2 AND version=$3 RETURNING *`,[t,id,version])).rows[0];
  if(!row)throw new AppError('VERSION_CONFLICT','Record changed or is unavailable. Refresh and retry.',409);
  return row;
}

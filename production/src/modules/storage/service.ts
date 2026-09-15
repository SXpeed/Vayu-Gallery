import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SQL } from '../../core/database.js';
import { AppError,requireValue } from '../../core/errors.js';
import { entitlement } from '../gallery/service.js';
import type { ObjectStore } from './s3.js';
export const uploadInput=z.object({name:z.string().min(1).max(180),mime:z.enum(['image/jpeg','image/png','image/webp','application/pdf']),
 bytes:z.number().int().min(1).max(50*1024*1024),checksum:z.string().regex(/^[a-f0-9]{64}$/),
 purpose:z.enum(['artwork','catalog','document','logo','enquiry','message']),spaceId:z.uuid().optional()}).strict();
export async function initiate(sql:SQL,t:string,input:unknown,storage:ObjectStore) {
  const data=uploadInput.parse(input),plan=await entitlement(sql,t);
  if(data.purpose==='message'&&!data.spaceId)throw new AppError('ROOM_REQUIRED','Message attachments require a conversation');
  await sql.query('SELECT security.reserve_usage($1,\'storage\',\'all\',$2)',[t,data.bytes]);
  const id=randomUUID(),key=`tenants/${t}/quarantine/${id}/${randomUUID()}`;
  await sql.query('INSERT INTO app.media(tenant_id,id,name,object_key,mime_type,byte_size,checksum_sha256,purpose,space_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [t,id,data.name,key,data.mime,data.bytes,data.checksum,data.purpose,data.spaceId||null]);
  return {id,url:await storage.uploadUrl(key,data.mime,data.bytes,data.checksum),expiresIn:60,headers:{'Content-Type':data.mime,'x-amz-checksum-sha256':Buffer.from(data.checksum,'hex').toString('base64')}};
}
export async function complete(sql:SQL,t:string,id:string) {
  const file=requireValue((await sql.query("UPDATE app.media SET state='quarantined',uploaded_at=now() WHERE tenant_id=$1 AND id=$2 AND state='pending' RETURNING id",[t,id])).rows[0]);
  const job=(await sql.query("SELECT security.enqueue($1,'media.verify',jsonb_build_object('mediaId',$2::text),$2::text) AS id",[t,file.id])).rows[0];
  return {jobId:job!.id,status:'quarantined'};
}
export async function download(sql:SQL,t:string,id:string,storage:ObjectStore) {
  const file=requireValue((await sql.query("SELECT * FROM app.media WHERE tenant_id=$1 AND id=$2 AND state='ready' AND deleted_at IS NULL",[t,id])).rows[0]);
  if(!file.object_key.startsWith(`tenants/${t}/private/`))throw new AppError('FILE_UNVERIFIED','File is not verified',409);
  await sql.query("SELECT security.append_audit($1,'file.download','media',$2)",[t,id]);
  const name=file.mime_type==='image/webp'?`${file.name.replace(/\.[^.]+$/,'')}.webp`:file.name;
  return {url:await storage.downloadUrl(file.object_key,name),expiresIn:60};
}

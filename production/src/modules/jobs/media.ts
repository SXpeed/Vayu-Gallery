import sharp from 'sharp';
import { hash } from '../../core/crypto.js';
import type { ObjectStore } from '../storage/s3.js';
import type { JobHandler } from './service.js';
export interface DocumentScanner { scanPdf(data:Uint8Array):Promise<'clean'|'infected'> }
export function verifyMedia(storage:ObjectStore,scanner?:DocumentScanner):JobHandler {
 return async(job,{transaction})=>{
   const media=await transaction(async sql=>(await sql.query('SELECT * FROM app.media WHERE tenant_id=$1 AND id=$2',[job.tenant_id,job.payload.mediaId])).rows[0]);
   if(!media)throw new Error('MEDIA_NOT_FOUND');
   const cleanup=async()=>{
     const key=media.quarantine_key;
     if(!key)return;
     if(!key.startsWith(`tenants/${job.tenant_id}/quarantine/`))throw new Error('QUARANTINE_KEY_INVALID');
     await storage.remove(key);
     await transaction(sql=>sql.query('UPDATE app.media SET quarantine_key=NULL WHERE tenant_id=$1 AND id=$2 AND quarantine_key=$3',[job.tenant_id,media.id,key]));
   };
   if(['ready','rejected','deleted'].includes(media.state)){await cleanup();return;}
   if(media.state!=='quarantined'||!media.object_key.startsWith(`tenants/${job.tenant_id}/quarantine/`))throw new Error('MEDIA_STATE_INVALID');
   const bytes=await storage.read(media.object_key,Number(media.byte_size));
   let output:Uint8Array=bytes,mime=media.mime_type,valid=bytes.byteLength===Number(media.byte_size)&&hash(bytes)===media.checksum_sha256;
   if(valid&&mime==='application/pdf') {
     if(!scanner)throw new Error('PDF_SCANNER_NOT_CONFIGURED');
     valid=Buffer.from(bytes.subarray(0,5)).toString()==='%PDF-'&&(await scanner.scanPdf(bytes))==='clean';
   }else if(valid) {
     try {
       const image=sharp(bytes,{limitInputPixels:40_000_000,animated:false,failOn:'warning'});
       const meta=await image.metadata();
       valid=['jpeg','png','webp'].includes(meta.format||'')&&!!meta.width&&!!meta.height;
       if(valid){output=await image.rotate().webp({lossless:true}).toBuffer();mime='image/webp';valid=output.byteLength<=50*1024*1024;}
     }catch{valid=false;}
   }
   if(!valid){await transaction(sql=>sql.query('SELECT security.release_storage($1,$2)',[job.tenant_id,media.id]));await cleanup();return;}
   // Originals remain quarantined until removal; only sanitized bytes enter private delivery storage.
   // The deterministic key makes a retry safe and cannot be overwritten using the upload URL.
   const key=`tenants/${job.tenant_id}/private/${media.id}/${hash(output)}`;
   await storage.put(key,output,mime);
   await transaction(async sql=>{
     await sql.query('SELECT security.finalize_media($1,$2,$3,$4,$5,$6)',[job.tenant_id,media.id,key,mime,output.byteLength,hash(output)]);
   });
   await cleanup();
 };
}

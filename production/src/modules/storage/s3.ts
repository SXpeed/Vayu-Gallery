import { S3Client,PutObjectCommand,GetObjectCommand,HeadObjectCommand,CopyObjectCommand,DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
export interface ObjectStore {
  uploadUrl(key:string,mime:string,bytes:number,checksum:string):Promise<string>;
  downloadUrl(key:string,name:string):Promise<string>;
  head(key:string):Promise<{bytes:number;mime:string}>;
  read(key:string,maximum:number):Promise<Uint8Array>;
  put(key:string,bytes:Uint8Array,mime:string):Promise<void>;
  remove(key:string):Promise<void>;
}
export function s3(config:Pick<Config,'STORAGE_ENDPOINT'|'STORAGE_REGION'|'STORAGE_BUCKET'|'STORAGE_ACCESS_KEY_ID'|'STORAGE_SECRET_ACCESS_KEY'>):ObjectStore {
  const client=new S3Client({endpoint:config.STORAGE_ENDPOINT,region:config.STORAGE_REGION,
    credentials:{accessKeyId:config.STORAGE_ACCESS_KEY_ID,secretAccessKey:config.STORAGE_SECRET_ACCESS_KEY},maxAttempts:3});
  const Bucket=config.STORAGE_BUCKET;
  return {
    uploadUrl:(Key,ContentType,ContentLength,checksum)=>getSignedUrl(client,new PutObjectCommand({Bucket,Key,ContentType,ContentLength,ChecksumSHA256:Buffer.from(checksum,'hex').toString('base64')}),{expiresIn:60}),
    downloadUrl:(Key,name)=>getSignedUrl(client,new GetObjectCommand({Bucket,Key,ResponseContentDisposition:`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,ResponseCacheControl:'private, no-store'}),{expiresIn:60}),
    async head(Key){const r=await client.send(new HeadObjectCommand({Bucket,Key}));return {bytes:r.ContentLength||0,mime:r.ContentType||''};},
    async read(Key,maximum){const r=await client.send(new GetObjectCommand({Bucket,Key}));if(!r.Body||!r.ContentLength||r.ContentLength>maximum)throw new AppError('FILE_SIZE','Object exceeds its declared limit',413);
      const chunks:Uint8Array[]=[];let size=0;for await(const chunk of r.Body as AsyncIterable<Uint8Array>){size+=chunk.byteLength;if(size>maximum)throw new AppError('FILE_SIZE','Object exceeds its declared limit',413);chunks.push(chunk);}return Buffer.concat(chunks);},
    async put(Key,Body,ContentType){await client.send(new PutObjectCommand({Bucket,Key,Body,ContentType,CacheControl:'private, no-store'}));},
    async remove(Key){await client.send(new DeleteObjectCommand({Bucket,Key}));}
  };
}

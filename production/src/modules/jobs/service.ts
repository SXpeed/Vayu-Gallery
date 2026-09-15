import type { SQL,Database } from '../../core/database.js';
import { randomUUID } from 'node:crypto';
export type Job={id:string;tenant_id:string;kind:string;payload:Record<string,any>;lease_token:string;attempts:number;created_by:string};
export type JobHandler=(job:Job,context:{transaction:<T>(fn:(sql:SQL)=>Promise<T>)=>Promise<T>})=>Promise<void>;
export async function runOne(db:Database,handlers:Record<string,JobHandler>,log:(event:Record<string,unknown>)=>void=()=>{}) {
 const job=await db.transaction(async sql=>(await sql.query<Job>('SELECT * FROM security.claim_job()')).rows[0]);
 if(!job)return false;
 const transaction=<T>(fn:(sql:SQL)=>Promise<T>)=>db.transaction(async sql=>{
   await sql.query("SELECT set_config('vayu.job',$1,true),set_config('vayu.lease',$2,true),set_config('vayu.tenant',$3,true),set_config('vayu.request',$4,true)",[job.id,job.lease_token,job.tenant_id,`job:${job.id}`]);
   if(!(await sql.query('SELECT security.job_scope($1) AS ok',[job.tenant_id])).rows[0]?.ok)throw new Error('LEASE_LOST');
   return fn(sql);
 });
 let errorCode:string|null=null;
 try {
   const handler=handlers[job.kind];
   if(!handler)throw new Error('HANDLER_NOT_CONFIGURED');
   await handler(job,{transaction});
 }catch(e){
   // Keep customer content, object URLs, tokens and transport errors out of diagnostics.
   const message=e instanceof Error?e.message:'';
   errorCode=/^[A-Z_]{3,80}$/.test(message)?message:'JOB_FAILED';
 }
 const acknowledged=await db.transaction(async sql=>(await sql.query('SELECT security.finish_job($1,$2,$3) AS ok',[job.id,job.lease_token,errorCode])).rows[0]?.ok);
 log({event:'job.completed',jobId:job.id,tenantId:job.tenant_id,kind:job.kind,attempt:job.attempts,errorCode,acknowledged});
 return true;
}

import { resolveTxt } from 'node:dns/promises';
import { hash } from '../../core/crypto.js';
import type { JobHandler } from './service.js';
export const verifyDomain:JobHandler=async(job,{transaction})=>{
 const domain=await transaction(async sql=>(await sql.query('SELECT id,hostname,verification_hash,state FROM app.custom_domains WHERE tenant_id=$1 AND id=$2',[job.tenant_id,job.payload.domainId])).rows[0]);
 if(!domain)throw new Error('DOMAIN_UNAVAILABLE');if(domain.state!=='pending')return;
 const records=await resolveTxt(`_vayu-challenge.${domain.hostname}`);
 if(!records.some(record=>hash(record.join(''))===domain.verification_hash))throw new Error('DOMAIN_OWNERSHIP_UNVERIFIED');
 await transaction(sql=>sql.query('SELECT security.mark_domain_verified($1,$2)',[job.tenant_id,domain.id]));
 // Certificate provisioning is a separate external integration. DNS verification never activates a hostname.
};

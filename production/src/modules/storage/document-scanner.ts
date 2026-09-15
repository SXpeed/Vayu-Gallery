import {z} from 'zod';
import type {DocumentScanner} from '../jobs/media.js';
const result=z.object({verdict:z.enum(['clean','infected'])}).strict();
// Operator-configured service contract. Uploaded PDFs stay quarantined on every transport or schema failure.
export function documentScanner(url:string,token:string,fetcher:typeof fetch=fetch):DocumentScanner {
 const endpoint=new URL(url);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.hash)throw new Error('Invalid document scanner endpoint');
 return {async scanPdf(bytes){
  const response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/pdf',Accept:'application/json',Authorization:`Bearer ${token}`},body:bytes as Uint8Array<ArrayBuffer>,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!response.ok||!response.headers.get('Content-Type')?.startsWith('application/json')||!response.body)throw new Error('DOCUMENT_SCANNER_UNAVAILABLE');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>1024)throw new Error('DOCUMENT_SCANNER_RESPONSE');chunks.push(chunk.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  let parsed;try{parsed=result.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{throw new Error('DOCUMENT_SCANNER_RESPONSE');}
  return parsed.verdict;
 }};
}

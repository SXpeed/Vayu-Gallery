import { readConfig } from '../core/config.js';
import { postgres } from '../core/database.js';
import { s3 } from '../modules/storage/s3.js';
import { documentScanner } from '../modules/storage/document-scanner.js';
import { runOne } from '../modules/jobs/service.js';
import { verifyMedia } from '../modules/jobs/media.js';
import { generateCatalog } from '../modules/jobs/catalog.js';
import { verifyDomain } from '../modules/jobs/domain.js';
import { GlobalFonts } from '@napi-rs/canvas';
import { resolve } from 'node:path';
// run scripts use the production directory as cwd; bundled artifacts include these fonts.
const fonts=resolve(process.cwd(),'dist/fonts');
for(const [file,family] of [['Inter-var.woff2','Inter'],['PlayfairDisplay-var.woff2','Playfair Display']] as const){
  const registered=GlobalFonts.registerFromPath(resolve(fonts,file),family)||GlobalFonts.registerFromPath(resolve(process.cwd(),'../public/fonts',file),family);
  if(!registered)throw new Error('Catalog fonts are missing. Run npm run build.');
}
const config=readConfig(process.env);
if(!config.JOBS_DATABASE_URL)throw new Error('Set JOBS_DATABASE_URL explicitly');
const db=postgres(config.JOBS_DATABASE_URL,'vayu_jobs',{caFile:config.PG_CA_FILE,development:config.NODE_ENV!=='production'});
const scanner=config.DOCUMENT_SCANNER_URL&&config.DOCUMENT_SCANNER_TOKEN?documentScanner(config.DOCUMENT_SCANNER_URL,config.DOCUMENT_SCANNER_TOKEN):undefined;
const storage=s3(config),handlers={'media.verify':verifyMedia(storage,scanner),'catalog.generate':generateCatalog(storage),'domain.verify':verifyDomain};
let stopped=false;
process.once('SIGTERM',()=>{stopped=true;});process.once('SIGINT',()=>{stopped=true;});
try {while(!stopped){const ran=await runOne(db,handlers,e=>process.stdout.write(`${JSON.stringify(e)}\n`));if(!ran)await new Promise(resolve=>setTimeout(resolve,1000));}}
finally{await db.close();}

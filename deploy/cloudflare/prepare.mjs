import {readFile,writeFile,mkdir,readdir,copyFile,lstat,rm,realpath} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,relative,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {publicConfig} from './config.mjs';

const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../..'),output=resolve(here,'public');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifestPath=join(here,'build-manifest.json');
export async function files(dir){const list=[];if((await lstat(dir)).isSymbolicLink())throw new Error('Directories cannot be symbolic links.');for(const item of await readdir(dir,{withFileTypes:true})){if(item.isSymbolicLink())throw new Error('Directories cannot contain symbolic links.');if(item.isDirectory())for(const file of await files(join(dir,item.name)))list.push(`${item.name}/${file}`);else if(item.isFile())list.push(item.name);else throw new Error('Only regular files can be packaged.');}return list.sort();}
export function validateAssetNames(names){
  if(!Array.isArray(names)||!names.includes('index.html')||!names.some(file=>/^assets\/platform-[\w-]+\.js$/.test(file))||!names.some(file=>/^assets\/platform-[\w-]+\.css$/.test(file))||!names.includes('fonts/Inter-var.woff2')||!names.includes('fonts/PlayfairDisplay-var.woff2')||new Set(names).size!==names.length||names.some(file=>typeof file!=='string'||!/^(index\.html|assets\/[a-zA-Z0-9_.-]+\.(js|css)|fonts\/[a-zA-Z0-9_.-]+\.woff2)$/.test(file)))throw new Error('Unexpected or incomplete production assets.');
}
export async function sourceSnapshot(base=root){
  const names=['platform.html','scripts/run.mjs','package.json'];
  for(const directory of ['src','shared','public/fonts'])for(const name of await files(join(base,directory)))if(!name.split('/').some(part=>part.startsWith('.')||part==='node_modules')&&/\.(m?js|jsx|tsx?|css|woff2)$/.test(name))names.push(`${directory}/${name}`);
  return Promise.all(names.sort().map(async file=>({file,sha256:digest(await readFile(join(base,file)))})));
}
async function assertOutput(){
  if(relative(here,output)!=='public'||resolve(await realpath(here),'public')!==resolve(output))throw new Error('Unsafe preparation output directory.');
  try{if((await lstat(output)).isSymbolicLink()||await realpath(output)!==output)throw new Error('Refusing a linked output directory.');}catch(error){if(error.code!=='ENOENT')throw error;}
}
async function build(){
  const sources=await sourceSnapshot();
  // Explicit production entry; envDir is disabled by this existing builder.
  execFileSync(process.execPath,[join(root,'scripts/run.mjs'),'--platform','--build'],{cwd:root,stdio:'inherit'});
  const source=join(root,'production/dist/web'),html=await readFile(join(source,'platform.html'),'utf8');
  if(!/\/assets\/platform-[\w-]+\.js/.test(html)||html.includes('/src/main.jsx'))throw new Error('The production frontend entry was not built.');
  if(JSON.stringify(sources)!==JSON.stringify(await sourceSnapshot()))throw new Error('Application sources changed during the build. Rebuild when edits finish.');
  await assertOutput();try{await rm(output,{recursive:true});}catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(output,{recursive:true});await writeFile(join(output,'index.html'),html);
  for(const folder of ['assets','fonts']){await mkdir(join(output,folder));for(const file of await files(join(source,folder))){if(file.includes('/')||!(/^[a-zA-Z0-9_.-]+\.(js|css|woff2)$/.test(file)))throw new Error('Unexpected production asset.');await copyFile(join(source,folder,file),join(output,folder,file));}}
  const names=await files(output);validateAssetNames(names);
  const entries=[];for(const file of names)entries.push({file,sha256:digest(await readFile(join(output,file)))});
  await writeFile(manifestPath,JSON.stringify({application:'Vayu-Gallery',slug:'vayu-gallery',entry:'src/platform-main.jsx',builtAt:new Date().toISOString(),sources,files:entries},null,2)+'\n');
  console.log(`Prepared ${entries.length} production assets locally. No deployment was run.`);
}
export function deploymentAccount(value, environmentValue) {
  if(typeof value!=='string'||!/^[a-f0-9]{32}$/i.test(value))throw new Error('Supply the new Cloudflare account ID explicitly with --account-id.');
  if(environmentValue && (typeof environmentValue!=='string'||environmentValue.toLowerCase()!==value.toLowerCase()))throw new Error('The shell Cloudflare account differs from this project. Select the intended new account before deployment.');
  return value.toLowerCase();
}
export async function configure(args){
  const value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
  const vars=publicConfig({PUBLIC_ORIGIN:value('--public-origin'),API_ORIGIN:value('--api-origin'),STORAGE_ORIGIN:value('--storage-origin')});
  const template=JSON.parse(await readFile(join(here,'wrangler.example.jsonc'),'utf8'));
  const config={...template,account_id:deploymentAccount(value('--account-id')),vars,routes:[{pattern:new URL(vars.PUBLIC_ORIGIN).hostname,custom_domain:true}]};
  await writeFile(join(here,'wrangler.jsonc'),JSON.stringify(config,null,2)+'\n',{flag:'wx'});
  console.log('Created local wrangler.jsonc for review. Configure Access secrets in Cloudflare yourself before deployment.');
}
async function check(){
  const config=JSON.parse(await readFile(join(here,'wrangler.jsonc'),'utf8')),vars=publicConfig(config.vars||{});
  deploymentAccount(config.account_id,process.env.CLOUDFLARE_ACCOUNT_ID);
  if(config.name!=='vayu-gallery'||config.main!=='worker.mjs'||config.workers_dev!==false||config.preview_urls!==false||config.assets?.directory!=='./public'||config.assets?.binding!=='ASSETS'||config.assets?.run_worker_first!==true||config.assets?.html_handling!=='none'||config.assets?.not_found_handling!=='none'||config.routes?.length!==1||config.routes[0].pattern!==new URL(vars.PUBLIC_ORIGIN).hostname||config.routes[0].custom_domain!==true||Object.keys(config.vars).sort().join(',')!=='API_ORIGIN,PUBLIC_ORIGIN,STORAGE_ORIGIN')throw new Error('Hosting configuration does not match the reviewed Vayu-Gallery entry.');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(manifest.entry!=='src/platform-main.jsx'||manifest.slug!=='vayu-gallery')throw new Error('Missing production build manifest.');
  if(JSON.stringify(manifest.sources)!==JSON.stringify(await sourceSnapshot()))throw new Error('Application sources changed after packaging. Rebuild before deployment.');
  await assertOutput();
  const actual=await files(output),expected=manifest.files.map(item=>item.file);
  validateAssetNames(actual);validateAssetNames(expected);
  if(JSON.stringify(actual.slice().sort())!==JSON.stringify(expected.slice().sort()))throw new Error('Asset list differs from the production build manifest. Rebuild before deployment.');
  for(const item of manifest.files){if(!/^(index\.html|(assets|fonts)\/[a-zA-Z0-9_.-]+\.(js|css|woff2))$/.test(item.file)||digest(await readFile(join(output,item.file)))!==item.sha256)throw new Error('An asset differs from the verified production build.');}
  console.log('Local production assets and non-secret hosting configuration pass. This does not verify remote services, credentials, DNS, or deployment.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)try{
  const args=process.argv.slice(2);
  if(args.includes('--build'))await build();
  else if(args.includes('--configure'))await configure(args);
  else if(args.includes('--check'))await check();
  else throw new Error('Use --build, --configure with your account ID and three origins, or --check. This tool never deploys.');
}catch(error){console.error(error.code==='ENOENT'?'Preparation is incomplete. Build assets and configure your own origins first.':error.code==='EEXIST'?'wrangler.jsonc already exists. Review it manually; it was not overwritten.':error.message);process.exitCode=1;}


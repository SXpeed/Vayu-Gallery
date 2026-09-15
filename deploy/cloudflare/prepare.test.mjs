import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateAssetNames,sourceSnapshot,deploymentAccount} from './prepare.mjs';

const valid=['index.html','assets/platform-safe.js','assets/platform-safe.css','assets/chunk-safe.js','fonts/Inter-var.woff2','fonts/PlayfairDisplay-var.woff2'];

test('asset packaging requires the production entry and rejects sources, maps, local preview and path escapes',()=>{
  assert.doesNotThrow(()=>validateAssetNames(valid));
  for(const extra of ['.env','server/server.mjs','production/dist/api.js','assets/private.js.map','art/quiet.svg','assets/../../secret.js','fonts/private.js','assets/font.woff2','platform.html','index.html'])assert.throws(()=>validateAssetNames([...valid,extra]),/assets/);
  for(const required of ['index.html','assets/platform-safe.js','assets/platform-safe.css','fonts/Inter-var.woff2'])assert.throws(()=>validateAssetNames(valid.filter(file=>file!==required)),/assets/);
});

test('build snapshots cover current application sources without credential or runtime data paths',async()=>{
  const sources=await sourceSnapshot(),names=sources.map(item=>item.file);
  for(const required of ['platform.html','scripts/run.mjs','src/platform-main.jsx','shared/catalog-design.mjs','public/fonts/Inter-var.woff2'])assert.ok(names.includes(required),required);
  assert.equal(names.some(name=>/(^|\/)(\.env|\.git|\.wrangler|\.local-data|node_modules)(\/|$)/.test(name)),false);
  assert.ok(sources.every(item=>/^[a-f0-9]{64}$/.test(item.sha256)));
});

test('the checked-in template exposes no domain or credential and uses the isolated production package',async()=>{
  const config=JSON.parse(await readFile(new URL('./wrangler.example.jsonc',import.meta.url),'utf8'));
  assert.equal(config.name,'vayu-gallery');assert.deepEqual(config.routes,[]);
  assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
  assert.equal(config.assets.directory,'./public');assert.equal(config.assets.run_worker_first,true);
  assert.deepEqual(config.vars,{PUBLIC_ORIGIN:'',API_ORIGIN:'',STORAGE_ORIGIN:''});
  assert.equal(config.build.command,'node prepare.mjs --check');
  assert.equal(config.observability.logs.invocation_logs,false);
});

test('deployment requires an explicit account and rejects conflicting shell account selection',()=>{
  const intended='1234567890abcdef1234567890abcdef';
  assert.equal(deploymentAccount(intended.toUpperCase()),intended);
  assert.equal(deploymentAccount(intended,intended),intended);
  for(const invalid of [undefined,null,'','REPLACE_ACCOUNT_ID','abc',123])assert.throws(()=>deploymentAccount(invalid),/account ID/);
  assert.throws(()=>deploymentAccount(intended,'abcdef1234567890abcdef1234567890'),/differs/);
});

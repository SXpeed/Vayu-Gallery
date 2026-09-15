import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Hono} from 'hono';
import {installWeb} from '../src/http/web.js';
test('compiled web serving cannot fall back for API paths, source code or traversal',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'vayu-web-test-'));try{
  await mkdir(path.join(root,'assets'));await writeFile(path.join(root,'platform.html'),'<h1>Gallery</h1>');await writeFile(path.join(root,'assets','app.js'),'export const app=true;');
  const app=new Hono();installWeb(app,root);
  const index=await app.request('/');assert.equal(index.status,200);assert.match(index.headers.get('Content-Type')||'',/text\/html/);
  assert.equal((await app.request('/assets/app.js')).status,200);
  for(const url of ['/api/state','/api/galleries/unknown','/production/src/runtime/node.ts','/.env','/assets/%2e%2e%2fplatform.html','/assets/app.js.map'])assert.equal((await app.request(url)).status,404,url);
 }finally{const target=path.resolve(root);assert.ok(target.startsWith(path.resolve(tmpdir())+path.sep));assert.ok(path.basename(target).startsWith('vayu-web-test-'));await rm(target,{recursive:true,force:true});}
});

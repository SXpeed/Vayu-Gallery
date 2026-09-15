import test from 'node:test';
import assert from 'node:assert/strict';
import {createEdge} from './worker.mjs';
import {publicConfig} from './config.mjs';

const values={PUBLIC_ORIGIN:'https://app.vayu-gallery-demo.com',API_ORIGIN:'https://origin.vayu-gallery-demo.com',STORAGE_ORIGIN:'https://account.r2.cloudflarestorage.com',ORIGIN_ACCESS_CLIENT_ID:'test-only-service-client-id',ORIGIN_ACCESS_CLIENT_SECRET:'test-only-service-client-secret-not-a-real-token'};
const env=extra=>({...values,ASSETS:{async fetch(request){const path=new URL(request.url).pathname;return new Response(request.method==='HEAD'?null:`asset:${path}`,{headers:{'Content-Type':path.endsWith('.html')?'text/html':'text/javascript','Cache-Control':'public, max-age=3600'}});}},...extra});
const req=(path,init={})=>new Request(values.PUBLIC_ORIGIN+path,init);

test('missing, placeholder, local, credentialed and recursive origins fail closed',async()=>{
  let calls=0;const edge=createEdge({fetchOrigin:async()=>{calls++;throw Error();},log:()=>{}});
  for(const API_ORIGIN of ['', 'http://origin.vayu-gallery-demo.com','https://localhost','https://127.0.0.1','https://[::1]','https://api.example.com','https://user:secret@origin.vayu-gallery-demo.com','https://origin.vayu-gallery-demo.com/path',values.PUBLIC_ORIGIN]){
    assert.equal((await edge.fetch(req('/'),env({API_ORIGIN}))).status,503);
  }
  assert.equal((await edge.fetch(req('/api/session'),env({ORIGIN_ACCESS_CLIENT_SECRET:''}))).status,503);
  assert.equal(calls,0);
  assert.throws(()=>publicConfig({}),/Configure/);
  assert.throws(()=>publicConfig({...values,PUBLIC_ORIGIN:'https://vayu-gallery.account.workers.dev'}),/own application domain/);
});

test('only production entry and allowlisted assets are served; no local preview or source fallback',async()=>{
  const edge=createEdge({fetchOrigin:async()=>{throw Error('Unexpected origin call');},log:()=>{}});
  for(const path of ['/src/main.jsx','/server/server.mjs','/production/.env','/.git/config','/assets/private.js.map','/api/state','/api/action','/api/login','/api/files/id','/unknown-route','/art/quiet.svg'])assert.equal((await edge.fetch(req(path),env())).status,404,path);
  const home=await edge.fetch(req('/'),env());assert.equal(await home.text(),'asset:/index.html');assert.equal(home.headers.get('Cache-Control'),'private, no-store');
  const csp=home.headers.get('Content-Security-Policy');assert.ok(csp.includes(values.STORAGE_ORIGIN));assert.ok(csp.includes("script-src 'self'"));
  assert.equal((await edge.fetch(req('/assets/platform-test.js'),env())).status,200);
  assert.equal((await edge.fetch(new Request('https://wrong.vayu-gallery-demo.com/'),env())).status,421);
});

test('proxy preserves CSRF, provider context, version and body while replacing spoofed origin headers',async()=>{
  let captured;const edge=createEdge({fetchOrigin:async(url,init)=>{captured={url,init,body:await new Response(init.body).text()};return Response.json({saved:true});},log:()=>{}});
  const body=JSON.stringify({title:'Private catalog'}),provider='40b9d195-00c3-4cd0-b9fc-6a591301c59e';
  const response=await edge.fetch(req('/api/galleries/one/catalogs/two/design?selection=one',{method:'POST',headers:{Origin:values.PUBLIC_ORIGIN,'Content-Type':'application/json',Cookie:'__Host-vayu-session=session','X-CSRF-Token':'csrf','If-Match':'"7"','X-Provider-Access':provider,'CF-Access-Client-Secret':'forged','X-Forwarded-Host':'evil.com',Forwarded:'host=evil.com'},body}),env());
  assert.equal(response.status,200);assert.equal(captured.url.origin,values.API_ORIGIN);assert.equal(captured.url.search,'?selection=one');
  assert.equal(captured.init.headers.get('Cookie'),'__Host-vayu-session=session');assert.equal(captured.init.headers.get('Origin'),values.PUBLIC_ORIGIN);
  assert.equal(captured.init.headers.get('X-CSRF-Token'),'csrf');assert.equal(captured.init.headers.get('If-Match'),'"7"');assert.equal(captured.init.headers.get('X-Provider-Access'),provider);
  assert.equal(captured.init.headers.get('X-Forwarded-Host'),new URL(values.PUBLIC_ORIGIN).host);assert.equal(captured.init.headers.get('Forwarded'),null);
  assert.equal(captured.init.headers.get('CF-Access-Client-Secret'),values.ORIGIN_ACCESS_CLIENT_SECRET);assert.equal(captured.body,body);
  assert.equal(captured.init.cache,'no-store');assert.deepEqual(captured.init.cf,{cacheTtlByStatus:{'100-599':-1}});
  assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'),'no-store');
});

test('cross-origin mutations are rejected before calling the backend',async()=>{
  let calls=0;const edge=createEdge({fetchOrigin:async()=>{calls++;return Response.json({});}});
  for(const Origin of ['https://evil.com','null',''])assert.equal((await edge.fetch(req('/api/logout',{method:'POST',headers:{Origin}}),env())).status,403);
  assert.equal(calls,0);
});

test('OIDC redirects are not followed and separate secure session cookies remain separate',async()=>{
  const cookies=['__Host-vayu-session=session; Path=/; Secure; HttpOnly; SameSite=Lax','__Host-vayu-csrf=csrf; Path=/; Secure; SameSite=Lax'];
  let calls=0;const edge=createEdge({fetchOrigin:async(url,init)=>{calls++;assert.equal(init.redirect,'manual');const headers=new Headers({Location:calls===1?'https://identity.service-provider.com/authorize?state=opaque':`${values.API_ORIGIN}/`});for(const cookie of cookies)headers.append('Set-Cookie',cookie);return new Response(null,{status:302,headers});},log:()=>{}});
  const login=await edge.fetch(req('/auth/login'),env());assert.equal(login.headers.get('Location'),'https://identity.service-provider.com/authorize?state=opaque');assert.equal(calls,1);
  const callback=await edge.fetch(req('/auth/callback?code=private-code'),env());assert.equal(callback.headers.get('Location'),`${values.PUBLIC_ORIGIN}/`);assert.deepEqual(callback.headers.getSetCookie(),cookies);
});

test('private response bodies stream without buffering and keep origin status',async()=>{
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('private bytes'));controller.close();}});
  const edge=createEdge({fetchOrigin:async()=>new Response(stream,{status:206,headers:{'Content-Type':'image/webp','Content-Range':'bytes 0-12/13','Cache-Control':'public, max-age=86400'}})});
  const response=await edge.fetch(req('/api/galleries/one/media/two/content'),env());assert.equal(response.status,206);assert.equal(response.body,stream);assert.equal(response.headers.get('Content-Range'),'bytes 0-12/13');assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal(await response.text(),'private bytes');
});

test('readiness requires both production API database readiness and the built entry',async()=>{
  const ready=createEdge({fetchOrigin:async()=>Response.json({status:'ready'})});
  assert.equal((await ready.fetch(req('/health/ready'),env())).status,200);
  assert.equal((await ready.fetch(req('/health/ready',{method:'HEAD'}),env())).status,200);
  assert.equal((await ready.fetch(req('/health/ready'),env({ASSETS:{async fetch(){return new Response(null,{status:404});}}}))).status,503);
  const wrong=createEdge({fetchOrigin:async()=>new Response('sample preview', {status:200})});assert.equal((await wrong.fetch(req('/health/ready'),env())).status,503);
  const oversized=createEdge({fetchOrigin:async()=>new Response('x'.repeat(3000))});assert.equal((await oversized.fetch(req('/health/ready'),env())).status,503);
});

test('origin failures expose neither tokens, request query strings nor private transport errors',async()=>{
  const events=[];const edge=createEdge({fetchOrigin:async()=>{throw Error(`private details ${values.ORIGIN_ACCESS_CLIENT_SECRET}`);},log:event=>events.push(event)});
  const response=await edge.fetch(req('/auth/callback?code=secret-code'),env());assert.equal(response.status,503);
  const evidence=JSON.stringify(events)+await response.text();assert.equal(evidence.includes('secret-code'),false);assert.equal(evidence.includes(values.ORIGIN_ACCESS_CLIENT_SECRET),false);assert.equal(events[0].route,'auth');
});

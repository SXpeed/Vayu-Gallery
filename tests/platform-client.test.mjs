import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformClient } from '../src/platform-client.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ACCESS = '33333333-3333-4333-8333-333333333333';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const make = fetch => createPlatformClient({ fetch, cookies: () => 'vayu-csrf=test-token', secure: () => false });

test('a gallery-bound continuation cannot upload or save into a newly selected gallery',async()=>{
 const calls=[];const client=make(async path=>{calls.push(path);return json({ok:true});});client.selectGallery(A);
 const gallery=client.bindGallery(A);await gallery.galleryRequest('media/uploads',{body:{}});client.selectGallery(B);
 await assert.rejects(gallery.galleryRequest('media/complete',{body:{}}),{code:'SCOPE_CHANGED'});assert.equal(calls.length,1);
 client.selectGallery(A);await assert.rejects(gallery.galleryRequest('artworks'),{code:'SCOPE_CHANGED'});client.dispose();
});
test('production session rejects a legacy sample-server response',async()=>{
 const client=make(async()=>json({user:{id:'sample'},state:{}}));await assert.rejects(client.session(),{code:'INVALID_SESSION'});client.dispose();
});

test('gallery switching aborts pending mutations and never retries them in the next tenant', async () => {
  const calls = [];
  let resolve;
  const client = make((path, options) => { calls.push({ path, options }); return new Promise(done => { resolve = done; }); });
  client.selectGallery(A, ACCESS);
  const mutation = client.galleryRequest('artworks', { method: 'POST', body: { title: 'Original gallery' } });
  client.selectGallery(B);
  assert.equal(calls[0].options.signal.aborted, true);
  resolve(json({ id: 'saved-before-cancellation' }));
  await assert.rejects(mutation, { code: 'SCOPE_CHANGED' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/galleries/${A}/artworks`);
  assert.equal(calls[0].options.headers['X-Provider-Access'], ACCESS);
  client.dispose();
});

test('late responses are discarded even when fetch cancellation is ignored', async () => {
  let finish;
  const client = make(() => new Promise(resolve => { finish = resolve; }));
  client.selectGallery(A);
  const read = client.galleryRequest('catalogs');
  client.selectGallery(B);
  finish(json({ items: [{ title: 'Gallery A private catalog' }] }));
  await assert.rejects(read, { code: 'SCOPE_CHANGED' });
});

test('provider access never carries over to another gallery or unscoped requests', async () => {
  const calls = [];
  const client = make(async (path, options) => { calls.push({ path, options }); return json(path==='/api/session'?{id:A,name:'Provider',email:'provider@example.test',provider:true,organizations:[]}:{}); });
  client.selectGallery(A, ACCESS);
  await client.galleryRequest('catalogs');
  await client.session();
  client.selectGallery(B);
  await client.galleryRequest('catalogs');
  assert.equal(calls[0].options.headers['X-Provider-Access'], ACCESS);
  assert.equal(calls[1].options.headers['X-Provider-Access'], undefined);
  assert.equal(calls[2].options.headers['X-Provider-Access'], undefined);
  await assert.rejects(client.request(`/api/galleries/${A}/catalogs`), { code: 'GALLERY_SCOPE' });
  assert.equal(calls.length, 3);
});

test('mutations send fresh CSRF tokens, quoted versions and same-origin credentials', async () => {
  let cookie = '__Host-vayu-csrf=one; vayu-csrf=wrong';
  const calls = [];
  const client = createPlatformClient({ fetch: async (path, options) => { calls.push(options); return json({}); }, cookies: () => cookie, secure: () => true });
  client.selectGallery(A);
  await client.galleryRequest('catalogs/one', { method: 'PATCH', body: { title: 'Changed' }, version: 7 });
  cookie = '__Host-vayu-csrf=two';
  await client.galleryRequest('catalogs/one/archive', { method: 'POST', version: 8 });
  assert.equal(calls[0].headers['If-Match'], '"7"');
  assert.equal(calls[0].headers['X-CSRF-Token'], 'one');
  assert.equal(calls[1].headers['X-CSRF-Token'], 'two');
  assert.equal(calls[0].credentials, 'same-origin');
  assert.equal(calls[0].cache, 'no-store');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[1].body, '{}');
});

test('missing or duplicate secure CSRF cookie fails before making a mutation', async () => {
  let calls = 0;
  for (const cookie of ['vayu-csrf=insecure-fallback', '__Host-vayu-csrf=a; __Host-vayu-csrf=b']) {
    const client = createPlatformClient({ fetch: async () => { calls += 1; return json({}); }, cookies: () => cookie, secure: () => true });
    await assert.rejects(client.request('/api/organizations', { body: { name: 'Gallery' } }), { status: 403, code: 'CSRF' });
  }
  assert.equal(calls, 0);
});

test('caller cancellation propagates without silently retrying', async () => {
  let calls = 0;
  const client = make((path, options) => new Promise((resolve, reject) => {
    calls += 1;
    options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
  }));
  client.selectGallery(A);
  const controller = new AbortController();
  const pending = client.galleryRequest('artworks', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('logout cancels gallery requests, clears scope and uses a CSRF protected request', async () => {
  let finish;
  const calls = [];
  const client = make((path, options) => {
    calls.push({ path, options });
    return path === '/api/logout' ? Promise.resolve(json({ ok: true })) : new Promise(resolve => { finish = resolve; });
  });
  client.selectGallery(A, ACCESS);
  const old = client.galleryRequest('artworks');
  await client.logout();
  finish(json({ items: [] }));
  await assert.rejects(old, { code: 'SCOPE_CHANGED' });
  await assert.rejects(client.galleryRequest('artworks'), { code: 'GALLERY_REQUIRED' });
  assert.equal(calls[1].path, '/api/logout');
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'test-token');
  assert.equal(calls[1].options.headers['X-Provider-Access'], undefined);
});

test('structured API errors preserve useful status and support reference without retry', async () => {
  let calls = 0;
  const client = make(async () => { calls += 1; return json({ error: { code: 'PROVIDER_MFA', message: 'Recent provider MFA is required' }, requestId: 'support-reference' }, 403); });
  await assert.rejects(client.request('/api/provider/organizations'), { status: 403, code: 'PROVIDER_MFA', requestId: 'support-reference' });
  assert.equal(calls, 1);
});

test('API paths and gallery identity are validated before transport', async () => {
  let calls = 0;
  const client = make(async () => { calls += 1; return json({}); });
  assert.throws(() => client.selectGallery('other-gallery'), TypeError);
  client.selectGallery(A);
  for (const path of ['https://outside.test/api/session', '/api/../auth/login', '/api/%2e%2e/auth/login', '/api//session', '/api/session#token', '/api\\session']) await assert.rejects(client.request(path), TypeError);
  await assert.rejects(client.galleryRequest('../organizations'), TypeError);
  await assert.rejects(client.galleryRequest('artworks', { method: 'PATCH', body: {}, version: 0 }), TypeError);
  assert.equal(calls, 0);
});

test('dispose cancels all outstanding work and refuses subsequent requests', async () => {
  let finish;
  const client = make(() => new Promise(resolve => { finish = resolve; }));
  const pending = client.session();
  client.dispose();
  finish(json({ id: 'session' }));
  await assert.rejects(pending, { code: 'SCOPE_CHANGED' });
  await assert.rejects(client.session(), { code: 'CLIENT_DISPOSED' });
});

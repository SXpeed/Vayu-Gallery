import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeSeed } from '../server/seed.mjs';
import { act, upload, canReadFile, visibleState } from '../server/domain.mjs';
import { createAppServer } from '../server/server.mjs';

const png = {
  name: 'private-photo.png', mime: 'image/png',
  data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]).toString('base64'),
};
const pdf = {
  name: 'selection.pdf', mime: 'application/pdf',
  data: Buffer.from('%PDF-1.4\nlocal regression fixture').toString('base64'),
};
function fixture() {
  const s = makeSeed();
  const [admin, member, guest, other] = s.users;
  return { s, admin, member, guest, other };
}
const save = (s, u, entity, data, entityId) => act(s, u, { action: 'save', entity, data, entityId });
const change = (s, u, action, entity, entityId, data) => act(s, u, { action, entity, entityId, data });
const denied = fn => assert.throws(fn, error => error.status === 403);
const conflict = fn => assert.throws(fn, error => error.status === 409);
function invoiceAndPayment(s, u) {
  const invoice = save(s, u, 'invoices', { title: 'Regression invoice', customerId: 'c1', artworkIds: ['a1'], taxRate: 0, sellerAddress: 'Gallery address, Mumbai' });
  change(s, u, 'invoice.issue', undefined, invoice.id);
  const payment = save(s, u, 'payments', { title: 'Regression payment', invoiceId: invoice.id });
  return { invoice, payment };
}

test('private room image IDs cannot be published through artwork records', () => {
  const { s, admin, member, other } = fixture();
  const file = upload(s, member, png);
  change(s, member, 'message.send', 'rooms', 'room2', { fileId: file.id });
  const originalImage = s.artworks.find(a => a.id === 'a1').image;
  assert.equal(canReadFile(s, admin, file.id), false);
  denied(() => save(s, admin, 'artworks', { image: `/api/files/${file.id}` }, 'a1'));
  assert.equal(s.artworks.find(a => a.id === 'a1').image, originalImage);
  assert.equal(canReadFile(s, admin, file.id), false);
  assert.equal(canReadFile(s, other, file.id), false);
  assert.equal(canReadFile(s, member, file.id), true);
});

test('artwork image references reject accessible PDFs', () => {
  const { s, admin } = fixture();
  const file = upload(s, admin, pdf);
  denied(() => save(s, admin, 'artworks', { image: `/api/files/${file.id}` }, 'a1'));
});

test('removed uploaders cannot reuse private files in messages or catalog versions', () => {
  const { s, admin, member } = fixture();
  const file = upload(s, member, pdf);
  change(s, member, 'message.send', 'rooms', 'room1', { fileId: file.id });
  save(s, admin, 'rooms', { memberIds: ['admin', 'client'] }, 'room1');
  assert.equal(canReadFile(s, member, file.id), false);
  const messagesBefore = s.messages.length;
  denied(() => change(s, member, 'message.send', 'conversations', 'dm1', { fileId: file.id }));
  denied(() => change(s, member, 'catalog.version', undefined, 'cat1', { fileId: file.id }));
  assert.equal(s.messages.length, messagesBefore);
  assert.equal(s.catalogs[0].versions.length, 0);
  assert.equal(canReadFile(s, admin, file.id), true);
});

test('demoting a member to guest revokes direct-message attachment access', () => {
  const { s, admin, member } = fixture();
  const file = upload(s, admin, png);
  change(s, admin, 'message.send', 'conversations', 'dm1', { fileId: file.id });
  assert.equal(canReadFile(s, member, file.id), true);
  change(s, admin, 'member.update', undefined, member.id, { role: 'guest' });
  const visible = visibleState(s, member);
  assert.deepEqual(visible.conversations, []);
  assert.equal(canReadFile(s, member, file.id), false);
  assert.equal(visible.files.some(f => f.id === file.id), false);
  assert.equal(canReadFile(s, admin, file.id), true);
});

test('issued invoices stay frozen after payment requests are removed and stale requests cannot be restored', () => {
  const { s, admin } = fixture();
  const { invoice, payment } = invoiceAndPayment(s, admin);
  assert.throws(() => save(s, admin, 'invoices', { taxRate: 100 }, invoice.id));
  assert.equal(s.invoices.find(i => i.id === invoice.id).total, payment.amount);
  change(s, admin, 'trash', 'payments', payment.id);
  assert.throws(() => save(s, admin, 'invoices', { taxRate: 100 }, invoice.id), /Only draft/);
  // A legacy mismatched request is still rejected even if persisted before the issue freeze.
  payment.amount -= 1;
  conflict(() => change(s, admin, 'restore', 'payments', payment.id));
  assert.ok(payment.deletedAt);
});

test('legacy mismatched payment amounts cannot mark an invoice or artwork paid', () => {
  const { s, admin } = fixture();
  const { invoice, payment } = invoiceAndPayment(s, admin);
  // Model a stale record persisted before invoice freezing was introduced.
  payment.amount -= 1;
  const auditCount = s.audit.length;
  conflict(() => change(s, admin, 'payment.simulate', undefined, payment.id));
  assert.equal(payment.status, 'Pending');
  assert.equal(invoice.status, 'Issued');
  assert.equal(s.artworks.find(a => a.id === 'a1').status, 'Available');
  assert.equal(s.audit.length, auditCount);
});

test('restoring a pending payment cannot duplicate another active request', () => {
  const { s, admin } = fixture();
  const { invoice, payment } = invoiceAndPayment(s, admin);
  change(s, admin, 'trash', 'payments', payment.id);
  const replacement = save(s, admin, 'payments', { title: 'Replacement request', invoiceId: invoice.id });
  conflict(() => change(s, admin, 'restore', 'payments', payment.id));
  assert.ok(payment.deletedAt);
  assert.deepEqual(s.payments.filter(p => p.invoiceId === invoice.id && !p.deletedAt).map(p => p.id), [replacement.id]);
});

test('issued invoices are retained and legacy orphan payment requests cannot be restored', () => {
  const { s, admin } = fixture();
  const { invoice, payment } = invoiceAndPayment(s, admin);
  change(s, admin, 'trash', 'payments', payment.id);
  assert.throws(() => change(s, admin, 'trash', 'invoices', invoice.id), /must be retained/);
  // Model an orphan created by the older implementation that allowed invoice deletion.
  s.invoices = s.invoices.filter(i => i.id !== invoice.id);
  conflict(() => change(s, admin, 'restore', 'payments', payment.id));
  assert.ok(payment.deletedAt);
  assert.equal(s.invoices.some(i => i.id === invoice.id), false);
});

test('catalog purge preserves a shared file until the last catalog reference is removed', () => {
  const { s, admin } = fixture();
  const file = upload(s, admin, pdf);
  const second = save(s, admin, 'catalogs', { title: 'Second saved catalog' });
  for (const catalogId of ['cat1', second.id]) change(s, admin, 'catalog.version', undefined, catalogId, { fileId: file.id });
  change(s, admin, 'trash', 'catalogs', 'cat1');
  change(s, admin, 'purge', 'catalogs', 'cat1');
  assert.ok(s.files.some(f => f.id === file.id));
  assert.equal(second.versions[0].fileId, file.id);
  assert.equal(canReadFile(s, admin, file.id), true);
  change(s, admin, 'trash', 'catalogs', second.id);
  change(s, admin, 'purge', 'catalogs', second.id);
  assert.equal(s.files.some(f => f.id === file.id), false);
});

test('catalog purge preserves files referenced by inquiries, including restorable inquiries', () => {
  const { s, admin } = fixture();
  const file = upload(s, admin, pdf);
  change(s, admin, 'catalog.version', undefined, 'cat1', { fileId: file.id });
  save(s, admin, 'inquiries', { attachments: [file.id] }, 'q1');
  change(s, admin, 'trash', 'inquiries', 'q1');
  change(s, admin, 'trash', 'catalogs', 'cat1');
  change(s, admin, 'purge', 'catalogs', 'cat1');
  assert.ok(s.files.some(f => f.id === file.id));
  change(s, admin, 'restore', 'inquiries', 'q1');
  assert.deepEqual(s.inquiries.find(q => q.id === 'q1').attachments, [file.id]);
});

test('guest directory contains only room participants and does not disclose their email addresses', () => {
  const { s, admin, guest } = fixture();
  const unrelated = change(s, admin, 'member.add', undefined, undefined, { name: 'Unrelated member', email: 'unrelated@example.test', role: 'member' });
  const visible = visibleState(s, guest);
  assert.equal(visible.users.some(u => u.id === unrelated.id), false);
  assert.deepEqual(visible.users.map(u => u.id).sort(), ['admin', 'client', 'member']);
  assert.ok(visible.users.filter(u => u.id !== guest.id).every(u => u.email === undefined));
  assert.equal(visible.users.find(u => u.id === guest.id).email, guest.email);
  save(s, admin, 'rooms', { memberIds: ['admin', 'member'] }, 'room1');
  assert.deepEqual(visibleState(s, guest).users.map(u => u.id), [guest.id]);
});

test('sale completion audits every related status change with a shared request identifier', () => {
  const { s, admin } = fixture();
  const invoice = save(s, admin, 'invoices', { title: 'Reserved artwork sale', customerId: 'c1', inquiryId: 'q1', artworkIds: ['a2'], taxRate: 0, sellerAddress: 'Gallery address, Mumbai' });
  change(s, admin, 'invoice.issue', undefined, invoice.id);
  const payment = save(s, admin, 'payments', { title: 'Reserved artwork payment', invoiceId: invoice.id });
  const requestId = 'sale-regression-request';
  act(s, admin, { action: 'payment.simulate', entityId: payment.id }, requestId);
  const events = s.audit.filter(e => e.requestId === requestId);
  const changes = [
    ['reservations', 'res1', 'Active', 'Completed'],
    ['artworks', 'a2', 'Reserved', 'Sold'],
    ['invoices', invoice.id, 'Issued', 'Paid'],
    ['inquiries', 'q1', 'Interested', 'Converted'],
    ['payments', payment.id, 'Pending', 'Paid'],
  ];
  for (const [entity, entityId, before, after] of changes) {
    const event = events.find(e => e.entity === entity && e.entityId === entityId);
    assert.ok(event, `Missing ${entity} audit event`);
    assert.equal(event.actorId, admin.id);
    assert.equal(event.workspaceId, admin.workspaceId);
    assert.equal(event.outcome, 'success');
    assert.deepEqual(event.changes.find(c => c.field === 'status'), { field: 'status', before, after });
  }
});

async function temporaryServer(t) {
  const tempParent = path.resolve(tmpdir());
  const prefix = 'vayu-review-regression-';
  const root = mkdtempSync(path.join(tempParent, prefix));
  const server = createAppServer({ root });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const resolved = path.resolve(root);
    // Only delete the unique temporary directory created by this fixture.
    assert.equal(path.dirname(resolved), tempParent);
    assert.ok(path.basename(resolved).startsWith(prefix));
    rmSync(resolved, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function request(endpoint, body, expectedStatus = 200) {
    const response = await fetch(`${base}/api/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const newCookie = response.headers.get('set-cookie');
    if (newCookie) cookie = newCookie.split(';')[0];
    const result = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(result));
    return result;
  }
  return { base, request, login: userId => request('login', { userId }) };
}

test('backup restore preserves removed room access and revokes restored public links', async t => {
  const f = await temporaryServer(t);
  await f.login('admin');
  const file = await f.request('upload', pdf);
  await f.request('action', { action: 'catalog.version', entityId: 'cat1', data: { fileId: file.id } });
  const revoked = (await f.request('action', { action: 'share.create', entityId: 'cat1', data: { days: 1 } })).result;
  const active = (await f.request('action', { action: 'share.create', entityId: 'cat1', data: { days: 1 } })).result;
  const backup = await f.request('backups', {});
  await f.request('action', { action: 'save', entity: 'rooms', entityId: 'room1', data: { memberIds: ['admin', 'member'] } });
  await f.request('action', { action: 'share.revoke', entityId: revoked.id });
  await f.login('other');
  const otherArtwork = (await f.request('action', { action: 'save', entity: 'artworks', data: { title: 'Other workspace after backup', price: 10 } })).result;
  await f.login('admin');
  await f.request('backups/restore', { name: backup.name });
  const state = await f.request('state');
  assert.deepEqual(state.rooms.find(r => r.id === 'room1').memberIds, ['admin', 'member']);
  assert.ok(state.audit.some(e => e.action === 'catalog.share_revoked' && e.entityId === revoked.id));
  assert.ok(state.audit.some(e => e.action === 'backup.restored'));
  for (const share of [revoked, active]) {
    const response = await fetch(`${f.base}/api/shared/${share.token}`);
    await response.arrayBuffer();
    assert.equal(response.status, 404);
  }
  await f.login('client');
  assert.equal((await f.request('state')).rooms.length, 0);
  await f.request(`files/${file.id}`, undefined, 404);
  await f.login('other');
  assert.ok((await f.request('state')).artworks.some(a => a.id === otherArtwork.id));
});

test('backup restore does not reopen a private room that was permanently removed', async t => {
  const f = await temporaryServer(t);
  await f.login('admin');
  const file = await f.request('upload', png);
  const room = (await f.request('action', { action: 'save', entity: 'rooms', data: { title: 'Removed private room', memberIds: ['admin', 'client'], attachments: [file.id] } })).result;
  const backup = await f.request('backups', {});
  await f.request('action', { action: 'trash', entity: 'rooms', entityId: room.id });
  await f.request('action', { action: 'purge', entity: 'rooms', entityId: room.id });
  await f.request('backups/restore', { name: backup.name });
  assert.equal((await f.request('state')).rooms.some(r => r.id === room.id), false);
  await f.login('client');
  assert.equal((await f.request('state')).rooms.some(r => r.id === room.id), false);
  await f.request(`files/${file.id}`, undefined, 404);
});

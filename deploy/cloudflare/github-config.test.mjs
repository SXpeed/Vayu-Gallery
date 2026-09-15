import test from 'node:test';
import assert from 'node:assert/strict';
import { githubConfiguration } from './github-config.mjs';

const valid = () => ({WORKERS_CI: '1', WORKERS_CI_BRANCH: 'main', WORKERS_CI_COMMIT_SHA: 'a'.repeat(40), VAYU_CLOUDFLARE_ACCOUNT_ID: '1234567890abcdef1234567890abcdef', VAYU_PUBLIC_ORIGIN: 'https://app.vayu-gallery-demo.com', VAYU_API_ORIGIN: 'https://origin.vayu-gallery-demo.com', VAYU_STORAGE_ORIGIN: 'https://account.r2.cloudflarestorage.com'});

test('GitHub deployment configuration requires the main branch build and explicit service settings', () => {
  assert.equal(githubConfiguration(valid())[1], valid().VAYU_CLOUDFLARE_ACCOUNT_ID);
  for (const override of [{WORKERS_CI: undefined}, {WORKERS_CI_BRANCH: 'feature'}, {WORKERS_CI_COMMIT_SHA: ''}]) assert.throws(() => githubConfiguration({...valid(), ...override}), /GitHub main branch/);
  for (const name of ['VAYU_CLOUDFLARE_ACCOUNT_ID','VAYU_PUBLIC_ORIGIN','VAYU_API_ORIGIN','VAYU_STORAGE_ORIGIN']) assert.throws(() => githubConfiguration({...valid(), [name]: ''}), new RegExp(name));
});

test('CI cannot redirect deployment to another account, loop back to the frontend, or serialize secrets', () => {
  assert.throws(() => githubConfiguration({...valid(), CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32)}), /differs/);
  assert.throws(() => githubConfiguration({...valid(), VAYU_API_ORIGIN: valid().VAYU_PUBLIC_ORIGIN}), /separate/);
  assert.throws(() => githubConfiguration({...valid(), VAYU_API_ORIGIN: 'https://user:password@origin.vayu-gallery-demo.com'}), /without a path or credentials/);
  const args = githubConfiguration({...valid(), CLOUDFLARE_API_TOKEN: 'sensitive-test-value', ORIGIN_ACCESS_CLIENT_SECRET: 'sensitive-test-value'});
  assert.equal(args.join(' ').includes('sensitive-test-value'), false);
});

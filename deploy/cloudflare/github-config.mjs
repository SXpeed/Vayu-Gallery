import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configure, deploymentAccount } from './prepare.mjs';
import { publicConfig } from './config.mjs';

// This entry is for Cloudflare's build of the connected GitHub main branch.
// It never reads local credentials, deploys, or fills in a missing service.
export function githubConfiguration(env) {
  if (env.WORKERS_CI !== '1' || env.WORKERS_CI_BRANCH !== 'main' || !/^[a-f0-9]{40}$/i.test(env.WORKERS_CI_COMMIT_SHA || '')) {
    throw new Error('Deploy through the connected GitHub main branch in Cloudflare Workers Builds.');
  }
  const required = ['VAYU_CLOUDFLARE_ACCOUNT_ID', 'VAYU_PUBLIC_ORIGIN', 'VAYU_API_ORIGIN', 'VAYU_STORAGE_ORIGIN'];
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing Cloudflare build variables: ${missing.join(', ')}. Configure the production services before deployment.`);
  const account = deploymentAccount(env.VAYU_CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_ACCOUNT_ID);
  const vars = publicConfig({PUBLIC_ORIGIN: env.VAYU_PUBLIC_ORIGIN, API_ORIGIN: env.VAYU_API_ORIGIN, STORAGE_ORIGIN: env.VAYU_STORAGE_ORIGIN});
  return ['--account-id', account, '--public-origin', vars.PUBLIC_ORIGIN, '--api-origin', vars.API_ORIGIN, '--storage-origin', vars.STORAGE_ORIGIN];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await configure(githubConfiguration(process.env)); }
  catch (error) { console.error(error.code === 'EEXIST' ? 'A deployment config already exists. Use a clean GitHub build; it was not overwritten.' : error.message); process.exitCode = 1; }
}

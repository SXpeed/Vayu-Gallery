import { build } from 'esbuild';
import { cp,mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await build({entryPoints:{api:'src/runtime/node.ts',jobs:'src/runtime/jobs.ts'},outdir:'dist',bundle:true,platform:'node',target:'node22',format:'esm',packages:'external',sourcemap:true});
await mkdir('dist/fonts',{recursive:true});
await cp('../public/fonts','dist/fonts',{recursive:true});
execFileSync(process.execPath,['../scripts/run.mjs','--platform','--build'],{stdio:'inherit'});

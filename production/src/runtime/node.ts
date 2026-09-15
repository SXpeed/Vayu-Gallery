import { serve } from '@hono/node-server';
import { readConfig } from '../core/config.js';
import { postgres } from '../core/database.js';
import { createIdentity } from '../modules/auth/service.js';
import { s3 } from '../modules/storage/s3.js';
import { createApp } from '../http/app.js';
import { installWeb } from '../http/web.js';
import { fileURLToPath } from 'node:url';
const config=readConfig(process.env);
const db=postgres(config.DATABASE_URL,'vayu_api',{caFile:config.PG_CA_FILE,development:config.NODE_ENV!=='production'});
const identityDb=postgres(config.AUTH_DATABASE_URL,'vayu_identity',{caFile:config.PG_CA_FILE,development:config.NODE_ENV!=='production'});
const app=createApp({config,db,identity:createIdentity(config,identityDb),storage:s3(config)});
installWeb(app,fileURLToPath(new URL('./web/',import.meta.url)));
const server=serve({fetch:app.fetch,port:config.PORT,hostname:config.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1'});
async function shutdown(){server.close();await Promise.all([db.close(),identityDb.close()]);}
process.once('SIGTERM',()=>{void shutdown();});process.once('SIGINT',()=>{void shutdown();});

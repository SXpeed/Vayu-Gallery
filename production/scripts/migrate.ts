import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { migrate } from '../src/core/migrations.js';
const url=process.env.MIGRATION_DATABASE_URL;
if(!url)throw new Error('Set MIGRATION_DATABASE_URL explicitly. Parent environment files are never loaded.');
const local=['localhost','127.0.0.1'].includes(new URL(url).hostname);
const client=new Client({connectionString:url,ssl:local&&process.env.NODE_ENV==='development'?false:{rejectUnauthorized:true,...(process.env.PG_CA_FILE?{ca:readFileSync(process.env.PG_CA_FILE,'utf8')}:{})}});
try{await client.connect();await migrate(client);process.stdout.write('Database migrations applied.\n');}
finally{await client.end();}

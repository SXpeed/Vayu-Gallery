import { readdir,readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hash } from './crypto.js';
import type { SQL } from './database.js';
export async function migrations() {
  const dir=fileURLToPath(new URL('../../migrations/',import.meta.url));
  return Promise.all((await readdir(dir)).filter(f=>/^\d{3}_[a-z_]+\.sql$/.test(f)).sort().map(async name=>({name,sql:await readFile(`${dir}/${name}`,'utf8')})));
}
export async function migrate(sql:SQL,execute:(text:string)=>Promise<unknown>=(text)=>sql.query(text)) {
  await sql.query('SELECT pg_advisory_lock(824817120)');
  try {
    await sql.query('CREATE TABLE IF NOT EXISTS public.vayu_schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    for(const migration of await migrations()) {
      const checksum=hash(migration.sql),previous=(await sql.query('SELECT checksum FROM public.vayu_schema_migrations WHERE name=$1',[migration.name])).rows[0];
      if(previous){if(previous.checksum!==checksum)throw new Error(`Applied migration was changed: ${migration.name}`);continue;}
      await sql.query('BEGIN');
      try {await execute(migration.sql);await sql.query('INSERT INTO public.vayu_schema_migrations(name,checksum) VALUES($1,$2)',[migration.name,checksum]);await sql.query('COMMIT');}
      catch(e){await sql.query('ROLLBACK');throw e;}
    }
  } finally {await sql.query('SELECT pg_advisory_unlock(824817120)');}
}

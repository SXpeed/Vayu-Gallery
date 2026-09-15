import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/core/migrations.js';
test('all migrations execute on PostgreSQL and can be applied again',async()=>{
 const db=new PGlite();
 try {
   await migrate(db,text=>db.exec(text));await migrate(db,text=>db.exec(text));
   const tables=await db.query<{tablename:string;rowsecurity:boolean}>("SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='app'");
   assert.ok(tables.rows.length>=30);assert.ok(tables.rows.every(t=>t.rowsecurity));
 } finally {await db.close();}
});

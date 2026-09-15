import { Client } from 'pg';
import { z } from 'zod';
// Offline break-glass operator command. Never creates passwords, sessions or sample users.
const userId=z.uuid().parse(process.argv[2]);
if(!process.env.MIGRATION_DATABASE_URL)throw new Error('Set MIGRATION_DATABASE_URL explicitly');
const client=new Client({connectionString:process.env.MIGRATION_DATABASE_URL,ssl:{rejectUnauthorized:true}});
try {
 await client.connect();await client.query('BEGIN');
 await client.query('LOCK TABLE control.provider_staff IN EXCLUSIVE MODE');
 if((await client.query('SELECT 1 FROM control.provider_staff')).rowCount)throw new Error('Provider is already bootstrapped. Use an audited provider administration operation.');
 const user=(await client.query('SELECT id FROM identity.users WHERE id=$1 AND email_verified AND disabled_at IS NULL',[userId])).rows[0];
 if(!user)throw new Error('An existing verified identity is required');
 await client.query("INSERT INTO control.provider_staff(user_id,role) VALUES($1,'owner')",[userId]);
 await client.query("INSERT INTO control.audit_events(actor_id,actor_type,action,entity_type,entity_id) VALUES($1,'system','provider.bootstrapped','provider_staff',$1::text)",[userId]);
 await client.query('COMMIT');process.stdout.write('Provider owner assigned to the verified identity.\n');
}catch(e){await client.query('ROLLBACK');throw e;}finally{await client.end();}

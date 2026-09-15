import { Pool, Client, type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { AppError } from './errors.js';

export interface SQL {
  query<T extends Record<string,any> = Record<string,any>>(text: string, values?: any[]): Promise<{rows:T[]; rowCount?:number|null}>;
}
export interface Database { transaction<T>(fn:(sql:SQL)=>Promise<T>):Promise<T>; close():Promise<void>; }
export type DatabaseRole = 'vayu_api'|'vayu_identity'|'vayu_jobs';
export type Scope = {sessionHash:string;requestId:string;tenantId?:string;providerAccessId?:string;csrfHash?:string};

export function postgres(url:string, role:DatabaseRole, options:{caFile?:string;development?:boolean;serverless?:boolean}={}):Database {
  const hostname=new URL(url).hostname;
  const local=['localhost','127.0.0.1','[::1]'].includes(hostname);
  const config={connectionString:url,ssl:local&&options.development ? false : {rejectUnauthorized:true, ...(options.caFile?{ca:readFileSync(options.caFile,'utf8')}:{})},
    connectionTimeoutMillis:10000,statement_timeout:15000,application_name:`vayu-${role}`};
  // Node uses a bounded pool. Serverless opens a request-local client against a managed pooler/Hyperdrive.
  const pool=options.serverless?undefined:new Pool({...config,max:8,idleTimeoutMillis:30000});
  return {
    async transaction(fn) {
      const client=pool?await pool.connect():new Client(config);
      if(!pool) await (client as Client).connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`); // Closed server-owned enum, never request input.
        await client.query("SET LOCAL statement_timeout='15s'");
        await client.query("SET LOCAL lock_timeout='5s'");
        const identity=await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN (current_user,session_user)');
        if(identity.rows.some(r=>r.rolsuper||r.rolbypassrls)) throw new Error('Unsafe runtime database role');
        const ownership=await client.query("SELECT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('identity','control','app','security','delivery') AND pg_has_role(session_user,c.relowner,'member')) AS unsafe");
        if(ownership.rows[0]?.unsafe)throw new Error('Runtime login must not own or assume ownership of application tables');
        const overlapping=await client.query("SELECT EXISTS(SELECT FROM pg_roles WHERE rolname=ANY($1::text[]) AND pg_has_role(session_user,oid,'member')) AS unsafe",[['vayu_api','vayu_identity','vayu_jobs'].filter(r=>r!==role)]);
        if(overlapping.rows[0]?.unsafe)throw new Error('Runtime database roles must not overlap');
        const result=await fn(client);
        await client.query('COMMIT'); return result;
      } catch(e) { await client.query('ROLLBACK'); throw e; }
      finally { if(pool) (client as PoolClient).release(); else await client.end(); }
    },
    async close(){await pool?.end();}
  };
}
export async function setScope(sql:SQL, scope:Scope) {
  await sql.query("SELECT set_config('vayu.session',$1,true),set_config('vayu.request',$2,true),set_config('vayu.tenant',$3,true),set_config('vayu.provider_access',$4,true)",
    [scope.sessionHash,scope.requestId,scope.tenantId||'',scope.providerAccessId||'']);
}
export async function authenticated<T>(db:Database,scope:Scope,fn:(sql:SQL)=>Promise<T>):Promise<T> {
  const validate=async(sql:SQL)=>{
    await setScope(sql,scope);
    const result=await sql.query('SELECT security.user_id() AS id, security.check_csrf($1) AS csrf',[scope.csrfHash||'']);
    if(!result.rows[0]?.id) throw new AppError('UNAUTHENTICATED','Sign in required',401);
    if(scope.csrfHash!==undefined&&!result.rows[0].csrf) throw new AppError('CSRF','Refresh this page before trying again',403);
    if(scope.tenantId) {
      const access=await sql.query('SELECT security.tenant_access($1) AND ($2::boolean=false OR security.provider_scope($1)) AS allowed',[scope.tenantId,Boolean(scope.providerAccessId)]);
      if(!access.rows[0]?.allowed) throw new AppError('TENANT_DENIED','Gallery access denied',403);
    }
  };
  // Provider access evidence survives a later rejected mutation or database rollback.
  if(scope.providerAccessId&&scope.tenantId) await db.transaction(async sql=>{
    await validate(sql);
    await sql.query("SELECT security.append_audit($1::uuid,'provider.request','organizations',($1::uuid)::text,jsonb_build_object('requestId',$2::text))",[scope.tenantId,scope.requestId]);
  });
  return db.transaction(async sql=>{
    await validate(sql);
    return fn(sql);
  });
}
export async function rateLimit(db:Database,key:string,maximum:number,seconds:number) {
  // Its own transaction commits rejected attempts instead of rolling the counter back.
  const allowed=await db.transaction(async sql=>(await sql.query('SELECT security.consume_rate($1,$2,$3) AS ok',[key,maximum,seconds])).rows[0]?.ok);
  if(!allowed) throw new AppError('RATE_LIMIT','Too many requests. Try again shortly.',429);
}

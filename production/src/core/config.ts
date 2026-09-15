import { z } from 'zod';
const secureUrl = z.url().refine(v => new URL(v).protocol === 'https:', 'HTTPS is required');
const databaseUrl = z.string().startsWith('postgresql://').or(z.string().startsWith('postgres://'));
const schema = z.object({
  NODE_ENV: z.enum(['production','development','test']).default('production'),
  APP_ORIGIN: z.url().refine(v => new URL(v).pathname === '/' && !new URL(v).username && !new URL(v).search && !new URL(v).hash, 'Use an origin only'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(4180),
  DATABASE_URL: databaseUrl, AUTH_DATABASE_URL: databaseUrl,
  OIDC_ISSUER: secureUrl, OIDC_CLIENT_ID: z.string().min(1), OIDC_CLIENT_SECRET: z.string().min(12),
  OIDC_MFA_ACR: z.string().min(1).transform(v=>v.split(',').map(s=>s.trim()).filter(Boolean)),
  TOKEN_ENCRYPTION_KEY: z.string().min(32),
  STORAGE_ENDPOINT: secureUrl, STORAGE_REGION: z.string().default('auto'), STORAGE_BUCKET: z.string().min(3),
  STORAGE_ACCESS_KEY_ID: z.string().min(8), STORAGE_SECRET_ACCESS_KEY: z.string().min(16),
  PG_CA_FILE: z.string().optional(), JOBS_DATABASE_URL: databaseUrl.optional(),
  DOCUMENT_SCANNER_URL:secureUrl.refine(v=>{const u=new URL(v);return !u.username&&!u.password&&!u.hash;}).optional(),
  DOCUMENT_SCANNER_TOKEN:z.string().min(16).optional()
}).superRefine((v,c)=>{
  const url = new URL(v.APP_ORIGIN);
  if (url.protocol !== 'https:' && !(v.NODE_ENV!=='production' && ['localhost','127.0.0.1'].includes(url.hostname))) c.addIssue({code:'custom',path:['APP_ORIGIN'],message:'Production requires HTTPS'});
  if (v.DATABASE_URL===v.AUTH_DATABASE_URL) c.addIssue({code:'custom',path:['AUTH_DATABASE_URL'],message:'Use a separate identity database role'});
  if(Boolean(v.DOCUMENT_SCANNER_URL)!==Boolean(v.DOCUMENT_SCANNER_TOKEN))c.addIssue({code:'custom',path:['DOCUMENT_SCANNER_URL'],message:'Configure both scanner URL and token'});
  for(const k of ['OIDC_CLIENT_SECRET','TOKEN_ENCRYPTION_KEY','STORAGE_SECRET_ACCESS_KEY'] as const)
    if (v[k].includes('REPLACE')) c.addIssue({code:'custom',path:[k],message:'Configure a real secret'});
});
export type Config = z.infer<typeof schema>;
export function readConfig(values: Record<string,string|undefined>): Config {
  const parsed=schema.safeParse(values);
  // Never include input values, connection URLs or credentials in diagnostics.
  if(!parsed.success) throw new Error(`Missing or invalid configuration: ${[...new Set(parsed.error.issues.map(i=>i.path.join('.')))].join(', ')}`);
  return parsed.data;
}

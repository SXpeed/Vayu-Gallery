import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,sign } from 'node:crypto';
import { fixture } from './helpers.js';
import { createIdentity } from '../src/modules/auth/service.js';
import { readConfig } from '../src/core/config.js';
import { hash } from '../src/core/crypto.js';
const config=readConfig({NODE_ENV:'test',APP_ORIGIN:'http://localhost:4180',DATABASE_URL:'postgresql://vayu_api@localhost/vayu_test',AUTH_DATABASE_URL:'postgresql://vayu_identity@localhost/vayu_test',OIDC_ISSUER:'https://identity.test',OIDC_CLIENT_ID:'vayu-test',OIDC_CLIENT_SECRET:'test-client-secret',OIDC_MFA_ACR:'urn:test:aal2',TOKEN_ENCRYPTION_KEY:'test-only-encryption-key-at-least-32-characters',STORAGE_ENDPOINT:'https://storage.test',STORAGE_BUCKET:'test',STORAGE_ACCESS_KEY_ID:'test-access-key',STORAGE_SECRET_ACCESS_KEY:'test-secret-at-least-16'});
test('OIDC validates signatures, nonce, PKCE, verified email and single-use callbacks',async t=>{
 const f=await fixture(),realFetch=globalThis.fetch,{publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
 const identity=createIdentity(config,f.identity);
 let nonce='',challenge='',invalidNonce=false,verified=true,wrongSignature=false;
 globalThis.fetch=async(input,init)=>{
   const url=String(input);
   if(url.endsWith('/.well-known/openid-configuration'))return Response.json({issuer:config.OIDC_ISSUER,authorization_endpoint:'https://identity.test/authorize',token_endpoint:'https://identity.test/token',jwks_uri:'https://identity.test/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],code_challenge_methods_supported:['S256']});
   if(url.endsWith('/jwks'))return Response.json({keys:[jwk]});
   if(url.endsWith('/token')){
     const body=new URLSearchParams(String(init?.body));
     assert.equal(Buffer.from(hash(body.get('code_verifier')||''),'hex').toString('base64url'),challenge);
     const now=Math.floor(Date.now()/1000),claims={iss:config.OIDC_ISSUER,sub:'new-identity',aud:config.OIDC_CLIENT_ID,iat:now,exp:now+300,auth_time:now,nonce:invalidNonce?'wrong-nonce':nonce,email:'new@example.com',email_verified:verified,name:'New user',acr:'urn:test:aal2'};
     const encoded=[{alg:'RS256',kid:'test-key',typ:'JWT'},claims].map(part=>Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
     const signature=sign('RSA-SHA256',Buffer.from(encoded),wrongSignature?generateKeyPairSync('rsa',{modulusLength:2048}).privateKey:privateKey).toString('base64url');
     return Response.json({access_token:'test-only-opaque',token_type:'Bearer',expires_in:300,id_token:`${encoded}.${signature}`});
   }
   throw new Error(`Unexpected test network destination`);
 };
 const begin=async()=>{const login=await identity.begin(),authUrl=new URL(login.url);nonce=authUrl.searchParams.get('nonce')!;challenge=authUrl.searchParams.get('code_challenge')!;const callback=new URL(`${config.APP_ORIGIN}/auth/callback`);callback.searchParams.set('state',authUrl.searchParams.get('state')!);callback.searchParams.set('code','test-code');return {login,callback};};
 try{
   await t.test('verified OIDC response creates hashed database sessions with MFA evidence',async()=>{
     const {login,callback}=await begin();const result=await identity.callback(callback,login.browser);
     const session=(await f.pg.query<any>('SELECT * FROM identity.sessions WHERE token_hash=$1',[hash(result.sessionToken)])).rows[0]!;
     assert.ok(session.mfa_at);assert.equal(session.csrf_hash,hash(result.csrf));assert.notEqual(session.token_hash,result.sessionToken);
     await assert.rejects(identity.callback(callback,login.browser),/expired/);
   });
   await t.test('another browser cannot consume the login transaction',async()=>{
     const {callback}=await begin();await assert.rejects(identity.callback(callback,'different-browser'),/expired/);
   });
   await t.test('nonce mismatch cannot authenticate',async()=>{
     const {login,callback}=await begin();invalidNonce=true;await assert.rejects(identity.callback(callback,login.browser));invalidNonce=false;
   });
   await t.test('an invalid JWT signature cannot authenticate',async()=>{
     const {login,callback}=await begin();wrongSignature=true;await assert.rejects(identity.callback(callback,login.browser));wrongSignature=false;
   });
   await t.test('unverified email cannot create a session or accept gallery membership',async()=>{
     const {login,callback}=await begin();verified=false;await assert.rejects(identity.callback(callback,login.browser),/verified email/);verified=true;
   });
 }finally{globalThis.fetch=realFetch;await f.close();}
});
test('production configuration rejects insecure origins, shared identity credentials and placeholders without logging secrets',()=>{
 assert.throws(()=>readConfig({}),/Missing or invalid configuration/);
 const error=assert.throws(()=>readConfig({...config,OIDC_MFA_ACR:'urn:test:aal2',NODE_ENV:'production',APP_ORIGIN:'http://example.com',AUTH_DATABASE_URL:config.DATABASE_URL,TOKEN_ENCRYPTION_KEY:'secret-value'} as any));
});

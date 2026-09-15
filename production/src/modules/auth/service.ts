import * as oidc from 'openid-client';
import type { Config } from '../../core/config.js';
import type { Database } from '../../core/database.js';
import { hash,token,encrypt,decrypt } from '../../core/crypto.js';
import { AppError } from '../../core/errors.js';

export function createIdentity(config:Config,db:Database) {
  // Cache immutable issuer metadata only. No user/request data is retained in global state.
  let discovery:Promise<oidc.Configuration>|undefined;
  const client=()=>discovery??=(oidc.discovery(new URL(config.OIDC_ISSUER),config.OIDC_CLIENT_ID,config.OIDC_CLIENT_SECRET,undefined,{execute:[oidc.enableNonRepudiationChecks],timeout:10})
    .catch(error=>{discovery=undefined;throw error;}));
  return {
    async begin() {
      const c=await client(),state=oidc.randomState(),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier(),browser=token();
      await db.transaction(sql=>sql.query('INSERT INTO identity.login_attempts(state_hash,browser_hash,encrypted_verifier,nonce,expires_at) VALUES($1,$2,$3,$4,now()+interval \'10 minutes\')',
        [hash(state),hash(browser),encrypt(verifier,config.TOKEN_ENCRYPTION_KEY),nonce]));
      const url=oidc.buildAuthorizationUrl(c,{redirect_uri:`${config.APP_ORIGIN}/auth/callback`,scope:'openid profile email',state,nonce,
        code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',max_age:'0',acr_values:config.OIDC_MFA_ACR.join(' ')});
      return {url:url.href,browser};
    },
    async callback(url:URL,browser:string|undefined) {
      const state=url.searchParams.get('state');
      if(!state||!browser) throw new AppError('LOGIN_FAILED','Sign-in expired. Start again.',401);
      // Consume before the network call: a callback cannot be replayed, including after a failed exchange.
      const attempt=await db.transaction(async sql=>(await sql.query('DELETE FROM identity.login_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *',[hash(state),hash(browser)])).rows[0]);
      if(!attempt) throw new AppError('LOGIN_FAILED','Sign-in expired. Start again.',401);
      const c=await client();
      const tokens=await oidc.authorizationCodeGrant(c,url,{pkceCodeVerifier:decrypt(attempt.encrypted_verifier,config.TOKEN_ENCRYPTION_KEY),expectedState:state,expectedNonce:attempt.nonce,idTokenExpected:true,maxAge:300});
      const claims=tokens.claims();
      if(!claims?.sub||claims.email_verified!==true||typeof claims.email!=='string') throw new AppError('VERIFY_EMAIL','A verified email address is required',403);
      const email=claims.email.toLowerCase();
      const authTime=typeof claims.auth_time==='number'?claims.auth_time:0;
      if(authTime*1000<Date.now()-5*60_000||authTime*1000>Date.now()+60_000) throw new AppError('REAUTHENTICATE','Fresh sign-in is required',401);
      const mfa=typeof claims.acr==='string'&&config.OIDC_MFA_ACR.includes(claims.acr);
      const sessionToken=token(),csrf=token();
      await db.transaction(async sql=>{
        const user=(await sql.query('INSERT INTO identity.users(issuer,subject,email,name,email_verified) VALUES($1,$2,$3,$4,true) ON CONFLICT(issuer,subject) DO UPDATE SET email=excluded.email,name=excluded.name,email_verified=true RETURNING id,disabled_at',
          [claims.iss,claims.sub,email,typeof claims.name==='string'?claims.name.slice(0,120):email.slice(0,120)])).rows[0];
        if(user?.disabled_at) throw new AppError('ACCOUNT_DISABLED','Account disabled',403);
        await sql.query('INSERT INTO identity.sessions(token_hash,user_id,csrf_hash,authenticated_at,mfa_at,expires_at) VALUES($1,$2,$3,to_timestamp($4),CASE WHEN $5 THEN to_timestamp($4) ELSE NULL END,now()+interval \'8 hours\')',[hash(sessionToken),user!.id,hash(csrf),authTime,mfa]);
        await sql.query("SELECT security.record_auth_event($1,'session.created')",[user!.id]);
      });
      // Identity/access tokens are never stored in browser storage or returned to the UI.
      return {sessionToken,csrf};
    }
  };
}
export type IdentityService=ReturnType<typeof createIdentity>;

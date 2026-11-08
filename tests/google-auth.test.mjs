import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {authAPI,authenticatedAccount,digest,googleIdentity} from '../cloud/auth.mjs';
import {privateAPI} from '../cloud/private-api.mjs';
import {database} from './d1.mjs';
const {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK}=await import(pathToFileURL(createRequire(new URL('../cloud/package.json',import.meta.url)).resolve('jose')).href);
const {publicKey,privateKey}=await generateKeyPair('RS256');
const resolveKey=createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'test',alg:'RS256'}]});
const now=Math.floor(Date.now()/1000),origin='https://status.example.com';
const req=(path,options={})=>new Request(origin+path,options);
const cookiePart=(r,name)=>r.headers.getSetCookie().find(x=>x.startsWith(name+'='))?.split(';')[0];
function setup(){const {sql,DB}=database();sql.prepare("INSERT INTO rp_accounts(id,email,role,disabled,created) VALUES('admin','admin@example.com','admin',0,?)").run(now);
  return {sql,env:{DB,APP_ORIGIN:origin,GOOGLE_CLIENT_ID:'example-client.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'x'.repeat(32)}};}
async function start(env){const response=await authAPI(req('/private/auth/google/start',{method:'POST',headers:{origin}}),env,now);
  assert.equal(response.status,200);const url=new URL((await response.json()).authorizationUrl);
  return {response,url,flow:cookiePart(response,'__Host-routepilot_oauth'),state:url.searchParams.get('state'),nonce:url.searchParams.get('nonce')};}
async function token(env,flow,changes={},key=privateKey){return new SignJWT({iss:'https://accounts.google.com',aud:env.GOOGLE_CLIENT_ID,
  iat:now,exp:now+3600,sub:'google-subject-1',email:'admin@example.com',email_verified:true,nonce:flow.nonce,...changes})
  .setProtectedHeader({alg:'RS256',kid:'test'}).sign(key);}
const callback=(flow,options={})=>req('/private/auth/google/callback?code=code-1&state='+flow.state,{headers:{cookie:flow.flow},...options});
function exchange(env,flow,signed){return async(url,options)=>{
  assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'manual');assert.equal(options.method,'POST');
  assert.equal(options.body.get('client_secret'),env.GOOGLE_CLIENT_SECRET);assert.equal(options.body.get('code'),'code-1');
  const proof=createHash('sha256').update(options.body.get('code_verifier')).digest('base64url');
  assert.equal(proof,flow.url.searchParams.get('code_challenge'));
  return Response.json({id_token:signed,access_token:'discarded-token'});
};}

test('same-origin login uses PKCE, hashed browser-bound state and a fixed callback without leaking secrets',async()=>{
  const {sql,env}=setup();try{
    for(const headers of [{},{origin:'https://attacker.example'}])
      assert.equal((await authAPI(req('/private/auth/google/start',{method:'POST',headers}),env,now)).status,403);
    assert.equal((await authAPI(req('/private/auth/google/start',{method:'POST',headers:{origin}}),{...env,GOOGLE_CLIENT_SECRET:''},now)).status,503);
    const flow=await start(env),row=sql.prepare('SELECT * FROM oauth_attempts').get();
    assert.equal(flow.url.origin,'https://accounts.google.com');assert.equal(flow.url.searchParams.get('scope'),'openid email');
    assert.equal(flow.url.searchParams.get('redirect_uri'),origin+'/private/auth/google/callback');
    assert.equal(flow.url.searchParams.get('code_challenge_method'),'S256');
    assert(!flow.url.href.includes(env.GOOGLE_CLIENT_SECRET));
    assert.equal(row.state_hash,await digest(flow.state));assert.equal(row.nonce_hash,await digest(flow.nonce));
    assert(!JSON.stringify(row).includes(flow.flow.split('=')[1]));
    for(const flag of ['HttpOnly','Secure','SameSite=Lax','Path=/','Max-Age=600'])assert(flow.response.headers.get('set-cookie').includes(flag));
    const meta=await authAPI(req('/private/auth'),env,now);assert.deepEqual(await meta.json(),{provider:'google',ready:true});
    assert.match(meta.headers.get('cache-control'),/no-store/);
  }finally{sql.close();}
});

test('valid Google callback creates an RP session; replay, logout, expiry and disabled accounts are denied',async()=>{
  const {sql,env}=setup();try{
    const flow=await start(env);let calls=0;const perform=exchange(env,flow,await token(env,flow));
    const deps={resolveKey,fetchToken:async(...args)=>{calls++;return perform(...args);}};
    const results=await Promise.all([authAPI(callback(flow),env,now,deps),authAPI(callback(flow),env,now,deps)]);
    assert.equal(calls,1);assert.equal(results.filter(r=>r.headers.get('location')==='/').length,1);
    const success=results.find(r=>r.headers.get('location')==='/'),cookie=cookiePart(success,'__Host-routepilot');
    assert.equal(success.status,303);assert.match(success.headers.get('cache-control'),/no-store/);
    const session=sql.prepare('SELECT * FROM rp_sessions').get();assert.equal(session.hash,await digest(cookie.split('=')[1]));
    assert.equal(session.expires,now+8*3600);assert.equal(sql.prepare('SELECT google_sub FROM rp_accounts').get().google_sub,'google-subject-1');
    const read=()=>req('/private/overview',{headers:{cookie}});
    assert.equal((await privateAPI(read(),env,now)).status,200);
    assert.equal((await authenticatedAccount(read(),env,now+8*3600)),null);
    sql.exec('UPDATE rp_accounts SET disabled=1');assert.equal((await privateAPI(read(),env,now)).status,401);
    sql.exec("UPDATE rp_accounts SET disabled=0,role='viewer'");assert.equal((await privateAPI(read(),env,now)).status,401);
    sql.exec("UPDATE rp_accounts SET role='admin'");
    assert.equal((await authAPI(req('/private/session',{method:'DELETE',headers:{cookie,origin:'https://attacker.example'}}),env,now)).status,403);
    assert.equal((await authAPI(req('/private/session',{method:'DELETE',headers:{cookie,origin}}),env,now)).status,200);
    assert.equal((await privateAPI(read(),env,now)).status,401);
    assert.equal((await privateAPI(req('/private/session',{method:'POST',headers:{origin},body:'old-key'}),env,now)).status,404);
  }finally{sql.close();}
});

test('callback rejects wrong browser/state, expired attempts, duplicate parameters and cancellation without exchanging a code',async()=>{
  const {sql,env}=setup();try{
    const flow=await start(env);const deps={resolveKey,fetchToken:()=>{throw Error('Unexpected exchange');}};
    for(const request of [callback(flow,{headers:{cookie:'__Host-routepilot_oauth='+'a'.repeat(64)}}),
      req('/private/auth/google/callback?state='+'b'.repeat(64)+'&code=x',{headers:{cookie:flow.flow}}),
      req('/private/auth/google/callback?state='+flow.state+'&code=a&code=b',{headers:{cookie:flow.flow}})]){
      assert.equal((await authAPI(request,env,now,deps)).headers.get('location'),'/?login=expired');
    }
    assert.equal((await authAPI(callback(flow),env,now+601,deps)).headers.get('location'),'/?login=expired');
    const next=await start(env);
    const cancelled=req('/private/auth/google/callback?error=access_denied&state='+next.state,{headers:{cookie:next.flow}});
    assert.equal((await authAPI(cancelled,env,now,deps)).headers.get('location'),'/?login=cancelled');
    assert.equal((await authAPI(callback(next),env,now,deps)).headers.get('location'),'/?login=expired');
    assert.equal(sql.prepare('SELECT count(*) AS n FROM rp_sessions').get().n,0);
  }finally{sql.close();}
});

test('Google ID tokens require valid signature, issuer, audience, nonce, lifetime and verified email',async()=>{
  const {sql,env}=setup();try{
    const flow=await start(env),nonceHash=await digest(flow.nonce);
    for(const changes of [{iss:'https://attacker.example'},{aud:'another-client'},{azp:'another-client'},
      {nonce:'another-nonce'},{email_verified:false},{email_verified:'true'},{email:undefined},{sub:''},
      {exp:now-60},{iat:now+60},{iat:now-700},{exp:undefined}])
      await assert.rejects(()=>token(env,flow,changes).then(t=>googleIdentity(t,env,nonceHash,now,resolveKey)));
    const other=await generateKeyPair('RS256');
    await assert.rejects(()=>token(env,flow,{},other.privateKey).then(t=>googleIdentity(t,env,nonceHash,now,resolveKey)));
    const failed=await authAPI(callback(flow),env,now,{resolveKey,fetchToken:exchange(env,flow,await token(env,flow,{nonce:'wrong'}))});
    assert.equal(failed.headers.get('location'),'/?login=failed');
    assert.equal(sql.prepare('SELECT count(*) AS n FROM rp_sessions').get().n,0);
  }finally{sql.close();}
});

test('RP never self-registers unknown users or rebinds an account; stable Google subject survives email changes',async()=>{
  const {sql,env}=setup();try{
    async function login(changes){const flow=await start(env);return authAPI(callback(flow),env,now,{resolveKey,fetchToken:exchange(env,flow,await token(env,flow,changes))});}
    assert.equal((await login({email:'unknown@example.com'})).headers.get('location'),'/?login=denied');
    assert.equal((await login({})).headers.get('location'),'/');
    assert.equal((await login({sub:'another-subject'})).headers.get('location'),'/?login=denied');
    assert.equal((await login({email:'renamed@example.com'})).headers.get('location'),'/');
    sql.exec('UPDATE rp_accounts SET disabled=1');
    assert.equal((await login({})).headers.get('location'),'/?login=denied');
    assert.equal(sql.prepare('SELECT count(*) AS n FROM rp_accounts').get().n,1);
  }finally{sql.close();}
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {accessIdentity} from '../cloud/access-auth.mjs';
import {digest, privateAPI} from '../cloud/private-api.mjs';
const {generateKeyPair, SignJWT, createLocalJWKSet, exportJWK} = await import(createRequire(new URL('../cloud/package.json',import.meta.url)).resolve('jose'));

const now = Math.floor(Date.now()/1000), issuer = 'https://example-team.cloudflareaccess.com', aud = 'a'.repeat(64);
const {publicKey, privateKey} = await generateKeyPair('RS256');
const resolve = createLocalJWKSet({keys:[{...await exportJWK(publicKey),kid:'test',alg:'RS256'}]});
const env = {ADMIN_AUTH_MODE:'access', ACCESS_ISSUER:issuer, ACCESS_AUD:aud,
  ACCESS_EMAIL_SHA256:await digest('admin@example.com')};
const claims = {iss:issuer,aud,sub:'test-user',email:'admin@example.com',iat:now,exp:now+3600};
const sign = (changes={}, key=privateKey) => new SignJWT({...claims,...changes}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(key);
const request = token => new Request('https://status.example.com/private/overview',{headers:{'Cf-Access-Jwt-Assertion':token}});

test('Access requires a valid signature, application audience, issuer, lifetime and allowed human identity', async()=>{
  assert.equal(await accessIdentity(request(await sign()),env,now,resolve),true);
  assert.equal(await accessIdentity(request(await sign({email:'ADMIN@example.com'})),env,now,resolve),true);
  for (const changes of [{email:'another@example.com'},{email:undefined},{sub:''},{aud:'b'.repeat(64)},
    {iss:'https://attacker.cloudflareaccess.com'},{exp:now-60},{iat:now+60},{iat:now-9*3600},
    {exp:undefined},{iat:undefined}]) {
    assert.equal(await accessIdentity(request(await sign(changes)),env,now,resolve),false);
  }
  const other = await generateKeyPair('RS256');
  assert.equal(await accessIdentity(request(await sign({},other.privateKey)),env,now,resolve),false);
  assert.equal(await accessIdentity(request('not-a-jwt'),env,now,resolve),false);
  assert.equal(await accessIdentity(request(await sign()),{...env,ACCESS_EMAIL_SHA256:''},now,resolve),false);
  assert.equal(await accessIdentity(request(await sign()),{...env,ACCESS_ISSUER:'http://localhost'},now,resolve),false);
  assert.equal(await accessIdentity(new Request('https://status.example.com/private/overview',
    {headers:{'Cf-Access-Authenticated-User-Email':'admin@example.com'}}),env,now,resolve),false);
});

test('Access mode never accepts legacy sessions or keys, even if Access configuration is broken', async()=>{
  const key='a'.repeat(48), configured={...env,ADMIN_SHA256:await digest(key),DB:{prepare(){throw Error('Must not use legacy sessions');}}};
  for (const config of [configured,{...configured,ACCESS_AUD:''},{...configured,ADMIN_AUTH_MODE:'invalid'}]) {
    assert.equal((await privateAPI(new Request('https://status.example.com/private/session',{
      method:'POST',headers:{origin:'https://status.example.com','Content-Type':'application/json'},body:JSON.stringify({key})
    }),config,now)).status,404);
    const r=await privateAPI(new Request('https://status.example.com/private/overview',{
      headers:{cookie:'__Host-routepilot='+'b'.repeat(64),'Cf-Access-Authenticated-User-Email':'admin@example.com'}
    }),config,now);
    assert.equal(r.status,401);assert.match(r.headers.get('cache-control'),/no-store/);
  }
  const metadata=await privateAPI(new Request('https://status.example.com/private/auth'),env,now);
  assert.deepEqual(await metadata.json(),{mode:'access'});
  assert.equal(await privateAPI(new Request('https://status.example.com/status/node-1/all.json'),env,now),null);
  assert.equal(await privateAPI(new Request('https://status.example.com/i/report'),env,now),null);
  assert.equal((await privateAPI(new Request('https://status.example.com/private/manage/revoke'),env,now)).status,401);
});

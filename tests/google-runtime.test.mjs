import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../cloud/package.json',import.meta.url));
const {Miniflare,createFetchMock}=require('miniflare');
const {build}=require('esbuild');
const {generateKeyPair,exportJWK,SignJWT}=await import(require.resolve('jose'));

test('Google callback exchanges tokens in the Workers runtime and rejects credential-bearing redirects',async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const bundle=await build({stdin:{contents:`import {authAPI} from './cloud/auth.mjs';
    export default {fetch(request,env){return authAPI(request,env,Math.floor(Date.now()/1000));}}`,
    resolveDir:root,sourcefile:'runtime-fixture.mjs'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
  const mock=createFetchMock();mock.disableNetConnect();
  const origin='https://status.example.com',client='test.apps.googleusercontent.com';
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-01',
    d1Databases:['DB'],bindings:{APP_ORIGIN:origin,GOOGLE_CLIENT_ID:client,GOOGLE_CLIENT_SECRET:'test-secret-123456789'},fetchMock:mock});
  try{
    const db=await mf.getD1Database('DB');
    for(const name of ['0004_private_control.sql','0005_google_accounts.sql'])
      for(const statement of readFileSync(new URL('../cloud/migrations/'+name,import.meta.url),'utf8').split(';').filter(x=>x.trim()))
        await db.prepare(statement).run();
    await db.prepare("INSERT INTO rp_accounts(id,email,created) VALUES('test','admin@example.com',1)").run();
    const {privateKey,publicKey}=await generateKeyPair('RS256');
    mock.get('https://www.googleapis.com').intercept({path:'/oauth2/v3/certs',method:'GET'})
      .reply(200,JSON.stringify({keys:[{...await exportJWK(publicKey),kid:'test',alg:'RS256'}]}),{headers:{'content-type':'application/json'}});
    async function start(){
      const r=await mf.dispatchFetch(origin+'/private/auth/google/start',{method:'POST',headers:{origin}});
      assert.equal(r.status,200);
      return {url:new URL((await r.json()).authorizationUrl),cookie:r.headers.get('set-cookie').split(';')[0]};
    }
    async function callback(flow){return mf.dispatchFetch(origin+'/private/auth/google/callback?'+new URLSearchParams({
      code:'test-code',state:flow.url.searchParams.get('state')}),{headers:{cookie:flow.cookie},redirect:'manual'});}
    const flow=await start(),now=Math.floor(Date.now()/1000);
    const signed=await new SignJWT({iss:'https://accounts.google.com',aud:client,sub:'test-sub',email:'admin@example.com',
      email_verified:true,iat:now,exp:now+300,nonce:flow.url.searchParams.get('nonce')})
      .setProtectedHeader({alg:'RS256',kid:'test'}).sign(privateKey);
    let exchanges=0;
    mock.get('https://oauth2.googleapis.com').intercept({path:'/token',method:'POST'}).reply(200,async options=>{
      exchanges++;const form=new URLSearchParams(await new Response(options.body).text());
      assert.equal(form.get('code_verifier'),flow.cookie.split('=')[1]);
      assert.equal(form.get('redirect_uri'),origin+'/private/auth/google/callback');
      return JSON.stringify({id_token:signed});
    },{headers:{'content-type':'application/json'}});
    const success=await callback(flow);
    assert.equal(success.headers.get('location'),'/admin/');assert.equal(exchanges,1);
    assert.equal((await db.prepare('SELECT count(*) n FROM rp_sessions').first()).n,1);
    const redirectFlow=await start();
    mock.get('https://oauth2.googleapis.com').intercept({path:'/token',method:'POST'})
      .reply(302,'',{headers:{location:'https://untrusted.example/token'}});
    const rejected=await callback(redirectFlow);
    assert.equal(rejected.headers.get('location'),'/admin/?login=failed');
    assert.equal((await db.prepare('SELECT count(*) n FROM rp_sessions').first()).n,1);
    mock.assertNoPendingInterceptors();
  }finally{await mf.dispose();await mock.close();}
});

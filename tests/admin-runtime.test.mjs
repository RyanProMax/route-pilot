import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomBytes,createHash} from 'node:crypto';
const require=createRequire(new URL('../cloud/package.json',import.meta.url));
const {Miniflare}=require('miniflare'),{build}=require('esbuild');
const hash=x=>createHash('sha256').update(x).digest('hex');

test('credential jobs and inventory commit through real D1 transactions in workerd',async()=>{
 const bundle=await build({stdin:{contents:`import {privateAPI} from './cloud/private-api.mjs';export default {fetch(r,e){return privateAPI(r,e,Math.floor(Date.now()/1000));}}`,resolveDir:fileURLToPath(new URL('..',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});
 const origin='https://status.example.com',session=randomBytes(32).toString('hex'),control=randomBytes(32).toString('hex');
 const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-07-01',d1Databases:['DB'],bindings:{APP_ORIGIN:origin,INSTANCE_ID:'test',CONTROL_SHA256:hash(control),SUBSCRIPTION_KEY:randomBytes(32).toString('base64')}});
 try{
  const db=await mf.getD1Database('DB');
  for(const name of ['0004_private_control.sql','0005_google_accounts.sql','0006_admin_console.sql'])
   for(const statement of readFileSync(new URL('../cloud/migrations/'+name,import.meta.url),'utf8').split(';').filter(x=>x.trim()))await db.prepare(statement).run();
  await db.exec('CREATE TABLE reports(minute INTEGER,ts INTEGER,metrics TEXT)');
  await db.prepare("INSERT INTO rp_accounts(id,email,created) VALUES('test','admin@example.com',1)").run();
  await db.prepare("INSERT INTO rp_sessions(hash,account_id,expires) VALUES(?,'test',?)").bind(hash(session),Math.floor(Date.now()/1000)+300).run();
  const call=(path,body)=>mf.dispatchFetch(origin+path,{method:'POST',headers:{origin,cookie:'__Host-routepilot='+session,authorization:'Bearer '+control,'content-type':'application/json'},body:JSON.stringify(body)});
  const create=await call('/private/credentials',{requestId:randomBytes(16).toString('hex'),action:'create',label:'Phone',client:'shadowrocket'});assert.equal(create.status,202);
  const poll=await call('/private/control/poll',{credentials:[]});assert.equal(poll.status,200);const {job}=await poll.json();
  const device={...job.credential,revoked:false},token=randomBytes(32).toString('base64url');
  const ack=await call('/private/control/ack',{id:job.id,lease:job.lease,ok:true,credential:device,token,files:{'clash.yaml':'node','shadowrocket.txt':'node','rules.conf':'rules'}});assert.equal(ack.status,200);
  assert.equal((await db.prepare('SELECT state FROM control_jobs').first()).state,'done');
  const inventory=await call('/private/control/poll',{credentials:[device]});assert.equal(inventory.status,200);
  const access=await call('/private/credentials/'+device.id+'/access',{});assert.equal(access.status,200);
  assert.equal((await access.json()).urls['clash.yaml'],origin+'/sub/'+token+'/clash.yaml');
  const response=await mf.dispatchFetch(origin+'/private/console',{headers:{cookie:'__Host-routepilot='+session}});assert.equal(response.status,200);assert.equal((await response.json()).credentials.length,1);
 }finally{await mf.dispose();}
});

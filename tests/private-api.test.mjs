import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,createCipheriv} from 'node:crypto';
import {test} from 'node:test';
import {privateAPI,digest,usageStatements,hostLoad} from '../cloud/private-api.mjs';

function setup() {
  const sql=new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../cloud/migrations/0004_private_control.sql',import.meta.url),'utf8'));
  sql.exec('CREATE TABLE reports(minute INTEGER, ts INTEGER, metrics TEXT)');
  const DB={prepare(query){let args=[];return {bind(...a){args=a;return this;},async first(){return sql.prepare(query).get(...args) ?? null;},async run(){return sql.prepare(query).run(...args);},async all(){return {results:sql.prepare(query).all(...args)};}};},
    async batch(statements){return Promise.all(statements.map(s=>s.all()));}};
  return {sql,env:{DB,INSTANCE_ID:'node-1',SUBSCRIPTION_KEY:randomBytes(32).toString('base64')}};
}
function req(path,options={}) {return new Request('https://status.example.com'+path,options);}
function envelope(env,id,token,files) {
  return digest(token).then(token_hash=>{
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(env.SUBSCRIPTION_KEY,'base64'),iv);
    cipher.setAAD(Buffer.from(`route-pilot:v1:${env.INSTANCE_ID}:${id}:${token_hash}`));
    return {id,token_hash,iv:iv.toString('base64'),ciphertext:Buffer.concat([cipher.update(JSON.stringify(files)),cipher.final(),cipher.getAuthTag()]).toString('base64')};
  });
}
const post=(body,authorization)=>({method:'POST',headers:{'Content-Type':'application/json',...(authorization?{authorization:'Bearer '+authorization}:{})},body:JSON.stringify(body)});

test('independent encrypted subscriptions, rotation, revocation and tamper rejection',async()=>{
  const {sql,env}=setup();
  env.ADMIN_AUTH_MODE='access';
  try {
    const management=randomBytes(32).toString('hex');env.PROVISION_SHA256=await digest(management);
    const a=randomBytes(32).toString('base64url'),b=randomBytes(32).toString('base64url');
    const idA='a'.repeat(24),idB='b'.repeat(24);
    const ea=await envelope(env,idA,a,{'clash.yaml':'private-A'}),eb=await envelope(env,idB,b,{'clash.yaml':'private-B'});
    assert.equal((await privateAPI(req('/private/manage/publish',post(ea)),env,100)).status,401);
    for(const e of [ea,eb])assert.equal((await privateAPI(req('/private/manage/publish',post(e,management)),env,100)).status,200);
    for(const [token,content] of [[a,'private-A'],[b,'private-B']]) {
      const r=await privateAPI(req('/sub/'+token+'/clash.yaml'),env,100);
      assert.equal(await r.text(),content);assert.match(r.headers.get('cache-control'),/no-store/);
      assert.equal((await privateAPI(req('/sub/'+token+'/clash.yaml?x=1'),env,100)).status,404);
      assert.equal((await privateAPI(req('/sub/'+token+'/clash.yaml',{method:'HEAD'}),env,100)).body,null);
    }
    assert(!JSON.stringify(sql.prepare('SELECT * FROM subscriptions').all()).includes('private-A'));
    const swapped={...ea,id:idB};assert.equal((await privateAPI(req('/private/manage/publish',post(swapped,management)),env,100)).status,400);
    const rotated=randomBytes(32).toString('base64url');
    await privateAPI(req('/private/manage/publish',post(await envelope(env,idA,rotated,{'clash.yaml':'private-A'}),management)),env,101);
    assert.equal((await privateAPI(req('/sub/'+a+'/clash.yaml'),env,101)).status,404);
    await privateAPI(req('/private/manage/revoke',post({id:idA},management)),env,102);
    assert.equal((await privateAPI(req('/sub/'+rotated+'/clash.yaml'),env,102)).status,404);
    assert.equal(await (await privateAPI(req('/sub/'+b+'/clash.yaml'),env,102)).text(),'private-B');
  } finally{sql.close();}
});

test('admin session is isolated, same-origin, expiring, HttpOnly and revocable',async()=>{
  const {sql,env}=setup();
  try {
    const key=randomBytes(32).toString('hex');env.ADMIN_SHA256=await digest(key);
    assert.equal((await privateAPI(req('/private/overview'),env,100)).status,401);
    assert.equal((await privateAPI(req('/private/session',post({key})),env,100)).status,403);
    const login=post({key});login.headers.origin='https://status.example.com';
    const response=await privateAPI(req('/private/session',login),env,100);
    const setCookie=response.headers.get('set-cookie');
    for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/']) assert(setCookie.includes(flag));
    const cookie=setCookie.split(';')[0];
    assert.equal((await privateAPI(req('/private/overview',{headers:{cookie}}),env,101)).status,200);
    assert.equal((await privateAPI(req('/private/overview',{headers:{cookie}}),env,28901)).status,401);
    assert.equal((await privateAPI(req('/private/session',{method:'DELETE',headers:{cookie,origin:'https://status.example.com'}}),env,102)).status,200);
    assert.equal((await privateAPI(req('/private/overview',{headers:{cookie}}),env,103)).status,401);
    assert.equal((await privateAPI(req('/private/manage/revoke',{...post({id:'a'.repeat(24)}),headers:{cookie}}),env,103)).status,401);
  } finally {sql.close();}
});

test('usage is idempotent, monotonic and rejects unbounded or malformed identities',async()=>{
  const {sql,env}=setup();
  try {
    const ts=Date.UTC(2026,10,5)/1000;
    const row={id:'a'.repeat(24),label:'Phone',revoked:false,online:true,month:'2026-11',uplink:20,downlink:40,since:ts-60,gaps:0};
    for(const [time,up] of [[ts,20],[ts,20],[ts-1,90],[ts+60,10]]) {
      for(const q of usageStatements(env.DB,[{...row,uplink:up}],time))await q.run();
    }
    const stored=sql.prepare('SELECT * FROM credential_usage').get();assert.equal(stored.uplink,20);assert.equal(stored.downlink,40);
    assert.throws(()=>usageStatements(env.DB,[row,row],ts));
    assert.throws(()=>usageStatements(env.DB,[{...row,id:'secret-uuid'}],ts));
    assert.throws(()=>usageStatements(env.DB,[{...row,uplink:-1}],ts));
    assert.throws(()=>usageStatements(env.DB,[{...row,month:'2026-10'}],ts));
    assert.deepEqual(hostLoad({cpu_percent:5,memory_used:20,memory_total:100,disk_used:50,disk_total:200,load1:.1},ts,ts),{cpu:5,memory:20,disk:25,load1:.1});
    assert.equal(hostLoad({},ts,ts+151),null);
  } finally {sql.close();}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cloudflareUsage,collectUsage,nextUsageUpdate,refreshCloudflareUsage,usagePeriod} from '../cloud/cloudflare-usage.mjs';
import {database} from './d1.mjs';
import {readFileSync} from 'node:fs';

test('midnight collection survives cold starts, concurrent runs and failed refreshes', async () => {
  const {sql,DB} = database();
  sql.exec(readFileSync(new URL('../cloud/migrations/0011_cloudflare_usage_snapshot.sql', import.meta.url),'utf8'));
  const env = {DB,CF_USAGE_PREVIEW_SCOPE:'test-account'};
  const before = Date.parse('2026-11-22T15:59:59Z');
  const midnight = before + 1000;
  let calls = 0;
  const read = async (_, at) => {
    calls++;
    return {status:'ready', at, metrics:[{used:0}]};
  };
  try {
    assert.equal(nextUsageUpdate(before),midnight);
    assert.equal((await cloudflareUsage(env,before)).status,'pending');
    await Promise.all([refreshCloudflareUsage(env,before,read), refreshCloudflareUsage({...env},before,read)]);
    assert.equal((await cloudflareUsage({...env},before)).at,before);
    const readOnly = {DB,CF_USAGE_ACCOUNT_ID:'test-account'};
    await refreshCloudflareUsage(readOnly,midnight,read);
    assert.equal((await cloudflareUsage(readOnly,midnight)).at,before);
    assert.equal((await cloudflareUsage({...readOnly,CF_USAGE_ACCOUNT_ID:'other'},midnight)).status,'unconfigured');
    assert.equal((await cloudflareUsage({...env,CF_USAGE_PREVIEW_SCOPE:'other'},before)).status,'pending');
    await refreshCloudflareUsage({...env},before,read);
    assert.equal(calls,1);
    await assert.rejects(refreshCloudflareUsage(env,midnight,async () => ({status:'ready',at:midnight,metrics:[{used:null}]})));
    const old = await cloudflareUsage(env,midnight);
    assert.equal(old.at,before);
    assert.equal(old.stale,true);
    await refreshCloudflareUsage(env,midnight,read);
    const latest = await cloudflareUsage({...env},midnight);
    assert.equal(latest.at,midnight);
    assert.equal(latest.stale,false);
    assert.equal(latest.nextUpdateAt,midnight+86_400_000);
    assert.equal(calls,2);
  } finally { sql.close(); }
});

test('UTC daily boundaries and monthly cycles include leap days and short months', () => {
  const at = Date.parse('2024-02-29T23:59:59Z');
  const period = usagePeriod(at,31);
  assert.equal(period.day,Date.parse('2024-02-29'));
  assert.equal(period.month,period.day);
  assert.equal(period.end,Date.parse('2024-03-31'));
  assert.equal(usagePeriod(Date.parse('2025-02-27'),31).month,Date.parse('2025-01-31'));
});

test('shared quotas reconcile across projects and incomplete datasets stay unknown', async () => {
  const env = {CF_USAGE_ACCOUNT_ID:'a'.repeat(32),CF_USAGE_TOKEN:'test-only-credential',CF_USAGE_PROJECTS:'{"worker:example":"Example","pages:site":"Example"}'};
  const data = await collectUsage(env,Date.parse('2026-05-15T12:00:00Z'),async (url,init) => {
    assert.ok(url.startsWith('https://api.cloudflare.com/client/v4/'));
    assert.equal(init.headers.Authorization,'Bearer '+env.CF_USAGE_TOKEN);
    if (!init.body) {
      const path = new URL(url).pathname;
      let result=[];
      if (path.endsWith('/scripts')) result=[{id:'example'}];
      if (path.endsWith('/projects')) result=[{name:'site',production_script_name:'internal-pages-alias',deployment_configs:{production:{env_vars:{PRIVATE:{value:'private-binding-value'}}}}}];
      return Response.json({success:true,result});
    }
    const dataset = JSON.parse(init.body).query.match(/items:(\w+)/)[1];
    const entries = {
      workersInvocationsAdaptive:[{dimensions:{scriptName:'example'},sum:{requests:40}}],
      pagesFunctionsInvocationsAdaptiveGroups:[{dimensions:{scriptName:'internal-pages-alias'},sum:{requests:60}}],
      r2OperationsAdaptiveGroups:['Standard','InfrequentAccess'].map(storageClass=>({dimensions:{bucketName:'example-bucket',storageClass,actionType:'GetObject'},sum:{requests:3}})),
      kvOperationsAdaptiveGroups:Array(1000).fill({}),
    };
    if (dataset==='d1AnalyticsAdaptiveGroups') return Response.json({errors:[{message:'sensitive-upstream-error'}]});
    return Response.json({data:{viewer:{accounts:[{items:entries[dataset]??[]}]}}});
  });
  const requests = data.metrics.find(m=>m.product==='Workers / Pages');
  assert.deepEqual(requests.projects,[{name:'Example',used:100}]);
  assert.equal(requests.used,100);
  assert.equal(data.metrics.find(m=>m.product==='D1' && m.title==='读取行数').used,null);
  assert.equal(data.metrics.find(m=>m.product==='KV' && m.title==='读取').used,null);
  assert.equal(data.metrics.find(m=>m.title==='Class B 操作').used,3);
  for (const secret of [env.CF_USAGE_ACCOUNT_ID,env.CF_USAGE_TOKEN,'private-binding-value','internal-pages-alias','sensitive-upstream-error'])
    assert.ok(!JSON.stringify(data).includes(secret));
});

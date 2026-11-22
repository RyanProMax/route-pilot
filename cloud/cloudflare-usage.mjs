// Only called after an administrator session has been verified. API credentials, raw
// GraphQL/REST payloads, resource IDs and binding values never leave this module.
const api = 'https://api.cloudflare.com/client/v4';
const dayMs = 86_400_000;
const rowLimit = 1000;
const recent = new WeakMap();
const iso = ms => new Date(ms).toISOString();
const classA = new Set('ListBuckets PutBucket ListObjects PutObject CopyObject CompleteMultipartUpload CreateMultipartUpload LifecycleStorageTierTransition ListMultipartUploads UploadPart UploadPartCopy ListParts PutBucketEncryption PutBucketCors PutBucketLifecycleConfiguration'.split(' '));
const classB = new Set('HeadBucket HeadObject GetObject UsageSummary GetBucketEncryption GetBucketLocation GetBucketCors GetBucketLifecycleConfiguration'.split(' '));

export function usagePeriod(now, cycleDay = 1) {
  const date = new Date(now);
  const year = date.getUTCFullYear(), month = date.getUTCMonth();
  function boundary(offset) {
    const last = new Date(Date.UTC(year, month + offset + 1, 0)).getUTCDate();
    return Date.UTC(year, month + offset, Math.min(cycleDay, last));
  }
  const offset = now < boundary(0) ? -1 : 0;
  return { day: Date.UTC(year, month, date.getUTCDate()), month: boundary(offset), end: boundary(offset + 1) };
}

export async function collectUsage(env, now = Date.now(), send = fetch) {
  const account = env.CF_USAGE_ACCOUNT_ID, token = env.CF_USAGE_TOKEN;
  if (!/^[a-f0-9]{32}$/.test(account ?? '') || !token) return { status: 'unconfigured' };
  const cycle = Number(env.CF_USAGE_CYCLE_DAY ?? 1);
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > 31) throw Error('Invalid cycle day');
  const owners = JSON.parse(env.CF_USAGE_PROJECTS || '{}');
  const period = usagePeriod(now, cycle);
  let remainingCalls = 45;
  async function request(path, body) {
    if (--remainingCalls < 0) throw Error('Request budget exceeded');
    const response = await send(api + path, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error('Cloudflare unavailable');
    const data = await response.json();
    if (data.errors?.length || data.success === false) throw Error('Dataset unavailable');
    return data;
  }
  async function list(path, size = 100, stopBefore = null) {
    const items = [];
    for (let page = 1; ; page++) {
      const { result, result_info: info } = await request('/accounts/' + account + '/' + path + '?per_page=' + size + '&page=' + page);
      if (!Array.isArray(result)) throw Error('Invalid inventory');
      items.push(...result);
      if (stopBefore && result.some(item => Date.parse(item.created_on) < stopBefore)) break;
      if (info?.total_pages != null ? page >= info.total_pages : result.length < size) break;
    }
    return items;
  }
  async function query(dataset, fields, dimensions, start = period.day) {
    const doc = `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
      items:${dataset}(limit:${rowLimit},filter:{datetime_geq:$s,datetime_lt:$e}){
        ${dimensions ? 'dimensions{' + dimensions + '}' : ''} ${fields}
      }}}}`;
    const data = await request('/graphql', { query: doc, variables: { a: account, s: iso(start), e: iso(now) } });
    const rows = data.data?.viewer?.accounts?.[0]?.items;
    if (!Array.isArray(rows) || rows.length >= rowLimit) throw Error('Incomplete dataset');
    return rows;
  }
  const optional = task => task.catch(() => null);
  const [scripts, pages, databases, namespaces] = await Promise.all([
    optional(list('workers/scripts')), optional(list('pages/projects', 10)),
    optional(list('d1/database')), optional(list('storage/kv/namespaces')),
  ]);
  const names = new Map(), inferred = new Map();
  function bind(kind,id,project) {
    if (typeof id !== 'string' || !id) return;
    const key = kind + ':' + id;
    if (!inferred.has(key)) inferred.set(key,new Set());
    inferred.get(key).add(project);
  }
  let bindingsComplete = Boolean(pages && scripts);
  for (const db of databases ?? []) names.set('d1:' + db.uuid, db.name);
  for (const ns of namespaces ?? []) names.set('kv:' + ns.id, ns.title);
  for (const page of pages ?? []) {
    for (const script of [page.production_script_name,page.preview_script_name]) {
      if (script) names.set('pages:' + script, page.name);
    }
    for (const conf of Object.values(page.deployment_configs ?? {})) {
      for (const [kind, bindings, field] of [['d1', conf.d1_databases, 'id'], ['kv', conf.kv_namespaces, 'namespace_id'], ['r2', conf.r2_buckets, 'name']]) {
        for (const binding of Object.values(bindings ?? {})) {
          bind(kind,binding[field],owners['pages:' + page.name] || page.name);
        }
      }
    }
  }
  function label(kind, id) {
    if (!id) return '账号合计';
    const key = kind + ':' + id;
    const name = names.get(key) || id;
    const explicit = Object.hasOwn(owners,key) ? owners[key] : owners[kind + ':' + name];
    if (typeof explicit === 'string' && explicit) return explicit;
    const linked = bindingsComplete && inferred.get(key);
    if (linked?.size) return [...linked].sort().join(' / ') + (linked.size > 1 ? '（共享）' : '');
    // Managed resources can be visible to analytics while their names are not.
    if (/^[\da-f-]{32,36}$/i.test(name)) return kind.toUpperCase() + ' · ' + name.slice(-6);
    return name;
  }
  const metrics = [];
  function metric(product, title, limit, rows, read, { window = 'day', unit = '次', note = '', estimate = false } = {}) {
    let projects = null;
    if (rows) {
      const totals = new Map();
      for (const row of rows) {
        const point = read(row);
        if (!point) continue;
        const [name, value] = point;
        if (!Number.isFinite(value) || value < 0) throw Error('Invalid measurement');
        totals.set(name, (totals.get(name) ?? 0) + value);
      }
      projects = Array.from(totals, ([name, used]) => ({ name, used })).sort((a,b) => b.used - a.used || a.name.localeCompare(b.name));
    }
    metrics.push({ product, title, limit, unit, window, note, estimate, projects, used: projects?.reduce((n,r) => n+r.used, 0) ?? null });
  }
  const sources = {
    worker: ['workersInvocationsAdaptive','sum{requests}','scriptName'],
    pages: ['pagesFunctionsInvocationsAdaptiveGroups','sum{requests}','scriptName'],
    d1: ['d1AnalyticsAdaptiveGroups','sum{rowsRead rowsWritten}','databaseId'],
    kv: ['kvOperationsAdaptiveGroups','sum{requests}','namespaceId actionType'],
    kvSize: ['kvStorageAdaptiveGroups','max{byteCount}','namespaceId',now-dayMs],
    r2: ['r2OperationsAdaptiveGroups','sum{requests}','bucketName actionType storageClass',period.month],
    r2Size: ['r2StorageAdaptiveGroups','max{payloadSize metadataSize}','bucketName date storageClass',period.month],
    objects: ['durableObjectsInvocationsAdaptiveGroups','sum{requests}','scriptName'],
    objectTime: ['durableObjectsPeriodicGroups','sum{duration rowsRead rowsWritten}','namespaceId'],
    objectSize: ['durableObjectsSqlStorageGroups','max{storedBytes}','namespaceId',now-dayMs],
    queue: ['queueMessageOperationsAdaptiveGroups','sum{billableOperations}','queueId'],
    ai: ['aiInferenceAdaptiveGroups','sum{totalNeurons}',''],
    workflows: ['workflowsAdaptiveGroups','sum{allStepCount}','workflowName'],
    hyperdrive: ['hyperdriveQueriesAdaptiveGroups','count','configId'],
    browser: ['browserRenderingBrowserTimeUsageAdaptiveGroups','sum{totalSessionDurationMs}',''],
    builds: ['workersBuildsBuildMinutesAdaptiveGroups','sum{buildMinutes}','',period.month],
  };
  const entries = Object.entries(sources);
  const results = await Promise.all(entries.map(([,args]) => optional(query(...args))));
  const rows = Object.fromEntries(entries.map(([key],i) => [key, results[i]]));
  // Link storage to its consumers only with a complete binding inventory. Large
  // accounts and tokens without metadata access still have resource-level totals.
  if (scripts && scripts.length <= remainingCalls - 8) {
    const settings = await Promise.all(scripts.map(s => optional(request('/accounts/'+account+'/workers/scripts/'+encodeURIComponent(s.id)+'/settings'))));
    for (const [i,meta] of settings.entries()) {
      const bindings = meta?.result?.bindings;
      if (!Array.isArray(bindings)) { bindingsComplete = false; continue; }
      const project = label('worker',scripts[i].id);
      for (const b of bindings) {
        if (b.type === 'd1') bind('d1',b.id,project);
        if (b.type === 'kv_namespace') bind('kv',b.namespace_id,project);
        if (b.type === 'r2_bucket') bind('r2',b.bucket_name,project);
      }
    }
  } else bindingsComplete = false;
  function named(kind, id, used) { return { name: label(kind, id), used }; }
  const pair = r => [r.name,r.used];
  const invocations = rows.worker && rows.pages && [
    ...(scripts ?? []).map(s => named('worker', s.id, 0)),
    ...(pages ?? []).map(p => named('pages', p.name, 0)),
    ...rows.worker.map(r => named('worker',r.dimensions.scriptName,r.sum.requests)),
    ...rows.pages.map(r => named('pages',r.dimensions.scriptName,r.sum.requests)),
  ];
  metric('Workers / Pages','请求数',100000,invocations,pair,{ note:'Workers 和 Pages Functions 共用每日额度。' });
  for (const [title,limit,field] of [['读取行数',5000000,'rowsRead'],['写入行数',100000,'rowsWritten']]) {
    const values = rows.d1 && [...(databases ?? []).map(db => named('d1',db.uuid,0)), ...rows.d1.map(r => named('d1',r.dimensions.databaseId,r.sum[field]))];
    metric('D1',title,limit,values,pair,{ unit:'行' });
  }
  metric('D1','数据库存储',5e9,databases?.every(db => Number.isFinite(db.file_size)) ? databases : null,
    db => [label('d1',db.uuid),db.file_size],{ window:'size',unit:'B' });
  metric('D1','数据库数量',10,databases,db => [label('d1',db.uuid),1],{window:'size',unit:'个'});
  for (const [action,title,limit] of [['read','读取',100000],['write','写入',1000],['delete','删除',1000],['list','列举',1000]]) {
    const values = rows.kv && [...(namespaces ?? []).map(ns => named('kv',ns.id,0)), ...rows.kv.filter(r => r.dimensions.actionType===action).map(r => named('kv',r.dimensions.namespaceId,r.sum.requests))];
    metric('KV',title,limit,values,pair);
  }
  metric('KV','存储',1e9,rows.kvSize?.length || namespaces?.length === 0 ? rows.kvSize : null,
    r => [label('kv',r.dimensions.namespaceId),r.max.byteCount],{ window:'size',unit:'B',note:'最近 24 小时各命名空间的存储峰值。',estimate:true });
  const storageClass = r => r.dimensions.storageClass?.replace(/[_ -]/g,'').toLowerCase();
  const standard = r => storageClass(r) === 'standard';
  const knownStorage = rows => rows?.every(r => ['standard','infrequentaccess'].includes(storageClass(r))) ? rows : null;
  const freeActions = new Set(['DeleteObject','DeleteBucket','AbortMultipartUpload']);
  const r2Operations = knownStorage(rows.r2)?.every(r => !standard(r) || classA.has(r.dimensions.actionType) || classB.has(r.dimensions.actionType) || freeActions.has(r.dimensions.actionType)) ? rows.r2 : null;
  for (const [type,limit,actions] of [['A',1e6,classA],['B',1e7,classB]]) {
    metric('R2','Class '+type+' 操作',limit,r2Operations,r => standard(r) && actions.has(r.dimensions.actionType) ? [label('r2',r.dimensions.bucketName),r.sum.requests] : null,{window:'month',note:'按所设周期统计 Standard 存储的操作量。',estimate:true});
  }
  const cycleDays = (period.end-period.month)/dayMs;
  metric('R2','标准存储',10,knownStorage(rows.r2Size),r => standard(r) ? [label('r2',r.dimensions.bucketName),(r.max.payloadSize+r.max.metadataSize)/1e9/cycleDays] : null,
    {window:'month',unit:'GB·月',note:'按桶的每日存储峰值折算本期累计 GB·月。',estimate:true});
  for (const [product,title,limit,source,dim,field,unit] of [
    ['Durable Objects','请求数',100000,'objects','scriptName','requests','次'],
    ['Durable Objects','运行时长',13000,'objectTime','namespaceId','duration','GB·s'],
    ['Durable Objects','读取行数',5e6,'objectTime','namespaceId','rowsRead','行'],
    ['Durable Objects','写入行数',1e5,'objectTime','namespaceId','rowsWritten','行'],
    ['Queues','消息操作',10000,'queue','queueId','billableOperations','次'],
    ['Workers AI','推理用量',10000,'ai','','totalNeurons','Neurons'],
    ['Workflows','执行步骤',3000,'workflows','workflowName','allStepCount','步'],
    ['Hyperdrive','查询次数',100000,'hyperdrive','configId','count','次'],
    ['Browser Run','运行时长',10,'browser','','totalSessionDurationMs','分钟'],
  ]) {
    metric(product,title,limit,rows[source],r => [label(source==='objects'?'worker':source,r.dimensions?.[dim]),field==='count' ? r.count : r.sum[field]/(source==='browser'?60000:1)],{unit});
  }
  metric('Durable Objects','SQLite 存储',5e9,rows.objectSize,r => [label('objectTime',r.dimensions.namespaceId),r.max.storedBytes],
    {window:'size',unit:'B',note:'最近 24 小时各命名空间的存储峰值。',estimate:true});
  metric('Workers Builds','构建时长',3000,rows.builds,r => ['账号合计',r.sum.buildMinutes],
    {window:'month',unit:'分钟',note:'Cloudflare 仅提供账号级构建分钟数。'});
  // A deployed direct upload is not a Pages build. Count successful build stages
  // from the current calendar month; deployments removed by the owner are unavailable.
  const calendar = usagePeriod(now);
  const builds = pages && await optional(Promise.all(pages.map(async page => {
    const deployments = await list('pages/projects/'+encodeURIComponent(page.name)+'/deployments',25,calendar.month);
    return named('pages',page.name,deployments.filter(d => Date.parse(d.created_on)>=calendar.month && d.stages?.some(s => s.name==='build' && s.status==='success')).length);
  })));
  metric('Pages','成功构建',500,builds,pair,{window:'calendar',note:'按本月可查询的成功构建阶段估算，排除直接上传。',estimate:true});
  return { status:'ready', at:now, dayEnd:period.day+dayMs, monthStart:period.month, monthEnd:period.end, calendarEnd:calendar.end, metrics };
}

export const usageCron = '0 16 * * *'; // Midnight in Asia/Shanghai.
export function nextUsageUpdate(now) {
  const offset = 8 * 3_600_000;
  return (Math.floor((now + offset) / dayMs) + 1) * dayMs - offset;
}
function snapshotScope(env) {
  return env.CF_USAGE_PREVIEW_SCOPE || env.CF_USAGE_ACCOUNT_ID;
}

export async function refreshCloudflareUsage(env, now, read = collectUsage) {
  const scope = snapshotScope(env);
  if (!scope || (!env.CF_USAGE_TOKEN && !env.CF_USAGE_PREVIEW_SCOPE)) return;
  const slot = nextUsageUpdate(now) - dayMs;
  const lease = now + 10 * 60_000;
  const claim = await env.DB.prepare(`INSERT INTO rp_cloudflare_usage(scope,slot,lease_until) VALUES(?,?,?)
    ON CONFLICT(scope) DO UPDATE SET slot=excluded.slot,lease_until=excluded.lease_until
    WHERE slot < excluded.slot OR (slot=excluded.slot AND sampled_at < excluded.slot AND lease_until <= ?)
    RETURNING slot`).bind(scope,slot,lease,now).first();
  if (!claim) return;
  try {
    const report = await read(env, now);
    if (report.status !== 'ready' || !Number.isFinite(report.at) || report.at < slot ||
        !report.metrics?.some(metric => Number.isFinite(metric.used))) throw Error('No usable Cloudflare snapshot');
    await env.DB.prepare('UPDATE rp_cloudflare_usage SET payload=?,sampled_at=?,lease_until=0 WHERE scope=? AND slot=? AND lease_until=?')
      .bind(JSON.stringify(report),report.at,scope,slot,lease).run();
    recent.delete(env);
  } catch (error) {
    await env.DB.prepare('UPDATE rp_cloudflare_usage SET lease_until=0 WHERE scope=? AND slot=? AND lease_until=?')
      .bind(scope,slot,lease).run();
    throw error;
  }
}

export async function cloudflareUsage(env, now) {
  const scope = snapshotScope(env);
  if (!scope) return {status:'unconfigured'};
  const cached = recent.get(env);
  if (cached?.scope === scope && now < cached.expires) return cached.data;
  const row = await env.DB.prepare('SELECT payload,sampled_at,lease_until FROM rp_cloudflare_usage WHERE scope=?').bind(scope).first();
  const nextUpdateAt = nextUsageUpdate(now);
  const refreshing = row?.lease_until > now || now < nextUpdateAt - dayMs + 60_000;
  if (!row?.payload) {
    if (!env.CF_USAGE_TOKEN && !env.CF_USAGE_PREVIEW_SCOPE) return {status:'unconfigured'};
    return {status:'pending',nextUpdateAt,refreshing};
  }
  const stale = row.sampled_at < nextUpdateAt - dayMs;
  const data = {...JSON.parse(row.payload),nextUpdateAt,stale,refreshing:stale && refreshing};
  recent.set(env,{scope, data, expires:stale ? now+30_000 : nextUpdateAt});
  return data;
}

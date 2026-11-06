import { Alert, Badge, Button, Empty, Flex, Progress, Segmented, Skeleton, Table, Tag, Tooltip } from 'antd';
import { RefreshCw, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TableColumnsType } from 'antd';
import { readStatus } from './data';
import type { Item, Range, State, StatusBundle, Summary } from './data';
import { HostMetrics } from './load';
import type { HostLoad } from './load';
import { HistoryBars, displayTime, labels, states, windows } from './status-history';

type Node = {
  instance: { id: string; name: string };
  reportedAt: number | null; serviceHealthy: boolean; connections: number | null;
  load: HostLoad | null; credentials: { online: boolean | null; revoked: boolean }[];
};

function TimeAxis({ data, range }: { data: Summary; range: Range }) {
  const format = new Intl.DateTimeFormat('zh-CN', range === '24h'
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit' });
  const end = Math.min(data.at, data.start + 72 * data.width);
  return <div className="history-axis" aria-label="历史时间轴">
    {[0, .25, .5, .75, 1].map(fraction => <time key={fraction}
      dateTime={new Date((data.start + (end - data.start) * fraction) * 1000).toISOString()}>
      {format.format((data.start + (end - data.start) * fraction) * 1000)}
    </time>)}
  </div>;
}

export function AdminOverview({ node, revision, refresh }: { node: Node; revision: number; refresh: () => void }) {
  const [bundle, setBundle] = useState<StatusBundle | null>(null);
  const [range, setRange] = useState<Range>('24h');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    addEventListener('online', update); addEventListener('offline', update);
    const timer = setInterval(() => setNow(Date.now() / 1000), 15000);
    return () => { removeEventListener('online', update); removeEventListener('offline', update); clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!online) { setLoading(false); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let pending = false;
    async function load() {
      if (document.hidden || pending) return;
      clearTimeout(timer);
      pending = true;
      setLoading(true);
      try {
        const next = await readStatus(node.instance.id, controller.signal);
        if (!controller.signal.aborted) { setBundle(next); setError(false); setNow(Date.now() / 1000); }
      } catch { if (!controller.signal.aborted) setError(true); }
      finally {
        pending = false;
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(load, 60000); }
      }
    }
    void load();
    document.addEventListener('visibilitychange', load);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', load); };
  }, [node.instance.id, revision, online]);
  const data = bundle?.instanceId === node.instance.id ? bundle.windows[range] : null;
  const fresh = online && !!node.reportedAt && now - node.reportedAt <= 150;
  const expired = !data || now - data.at > 150;
  const currentState = (item?: Item): State => !item || !online || error || expired || !item.at || now - item.at > 150 ? 'unknown' : item.status;
  const traffic = online && !error && !expired && data?.lastReport && now - data.lastReport <= 150 &&
    data.traffic?.month === new Date(now * 1000).toISOString().slice(0, 7) ? data.traffic : null;
  const used = traffic ? Math.max(0, traffic.planGB - traffic.remainingGB) : null;
  const percent = traffic && traffic.planGB > 0 ? Math.max(0, Math.min(100, used! / traffic.planGB * 100)) : 0;
  const connection = data?.checks.find(item => item.id === 'connections');
  const columns: TableColumnsType<Item> = [
    { title: '检查项目', key: 'name', width: 152, className: 'check-name', render: (_, item) => <span className="check-label"><Badge color={states[currentState(item)].color} /><span>{labels[item.id]}</span></span> },
    { title: '历史状态', key: 'history', className: 'check-history', render: (_, item) => data && <HistoryBars item={item} data={data} instanceId={node.instance.id} activeTooltip={activeTooltip} setActiveTooltip={setActiveTooltip} /> },
    { title: '成功率', key: 'rate', width: 84, align: 'right', className: 'check-rate', render: (_, item) => <span aria-label={'成功率 ' + (item.rate === null ? '暂无数据' : item.rate + '%')}>{item.rate === null ? '—' : Number(item.rate.toFixed(2)) + '%'}</span> },
    { title: <Tooltip title="最近一次入口 TCP 建连耗时">建连耗时</Tooltip>, key: 'latency', width: 102, align: 'right', className: 'check-latency', render: (_, item) => currentState(item) === 'unknown' || item.latency === null ? '—' : item.latency + ' ms' },
  ];
  return <>
    <section className="node-summary" aria-label="节点信息">
      <span className="node-icon"><Server size={28} strokeWidth={1.5} /></span>
      <div className="node-description">
        <div className="node-title"><h2>{node.instance.name}</h2><Tag color={fresh ? node.serviceHealthy ? 'success' : 'error' : 'default'}>{fresh ? node.serviceHealthy ? '健康' : '异常' : '待更新'}</Tag></div>
        <div className="node-facts">
          <span>{node.instance.id} · 固定出口</span>
          {(['edge4', 'edge6'] as const).map(id => { const state = currentState(data?.checks.find(item => item.id === id)); return <Badge key={id} color={states[state].color} text={`${id === 'edge4' ? 'IPv4' : 'IPv6'} ${state === 'ok' ? '在线' : states[state].label}`} />; })}
          <span>{fresh ? node.credentials.filter(row => row.online && !row.revoked).length : '—'} 个在线凭证 / {fresh ? node.connections ?? '—' : '—'} 条连接</span>
        </div>
      </div>
    </section>
    <section className="console-history" aria-labelledby="history-title">
      <div className="section-heading">
        <h2 id="history-title">连接状态</h2>
        <Flex gap={12} align="center">
          <Button type="text" aria-label="刷新状态" title="刷新状态" loading={loading} icon={<RefreshCw size={16} />} onClick={refresh} />
          <Segmented<Range> aria-label="时间范围" value={range} options={Object.entries(windows).map(([value, label]) => ({ value: value as Range, label }))} onChange={value => { setRange(value); setActiveTooltip(null); }} />
        </Flex>
      </div>
      {(!online || error || (data && expired)) && <Alert className="console-alert" type="warning" showIcon title={!online ? '设备已离线，联网后自动恢复' : error ? '历史数据读取失败，正在自动重试' : '历史数据已过期，等待更新'} />}
      {!data && loading ? <Skeleton active paragraph={{ rows: 5 }} /> : <>
        <Table<Item> className="status-table" columns={columns} dataSource={data?.checks.filter(item => item.id !== 'connections') ?? []} rowKey="id" pagination={false} tableLayout="fixed" locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史数据" /> }} />
        {data && <div className="status-axis"><TimeAxis data={data} range={range} /></div>}
        <Flex className="history-legend" gap={24} justify="center" wrap>{Object.entries(states).map(([key, state]) => <Badge key={key} color={state.color} text={key === 'ok' ? '正常' : state.label} />)}</Flex>
      </>}
    </section>
    <section className="connection-section" aria-labelledby="connection-title">
      <div className="connection-heading"><h2 id="connection-title">节点连接数</h2><span>历史峰值 · 区间档位</span></div>
      {data && connection ? <>
        <div className="connection-plot">
          <div className="connection-scale" aria-hidden="true"><span>≥100</span><span>&lt;100</span><span>&lt;50</span><span>&lt;30</span><span>&lt;10</span></div>
          <HistoryBars item={connection} data={data} instanceId={node.instance.id} activeTooltip={activeTooltip} setActiveTooltip={setActiveTooltip} />
        </div>
        <div className="connection-axis"><TimeAxis data={data} range={range} /></div>
      </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无连接记录" />}
    </section>
    <section className="resource-strip" aria-label="节点资源">
      <HostMetrics load={fresh ? node.load : null} />
      <div className="monthly-traffic"><div className="resource-label">月流量 <span>{traffic?.month ?? '待更新'}</span></div>
        <div className="resource-value">{used === null ? '—' : used.toLocaleString('zh-CN')}<small>{traffic ? ' / ' + traffic.planGB.toLocaleString('zh-CN') + ' GB' : ''}</small></div>
        <Progress percent={percent} showInfo={false} strokeColor={percent > 90 ? states.down.color : states.ok.color} railColor="#e9edf3" size={['100%', 5]} aria-label="本月已用流量百分比" />
        <span className="traffic-remaining">{traffic ? '剩余约 ' + traffic.remainingGB.toLocaleString('zh-CN') + ' GB' : '暂无流量数据'}</span>
      </div>
    </section>
    {data && <div className="history-updated">历史更新于 {displayTime(data.at)}</div>}
  </>;
}

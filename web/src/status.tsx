import {
  Alert, Badge, Empty, Flex, Table,
} from 'antd';
import { ArrowLeftRight } from 'lucide-react';
import { Card } from './beui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './beui/tabs';
import { useEffect, useRef, useState } from 'react';
import type { TableColumnsType } from 'antd';
import { cachedStatus, readInstances, readStatus } from './data';
import { pollVisible } from './polling';
import { remainingTraffic } from './traffic';
import type { InitialData, Item, Range, State, StatusBundle } from './data';
import { HostMetrics, MetricCard } from './load';
import type { HostLoad } from './load';
import { InstanceNavigation } from './instance-navigation';

import { HistoryBars, labels, states, windows, displayTime } from './status-history';
import { measurementFresh } from './freshness';

// Older public Workers omit the link measurement. Keep that distinct from a measured failure.
const unpublishedLink: Item = { id: 'link', at: null, status: 'unknown', rate: null, latency: null, history: [] };

const number = (value: number) => value.toLocaleString('zh-CN');

export type PrivateNode = {
  instance: { id: string; name: string }; at: number; reportedAt: number | null; freshFor?: number;
  load: HostLoad | null;
};

export function StatusOverview({ initial, pending, privateNode, hidden }: {
  initial: InitialData; pending?: Promise<InitialData>; privateNode?: PrivateNode | null; hidden?: boolean;
}) {
  const [instances, setInstances] = useState(initial.instances);
  const [instanceId, setInstanceId] = useState<string | null>(initial.instances[0]?.id ?? null);
  const [instanceError, setInstanceError] = useState(initial.instanceError);
  const [catalogPending, setCatalogPending] = useState(!pending && (initial.instanceError || !initial.completedAt));
  const [range, setRange] = useState<Range>('24h');
  const [bundle, setBundle] = useState<StatusBundle | null>(initial.bundle);
  const data = bundle?.instanceId === instanceId ? bundle.windows[range] : null;
  const [error, setError] = useState(initial.error);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const initialPoll = useRef<{ id?: string; completedAt: number }>({ id: initial.instances[0]?.id, completedAt: initial.completedAt });


  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if (!pending) return;
    let active = true;
    void pending.then(next => {
      if (!active) return;
      const id = next.instances[0]?.id;
      initialPoll.current = { id, completedAt: next.bundle ? next.completedAt : 0 };
      setInstances(next.instances); setInstanceId(id ?? null); setBundle(next.bundle);
      setInstanceError(next.instanceError); setError(next.error);
      setCatalogPending(next.instanceError);
    });
    return () => { active = false; };
  }, [pending]);

  useEffect(() => {
    if (!catalogPending) return;
    return pollVisible(async signal => {
      const entries = await readInstances(signal);
      if (signal.aborted) return;
      setInstances(entries);
      setInstanceId(current => entries.some(entry => entry.id === current) ? current : entries[0].id);
      setInstanceError(false); setCatalogPending(false);
      return false;
    }, { onError: () => setInstanceError(true) });
  }, [catalogPending]);

  useEffect(() => {
    if (!instanceId) return;
    const initialDelay = initialPoll.current.id === instanceId && initialPoll.current.completedAt
      ? Math.max(0, 60_000 - (Date.now() - initialPoll.current.completedAt)) : 0;
    initialPoll.current.id = undefined;
    return pollVisible(async signal => {
      const next = await readStatus(instanceId, signal);
      if (signal.aborted) return;
      setBundle(next); setError(false); setNow(Date.now() / 1000);
    }, { initialDelay, onError: () => setError(true) });
  }, [instanceId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 15_000);
    return () => clearInterval(timer);
  }, []);

  const loading = !data && !error && !instanceError && online;

  const stale = Boolean(data && (!online || !measurementFresh(data.at, now) || error));
  const checks = data?.checks ?? [];
  const rows = data && !checks.some(item => item.id === 'link') ? [...checks, unpublishedLink] : checks;
  const currentState = (item: Item): State =>
    data && measurementFresh(item.at, data.at, item.freshFor) ? item.status : 'unknown';
  const reportFresh = Boolean(data && measurementFresh(data.lastReport, data.at, data.freshFor));
  const traffic = remainingTraffic(data?.traffic, reportFresh, now);
  const remaining = traffic?.percent ?? null;
  const quotaColor = traffic?.level && traffic.level !== 'ok' ? states[traffic.level].color : undefined;
  const managedNode = privateNode?.instance.id === instanceId ? privateNode : null;
  const privateFresh = managedNode && measurementFresh(managedNode.reportedAt, managedNode.at, managedNode.freshFor);
  const publicLoad = reportFresh ? data?.load : null;
  const load = privateFresh && managedNode.at > (data?.at ?? 0) ? managedNode.load : publicLoad;

  const columns: TableColumnsType<Item> = [
    {
      title: '检查项目',
      key: 'name',
      width: 152,
      className: 'check-name',
      render: (_, item) => <span className="check-label">
        <Badge color={states[currentState(item)].color} role="img" aria-label={(stale ? '上次状态：' : '当前状态：') + states[currentState(item)].label} />
        <span>{labels[item.id]}</span>
      </span>,
    },
    {
      title: '历史状态',
      key: 'history',
      className: 'check-history',
      render: (_, item) => (
        item.id === 'link' && (!item.history.length || !item.at && item.rate === null) ? <span className="link-awaiting">暂无公开的探针样本</span> :
        data && <HistoryBars item={item} data={data} instanceId={instanceId}
          activeTooltip={activeTooltip} setActiveTooltip={setActiveTooltip} />
      ),
    },
    {
      title: '成功率',
      key: 'rate',
      align: 'right',
      width: 84,
      className: 'check-rate',
      render: (_, item) => (
        <span aria-label={'成功率 ' + (item.rate === null ? '暂无数据' : item.rate.toFixed(2) + '%')}>
          {item.rate === null ? '—' : Number(item.rate.toFixed(2)) + '%'}
        </span>
      ),
    },
    {
      title: '延迟',
      key: 'latency',
      align: 'right',
      width: 102,
      className: 'check-latency',
      render: (_, item) => {
        const latency = currentState(item) === 'unknown' || item.latency === null ? '—' : item.latency + ' ms';
        return <span aria-label={(item.id === 'link' ? '链路延迟 ' : '建连耗时 ') + latency}>{latency}</span>;
      },
    },
  ];

  return (
        <main className="status-content" hidden={hidden}>
          <section className="node-overview" aria-label="节点概况">
            <h1>节点概览</h1>
            <InstanceNavigation instances={instances} value={instanceId} onChange={value => {
              if (value !== instanceId) {
                setInstanceId(value);
                setBundle(cachedStatus(value));
                setError(false);
                setActiveTooltip(null);
              }
            }} />
          </section>

          {!data && (!online || instanceError || error) && <Alert type="warning"
            title={!online ? '设备已离线，联网后自动恢复' : '暂时无法读取数据，正在自动重试'}
            showIcon className="status-alert" />}
          {stale && data && <div className="snapshot-note" role="status"
            title="保留上次成功读取的数据，恢复连接后自动更新；并非实时状态">
            上次数据 · <time dateTime={new Date(data.at * 1000).toISOString()}>{displayTime(data.at)}</time>
          </div>}

          <HostMetrics load={load}>
            <MetricCard label="本月剩余流量" icon={ArrowLeftRight} iconColor="var(--icon-traffic)" percent={remaining} color={quotaColor}
              value={<><span className="traffic-amount">{traffic ? <>
                <span><small>约 </small>{number(traffic.remainingGB)}<small> GB</small></span>
                <small className="traffic-total">/ {number(traffic.planGB)} GB</small>
              </> : '—'}</span>{traffic && <time className="traffic-reset" dateTime={new Date(traffic.resetAt * 1000).toISOString()}
                title="流量按 UTC 自然月统计，重置时间按本地时区显示">下次重置 {displayTime(traffic.resetAt)}</time>}</>} />
          </HostMetrics>
          <section aria-labelledby="history-title" className="history-section">
            <Card className="history-card">
              <Tabs value={range} onValueChange={value => {
                setRange(value as Range);
                setActiveTooltip(null);
              }}>
                <div className="section-heading">
                  <h2 id="history-title">稳定性记录</h2>
                  <TabsList aria-label="时间范围" wrapperClassName="pill-group" className="pill-list">
                    {Object.entries(windows).map(([value, label]) =>
                      <TabsTrigger key={value} value={value}>{label}</TabsTrigger>)}
                  </TabsList>
                </div>
                {Object.keys(windows).map(value => <TabsContent key={value} value={value} className="history-panel">
                  {value === range && <>
                  <Table<Item>
                    className="status-table"
                    columns={columns}
                    dataSource={rows}
                    rowKey="id"
                    pagination={false}
                    tableLayout="fixed"
                    loading={loading}
                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" /> }}
                  />
                  <div className="history-footer">
                    <Flex className="history-legend" gap={16} wrap>
                      {Object.values(states).map(state => <Badge key={state.label} color={state.color} text={state.label} />)}
                    </Flex>
                    {data && <span className="history-period">{displayTime(data.start)} – {displayTime(data.at)}</span>}
                  </div>
                  </>}
                </TabsContent>)}
              </Tabs>
            </Card>
          </section>

          {!!data?.events.length && (
            <section className="events-section" aria-labelledby="events-title">
              <h2 id="events-title">状态变化</h2>
              <Table
                size="small"
                showHeader={false}
                pagination={false}
                rowKey={event => event.id + '-' + event.at}
                dataSource={data.events}
                columns={[
                  { key: 'name', render: (_, event) => labels[event.id] },
                  { key: 'status', render: (_, event) => <Badge color={states[event.status].color} text={states[event.status].label} /> },
                  { key: 'time', align: 'right', render: (_, event) => <time>{displayTime(event.at)}</time> },
                ]}
              />
            </section>
          )}
        </main>
  );
}

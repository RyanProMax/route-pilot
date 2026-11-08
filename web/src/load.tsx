import { Progress } from 'antd';
import type { ReactNode } from 'react';
export type HostLoad = {cpu:number|null; memory:number|null; disk:number|null; load1:number|null};
export function HostMetrics({load, children}: {load:HostLoad|null|undefined; children?: ReactNode}) {
  return <section className="host-metrics" aria-label="节点资源">
    {([['cpu','CPU'],['memory','内存'],['disk','磁盘']] as const).map(([key,label]) => {
      const value = load?.[key];
      return <div className="host-metric" key={key}>
        <div className="host-metric-label"><span>{label}</span><span>{value == null ? '—' : value+'%'}</span></div>
        <Progress percent={value ?? 0} showInfo={false} strokeColor="var(--rp-primary)" railColor="var(--rp-rail)" size={['100%',3]} aria-label={label+'使用率'} />
      </div>;
    })}
    {children}
  </section>;
}

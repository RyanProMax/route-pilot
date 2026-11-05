import { Progress } from 'antd';
export type HostLoad = {cpu:number|null; memory:number|null; disk:number|null; load1:number|null};
export function HostMetrics({load}: {load:HostLoad|null|undefined}) {
  return <section className="host-metrics" aria-label="主机负载">
    {([['cpu','CPU'],['memory','内存'],['disk','磁盘']] as const).map(([key,label]) => {
      const value = load?.[key];
      return <div className="host-metric" key={key}>
        <div className="host-metric-label"><span>{label}</span><span>{value == null ? '—' : value+'%'}</span></div>
        <Progress percent={value ?? 0} showInfo={false} strokeColor="#159b76" railColor="#edf0ee" size={['100%',4]} aria-label={label+'使用率'} />
      </div>;
    })}
    <div className="host-metric"><div className="host-metric-label"><span>系统负载</span><span>{load?.load1?.toFixed(2) ?? '—'}</span></div></div>
  </section>;
}

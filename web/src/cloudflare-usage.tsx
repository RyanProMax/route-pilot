import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Alert, Skeleton } from "antd";
import { Boxes, Braces, ChevronDown, Cloud, Database, HardDrive, Layers3, TriangleAlert } from "lucide-react";
import { pollVisible } from "./polling";
import "./cloudflare-usage.css";

type Metric = {
  product: string; title: string; window: "day" | "month" | "calendar" | "size";
  used: number | null; limit: number; unit: string; estimate: boolean;
  projects: { name: string; used: number }[] | null;
};
type Snapshot = { status: "ready"; at: number; dayEnd: number; monthStart: number; monthEnd: number; calendarEnd: number; metrics: Metric[] };
const percent = new Intl.NumberFormat("zh-CN", {style:"percent", maximumFractionDigits:2});
const number = new Intl.NumberFormat("zh-CN", {maximumFractionDigits:2});
const date = (at: number) => new Date(at).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});
const periodNames = {day:"每日", month:"每月", calendar:"每月", size:"当前占用"};
const ratio = (m: Metric) => m.used === null ? -1 : m.used / m.limit;
const metricKey = (m: Metric) => m.product + " · " + m.title;

function share(part: number, total: number) {
  if (total === 0) return "—";
  const value = part / total;
  return value > 0 && value < .0001 ? "<0.01%" : percent.format(value);
}

function ResetDates({report}: {report:Snapshot}) {
  const splitMonth = report.monthEnd !== report.calendarEnd;
  return <div className="usage-dates">
    <span>更新于 {date(report.at)}</span>
    <span>{splitMonth ? "账期重置" : "月额度重置"} {date(report.monthEnd)}</span>
    {splitMonth && <span>自然月重置 {date(report.calendarEnd)}</span>}
  </div>;
}
function quantity(value: number, unit: string) {
  if (unit === "B") {
    const level = Math.min(3, Math.max(0, Math.floor(Math.log10(value || 1) / 3)));
    return number.format(value / 1000 ** level) + " " + ["B","KB","MB","GB"][level];
  }
  const amount = value > 0 && value < .01 ? "<0.01" : number.format(value);
  return amount + " " + unit;
}
function ProductIcon({product}: {product:string}) {
  const Icon = product === "D1" ? Database : product === "KV" ? Layers3 : product === "R2" ? HardDrive
    : product.includes("Workers") ? Cloud : product === "Pages" ? Braces : Boxes;
  return <span className="usage-icon" data-product={product}><Icon size={17} strokeWidth={1.65} aria-hidden="true" /></span>;
}
function QuotaMeter({value, limit, remaining, label}: {value: number; limit: number; remaining?: boolean; label: string}) {
  const displayed = remaining ? Math.max(0, limit - value) : value;
  const portion = share(displayed, limit);
  return <span className="usage-ratio">
    <meter className="usage-meter" min={0} max={limit} value={Math.min(limit, displayed)}
      data-level={value >= limit ? "full" : value >= .8 * limit ? "warning" : undefined}
      aria-label={label} aria-valuetext={portion}/>
    <span>{portion}</span>
  </span>;
}
function Reveal({id, open, children}: {id: string; open: boolean; children: ReactNode}) {
  return <div id={id} className="usage-reveal" data-open={open} inert={!open} aria-hidden={!open}>
    <div className="usage-reveal-inner">{children}</div>
  </div>;
}
function UsageMetric({metric:m, splitMonth}: {metric:Metric;splitMonth:boolean}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const used = m.used;
  const period = splitMonth && m.window === "month" ? "账期" : splitMonth && m.window === "calendar" ? "自然月" : periodNames[m.window];
  const summary = <>
    <span className="usage-product"><ProductIcon product={m.product}/><span><strong>{m.product}</strong><small>{m.title}</small></span></span>
    <span className="usage-period">{period}</span>
    <span className="usage-amount">{used === null ? "—" : (m.estimate && used > 0 ? "≈ " : "") + quantity(used,m.unit)}<small> / {quantity(m.limit,m.unit)}</small></span>
    <span className="usage-left">{used === null
      ? <span className="usage-warning"><TriangleAlert size={14} aria-hidden="true"/>暂不可用</span>
      : <QuotaMeter value={used} limit={m.limit} remaining label={metricKey(m) + "剩余比例"}/>}</span>
  </>;
  if (used === null || !m.projects?.length) {
    return <div className="usage-detail"><div className="usage-summary">{summary}</div></div>;
  }
  return <div className="usage-detail">
    <button type="button" className="usage-summary" aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(value=>!value)}>
      {summary}<ChevronDown className="usage-chevron" size={15} aria-hidden="true"/>
    </button>
    <Reveal id={panelId} open={open}>
      <div className="usage-breakdown">
        <ul aria-label={metricKey(m) + "各项目占免费额度"}>
          {m.projects.map(project => {
            const amount = quantity(project.used, m.unit);
            return <li key={project.name} title={amount + " / " + quantity(m.limit, m.unit)}>
              <span className="usage-project-name">{project.name}</span>
              <QuotaMeter value={project.used} limit={m.limit} label={project.name + "占免费额度"}/>
            </li>;
          })}
        </ul>
      </div>
    </Reveal>
  </div>;
}

export function CloudflareUsage({onExpired}: {onExpired:()=>void}) {
  const [report,setReport] = useState<Snapshot|null>(null);
  const [message,setMessage] = useState("");
  const [busy,setBusy] = useState(true);
  const [showAll,setShowAll] = useState(false);
  const expired = useRef(onExpired);
  expired.current = onExpired;
  useEffect(() => {
    let nextRead = 0;
    return pollVisible(async signal => {
      if (Date.now() < nextRead) return nextRead - Date.now();
      const res = await fetch("/private/cloudflare-usage", {cache:"no-store", signal});
      if (signal.aborted) return;
      if (res.status === 401 || res.status === 403) { expired.current(); return false; }
      if (!res.ok) throw Error();
      const data = await res.json();
      if (signal.aborted) return;
      setBusy(false);
      if (data.status === "unconfigured") {
        setReport(null);
        setMessage("尚未连接 Cloudflare 账号。请在服务端配置只读用量凭据。");
        return false;
      }
      if (!Number.isFinite(data.nextUpdateAt)) throw Error();
      if (data.status === "pending") {
        setReport(null);
        setMessage("正在等待首份每日用量快照。");
      } else if (data.status === "ready" && Array.isArray(data.metrics)) {
        setReport(data);
        setMessage(data.stale ? "今日快照尚未更新，当前显示上次采集的用量。" : "");
      } else throw Error();
      const checkAgain = data.refreshing || (data.status === "pending" && nextRead === 0);
      nextRead = checkAgain ? Date.now() + 30_000 : data.nextUpdateAt + 1500;
      return Math.max(1, nextRead - Date.now());
    }, {onError: () => { setBusy(false); setMessage("暂时无法读取用量快照，将自动重试。"); }});
  },[]);
  const metrics = [...(report?.metrics ?? [])].sort((a,b)=>ratio(b)-ratio(a));
  const primary = metrics.filter(m=>m.used !== 0);
  const additional = metrics.filter(m=>m.used === 0);
  const splitMonth = report?.monthEnd !== report?.calendarEnd;
  return <main className="console-main usage-main">
    <div className="usage-toolbar"><h1>Cloudflare 用量</h1>{report && <ResetDates report={report}/>}</div>
    {message && <Alert className="console-alert" type="info" showIcon title={message}/>}
    {!report && busy && <Skeleton active paragraph={{rows:5}}/>}
    {report && <section className="usage-panel console-panel" aria-label="各项免费额度">
        <div className="usage-panel-head"><h2>免费额度</h2></div>
        <div className="usage-columns" aria-hidden="true"><span>产品 / 指标</span><span>周期</span><span>已用 / 免费上限</span><span>剩余比例</span></div>
        {primary.map(m=><UsageMetric key={metricKey(m)} metric={m} splitMonth={splitMonth}/>)}
        {!primary.length && !showAll && <p className="usage-empty">本期暂无已使用的额度。</p>}
        {additional.length > 0 && <>
          <Reveal id="usage-additional" open={showAll}>
            {additional.map(m=><UsageMetric key={metricKey(m)} metric={m} splitMonth={splitMonth}/>)}
          </Reveal>
          <button type="button" className="usage-more" aria-expanded={showAll} aria-controls="usage-additional" onClick={()=>setShowAll(value=>!value)}>
            {showAll ? "收起指标" : "更多指标"}<ChevronDown size={15} aria-hidden="true"/>
          </button>
        </>}
      </section>}
  </main>;
}

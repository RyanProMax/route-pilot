import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Alert,Badge,Button,ConfigProvider,Flex,Form,Input,Skeleton,Table,Tooltip} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {theme} from './status';
import {HostMetrics} from './load';
import type {HostLoad} from './load';
import routeMark from './assets/routepilot-mark.svg';
import './status.css';

type Usage = {id:string; label:string; revoked:boolean; online:boolean|null; uplink:number; downlink:number; since:number; at:number; gaps:number};
type Overview = {at:number;month:string;reportedAt:number|null;load:HostLoad|null;credentials:Usage[]};
const size = (bytes:number) => {
  const units=['B','KB','MB','GB','TB']; let i=0;
  while(bytes>=1000 && i<units.length-1) {bytes/=1000;i++;}
  return new Intl.NumberFormat('zh-CN',{maximumFractionDigits:i?2:0}).format(bytes)+' '+units[i];
};
const time = (ts:number) => new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(ts*1000);
function Admin() {
  const [data,setData]=useState<Overview|null>(null), [auth,setAuth]=useState<boolean|null>(null);
  const [mode,setMode]=useState<'key'|'access'|null>(null), [revision,setRevision]=useState(0);
  const [error,setError]=useState(''), [busy,setBusy]=useState(false);
  const [form]=Form.useForm();
  useEffect(()=>{
    const controller=new AbortController();
    void fetch('/private/auth',{cache:'no-store',signal:controller.signal}).then(async r=>{
      if(!r.ok)throw Error();
      const next=await r.json();
      if(next.mode!=='key' && next.mode!=='access')throw Error();
      if(!controller.signal.aborted)setMode(next.mode);
    }).catch(()=>{if(!controller.signal.aborted)setError('暂时无法读取登录配置');});
    return ()=>controller.abort();
  },[]);
  useEffect(()=>{
    if(!mode)return;
    let stopped=false, timer:ReturnType<typeof setTimeout>;
    const controller=new AbortController();
    async function load() {
      if(document.hidden) {timer=setTimeout(load,60000); return;}
      try {
        const r=await fetch('/private/overview',{cache:'no-store',redirect:'manual',signal:controller.signal});
        if(stopped)return;
        if(r.type==='opaqueredirect' || r.status===401 || r.status===403) {setAuth(false);setData(null);setError('');return;}
        if(!r.ok)throw Error();
        const next=await r.json(); if(stopped)return;
        setData(next);setAuth(true);setError('');
      } catch {if(!stopped){setError('暂时无法读取数据');setData(value=>value?{...value,load:null,credentials:value.credentials.map(row=>({...row,online:null}))}:null);}}
      if(!stopped)timer=setTimeout(load,60000);
    }
    void load(); return ()=>{stopped=true;clearTimeout(timer);controller.abort();};
  },[mode,revision]);
  async function login(values:{key:string}) {
    setBusy(true);setError('');
    try {
      const r=await fetch('/private/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values),cache:'no-store'});
      if(!r.ok)throw Error();
      form.resetFields();setAuth(true);setRevision(value=>value+1);
    }catch{setError('密钥无效或暂时无法登录');}finally{setBusy(false);}
  }
  async function logout() {
    if(mode==='access') {window.location.assign('/cdn-cgi/access/logout');return;}
    setBusy(true);
    try {
      const r=await fetch('/private/session',{method:'DELETE',cache:'no-store'});
      if(!r.ok)throw Error();
      setData(null);setAuth(false);setRevision(value=>value+1);
    }catch{setError('退出失败，请重试');}finally{setBusy(false);}
  }
  return <ConfigProvider theme={theme} locale={zhCN}><div className="status-page admin-page">
    <header className="site-header"><a className="brand" href="/"><img src={routeMark} alt="" width={40} height={40}/><span>route-pilot</span></a>
      {auth && <Button type="text" loading={busy} onClick={logout}>退出</Button>}</header>
    <main>
      {error && <Alert type="warning" title={error} className="status-alert" showIcon/>}
      {auth===false ? <section className="admin-login"><h1>管理访问</h1>
        {mode==='access' ? <Button type="primary" size="large" href="/admin/">使用 Google 登录</Button> : <Form form={form} layout="vertical" onFinish={login} requiredMark={false}>
          <Form.Item name="key" label="管理密钥" rules={[{required:true,message:'请输入管理密钥'}]}>
            <Input.Password autoComplete="current-password" size="large"/></Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>进入</Button>
        </Form>}</section> : !data ? <Skeleton active paragraph={{rows:6}}/> : <>
        <Flex className="section-heading" justify="space-between" align="center"><h2>主机负载</h2><time>{data.reportedAt ? time(data.reportedAt) : '待更新'}</time></Flex>
        <HostMetrics load={data.load}/>
        <section className="admin-usage"><Flex justify="space-between" align="center" className="section-heading"><h2>凭证流量</h2><span>{data.month}</span></Flex>
          <Table<Usage> rowKey="id" dataSource={data.credentials} pagination={false} scroll={{x:670}} columns={[
            {title:'凭证',dataIndex:'label',render:(label,row)=><Flex align="center" gap={8}><Badge color={row.online===null?'#dce3df':row.online?'#159b76':'#bdc8c2'}/><span>{label}</span>{row.revoked && <span className="usage-muted">已停用</span>}</Flex>},
            {title:'上传',dataIndex:'uplink',align:'right',render:size},
            {title:'下载',dataIndex:'downlink',align:'right',render:size},
            {title:'合计',align:'right',render:(_,row)=>size(row.uplink+row.downlink)},
            {title:'开始统计',dataIndex:'since',align:'right',render:(ts,row)=><Tooltip title={row.gaps ? '服务重启或计数重置，未采集区间可能缺失' : null}><span>{time(ts)}{row.gaps?' *':''}</span></Tooltip>},
          ]}/>
        </section></>}
    </main></div></ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<Admin/>);

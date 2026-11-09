import {
  Alert,
  App as AntApp,
  Avatar,
  Badge,
  Button,
  ConfigProvider,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Select,
  Skeleton,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Check,
  ChevronDown,
  UserRound,
  Copy,
  Ellipsis,
  KeyRound,
  LogOut,
  LogIn,
  Plus,
  Search,
} from "lucide-react";
import zhCN from "antd/locale/zh_CN";
import { theme } from "./theme";
import { StatusOverview } from "./status";
import type { InitialData } from "./data";
import { pollVisible } from "./polling";
import type { HostLoad } from "./load";
import mark from "./assets/routepilot-mark.svg";
import google from "./assets/google-g.png";
import "./status.css";
import "./app.css";

type Page = "overview" | "credentials" | "activity";
type Credential = {
  id: string;
  label: string;
  client: string;
  created: number;
  updated: number;
  revoked: boolean;
  online: boolean | null;
  has_subscription: boolean;
  download_revoked: boolean;
  uplink: number | null;
  downlink: number | null;
  at: number | null;
  gaps?: number;
  since?: number;
};
type Job = {
  id: string;
  action: string;
  device_id: string;
  state: string;
  created: number;
  finished: number | null;
  error: string | null;
  payload: { label?: string };
};
type Event = { at: number; action: string; device_id: string; outcome: string };
type ConsoleData = {
  at: number;
  month: string;
  account: { email: string; role: string };
  instance: { id: string; name: string; country: string };
  reportedAt: number | null;
  serviceHealthy: boolean;
  load: HostLoad | null;
  connections: number | null;
  controlReady: boolean;
  controlSeen: number | null;
  credentials: Credential[];
  jobs: Job[];
  events: Event[];
};
const titles: Record<Page, string> = {
  overview: "运行概览",
  credentials: "凭证管理",
  activity: "操作记录",
};
const actionNames: Record<string, string> = {
  create: "创建凭证",
  rename: "修改名称",
  revoke: "撤销凭证",
  rotate: "重置订阅地址",
  publish: "生成订阅",
  access: "查看订阅",
};
const stateNames: Record<string, string> = {
  queued: "等待执行",
  running: "执行中",
  done: "已完成",
  failed: "失败",
};
const errorNames: Record<string, string> = {
  label_conflict: "名称已存在",
  unknown_credential: "凭证不存在或已撤销",
  apply_failed: "节点执行失败",
  agent_timeout: "节点响应超时",
};
const bytes = (n: number | null) => {
  if (n === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < 4) {
    n /= 1000;
    i++;
  }
  return (
    new Intl.NumberFormat("zh-CN", { maximumFractionDigits: i ? 2 : 0 }).format(
      n,
    ) +
    " " +
    units[i]
  );
};
const time = (n: number | null) =>
  n
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(n * 1000)
    : "—";
const pageFromURL = (): Page => {
  const v = new URLSearchParams(location.search).get("view");
  return v === "credentials" || v === "activity" ? v : "overview";
};
const requestId = () => crypto.randomUUID().replaceAll("-", "");
const msg: Record<string, string> = {
  "Name already exists": "这个名称已被使用",
  "Operation in progress": "该凭证有未完成的操作",
  "Credential unavailable": "凭证不存在或已撤销",
  "Control agent unavailable": "节点尚未连接管理服务",
  "Operation conflict": "操作冲突，请刷新后重试",
  "Publish subscription first": "请先生成订阅地址",
  "Credential limit reached": "已达到凭证数量上限",
};
function Brand({ onHome }: { onHome: () => void }) {
  return (
    <a href="/" className="console-brand" aria-label="Route Pilot 状态首页" onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onHome();
    }}>
      <img src={mark} width={32} height={32} alt="" />
      <span>Route Pilot</span>
    </a>
  );
}

function RoutePilotApp({ initial }: { initial: InitialData }) {
  const { message, modal } = AntApp.useApp();
  const [data, setData] = useState<ConsoleData | null>(null),
    [auth, setAuth] = useState<boolean | null>(null),
    [ready, setReady] = useState<boolean | null>(null);
  const [page, setPage] = useState<Page>(pageFromURL),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [formOpen, setFormOpen] = useState(false),
    [editing, setEditing] = useState<Credential | null>(null);
  const [form] = Form.useForm(),
    [saving, setSaving] = useState(false),
    [access, setAccess] = useState<{
      row: Credential;
      urls: Record<string, string> | null;
    } | null>(null),
    [copyKey, setCopyKey] = useState("");
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const alive = useRef(true);
  const [loginError, setLoginError] = useState(() => {
    const value = new URLSearchParams(location.search).get("login");
    return (
      (
        {
          denied: "该 Google 账号没有管理员权限",
          expired: "登录已过期，请重新登录",
          failed: "登录未完成，请重试",
          cancelled: "已取消登录",
          unavailable: "Google 登录尚未配置",
        } as Record<string, string>
      )[value ?? ""] ?? ""
    );
  });
  const [loginOpen, setLoginOpen] = useState(() => new URLSearchParams(location.search).has("login"));
  const sessionEpoch = useRef(0);
  const wasAuthenticated = useRef(false);
  const confirmation = useRef<ReturnType<typeof modal.confirm> | null>(null);
  function forgetSession(prompt = false) {
    sessionEpoch.current++;
    wasAuthenticated.current = false;
    setAuth(false); setData(null); setAccess(null); setFormOpen(false); setEditing(null);
    setSearch(""); setFilter("all"); setCopyKey(""); form.resetFields();
    confirmation.current?.destroy(); confirmation.current = null;
    setPage("overview"); history.replaceState(null, "", "/");
    if (prompt) { setLoginError("登录已过期，请重新登录"); setLoginOpen(true); }
  }
  useEffect(() => {
    const update = () => setNow(Date.now() / 1000);
    const timer = setInterval(update, 15_000);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', update); window.removeEventListener('offline', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (new URLSearchParams(location.search).has("login")) history.replaceState(null, "", "/");
    const pop = () => setPage(pageFromURL());
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (!loginOpen) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function metadata() {
      try {
        const response = await fetch("/private/auth", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw Error();
        const next = await response.json();
        if (next.provider !== "google") throw Error();
        if (!controller.signal.aborted) setReady(next.ready === true);
      } catch {
        if (!controller.signal.aborted) {
          setLoginError("暂时无法连接登录服务，正在重试");
          timer = setTimeout(metadata, 15000);
        }
      }
    }
    void metadata();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [loginOpen]);
  useEffect(() => pollVisible(async signal => {
    const epoch = sessionEpoch.current;
    const response = await fetch("/private/console", { cache: "no-store", signal });
    if (signal.aborted || epoch !== sessionEpoch.current) return false;
    if (response.status === 401 || response.status === 403) {
      const prompt = wasAuthenticated.current;
      const requestedManagement = pageFromURL() !== "overview";
      forgetSession(prompt);
      if (requestedManagement && !prompt) setLoginOpen(true);
      return false;
    }
    if (!response.ok) throw Error();
    const next = await response.json();
    if (signal.aborted || epoch !== sessionEpoch.current) return false;
    if (next.account?.role !== "admin") { forgetSession(); return false; }
    wasAuthenticated.current = true;
    setData(next); setAuth(true); setError(""); setLoginOpen(false);
    return next.jobs.some((job: Job) => ["queued", "running"].includes(job.state)) ? 5000 : 30000;
  }, { onError: () => setError("暂时无法读取管理数据，请稍后重试") }), [revision]);
  async function api(path: string, body?: unknown) {
    const epoch = sessionEpoch.current;
    const r = await fetch(path, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (r.status === 401 || r.status === 403) {
      forgetSession(true);
      throw Error("登录已过期，请重新登录");
    }
    const next = await r.json();
    if (epoch !== sessionEpoch.current) throw Error("登录状态已变化");
    if (!r.ok) throw Error(msg[next.error] ?? "操作未完成，请重试");
    return next;
  }
  async function login() {
    setBusy(true);
    setLoginError("");
    try {
      const response = await fetch("/private/auth/google/start", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw Error();
      const r = await response.json();
      const u = new URL(r.authorizationUrl);
      if (
        u.origin !== "https://accounts.google.com" ||
        u.pathname !== "/o/oauth2/v2/auth"
      )
        throw Error();
      location.assign(u.href);
    } catch {
      setLoginError("暂时无法发起 Google 登录，请重试");
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    sessionEpoch.current++;
    try {
      const r = await fetch("/private/session", {
        method: "DELETE",
        cache: "no-store",
      });
      if (!r.ok) throw Error();
      forgetSession();
      setLoginOpen(false);
    } catch {
      message.error("退出失败，请重试");
    } finally {
      setBusy(false);
      setRevision((x) => x + 1);
    }
  }
  function navigate(value: Page) {
    if (value === page) return;
    setPage(value);
    history.pushState(
      null,
      "",
      value === "overview" ? "/" : "/?view=" + value,
    );
  }
  function openForm(row: Credential | null) {
    setEditing(row);
    form.setFieldsValue({
      label: row?.label ?? "",
      client: row?.client ?? "clash",
    });
    setFormOpen(true);
  }
  async function submit(values: { label: string; client: string }) {
    setSaving(true);
    try {
      await api("/private/credentials", {
        requestId: requestId(),
        action: editing ? "rename" : "create",
        deviceId: editing?.id,
        ...values,
        label: values.label.trim(),
      });
      setFormOpen(false);
      setRevision((x) => x + 1);
      message.success("已提交，等待节点执行");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function operation(row: Credential, action: string) {
    const details: Record<string, string> = {
      revoke:
        "订阅下载会立即停用，节点执行完成后，已导入的配置也将失效。应用变更时，其他连接可能短暂重连。",
      rotate:
        "旧订阅地址将在执行完成后失效，需要在客户端更新订阅地址。已导入的节点仍可连接。",
      publish: "为当前凭证生成客户端订阅，保留已有节点身份。",
    };
    confirmation.current = modal.confirm({
      title: actionNames[action],
      content: (
        <>
          <strong>{row.label}</strong>
          <p>{details[action]}</p>
        </>
      ),
      okText: action === "revoke" ? "确认撤销" : "确认",
      cancelText: "取消",
      okButtonProps: { danger: action === "revoke" },
      async onOk() {
        try {
          await api("/private/credentials", {
            requestId: requestId(),
            action,
            deviceId: row.id,
          });
          setRevision((x) => x + 1);
          message.success("操作已提交");
        } catch (e) {
          message.error((e as Error).message);
          throw e;
        }
      },
    });
  }
  async function showAccess(row: Credential) {
    setAccess({ row, urls: null });
    try {
      const r = await api("/private/credentials/" + row.id + "/access");
      if (alive.current)
        setAccess((current) =>
          current?.row.id === row.id ? { row, urls: r.urls } : current,
        );
    } catch (e) {
      setAccess(null);
      message.error((e as Error).message);
    }
  }
  async function copy(name: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopyKey(name);
      setTimeout(() => setCopyKey(""), 1800);
    } catch {
      message.error("复制失败，请手动选择地址");
    }
  }
  const fresh =
      !!data?.reportedAt && data.at - data.reportedAt <= 150,
    controlFresh =
      !!data?.controlSeen && data.at - data.controlSeen <= 150;
  const jobFor = (id: string) => data?.jobs.find((j) => j.device_id === id);
  const pending = (id: string) =>
    ["queued", "running"].includes(jobFor(id)?.state ?? "");
  function status(row: Credential) {
    const job = jobFor(row.id);
    if (pending(row.id))
      return (
        <Tag color="processing">
          {job?.state === "running" ? "执行中" : "待同步"}
        </Tag>
      );
    if (job?.state === "failed")
      return (
        <Tooltip title={errorNames[job.error ?? ""] ?? "操作失败"}>
          <Tag color="error">操作失败</Tag>
        </Tooltip>
      );
    if (row.revoked) return <Tag>已撤销</Tag>;
    if (row.download_revoked) return <Tag color="warning">订阅已停用</Tag>;
    return (
      <Badge
        color={fresh && row.online ? "#348267" : "#aaaaaa"}
        text={
          fresh && row.online
            ? "在线"
            : row.online === null || !fresh
              ? "待更新"
              : "离线"
        }
      />
    );
  }
  const rows = (data?.credentials ?? []).filter(
    (r) =>
      (!search || r.label.toLowerCase().includes(search.toLowerCase())) &&
      (filter === "all" ||
        (filter === "active" && !r.revoked) ||
        (filter === "revoked" && r.revoked)),
  );
  const columns = [
    {
      title: "凭证",
      key: "name",
      render: (_: unknown, r: Credential) => (
        <div className="credential-name">
          <span className="credential-icon">
            <KeyRound size={17} />
          </span>
          <div>
            <strong>{r.label}</strong>
            <small>
              {r.client === "clash" ? "Clash Verge" : "Shadowrocket"}
            </small>
          </div>
        </div>
      ),
    },
    {
      title: "状态",
      key: "status",
      width: 115,
      render: (_: unknown, r: Credential) => status(r),
    },
    {
      title: "本月用量",
      key: "usage",
      width: 160,
      render: (_: unknown, r: Credential) => (
        <Tooltip
          title={
            r.at
              ? `上行 ${bytes(r.uplink)} · 下行 ${bytes(r.downlink)}${r.gaps ? " · 重启前存在未采样区间" : ""}`
              : undefined
          }
        >
          <span className="number">
            {r.at ? bytes((r.uplink ?? 0) + (r.downlink ?? 0)) : "—"}
            {r.gaps ? " *" : ""}
          </span>
        </Tooltip>
      ),
    },
    { title: "创建时间", dataIndex: "created", width: 150, render: time },
    {
      title: "",
      key: "action",
      width: 150,
      render: (_: unknown, r: Credential) => (
        <Flex gap={4} justify="flex-end">
          <Button
            type="text"
            size="small"
            disabled={r.revoked || pending(r.id)}
            onClick={() =>
              r.has_subscription && !r.download_revoked
                ? void showAccess(r)
                : operation(r, "publish")
            }
          >
            {r.has_subscription ? "订阅地址" : "生成订阅"}
          </Button>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "rename", label: "修改名称" },
                {
                  key: "rotate",
                  label: "重置订阅地址",
                  disabled: !r.has_subscription,
                },
                { type: "divider" },
                { key: "revoke", label: "撤销凭证", danger: true },
              ],
              onClick: (x) =>
                x.key === "rename" ? openForm(r) : operation(r, x.key),
            }}
          >
            <Button
              type="text"
              size="small"
              aria-label={"管理 " + r.label}
              disabled={r.revoked || pending(r.id)}
              icon={<Ellipsis size={18} />}
            />
          </Dropdown>
        </Flex>
      ),
    },
  ];
  const isAdmin = auth === true && data?.account.role === "admin";
  const activePage = isAdmin ? page : "overview";
  return (
    <Layout className="site-layout">
      <Layout className="site-body status-page">
        <header className="site-header app-header">
          <Brand onHome={() => navigate("overview")} />
          {isAdmin && <Menu className="app-navigation" mode="horizontal" aria-label="管理导航"
            selectedKeys={[activePage === 'activity' ? 'credentials' : activePage]}
            items={[{key:'overview',label:'首页'},{key:'credentials',label:'凭证管理'}]}
            onClick={({key}) => navigate(key as Page)} />}
          {isAdmin ? <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "account", label: data?.account.email, disabled: true },
                {
                  key: "logout",
                  icon: <LogOut size={15} />,
                  label: "退出登录",
                },
              ],
              onClick: ({ key }) => { if (key === "logout") void logout(); },
            }}
          >
            <Button type="text" className="account-button" aria-label="用户菜单" loading={busy}>
              <Avatar size={28} className="account-avatar">
                <UserRound size={18} />
              </Avatar>
              <span className="account-label">管理员</span>
              <ChevronDown size={16} />
            </Button>
          </Dropdown> : <Button className="login-button" icon={<LogIn size={16} />} onClick={() => { setLoginError(""); setLoginOpen(true); }}>登录</Button>}
        </header>
        <StatusOverview initial={initial} privateNode={isAdmin ? data : null} hidden={activePage !== 'overview'} />
        {isAdmin && activePage !== 'overview' && <main className="console-main">
          <h1 className="sr-only">{titles[page]}</h1>
          {data && (error || !navigator.onLine || now - data.at > 150) && <div className="snapshot-note" role="status">上次数据 · {time(data.at)}</div>}
          {!data ? (
            <div className="console-loading">
              <Skeleton active paragraph={{ rows: 3 }} />
              <Skeleton active paragraph={{ rows: 6 }} />
            </div>
          ) : (
            <>
              {page !== "overview" && <Tabs className="credential-tabs" activeKey={page} tabBarGutter={24} onChange={key => navigate(key as Page)}
                tabBarExtraContent={page === 'credentials' ? <Button type="primary" icon={<Plus size={17} />}
                  disabled={!data.controlReady} onClick={() => openForm(null)}>创建凭证</Button> : null} items={[
                { key: "credentials", label: "全部凭证" }, { key: "activity", label: "操作记录" },
              ]} />}
              {page === "credentials" && (
                <section className="console-panel credentials-panel">
                  {!controlFresh && (
                    <Alert
                      title="节点管理任务尚未连接，提交的操作将等待执行。"
                      type="warning"
                      showIcon
                    />
                  )}
                  <div className="table-toolbar">
                    <Input
                      prefix={<Search size={16} />}
                      placeholder="搜索凭证名称"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      allowClear
                      aria-label="搜索凭证"
                    />
                    <Select
                      value={filter}
                      onChange={setFilter}
                      aria-label="筛选凭证状态"
                      options={[
                        { value: "all", label: "全部状态" },
                        { value: "active", label: "有效凭证" },
                        { value: "revoked", label: "已撤销" },
                      ]}
                    />
                    <span>{rows.length} 个凭证</span>
                  </div>
                  <Table<Credential>
                    rowKey="id"
                    columns={columns}
                    dataSource={rows}
                    scroll={{ x: 780 }}
                    pagination={{
                      pageSize: 10,
                      hideOnSinglePage: true,
                      showSizeChanger: false,
                    }}
                    locale={{
                      emptyText: (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={search ? "没有匹配的凭证" : "还没有凭证"}
                        />
                      ),
                    }}
                  />
                </section>
              )}
              {page === "activity" && (
                <section className="console-panel activity-panel">
                  <Table<Job>
                    rowKey="id"
                    dataSource={[
                      ...data.jobs,
                      ...data.events
                        .filter((e) => e.action === "access")
                        .map((e, i) => ({
                          id: "access-" + e.at + "-" + i,
                          action: e.action,
                          device_id: e.device_id,
                          state: "done",
                          created: e.at,
                          finished: e.at,
                          error: null,
                          payload: {},
                        })),
                    ].sort((a, b) => b.created - a.created)}
                    scroll={{ x: 720 }}
                    pagination={{
                      pageSize: 12,
                      hideOnSinglePage: true,
                      showSizeChanger: false,
                    }}
                    columns={[
                      {
                        title: "操作",
                        dataIndex: "action",
                        render: (v: string) => actionNames[v],
                      },
                      {
                        title: "凭证",
                        render: (_, r) =>
                          data.credentials.find((c) => c.id === r.device_id)
                            ?.label ??
                          r.payload.label ??
                          "凭证",
                      },
                      {
                        title: "状态",
                        dataIndex: "state",
                        render: (v: string) => (
                          <Tag
                            color={
                              v === "failed"
                                ? "error"
                                : v === "done"
                                  ? "success"
                                  : "processing"
                            }
                          >
                            {stateNames[v]}
                          </Tag>
                        ),
                      },
                      { title: "提交时间", dataIndex: "created", render: time },
                      {
                        title: "完成时间",
                        dataIndex: "finished",
                        render: time,
                      },
                      {
                        title: "结果",
                        render: (_, r) =>
                          r.error
                            ? (errorNames[r.error] ?? "执行失败")
                            : r.state === "done"
                              ? "已生效"
                              : "等待节点确认",
                      },
                    ]}
                    locale={{
                      emptyText: (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="暂无操作记录"
                        />
                      ),
                    }}
                  />
                </section>
              )}
            </>
          )}
        </main>}
      </Layout>
      <Modal title="登录" open={loginOpen && !isAdmin} onCancel={() => setLoginOpen(false)} footer={null}
        width={320} centered destroyOnHidden mask={{ closable: !busy }} closable={false} keyboard={!busy}
        styles={{ header: { textAlign: 'center' } }}>
        <Flex vertical align="center" gap={20} className="login-options">
          {loginError && <Alert type="warning" title={loginError} showIcon />}
          {ready === false ? <Alert type="info" title="Google 登录尚未配置" showIcon /> :
            <Button shape="circle" size="large" aria-label="使用 Google 登录"
              icon={<img src={google} width={24} height={24} alt="" />}
              loading={busy || ready === null} disabled={ready !== true} onClick={login} />}
        </Flex>
      </Modal>
      <Drawer
        title={editing ? "修改凭证名称" : "创建凭证"}
        open={isAdmin && formOpen}
        onClose={() => !saving && setFormOpen(false)}
        size={440}
        destroyOnHidden
        footer={
          <Flex justify="flex-end" gap={10}>
            <Button disabled={saving} onClick={() => setFormOpen(false)}>
              取消
            </Button>
            <Button
              type="primary"
              loading={saving}
              onClick={() => form.submit()}
            >
              {editing ? "保存" : "创建凭证"}
            </Button>
          </Flex>
        }
      >
        <p className="drawer-description">
          {editing
            ? "名称仅用于识别，不会改变节点身份。"
            : "每个凭证拥有独立的节点身份与用量统计，可供多台设备共用。"}
        </p>
        <Form form={form} layout="vertical" onFinish={submit}>
          <Form.Item
            name="label"
            label="凭证名称"
            rules={[
              { required: true, whitespace: true, message: "请输入凭证名称" },
              { max: 80, message: "最多 80 个字符" },
            ]}
          >
            <Input
              placeholder="例如：我的 Mac"
              maxLength={80}
              autoComplete="off"
            />
          </Form.Item>
          {!editing && (
            <Form.Item name="client" label="主要客户端">
              <Select
                options={[
                  { value: "clash", label: "Clash Verge" },
                  { value: "shadowrocket", label: "Shadowrocket" },
                ]}
              />
            </Form.Item>
          )}
          <Alert
            type="info"
            showIcon
            title={
              editing
                ? "提交后由节点同步名称"
                : "创建后提供两种客户端的订阅地址。节点应用配置时，现有连接可能短暂重连。"
            }
          />
        </Form>
      </Drawer>
      <Drawer
        title="订阅地址"
        open={isAdmin && !!access}
        onClose={() => setAccess(null)}
        size={520}
        destroyOnHidden
      >
        {access && (
          <>
            <div className="access-heading">
              <span className="credential-icon">
                <KeyRound size={21} />
              </span>
              <div>
                <h3>{access.row.label}</h3>
                <p>选择客户端，复制地址导入订阅。</p>
              </div>
            </div>
            {!access.urls ? (
              <Skeleton active />
            ) : (
              <div className="subscription-links">
                {[
                  ["clash.yaml", "Clash Verge", "远程配置"],
                  ["shadowrocket.txt", "Shadowrocket", "节点订阅"],
                  ["rules.conf", "Shadowrocket 分流", "配置文件"],
                ].map(([key, name, hint]) => (
                  <section key={key}>
                    <Flex justify="space-between" align="center">
                      <div>
                        <h4>{name}</h4>
                        <small>{hint}</small>
                      </div>
                      <Button
                        icon={
                          copyKey === key ? (
                            <Check size={15} />
                          ) : (
                            <Copy size={15} />
                          )
                        }
                        onClick={() => void copy(key, access.urls![key])}
                      >
                        {copyKey === key ? "已复制" : "复制"}
                      </Button>
                    </Flex>
                    <Input.TextArea
                      value={access.urls![key]}
                      readOnly
                      autoSize={{ minRows: 2, maxRows: 3 }}
                      aria-label={name + "订阅地址"}
                    />
                  </section>
                ))}
              </div>
            )}
            <Alert
              type="warning"
              showIcon
              title="持有订阅地址即可使用此凭证，请勿公开分享。"
            />
          </>
        )}
      </Drawer>
    </Layout>
  );
}
export function mount(initial: InitialData) {
  createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={theme} locale={zhCN}>
      <AntApp><RoutePilotApp initial={initial} /></AntApp>
    </ConfigProvider>,
  );
}

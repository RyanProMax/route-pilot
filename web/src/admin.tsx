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
  Progress,
  Select,
  Skeleton,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Ellipsis,
  ExternalLink,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  Plus,
  Search,
  Server,
  ShieldCheck,
} from "lucide-react";
import zhCN from "antd/locale/zh_CN";
import { theme } from "./theme";
import { HostMetrics } from "./load";
import type { HostLoad } from "./load";
import mark from "./assets/routepilot-mark.svg";
import japan from "./assets/jp.svg";
import "./status.css";
import "./admin.css";

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
function Brand() {
  return (
    <a href="/" className="console-brand" aria-label="route-pilot 状态首页">
      <img src={mark} width={34} height={34} alt="" />
      <span>route-pilot</span>
    </a>
  );
}

function Admin() {
  const { message, modal } = AntApp.useApp();
  const [data, setData] = useState<ConsoleData | null>(null),
    [auth, setAuth] = useState<boolean | null>(null),
    [ready, setReady] = useState<boolean | null>(null);
  const [page, setPage] = useState<Page>(pageFromURL),
    [menuOpen, setMenuOpen] = useState(false),
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
  const alive = useRef(true);
  const [loginError] = useState(() => {
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
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const metadata = () =>
      fetch("/private/auth", { cache: "no-store", signal: controller.signal })
        .then(async (r) => {
          if (!r.ok) throw Error();
          const d = await r.json();
          if (d.provider !== "google") throw Error();
          setReady(d.ready);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setError("暂时无法连接服务");
            timer = setTimeout(metadata, 15000);
          }
        });
    void metadata();
    if (new URLSearchParams(location.search).has("login"))
      history.replaceState(null, "", "/admin/");
    const pop = () => setPage(pageFromURL());
    addEventListener("popstate", pop);
    return () => {
      controller.abort();
      clearTimeout(timer);
      removeEventListener("popstate", pop);
    };
  }, []);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function load() {
      if (document.hidden) {
        timer = setTimeout(load, 10000);
        return;
      }
      try {
        const r = await fetch("/private/console", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (stopped) return;
        if (r.status === 401 || r.status === 403) {
          setAuth(false);
          setData(null);
          setAccess(null);
          setFormOpen(false);
          return;
        }
        if (!r.ok) throw Error();
        const next = await r.json();
        if (stopped) return;
        setData(next);
        setAuth(true);
        setError("");
        timer = setTimeout(
          load,
          next.jobs.some((j: Job) => ["queued", "running"].includes(j.state))
            ? 5000
            : 30000,
        );
      } catch {
        if (!stopped) {
          setError("暂时无法读取数据，请稍后重试");
          timer = setTimeout(load, 15000);
        }
      }
    }
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [revision]);
  async function api(path: string, body?: unknown) {
    const r = await fetch(path, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (r.status === 401 || r.status === 403) {
      setAuth(false);
      setData(null);
      setAccess(null);
      throw Error("登录已过期，请重新登录");
    }
    const next = await r.json();
    if (!r.ok) throw Error(msg[next.error] ?? "操作未完成，请重试");
    return next;
  }
  async function login() {
    setBusy(true);
    setError("");
    try {
      const r = await api("/private/auth/google/start");
      const u = new URL(r.authorizationUrl);
      if (
        u.origin !== "https://accounts.google.com" ||
        u.pathname !== "/o/oauth2/v2/auth"
      )
        throw Error();
      location.assign(u.href);
    } catch {
      setError("暂时无法发起 Google 登录");
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      const r = await fetch("/private/session", {
        method: "DELETE",
        cache: "no-store",
      });
      if (!r.ok) throw Error();
      setData(null);
      setAccess(null);
      setAuth(false);
      setRevision((x) => x + 1);
    } catch {
      message.error("退出失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  function navigate(value: Page) {
    setPage(value);
    setMenuOpen(false);
    history.pushState(
      null,
      "",
      value === "overview" ? "/admin/" : "/admin/?view=" + value,
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
    modal.confirm({
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
      !!data?.reportedAt && Date.now() / 1000 - data.reportedAt <= 150,
    controlFresh =
      !!data?.controlSeen && Date.now() / 1000 - data.controlSeen <= 150;
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
        color={fresh && row.online ? "#159b76" : "#b1bab6"}
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
  const menuItems = [
    { key: "overview", icon: <LayoutDashboard size={18} />, label: "运行概览" },
    { key: "credentials", icon: <KeyRound size={18} />, label: "凭证管理" },
    { key: "activity", icon: <Activity size={18} />, label: "操作记录" },
  ];
  const navigation = (
    <>
      <Brand />
      <div className="console-nav-label">工作空间</div>
      <Menu
        mode="inline"
        selectedKeys={[page]}
        items={menuItems}
        onClick={(x) => navigate(x.key as Page)}
      />
      <a
        className="console-public-link"
        href="/"
        target="_blank"
        rel="noreferrer"
      >
        <ExternalLink size={16} />
        公开状态页
        <ArrowUpRight size={15} />
      </a>
      <div className="console-sidebar-note">
        <span className="tiny-dot" />
        管理员工作空间
      </div>
    </>
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
  if (auth === null)
    return (
      <div className="console-boot">
        <Brand />
        {error ? (
          <Alert title={error} type="warning" showIcon />
        ) : (
          <Skeleton active paragraph={{ rows: 4 }} />
        )}
      </div>
    );
  if (auth === false)
    return (
      <div className="login-page">
        <header>
          <Brand />
          <a href="/">
            查看公开状态
            <ArrowUpRight size={16} />
          </a>
        </header>
        <main className="login-main">
          <section className="login-context">
            <span className="eyebrow">ROUTE-PILOT CONSOLE</span>
            <h1>
              节点、凭证与用量。
              <br />
              <span>在一处管理。</span>
            </h1>
            <div className="login-map" aria-hidden="true">
              <div className="map-source">
                <KeyRound size={23} />
              </div>
              <div className="map-path">
                <span />
                <span />
                <span />
              </div>
              <div className="map-node">
                <img src={mark} width={32} alt="" />
              </div>
              <div className="map-path">
                <span />
                <span />
                <span />
              </div>
              <div className="map-target">
                <Server size={23} />
              </div>
            </div>
            <div className="login-capabilities">
              <span>
                <Activity size={16} />
                运行状态
              </span>
              <span>
                <KeyRound size={16} />
                访问凭证
              </span>
              <span>
                <ArrowUpRight size={16} />
                流量用量
              </span>
            </div>
          </section>
          <section className="login-panel">
            <span className="login-symbol">
              <ShieldCheck size={24} />
            </span>
            <h2>登录控制台</h2>
            <p>使用已授权的 Google 账号继续。</p>
            {(error || loginError) && (
              <Alert type="warning" title={error || loginError} showIcon />
            )}
            {ready === false ? (
              <Alert type="info" title="Google 登录尚未配置" showIcon />
            ) : (
              <Button
                type="primary"
                block
                size="large"
                loading={busy || ready === null}
                disabled={ready !== true}
                onClick={login}
              >
                使用 Google 登录
                <ArrowUpRight size={17} />
              </Button>
            )}
            <div className="login-footnote">
              仅限管理员 · 公开状态页无需登录
            </div>
          </section>
        </main>
        <footer>
          <span>route-pilot</span>
        </footer>
      </div>
    );
  return (
    <Layout className="console-layout">
      <Layout.Sider className="console-sidebar" width={224} theme="light">
        {navigation}
      </Layout.Sider>
      <Drawer
        className="console-mobile-menu"
        placement="left"
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        width={260}
        title="工作空间"
      >
        {navigation}
      </Drawer>
      <Layout className="console-body">
        <header className="console-header">
          <Flex align="center" gap={12}>
            <Button
              className="mobile-nav-toggle"
              type="text"
              aria-label="打开导航"
              icon={<MenuIcon size={20} />}
              onClick={() => setMenuOpen(true)}
            />
            <span className="header-workspace">工作空间</span>
            <ChevronRight size={14} />
            <span>{titles[page]}</span>
          </Flex>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "logout",
                  icon: <LogOut size={15} />,
                  label: "退出登录",
                },
              ],
              onClick: () => void logout(),
            }}
          >
            <Button type="text" className="account-button" loading={busy}>
              <Avatar size={28} className="account-avatar">
                {data?.account.email.slice(0, 1).toUpperCase() ?? "A"}
              </Avatar>
              <span>{data?.account.email ?? "管理员"}</span>
            </Button>
          </Dropdown>
        </header>
        <main className="console-main">
          <div className="console-page-heading">
            <div>
              <span className="eyebrow">
                {page === "overview"
                  ? "OVERVIEW"
                  : page === "credentials"
                    ? "CREDENTIALS"
                    : "ACTIVITY"}
              </span>
              <h1>{titles[page]}</h1>
            </div>
            {page === "credentials" ? (
              <Button
                type="primary"
                icon={<Plus size={17} />}
                disabled={!data?.controlReady}
                onClick={() => openForm(null)}
              >
                创建凭证
              </Button>
            ) : (
              <span className="last-updated">
                更新于 {time(data?.reportedAt ?? null)}
              </span>
            )}
          </div>
          {error && (
            <Alert
              className="console-alert"
              title={error}
              type="warning"
              showIcon
            />
          )}
          {!data ? (
            <div className="console-loading">
              <Skeleton active paragraph={{ rows: 3 }} />
              <Skeleton active paragraph={{ rows: 6 }} />
            </div>
          ) : (
            <>
              {page === "overview" && (
                <>
                  <div className="summary-grid">
                    <article>
                      <span>
                        <Server size={17} />
                        节点状态
                      </span>
                      <strong
                        className={data.serviceHealthy ? "healthy-text" : ""}
                      >
                        {data.serviceHealthy
                          ? "健康"
                          : fresh
                            ? "异常"
                            : "待更新"}
                        <i
                          className={
                            "health-dot " +
                            (data.serviceHealthy ? "is-healthy" : "")
                          }
                        />
                      </strong>
                      <small>{data.instance.name}</small>
                    </article>
                    <article>
                      <span>
                        <KeyRound size={17} />
                        有效凭证
                      </span>
                      <strong>
                        {
                          data.credentials.filter(
                            (r) =>
                              !r.revoked &&
                              r.has_subscription &&
                              !r.download_revoked,
                          ).length
                        }
                        <em>个</em>
                      </strong>
                      <small>
                        {
                          data.credentials.filter(
                            (r) => r.online && !r.revoked && fresh,
                          ).length
                        }{" "}
                        个在线
                      </small>
                    </article>
                    <article>
                      <span>
                        <ArrowUpRight size={17} />
                        本月流量
                      </span>
                      <strong>
                        {bytes(
                          data.credentials.reduce(
                            (n, r) => n + (r.uplink ?? 0) + (r.downlink ?? 0),
                            0,
                          ),
                        )}
                      </strong>
                      <small>{data.month}</small>
                    </article>
                    <article>
                      <span>
                        <Activity size={17} />
                        当前连接
                      </span>
                      <strong>
                        {fresh ? (data.connections ?? "—") : "—"}
                        <em>条</em>
                      </strong>
                      <small>节点 TCP 连接</small>
                    </article>
                  </div>
                  <section className="console-panel node-panel">
                    <div className="panel-heading">
                      <h2>节点资源</h2>
                      <Badge
                        color={controlFresh ? "#159b76" : "#bd9425"}
                        text={controlFresh ? "管理任务在线" : "管理任务待连接"}
                      />
                    </div>
                    <div className="node-identity">
                      <span className="node-icon">
                        {data.instance.country === "JP" ? (
                          <img src={japan} width={25} alt="日本" />
                        ) : (
                          <Server size={24} />
                        )}
                      </span>
                      <div>
                        <h3>{data.instance.name}</h3>
                        <span>{data.instance.id}</span>
                      </div>
                      <Tag>固定出口</Tag>
                    </div>
                    <HostMetrics load={fresh ? data.load : null} />
                  </section>
                  <div className="overview-bottom">
                    <section className="console-panel">
                      <div className="panel-heading">
                        <h2>凭证用量</h2>
                        <Button
                          type="link"
                          onClick={() => navigate("credentials")}
                        >
                          查看全部
                          <ChevronRight size={14} />
                        </Button>
                      </div>
                      {data.credentials.length ? (
                        <div className="usage-list">
                          {[...data.credentials]
                            .sort(
                              (a, b) =>
                                (b.uplink ?? 0) +
                                (b.downlink ?? 0) -
                                (a.uplink ?? 0) -
                                (a.downlink ?? 0),
                            )
                            .slice(0, 5)
                            .map((r) => {
                              const total = data.credentials.reduce(
                                  (n, x) =>
                                    n + (x.uplink ?? 0) + (x.downlink ?? 0),
                                  0,
                                ),
                                value = (r.uplink ?? 0) + (r.downlink ?? 0);
                              return (
                                <div key={r.id}>
                                  <Flex justify="space-between">
                                    <span>{r.label}</span>
                                    <strong>{bytes(value)}</strong>
                                  </Flex>
                                  <Progress
                                    percent={total ? (value / total) * 100 : 0}
                                    showInfo={false}
                                    strokeColor="#3f7b65"
                                    size={["100%", 5]}
                                  />
                                </div>
                              );
                            })}
                        </div>
                      ) : (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="还没有凭证"
                        >
                          <Button onClick={() => navigate("credentials")}>
                            创建首个凭证
                          </Button>
                        </Empty>
                      )}
                    </section>
                    <section className="console-panel">
                      <div className="panel-heading">
                        <h2>最近操作</h2>
                        <Button
                          type="link"
                          onClick={() => navigate("activity")}
                        >
                          全部记录
                          <ChevronRight size={14} />
                        </Button>
                      </div>
                      {data.events.length ? (
                        <div className="recent-events">
                          {data.events.slice(0, 5).map((e, i) => (
                            <div key={i}>
                              <span className={"event-dot " + e.outcome} />
                              <div>
                                <strong>{actionNames[e.action]}</strong>
                                <small>
                                  {data.credentials.find(
                                    (c) => c.id === e.device_id,
                                  )?.label ?? "凭证"}
                                </small>
                              </div>
                              <time>{time(e.at)}</time>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="暂无操作记录"
                        />
                      )}
                    </section>
                  </div>
                </>
              )}
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
        </main>
        <footer className="console-footer">
          <span>route-pilot</span>
          <a href="/">
            公开状态页
            <ArrowUpRight size={13} />
          </a>
        </footer>
      </Layout>
      <Drawer
        title={editing ? "修改凭证名称" : "创建凭证"}
        open={formOpen}
        onClose={() => !saving && setFormOpen(false)}
        width={440}
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
        open={!!access}
        onClose={() => setAccess(null)}
        width={520}
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
createRoot(document.getElementById("root")!).render(
  <ConfigProvider theme={theme} locale={zhCN}>
    <AntApp>
      <Admin />
    </AntApp>
  </ConfigProvider>,
);

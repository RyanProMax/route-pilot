# Admin console

One React/TypeScript/Ant Design application serves `/` for both visitors and administrators.

- Signed out: redacted public status, with a login button in the top right.
- Signed in as an RP administrator: the same overview layout, with management menus available.
- Login methods appear in an Ant Design modal. Phase one only supports allowlisted Google administrator accounts; there is no standalone login page.
- Credential and activity views use `/?view=credentials` and `/?view=activity`. All administrator views and Google login results use the root page; there is no separate administrator route.

Accounts, role checks and sessions belong to the RP server. This release has no ordinary-user page or public registration.

## Console layout

The existing management API is scoped to one node per deployment; this visual refactor does not add cross-node administration. Resource metrics remain directly visible, and status details use tooltips rather than dialogs. Only login and consequential action confirmations use modals. The console uses a top navigation bar for overview and credential management, with the account menu on the right. Credential management has no duplicate page heading; its create button sits at the right of the tabs. Operation history remains available under the credential management tabs and at `/?view=activity`.

The overview reads all history windows from the same public status API as the home page; changing the time range does not issue another request. Status cells share the home page renderer and responsive sizing: 72 samples, 3px gaps and 26px height on desktop; 2px gaps and 24px height at widths up to 820px. Hover, keyboard focus and touch expose the sample period and result. Sample periods use API timestamps.

Connection history reports **peak bands**, not exact historical counts. Entry latency is the latest TCP connection time, not an average. CPU, memory, disk and remaining monthly traffic share one metric row, or two columns on smaller screens. The overview omits average load, the update timestamp and the extra private summary row. Hardware capacity is not available in this API. Remaining monthly traffic is the public NIC estimate, separate from per-credential payload accounting. Both public and private quota displays use remaining allowance / total allowance and a remaining-percentage bar; less than 25% is amber and less than 10% is red. Invalid or zero allowance, missing data and a mismatched UTC month remain unavailable. Missing or stale values remain unavailable.

The anonymous and administrator views share the white/ink theme and double-path mark, with the Route Pilot wordmark. The same vector generates the favicon and PWA launcher icons.

## Enable

After deploying migrations/server, configuring Google login and installing device helpers:

```sh
python3 ops/install_control.py --config /private/routepilot/deploy.json
```

The installer provisions a separate `CONTROL_SHA256` Worker secret and a root-only VPS key, then enables a 30-second oneshot timer. It imports available private client tokens without changing existing URLs. Use **生成订阅** for an older identity whose encrypted export has not been prepared for the console. The existing node UUID is preserved.

## Operations

| Action | Effect |
| --- | --- |
| Create | Independent UUID, accounting identity and private subscriptions for both clients |
| Rename | Changes the display label; preserves UUID and subscription URL |
| Generate subscription | Publishes the current identity using its existing token when available |
| Copy subscription | Explicit authenticated retrieval; no secret in list responses or browser storage |
| Reset subscription address | Replaces the download token; imported nodes remain usable |
| Revoke | Stops downloads immediately, then removes the UUID and closes its sessions on the VPS |

Creation and revocation validate/apply the Xray configuration and restart the service; other clients may briefly reconnect. Keep pending and failed states visible. A submitted job is not proof that the node has applied it. Operations are serialized, leased and retried; durable private results prevent duplicate creation/rotation. A failed operation can be retried after restoring the management task.

Clash Verge imports `clash.yaml` as a remote profile. Shadowrocket imports its node subscription and the separate routing configuration. Sharing one credential across devices shares accounting and revocation scope.

## Runtime

VPS control: every 30 seconds, one operation per run, no inbound listener or web server. The reporting timer remains every 60 seconds. The authenticated app polls management data every 30 seconds, or every 5 seconds while work is pending; hidden tabs pause polling. Public status retains its separate shared cache.

Private responses use `no-store`. D1 stores token hashes and AES-GCM envelopes, including an encrypted token for administrator retrieval; only explicit retrieval returns URLs. Control jobs and audit records contain no node secrets. Completed jobs and audit events are retained for 90 days. Traffic totals count proxy payload bytes from the first measurement, not provider billing; `*` indicates sampling gaps around restarts.

For diagnostics, inspect `systemctl status routepilot-control.timer routepilot-control.service` and the sanitized service result. Do not print root token files, job result files or subscription bodies. Stopping the timer pauses credential changes without stopping the proxy or monitoring; queued revocations still block downloads until completed. CLI publication is blocked while web management is installed to prevent stale tokens from being restored.

The shared `StatusOverview` renders public data in both session states. Private host metrics are used only for the matching managed instance. Logout and rejected sessions clear private data, forms, subscription drawers and action confirmations. Late responses from an earlier session cannot repopulate the private UI. Public status remains available when the management service is unavailable.

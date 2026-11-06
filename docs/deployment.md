# Deployment

## Quick start

Requires an authorized Ubuntu 24.04/systemd VPS, verified SSH host keys, Python 3.11+, Node.js 24+, a Cloudflare zone, Wrangler 4, and D1. Xray is installed and pinned through the deployment skill; an existing proxy service is inspected and preserved during migration.

1. Invoke [fixed-ip-vpn](../skills/fixed-ip-vpn/SKILL.md) in your agent, naming the target VPS. The skill runs the entire deployment and verification workflow; it does not guarantee an unreachable network can be made directly reachable.
2. Copy [deployment settings](../examples/deploy.example.json) to a **private directory outside the checkout**, replace its values, and set mode `600`. Create a D1 database with `wrangler d1 create routepilot-node-1`; put its ID/name in the settings file. Authenticate Wrangler for that Cloudflare account.
3. Build and publish the status services:

```sh
npm --prefix web ci --include=optional
python3 ops/publish_monitor.py --config /private/routepilot/deploy.json
python3 ops/install_reporter.py --config /private/routepilot/deploy.json \
  --ssh-host my-vps --token-file ~/.local/share/routepilot/instances/node-1/report-token
```

4. Install the administrator-only credential helpers, harden an existing static-user Xray service, and issue client profiles:

```sh
python3 ops/install_devices.py --config /private/routepilot/deploy.json
python3 ops/harden_runtime.py --config /private/routepilot/deploy.json
python3 ops/register_device.py --config /private/routepilot/deploy.json \
  --name Mac --client clash --out /private/routepilot/mac
python3 ops/register_device.py --config /private/routepilot/deploy.json \
  --name Phone --client shadowrocket --out /private/routepilot/phone
```

A credential may intentionally be shared across devices and native client formats. Publish a private HTTPS subscription with `ops/subscriptions.py publish --directory /private/routepilot/mac` and import its URL as a remote profile. The Agent updates the encrypted copy without changing its download URL or node identity; clients can refresh it. No extra hostname, VPS HTTP origin, tunnel or DNS permission is required. See [subscriptions and management](subscriptions.md).

Production identifiers are generated into temporary deployment staging directories. `cloud/wrangler.json` and `cloud/status-site.json` are reusable templates. The public instance manifest is replaced from the private deployment settings during publication.

Cloudflare runs two Workers: `routepilot-web` serves the status/admin pages and PWA assets; `routepilot-server` handles reporting, status APIs, subscriptions and Google authentication. Their names do not depend on the node location. Set `server_worker` and `web_worker` in private settings for separate installations in the same account. Renaming a live Worker must preserve its immutable Worker ID, secrets, D1 bindings, routes and schedules; do not deploy an empty replacement with a new name.

## Measurements

- **Heartbeat:** receipt of the VPS report; missing after 150 seconds is unknown.
- **Service:** Xray active and listening on the configured port.
- **Egress:** the report's source IPv4 matches the configured fixed address.
- **IPv4 / IPv6 entry:** Cloudflare can open the corresponding TCP port. This is Cloudflare's viewpoint, not proof of reachability on every home/mobile network.
- **Node connections:** online credentials and the instance-wide TCP connection count, shown in history tooltips as separate credential and connection lines; a missing historical credential count is omitted. Connection bands are `<10`, `<30`, `<50`, `<100`, `≥100`. Multiple clients using one credential count once, including legacy shared credentials. This does not measure physical devices. Per-credential online state and traffic counters remain available privately over SSH; the public page receives only aggregates.

The VPS samples every 60 seconds. The foreground page fetches all three history windows in one request and polls once a minute; switching windows reuses that response without a request or loading placeholder. Public responses are cached for 60 seconds. D1 retains 31 days and pre-aggregates 24-hour, 7-day and 30-day histories. Historical credential/connection values are window peaks, not distinct visitors across the whole period.

The public page is installable as a standalone PWA. On iPhone, open it in Safari and use Share → Add to Home Screen; supported Chromium browsers offer an install action. Offline launches show a connection fallback, and current health is hidden when the browser reports offline. The service worker does not store node measurements; see [mobile app caching](operations.md#installable-mobile-app).

Remaining traffic is the configured monthly allowance minus outbound NIC bytes, rounded to GB (10⁹ bytes). It is an estimate based on UTC calendar months; provider billing, pooled allowance and proportional quotas may differ. No billing API is implied.

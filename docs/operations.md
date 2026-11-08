# Operations

## Services and data

| Location | Contents |
| --- | --- |
| `/var/lib/routepilot/snapshot/` | Latest host snapshot, monthly NIC counter and root-only credential accounting baseline |
| `/etc/routepilot-report/` | Private reporting credential and settings |
| `/var/lib/routepilot-devices/` | Root-only device registry and client profiles |
| `/etc/routepilot-devices/` | Private node-generation settings |
| `/var/lib/routepilot/backups/` | Versioned pre-change server files |
| Private directory on the operator's machine | Deployment settings and client import files |
| D1 | Reports, samples, latest values, state events and pre-aggregated buckets |

Never copy private state into the source repository. The public UI contains no device configuration or download endpoint.

The project is named `route-pilot`. Existing `routepilot` Python imports, systemd units, Worker names and private state paths retain their identifiers so upgrades preserve credentials and history.

## Routine checks

```sh
ssh my-vps 'systemctl is-active xray fail2ban'
ssh my-vps 'systemctl list-timers routepilot-report.timer'
ssh my-vps 'sudo -n journalctl -u routepilot-report.service -n 10 --no-pager'
```

Use the actual proxy service name (`xray` or `fixed-ip-vpn`). The statistics API listens only on loopback and exposes only StatsService. Credential provisioning runs on demand through SSH, with no background daemon. `routepilot-xray-guard.service` is a oneshot firewall loader with no resident process; do not remove it while the Xray security override depends on it.

## Updates and rollback

Back up private state before upgrading. Apply D1 migrations before publishing code that reads their columns. Update files atomically, then verify service health and fixed egress. Failed Xray validation does not replace the running configuration; failed restart restores the previous file and its ownership/mode.

Stop the reporting timer to pause host reporting; Cloudflare probes remain independent. Removing a monitoring or provisioning helper must not remove Xray, SSH, fail2ban, unrelated services or firewall rules. Retain recovery backups privately.

Keep a trusted SSH recovery session during port migration. The deployment Skill requires staged dual-port operation, an independent new login, effective-config checks and timed rollback before closing the old port.

For compatibility with existing history and clients, the `devices`/`deviceHistory` status fields and `device_peak` database column now represent credential counts, not physical devices. The public UI labels them as credentials.

## Public history API

`GET /status/<instance-id>/all.json` returns `{ instanceId, windows: { "24h": ..., "7d": ..., "30d": ... } }`. Each window retains its own 72 aggregate buckets; the API reads current measurements once in a single D1 batch. It does not download raw samples or derive short windows from coarse monthly buckets.

The page fetches this bundle on instance selection, then once per minute while visible. Time-range changes only select already loaded data. Failed refreshes retain history and mark current readings unavailable. Cache lifetime remains 60 seconds; unsupported query parameters and methods cannot bypass the canonical public cache path. The older per-window endpoints remain available for existing clients. Deploy the API and its new route before the frontend.

### Browser startup and asset caching

For local development, install both `cloud` and `web` dependencies, then run `npm --prefix web run dev`. This starts the actual React source with Vite at `http://127.0.0.1:5173/` and bundles `cloud/worker.mjs` into a local workerd instance on port 8787. The script applies the repository's D1 migrations and keeps local data in the ignored `cloud/.wrangler/local-d1/` directory. Restart this command after backend changes; frontend changes use Vite hot reload.

The local Worker uses the single instance from `web/public/instances.json`. It starts without reports, administrator accounts or Google credentials, so missing measurements and unavailable login remain explicit. It does not connect to deployed D1 or live node services. Vite proxies API requests to the loopback Worker's generated HTTPS certificate; certificate verification is disabled only for that local development proxy. Production HTTPS and authentication checks are unchanged. Use `npm --prefix web run dev:web` only when managing the local Worker separately.

To display live public measurements, set `ROUTEPILOT_PUBLIC_ORIGIN=https://YOUR_STATUS_HOST` in the ignored `web/.env.local` file, then restart. Only the public instance catalog and status endpoints use this upstream, with normal TLS verification and without forwarding cookies or authorization headers. Google OAuth remains bound to its registered application origin; this public-data option does not bridge administrator sessions between localhost and the deployed site.

The static HTML includes a complete Ant Design skeleton rendered at build time and the small page stylesheet, so rendering it needs no additional CSS request. It contains no instance names, measurements or health claims. The library's extracted styles precede application CSS; preserve that order so overrides and skeleton dimensions work before and after React mounts.

HTML preloads the public instance catalog and application module. A small bootstrap fetches the first instance's bundle concurrently with the React/component-library download and passes the result into the application; mounting does not fetch it again. Both API and catalog failures have bounded 15-second requests and retry at the normal foreground interval. Background polling and range changes preserve displayed content.

Content-hashed JS, CSS, fonts and images under `/assets/` use `public, max-age=31536000, immutable`. A changed build produces new filenames. HTML continues to revalidate, and `/instances.json` caches for 60 seconds. No private credential or client profile is part of this cache. API caching saves repeated data work but cannot remove an initial HTML round trip or a first-time component download; measure cold and repeat visits separately.

### Installable mobile app

The Vite PWA plugin builds the manifest and Workbox service worker. The manifest uses a stable root ID/scope and standalone display. Apple home-screen metadata, an opaque 180px touch icon, 192/512px launcher icons, a maskable icon and safe-area insets support mobile launchers. Regenerate the icons from the project vector with `npm --prefix web run icons`.

Only the offline fallback, its script, icons and manifest enter the service worker cache. Root document navigation uses NetworkOnly with a precached offline fallback; application HTML, instance metadata and `/status/` are not precached. The existing HTTP cache remains responsible for the 60-second public status lifetime. An already-open page clears current health on the browser's offline event, retains timestamped history and resumes fetching on reconnect. An offline launch shows a connection message with retry, and returns to the live page on the browser's online event.

Keep `sw.js` and its registration script revalidated. New workers activate without an update prompt and clean outdated precaches; normal navigations fetch current HTML. No push permission, background status polling or public credentials are introduced. Browser installation checks do not replace adding the app to a real iPhone home screen.

### Partial history intervals

The rightmost history bucket is the current interval, which may not yet have a sample. VPS reports and Cloudflare entry probes arrive independently, so a current state can still be fresh while the new history bucket remains unknown. The public cache may retain that view for up to 60 seconds. Do not copy the previous bucket's healthy state into an unobserved interval. Leading unknown buckets can predate monitoring or represent missing samples; they are not failed probes.

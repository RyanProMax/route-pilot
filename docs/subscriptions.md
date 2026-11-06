# Subscriptions and private usage

VPS runs Xray, the minute reporter and an optional 30-second credential management task. Cloudflare handles subscription downloads, encrypted storage, public status and the private admin page. No VPS web server, tunnel or extra hostname is required. Proxy traffic still connects directly to the VPS.

## Publish

With web management enabled, use the [admin console](admin-console.md). CLI publication deliberately refuses to overwrite its authoritative token state. CLI node revocation remains available for recovery. The commands below apply before enabling the control task.

Run `ops/publish_monitor.py` to apply the migration and create the Worker secrets. Its private instance directory holds `subscription-key`, `provision-key` and `report-token` (mode 600). Back up these files privately.

```sh
python3 ops/subscriptions.py --config /private/routepilot/deploy.json \
  publish --directory /private/routepilot/phone
```

First export the identity with `ops/register_device.py`. Publishing refreshes that active identity over verified SSH, encrypts the files locally, and sends only the authenticated AES-256-GCM envelope to CF. A revoked identity cannot be republished from an old export. Per-identity URLs are saved to `subscription-urls.json` in the private output directory; the CLI does not print them.

- `clash.yaml`: complete native configuration, import as a remote profile.
- `shadowrocket.txt`: Base64 subscription containing native VLESS links.
- `rules.conf`: separate Shadowrocket routing configuration. Import it and select configuration routing; the node subscription alone does not install routing rules.

Downloads use independent random 256-bit bearer tokens. D1 stores token digests and authenticated ciphertext; the decryption key stays in Worker secrets. Downloads bypass caches and use no application access logs. The URL grants access to the node credential: share it only with its intended holder. Cloudflare's account administrators and the operator remain trusted parties.

## Rotate and revoke

```sh
# New download URL; the node UUID stays the same.
python3 ops/subscriptions.py publish --directory /private/routepilot/phone --rotate-token

# Revoke the URL, remove its UUID on the VPS, and close existing proxy sessions.
python3 ops/subscriptions.py revoke --id REGISTERED_ID

# Only block future downloads; imported nodes continue to work.
python3 ops/subscriptions.py revoke --id REGISTERED_ID --download-only
```

Node revocation validates and replaces the Xray configuration, then restarts Xray. Other clients briefly reconnect. Cloudflare and the VPS cannot be updated in a single transaction: the command revokes downloads first and reports any incomplete VPS step; rerun it to finish. Revoking one identity does not revoke another or a legacy shared credential. Never retire legacy credentials until all intended clients have migrated.

## Admin and accounting

Open `/admin/` on the deployed status hostname. [Google login](admin-login.md) verifies identity directly at the Worker; RP manages allowed accounts and revocable sessions in D1. No public registration or fallback key login is available. The console manages credential lifecycle through a bounded task queue; reporting, provisioning and the control task use separate credentials. Browser sessions use eight-hour Secure, HttpOnly, SameSite=Lax cookies, with only their hashes stored in D1.

The public page shows aggregate CPU usage, memory, disk and one-minute system load. Credential names and traffic are only available through the authenticated management API. Private responses are not cached by CF, the browser or the service worker. Public status keeps its 60-second cache.

The reporter persists deltas from Xray's non-resetting counters before upload. Duplicate/retried reports do not add traffic twice; a service restart preserves the accumulated totals. Accounting begins at the first baseline, without inventing earlier usage. Unobserved traffic immediately before a restart can be lost; the admin table marks sampling gaps with `*`. A single interval spanning a UTC month boundary is split proportionally. Totals are proxy payload bytes, not provider-billed NIC traffic.

Web management supports 32 active registered identities and 512 retained inventory/accounting identities per instance. Monthly usage is retained for about 13 months; monitoring history remains 31 days. Credentials are accounting identities, not physical devices. Multiple clients sharing one credential share its usage and revocation scope.

Private routes have a best-effort per-location rate limit. This reduces abuse of decryption and database calls, but requests still invoke a Worker and are not a guarantee against exhausting the free invocation allowance.

# Verification boundaries

Automated tests exercise aggregation, stale-data handling, redaction, concurrent registration, credential reuse, revocation and configuration ownership. Service transaction tests use temporary directories/mocks and do not establish that every Linux distribution has been deployed successfully.

Rendered UI checks cover desktop and narrow mobile viewports, flat radio selection, active state, flags, self-hosted typography, text cursors, outside-dismiss tooltips, time windows and overflow. A desktop touch emulation does not replace Safari on the actual phone.

Startup checks cover the complete skeleton before the application module is available, desktop/mobile geometry, one initial bundle request, request-free range switches, instance switching, and automatic recovery from catalog/API errors. Compare cold and repeat visits under the same network and CPU conditions; API cache hits alone do not establish first-paint speed. Verify long-lived cache headers only on content-hashed public assets and preserve HTML revalidation and the 60-second status cache.

PWA checks cover a parsed, installable manifest in a non-incognito browser profile, opaque launcher icons and maskable safe bounds, service worker activation/update, no status or instance records in Cache Storage, offline launch fallback, and online recovery. Verify network failure at the server/worker boundary as well as browser offline events: per-page network emulation may leave service worker requests online. Real iOS home-screen installation remains a separate device check.

Deployment acceptance must separately record:

1. Verified SSH access on the intended port; key-only/root-disabled settings; firewall and fail2ban active.
2. Proxy candidate passes the actual installed kernel's syntax check.
3. Each credential registration receives a distinct UUID; retries and cross-format exports reuse it, and multiple devices may share it. Revocation removes that credential from Xray. No private profile or registration endpoint is exposed by the status site.
4. Independent proxy requests reach two IP-echo services with the expected fixed IPv4.
5. Domestic media/services remain direct and use appropriate DNS.
6. Credential statistics reflect authenticated identities; zero and unavailable are distinguished.
7. Reporter, D1, cached status API and static UI remain available without the operator's Mac.

Record actual machine-specific evidence outside the public repository. Do not replace current acceptance with historical claims, and do not treat Cloudflare TCP success as proof of mobile-network reachability.

Admin acceptance includes desktop/mobile login, overview, navigation, search/filter, create/rename drawers, private subscription retrieval, pending/failed jobs and confirmation dialogs. Unit tests and workerd/D1 tests verify same-origin writes, per-request role checks, lease expiry, replay, encrypted storage and subscription rotation/revocation. A disposable production identity should complete creation, rename, rotation and revocation without changing existing identities. Record this separately from real Google login and device connectivity.

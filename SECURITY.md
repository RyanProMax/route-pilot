# Security

Report vulnerabilities privately to the repository maintainers using the hosting platform's security-reporting channel. Do not attach node configurations, private keys or production logs to public issues. If no private reporting channel is enabled, ask the maintainer for one without disclosing credentials.

## Trust boundaries

- Public WebUI: read-only aggregate fields. It cannot access device profiles or the registry.
- Reporting: a separate high-entropy bearer token authenticates ingestion. Its digest is a Worker secret; the VPS sender loads the credential through systemd.
- Device administration: verified key-only SSH and root-only local helpers. There is no public registration or persistent VPS provisioning daemon. CF subscription downloads require random bearer tokens; encrypted uploads require a separate provisioning key.
- Client profiles: each credential registration has an independent VLESS UUID and may be shared across devices. The private SQLite registry and generated files remain on the VPS and the authorized operator's machine; only authenticated encrypted profile copies enter CF subscription storage; neither plaintext profiles nor secrets enter the source repository.
- Sharing is an operator choice. Multiple clients using the same credential have the same accounting and revocation identity; there is no physical-device restriction or claim to distinguish authorized sharing from copying.
- Statistics count authenticated online credentials, including a legacy shared identity once. The node-wide TCP count remains separate. Credential labels and per-credential traffic counters are available over SSH and the authenticated admin API; no UUIDs, source IPs or per-credential records enter public summaries.
- Full revocation disables the CF download and removes the corresponding Xray credential with a validated restart that closes sessions. Token-only revocation cannot disable previously imported configurations. Partial cross-system failures are reported for retry.
- CF stores per-identity AES-256-GCM envelopes with identity/token-bound additional authenticated data. Encryption, provisioning, reporting and admin secrets are separated; the database contains token hashes, not bearer URLs. Private responses and admin data are never cached. Worker application logs are disabled; restrict Cloudflare account access and never enable request URL logging for private subscription paths.
- Google admin login uses CF Access with one explicit Google IdP and an exact email allowlist. The Worker also verifies RS256 JWT signatures, issuer, audience, expiry and allowed email hashes. Access mode rejects old keys and local session cookies; incomplete configuration fails closed. Never accept an email header alone. See [setup and revocation](docs/admin-login.md).
- Optional key-mode sessions are eight-hour Secure/HttpOnly/SameSite=Strict cookies backed by hashed records. Login/logout require same origin. Key mode is a separate deployment choice, never an Access failure fallback. The admin UI has no node mutation endpoint; authenticated provisioning remains an operator CLI action.

## Operations

Keep production deployment settings outside this checkout. State directories use mode 700 and credential/profile files mode 600. Do not use third-party conversion or QR services for private profiles. Keep TLS and SSH host-key validation enabled. Validate candidates, preserve file ownership and a recovery session, and retain legacy credentials until replacement clients have been tested.

Credential updates are serialized across concurrent Agent invocations. Reissuing the same active credential name preserves its credential; rotation requires explicit revocation/replacement. Root access to the VPS can read all node credentials and is part of the administrative trust boundary.

Xray version pinning, SSH port migration, fail2ban and removing unused services belong to the deployment Skill. Real-device acceptance is separate from simulated tests and Cloudflare TCP reachability.

## Runtime baseline

For an existing static non-root Xray account, `ops/harden_runtime.py` installs a reversible systemd override and a dedicated nftables table. It does not flush other firewall rules or change the SSH listener.

- Xray receives its root-only configuration through systemd `LoadCredential`; persistent configuration is root:root 600.
- The runtime retains only `CAP_NET_BIND_SERVICE`, uses a read-only filesystem, private temporary/device namespaces and protected home/kernel/control-group paths.
- `LimitCORE=0` and an empty `CoredumpFilter` limit crash-memory exposure. Logs use warning level with access logging disabled.
- Proxy routes reject private, loopback, link-local/metadata and IPv6 destinations under the fixed-IPv4 policy. DNS-aware routing checks domain targets as well.
- Host egress filtering separately blocks private/link-local connections by the Xray UID, preserving replies and local resolver queries. The statistics listener accepts local root clients only, and exposes StatsService without administrative mutation APIs.
- Private inventory paths reject symlinks, hardlinks and foreign ownership. Credential files use atomic mode-600 writes.

The updater refuses DynamicUser layouts for this UID-based firewall design; inspect those layouts and select a stable firewall identity explicitly. Do not apply a guessed UID.

No configuration can promise confidentiality after the process holding active credentials or a privileged administrator is compromised. This baseline reduces exposure and the impact of a compromise; it is not a claim of immunity to undiscovered vulnerabilities. Review deployed versions and recovery backups during upgrades.

References: [systemd execution and credentials](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html), [Xray routing](https://xtls.github.io/config/routing.html), [Xray statistics API](https://xtls.github.io/config/api.html).

## Build dependencies

Workbox's build-time `glob` dependency is pinned to 14.0.3 to address its traversal and transitive pattern-matching advisories. Verify the generated service worker when changing this override.

The build-only Rollup resolver still depends on `deepmerge` 4.3.1, whose [prototype-poisoning advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) has no patched upstream release as of 2026-11-05. It processes repository-controlled build options, not public API input, and is not shipped as a runtime dependency. Do not build untrusted configurations. Track an upstream fix; do not force-downgrade the PWA plugin merely to suppress the audit report.

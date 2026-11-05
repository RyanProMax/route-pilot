# Agent-issued credentials and client configurations

The deployment Skill directs the Agent to issue native profiles over verified SSH. CF can distribute encrypted copies through private HTTPS subscriptions; there is no VPS HTTP service, registration website or cloud tunnel. See [subscriptions](subscriptions.md) for remote refresh and revocation. The VPS keeps a private credential registry; the public status page receives aggregate counts only.

## Issue and update

```sh
python3 ops/install_devices.py --config /private/routepilot/deploy.json
python3 ops/register_device.py --config /private/routepilot/deploy.json \
  --name Mac --client clash --out /private/routepilot/mac
python3 ops/register_device.py --config /private/routepilot/deploy.json \
  --name Phone --client shadowrocket --out /private/routepilot/phone
```

Use a mode-700 output directory. The returned files use mode 600:

- Clash Verge: import `clash.yaml` as a standalone local profile.
- Shadowrocket: import the reachable node from `shadowrocket.txt` using a private file or a locally generated QR code. Import `rules.conf` if the app needs the corresponding routing configuration.
- `device.json` identifies the registration for subsequent administration. It contains no node credential.

The same active credential name reuses its UUID and registry ID, including when exporting another client format. Repeating a failed transfer is safe: the server reissues the same device's files. Use separate names when independent accounting or revocation is wanted; sharing one credential across several devices is supported. For local exports, updates require reimporting the files. For HTTPS subscriptions, publish the refreshed encrypted copy and let the client refresh its existing URL.

Do not put node credentials into chat, public issues, online QR generators or third-party converters. The Agent should complete the import where it can operate the client; phone acceptance remains pending until tested on that phone.

## Revocation and replacement

List device metadata over administrative SSH:

```sh
ssh my-vps 'cd /opt/routepilot && sudo -n python3 -m devices.provision \
  --settings /etc/routepilot-devices/settings.json list'
```

Revoke a specific registry ID:

```sh
ssh my-vps 'cd /opt/routepilot && sudo -n python3 -m devices.provision \
  --settings /etc/routepilot-devices/settings.json revoke --device DEVICE_ID'
```

Revocation removes the credential from Xray using a validated configuration with rollback. Issuing the same name after revocation creates a new credential. Configurations are never rotated implicitly during ordinary updates.

Keep shared legacy credentials until every affected client has migrated and passed fixed-egress and domestic-routing checks. Online credentials are deduplicated by authentication identity. Several clients sharing a credential count once; a legacy shared credential also counts once. The public connection band is the entire node’s TCP count, including unauthenticated handshakes, and is not a per-credential session count.

## Private credential usage

```sh
ssh my-vps 'cd /opt/routepilot && sudo -n python3 -m devices.usage'
```

This returns each credential label, online state and uplink/downlink bytes for the **current Xray process lifetime**. These byte counters reset on restart; they are not monthly billing counters. UUIDs and source IPs are omitted. The private SSH view remains process-scoped. The minute reporter separately persists deltas and sends monthly totals to the authenticated CF admin API; see [accounting limits](subscriptions.md#admin-and-accounting).

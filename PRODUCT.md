# route-pilot

<!-- impeccable:product-schema 1 -->

## Platform
web

## Users
People operating their own VPS and personal proxy clients, who need stable IPv4 egress and a clear service status page.

## Purpose
A reusable deployment skill, lightweight VPS reporting and per-device configuration delivery, Cloudflare Workers/D1 monitoring, and a public status WebUI.

## Capabilities and Constraints
- Deploy VLESS/REALITY, verify direct IPv4/IPv6 ingress and fixed IPv4 egress.
- Apply key-only SSH, staged management-port migration, fail2ban, and minimal exposed services with rollback.
- Keep client profiles separate from unrelated subscriptions; domestic services use direct routing.
- Monitor VPS health independently of the user's Mac. Cloudflare observes TCP entry reachability; the host reports aggregate health.
- Let the deployment Agent issue independently managed client credentials (sharing across devices is supported) over verified SSH and deliver native profiles privately; no subscription web service is required.
- Client-reported identity is not cryptographic hardware attestation. Never claim copied VLESS credentials cannot be reused.
- Current public surface is a minimal light single page built with React, TypeScript and Ant Design, with flat country-labelled instance choices.
- Do not invent observations, devices or uptime. Stale and missing samples stay unknown.
- Production host/account identifiers, hardware identifiers, credentials and runtime databases stay outside the repository.

## Stack
Python standard library and systemd on Linux; Cloudflare Workers/D1 and static assets; React/TypeScript/Vite/Ant Design.

## Operating Context
One deployment settings file identifies a VPS, database, hostnames and private state directory. The skill orchestrates deployment on an explicitly authorized host; importing this repository is not standing authorization to change unrelated systems.

## Evidence
Source tests cover status projection, sample aggregation, device provisioning, and configuration safeguards. A successful TCP probe does not prove reachability from every ISP or a completed proxy handshake. Client verification and platform-specific limitations are documented separately.

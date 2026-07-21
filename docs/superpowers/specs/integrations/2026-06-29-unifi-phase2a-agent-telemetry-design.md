# UniFi Network Integration — Phase 2a (Agent-Side Deep Telemetry, Read-Only)

**Date:** 2026-06-29
**Status:** Design — awaiting spec review
**Branch:** `feat/unifi-network-integration` (continues the Phase 1 work)
**Builds on:** `docs/superpowers/specs/integrations/2026-06-28-unifi-network-integration-design.md` (Phase 1, shipped)
**Scope:** Phase 2a only — **read-only** deep telemetry collected by the Breeze agent from the on-site UniFi controller. Control/write actions (restart, PoE power-cycle, block client, firmware upgrade) are **Phase 2b** and out of scope here. Event push (Alarm Manager webhooks) remains **Phase 3**.

## Problem

Phase 1 wired Ubiquiti's **cloud** Site Manager API (`api.ui.com`) into Breeze: a partner pastes one API key, maps UniFi hosts/sites to Breeze sites, and Breeze syncs fleet **inventory** (model, MAC, firmware, uptime, adoption) plus latest WAN/ISP metrics. That cloud key is read-only and deliberately shallow — it cannot see per-port PoE state, throughput, or the **clients** (stations) attached to each device. Those live only on the on-site controller's local API.

The competitive opening for Breeze is that it **already deploys an agent** at most of these sites. That agent can reach the local UniFi controller behind customer NAT and pull the deep, per-port, per-client telemetry the cloud key can't — without standing up a separate collector or asking the customer to expose anything. Phase 2a does exactly that, read-only: a designated agent polls the controller's official **Network Integration API** and pushes device + client telemetry into Breeze, linked to the network model Phase 1 already populates.

### Why agent-side + official Network Integration API

A 2026-06-27 research pass found four UniFi surfaces. The **cloud Site Manager API** (Phase 1) needs no on-site path but is read-only and shallow. The **Connector Proxy** is cloud→local at ~800ms and abandons the agent thesis. The **legacy cookie API** is the most complete but undocumented, version-fragile, and broken by mandatory MFA. The **local Network Integration API** (`/proxy/network/integration/v1`, controller firmware ≥ 9.3, per-controller local API key) is official, documented, stable, and — reached from the on-site agent — gives the per-port/per-client depth Phase 1 lacks. Phase 2a uses the agent + Network Integration API. The legacy cookie API is explicitly rejected (maintenance risk); the Connector Proxy is reserved for a future "no-agent" fallback.

## Goals / Non-goals

**Goals**
- **One collector per UniFi console/host.** A console runs a single local controller serving all its sites, so deep telemetry is configured **once per console**, attached to the Phase 1 `unifi_site_mappings` for that host.
- **Designate a collector agent** (an online `devices` row at that site) to do the polling, chosen via the network-proxy "bridge-agent picker" UX.
- **Read-only poll** of the local Network Integration API for: per-device port/PoE detail, device health (uptime, cpu/mem, tx/rx counters, client count), and currently-associated clients.
- **Push batched telemetry** up to Breeze, reconcile into **current-state** tables (snapshot semantics: upsert seen, mark disappeared stale — identical to Phase 1's device handling).
- **Link** clients to the existing `discovered_assets` network model by `(org_id, mac)` **only when a row already exists** (enrich, never create), so the unified view and AI tools see them without flooding `discovered_assets` with phones/IoT.
- Strict tenant isolation: org-axis RLS on all three new tables, enforced at the DB layer per the RLS contract; the local API key encrypted at rest.

**Non-goals (YAGNI for Phase 2a)**
- **No write/control actions** — restart, PoE power-cycle, block client, firmware upgrade are Phase 2b.
- **No time-series.** Store only the latest snapshot per device/client. Trend charts / Timescale are a later phase. (Matches the Phase 1 "latest snapshot only" decision.)
- **No per-poll ledger.** Polls are frequent (default 60s); freshness and errors live on the `unifi_collectors` row, not an append-only run table.
- **No legacy cookie API and no Connector Proxy path** in this phase.
- **No new identity/transport.** Reuse the existing agent config-delivery channel, agent-role auth, BullMQ, and secretCrypto — do not invent parallel systems.
- **No standalone (cloud-less) onboarding.** Phase 2a extends an existing Phase 1 cloud mapping; controllers with no Phase 1 mapping are not configurable here (revisit if demand appears).

## Architecture

Three new tables, one new agent Go package, one agent ingest route + BullMQ worker, and additive UI on the existing integration panel. Reuses the Phase 1 `unifi_integrations` / `unifi_site_mappings` for partner connection + site/org resolution.

```
UniFi console (firmware ≥9.3, local API key)
      ▲  read-only GETs (/proxy/network/integration/v1/...)
      │
[ Breeze agent: agent/internal/unifi ]  ── collector_device_id chosen per console
      │  POST /agent/unifi-telemetry  (agent-role auth, batched payload)
      ▼
[ API route ] → enqueue (runOutsideDbContext) → BullMQ `unifi-telemetry`
      ▼
[ unifiTelemetryWorker ] (withSystemDbAccessContext)
      ├─ resolve collector → integration/org/site via unifi_site_mappings
      ├─ upsert unifi_device_telemetry  (per-port PoE + health, mark stale)
      ├─ upsert unifi_clients           (current associations, mark stale)
      └─ enrich discovered_assets by (org_id, mac) when a row exists
```

### Onboarding & config model

`unifi_collectors` is the new config row, **one per `(integration_id, unifi_host_id)`**. The local controller is identified by the Phase 1 `unifi_host_id` (console id); the Breeze org/site for any polled device or client is resolved through the existing `unifi_site_mappings` (`unifi_host_id` + `unifi_site_id`). The operator enables deep telemetry for a console from the Phase 1 mapping panel: pick a collector agent (online `devices` row at that site), enter the controller URL + local API key, save.

The server pushes the collector config (controller URL, **decrypted** local key, poll interval) to the chosen agent over the existing agent config channel — the local key into `secrets.yaml` (locked perms), the URL + schedule into `agent.yaml`. The key crossing to a trusted agent matches how existing backup S3 / SNMP secrets are delivered.

### Data model

All migrations idempotent (`IF NOT EXISTS`, `DO $$` guards, `pg_policies` existence checks) with RLS added in the **same** migration that creates each table. Drizzle schema extends `apps/api/src/db/schema/unifi.ts`.

#### `unifi_collectors` — per-console collector config (RLS shape 1, org-axis)

```
id                    uuid PK default gen_random_uuid()
integration_id        uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE
org_id                uuid NOT NULL REFERENCES organizations(id)        -- denormalized for RLS
site_id               uuid NOT NULL REFERENCES sites(id)                -- the Breeze site this console serves
unifi_host_id         text NOT NULL                                     -- Phase 1 console id
collector_device_id   uuid NOT NULL REFERENCES devices(id)             -- the agent that polls
controller_url        text NOT NULL                                     -- e.g. https://192.168.1.1
local_api_key_encrypted text NOT NULL                                   -- secretCrypto, AAD unifi_collectors.local_api_key_encrypted
is_enabled            boolean NOT NULL DEFAULT true
poll_interval_seconds integer NOT NULL DEFAULT 60
status                varchar(20) NOT NULL DEFAULT 'pending'            -- pending | connected | unreachable | error | firmware_too_old
firmware_ok           boolean
last_poll_at          timestamptz
last_poll_status      varchar(16)                                       -- success | partial | failed
last_poll_error       text
created_by            uuid REFERENCES users(id)
created_at            timestamptz NOT NULL DEFAULT now()
updated_at            timestamptz NOT NULL DEFAULT now()
UNIQUE (integration_id, unifi_host_id)
```

> `org_id`/`site_id` are denormalized onto the collector for org-axis RLS and routing. They are the **collector agent's** org/site — the agent (`collector_device_id`) physically lives at one site, so the config row is scoped to that org. Individual devices/clients resolve their **own** site/org per row via `unifi_site_mappings` (so a console whose UniFi sites map to several Breeze sites — even several orgs — still routes each telemetry row correctly; only the config row is anchored to the collector agent's org).

#### `unifi_device_telemetry` — latest per-device telemetry (RLS shape 1, org-axis)

```
id                  uuid PK default gen_random_uuid()
collector_id        uuid NOT NULL REFERENCES unifi_collectors(id) ON DELETE CASCADE
org_id              uuid NOT NULL REFERENCES organizations(id)
site_id             uuid NOT NULL REFERENCES sites(id)
unifi_device_id     text NOT NULL                                       -- matches Phase 1 unifi_devices.unifi_device_id
mac                 text
name                text
uptime_seconds      bigint
cpu_pct             real
mem_pct             real
tx_bytes            bigint
rx_bytes            bigint
num_clients         integer
poe_ports           jsonb                                              -- [{port_idx,name,poe_mode,poe_power_w,link_speed_mbps,up}]
raw                 jsonb NOT NULL
is_stale            boolean NOT NULL DEFAULT false
last_seen_at        timestamptz
first_synced_at     timestamptz NOT NULL DEFAULT now()
last_synced_at      timestamptz NOT NULL DEFAULT now()
created_at          timestamptz NOT NULL DEFAULT now()
updated_at          timestamptz NOT NULL DEFAULT now()
UNIQUE (collector_id, unifi_device_id)
```

> Kept separate from Phase 1 `unifi_devices` (cloud inventory) so local telemetry never clobbers the cloud-sourced rows; the web view joins the two by `unifi_device_id`.

#### `unifi_clients` — current client associations (RLS shape 1, org-axis)

```
id                  uuid PK default gen_random_uuid()
collector_id        uuid NOT NULL REFERENCES unifi_collectors(id) ON DELETE CASCADE
org_id              uuid NOT NULL REFERENCES organizations(id)
site_id             uuid NOT NULL REFERENCES sites(id)
mac                 text NOT NULL
hostname            text
ip_address          inet
connected_device_id text                                               -- unifi_device_id of the AP/switch it is on
uplink_port_idx     integer
is_wired            boolean
ssid                text
vlan                integer
signal_dbm          integer
tx_bytes            bigint
rx_bytes            bigint
uptime_seconds      bigint
discovered_asset_id uuid REFERENCES discovered_assets(id)              -- enrich-only link by (org_id, mac)
raw                 jsonb NOT NULL
is_stale            boolean NOT NULL DEFAULT false
first_seen_at       timestamptz NOT NULL DEFAULT now()
last_seen_at        timestamptz NOT NULL DEFAULT now()
created_at          timestamptz NOT NULL DEFAULT now()
updated_at          timestamptz NOT NULL DEFAULT now()
UNIQUE (collector_id, mac)
```

### RLS

All three tables are **shape 1 (direct `org_id`)**: `ENABLE` + `FORCE ROW LEVEL SECURITY` and SELECT/INSERT/UPDATE/DELETE policies on `public.breeze_has_org_access(org_id)`, added in the creating migration. Shape-1 tables are auto-discovered by `rls-coverage.integration.test.ts` (no allowlist entry), but the PR adds cross-org **forge tests** (a partner/org-B insert forging org-A `org_id` must throw `row-level security`). The local API key is an org-scoped secret. Telemetry ingest runs system-scoped via `withSystemDbAccessContext` (agent path), consistent with the existing agent-result handlers.

### Agent collector — `agent/internal/unifi/`

- `client.go` — Network Integration API HTTP client. Self-signed-TLS tolerant (local controllers ship self-signed certs; reuse the `httpfetch.go` pattern). Sets the local API key header. Read-only GETs only: list devices, per-device port/PoE detail, list clients. A firmware/capability probe records `firmware_ok` (controller below 9.3 or integration disabled → reported up, no poll).
- `collector.go` — scheduler. For each enabled collector config, on `poll_interval_seconds`, fetch devices + clients, assemble a batched payload, POST to the ingest endpoint. Per-console failures are isolated and reported as `partial`/`failed` without crashing the agent loop.
- Config is read from `agent.yaml` (URL, interval) + `secrets.yaml` (key), delivered by the server via the existing config channel.

### Server ingest + worker

- `POST /agent/unifi-telemetry` — **agent-role auth** (must NOT be guarded by partner/org middleware; mirrors the agent result/log endpoints). Body (Zod-validated): `{ collectorId, polledAt, firmwareOk, devices: [...], clients: [...], error? }`. The route enqueues the raw payload to a BullMQ `unifi-telemetry` queue via `runOutsideDbContext` and returns `202`. It does **not** write telemetry inline.
- `unifiTelemetryWorker` — processes under `withSystemDbAccessContext`: resolves `collectorId` → integration/org/site, resolves each device/client's site via `unifi_site_mappings` when needed, upserts `unifi_device_telemetry` and `unifi_clients` (snapshot: upsert seen, mark disappeared rows `is_stale`), enriches `discovered_assets` by `(org_id, mac)` when a row exists, and updates the collector's `status` / `last_poll_*` / `firmware_ok`.

### Collector-config CRUD route

Partner-scoped routes (extend `apps/api/src/routes/unifi/`), each `requireMfa` + `requirePermission` + audited, with the Phase 1 cross-org `canAccessOrg` guard:
- `GET /unifi/collectors` — list configured collectors (+status) for the partner.
- `PUT /unifi/collectors` — upsert a console's collector (validates the chosen `collector_device_id` belongs to the resolved site's org; encrypts the key).
- `DELETE /unifi/collectors/:hostId` — remove a collector (cascades telemetry; revokes the pushed config).
- A read endpoint for the telemetry view: `GET /unifi/telemetry?siteId=...` returning devices (with `poe_ports`) + clients for a mapped site.

### Web UI

Additive to `apps/web/src/components/integrations/UnifiIntegration.tsx`:
- In the existing mapping panel, per console: a "Deep telemetry" control — collector-agent picker (online agents at the site), controller URL, local API key (password field), enable toggle — saved via `runAction`. Shows collector `status` including `unreachable` / `firmware_too_old`.
- A read-only telemetry panel per site: devices with per-port PoE (power, link, mode) and client counts, plus a clients table (hostname, IP, AP, signal, wired/wifi). Clients/devices also surface in the existing network/`discovered_assets` views via the MAC link.

### Governance & security

- **Read-only:** the agent issues only GETs to the controller; no write endpoints are called this phase.
- **Secret handling:** local API key encrypted at rest (`secretCrypto`), pushed once to the trusted collector agent over the authenticated config channel, stored in `secrets.yaml` (locked perms). Never logged or returned decrypted.
- **Config mutations** are partner-scoped, `requireMfa` + `requirePermission`, audited via `writeRouteAudit`; the cross-org `canAccessOrg` guard prevents assigning a collector for another org's site.
- **SSRF posture:** `controller_url` is operator-configured and fixed on the collector row, not attacker-supplied per poll; the agent targets exactly the configured URL.
- **Agent release:** the new capability requires an agent build + promote per repo convention (bare semver; `AGENT_AUTO_PROMOTE=false`).

### Testing

- **Go:** `client.go` against `httptest` (HTTP + self-signed TLS) incl. firmware-too-old probe; `collector.go` scheduling + payload assembly; per-console failure isolation.
- **API:** ingest route (agent-role, validation, enqueue-not-inline); worker reconciliation (create/update/unchanged, stale-on-disappearance, link-by-MAC enrich-only, no-create); collector CRUD (MFA, cross-org guard, key encryption); RLS cross-org forge tests for all three tables; `rls-coverage` stays green.
- **Web:** collector config render + `runAction` mutation feedback; telemetry panel render; partner-only gating.

## Rollback / risk

- **Additive.** New tables, new agent package, new ingest route + worker, additive UI. No change to Phase 1 cloud sync or existing agent/device paths beyond an enrich-only nullable link into `discovered_assets`.
- **Opt-in per console.** Disabling/deleting a collector cascades its telemetry and revokes the pushed agent config; agent-discovered assets and Phase 1 cloud inventory remain intact.
- **API immaturity contained** by the `raw` jsonb columns (schema drift survives) and `partial` poll status (per-console failures don't cascade).
- **Cardinality bounded** by current-state-only storage (no time-series, no per-poll ledger) and by linking — not copying — clients into `discovered_assets`.
- **Reverting** is a migration-down of three isolated tables, removing the agent package + ingest route, and an agent release; nothing outside these tables depends on them.

## Future Phases (recorded for continuity)

- **Phase 2b — control actions.** restart device, PoE port power-cycle, block/unblock client, firmware upgrade — issued through the agent to the same local API, governed by `requireMfa` + `requirePermission(DEVICES_EXECUTE)` + audit (and, when wired, Breeze Authenticator step-up), using the synchronous `http_request`/`agentCommandAwait` request-response path. This is the write counterpart to 2a's reads.
- **Phase 3 — event push.** UniFi Alarm Manager webhooks (client connect/disconnect, WAN down, PoE loss, threats) into Breeze alerting; optional CEF syslog into the log pipeline. Replaces poll-only freshness with real-time events.
- **Cloud write / no-agent fallback.** When Ubiquiti enables write on Site Manager keys, or via the Connector Proxy, control + telemetry can reach sites with no agent.

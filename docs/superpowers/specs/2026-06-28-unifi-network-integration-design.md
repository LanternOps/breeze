# UniFi Network Integration — Phase 1 (Cloud Read-Only Inventory)

**Date:** 2026-06-28
**Status:** Design — awaiting spec review
**Branch:** `feat/unifi-network-integration`
**Scope:** Phase 1 only. Phases 2 (agent-side deep telemetry + control actions) and 3 (Alarm Manager webhook push) are described under [Future Phases](#future-phases) but are explicitly out of scope for this spec.

## Problem

Breeze is an RMM, and a large share of the MSP install base runs Ubiquiti UniFi for networking (APs, switches, gateways). Today Breeze has no visibility into that gear except whatever its own LAN discovery (`discovered_assets`) infers from ARP/SNMP scans — model, firmware, PoE state, WAN health, and adoption status are all invisible. MSPs want to see their whole UniFi fleet — every customer's consoles, devices, firmware levels, and WAN health — inside Breeze without standing up a separate UniFi dashboard or touching each site.

Ubiquiti now exposes a **cloud Site Manager API** (`api.ui.com`) that returns the entire fleet of consoles, sites, and devices under one Ubiquiti account via a single `X-API-KEY`, with no on-site footprint and nothing to reach behind customer NAT. It is **read-only today** (Ubiquiti has stated write endpoints are "coming"), which is a perfect fit for an inventory-and-monitoring first cut. This spec covers wiring that cloud API into Breeze: one connection per partner, mapping UniFi sites to Breeze organizations, syncing device inventory + WAN metrics into the existing network model, and recording each sync run.

### Why cloud-first (vs. agent or legacy API)

A 2026-06-27 research pass into the UniFi API surface found three other surfaces — the on-LAN Network Integration API (write-capable but needs an on-site collector + firmware ≥9.3), the Connector Proxy (cloud→local control with ~800ms latency), and the legacy cookie API (most complete but undocumented and now broken by mandatory MFA). All require either an on-site path or per-site credentials. The Site Manager cloud key needs neither and ships fleet inventory fastest. Deep telemetry and control belong in Phase 2 over the existing Breeze agent.

## Goals / Non-goals

**Goals**
- One **partner-level** UniFi cloud connection: paste a Site Manager API key, validate it, store it encrypted.
- **Map** UniFi hosts/sites to Breeze **sites** (org derived from the site) so each console's devices route to the right customer location — and so synced devices have the `site_id` that `discovered_assets` requires.
- **Sync** device inventory (model, MAC, type, firmware + upgrade-available, uptime, adoption state) and latest WAN/ISP metrics into dedicated UniFi tables at full fidelity.
- **Link** synced UniFi devices into the existing `discovered_assets` network model (by org + MAC) so the unified network view and existing AI tools see them, without duplicating or clobbering agent-discovered rows.
- **Record** every sync run in a ledger (`unifi_sync_runs`) — counts of created/updated/unchanged/removed per run — for an audit trail and a "what did the last sync change" view.
- Strict tenant isolation: partner-axis RLS on the connection, org-axis RLS on synced data, all enforced at the DB layer per the RLS contract.

**Non-goals (YAGNI for Phase 1)**
- No write/control actions (restart, PoE cycle, block client) — that needs the local API or Connector Proxy (Phase 2).
- No Go-agent changes and no on-LAN polling — Phase 2.
- No webhook/event push (Alarm Manager) — Phase 3.
- No full reversible undo with before/after row snapshots — the ledger records what changed; it does not roll back. (Decided: a read-only import doesn't justify versioned-snapshot rollback machinery.)
- No client/station inventory or per-client telemetry — devices + WAN health only this phase. (Client lists are high-cardinality and better collected on-LAN in Phase 2.)
- No historical time-series of WAN metrics — store only the latest snapshot per site. Time-series (Timescale) is a later phase.
- Self-hosted (non-UniFi-OS) Network Applications are **not reachable** via Site Manager; they are out of scope and surfaced as such in the UI.

## Architecture

Four new tables, one service module, one route file, one BullMQ worker, one web component. Mirrors the **SentinelOne** integration shape (partner-level connector + org-scoped synced child data + encrypted credential) and the **accounting** connect/settings UI flow.

### Data model

All migrations are idempotent (`IF NOT EXISTS`, `DO $$` guards, `pg_policies` existence checks) and add RLS in the **same** migration that creates each table, per CLAUDE.md. Drizzle schema lives in a new `apps/api/src/db/schema/unifi.ts`.

#### `unifi_integrations` — partner-scoped connector (RLS shape 3, partner-axis)

```
id                uuid PK default gen_random_uuid()
partner_id        uuid NOT NULL REFERENCES partners(id)
base_url          text NOT NULL DEFAULT 'https://api.ui.com'   -- override for testing
api_key_encrypted text NOT NULL                                -- via secretCrypto.encryptSecret
account_label     text                                         -- human label for the Ubiquiti account
is_active         boolean NOT NULL DEFAULT true
status            varchar(20) NOT NULL DEFAULT 'connected'     -- connected | error | reauth_required
last_sync_at      timestamptz
last_sync_status  varchar(20)                                  -- success | partial | failed
last_sync_error   text
created_by        uuid REFERENCES users(id)
created_at        timestamptz NOT NULL DEFAULT now()
updated_at        timestamptz NOT NULL DEFAULT now()
```

- Unique partial index: `(partner_id) WHERE is_active` — at most one active cloud connection per partner (Site Manager keys are account-wide; one per MSP is the model).
- Policies: `breeze_has_partner_access(partner_id)` for SELECT/INSERT/UPDATE/DELETE (flat partner check, never tree traversal). Add to `PARTNER_TENANT_TABLES` in `rls-coverage.integration.test.ts`.

#### `unifi_site_mappings` — UniFi site → Breeze site (RLS shape 1, direct org_id)

```
id              uuid PK
integration_id  uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE
org_id          uuid NOT NULL REFERENCES organizations(id)   -- denormalized from site, for RLS + device routing
site_id         uuid NOT NULL REFERENCES sites(id)           -- the Breeze site UniFi gear lands on
unifi_host_id   text NOT NULL                 -- console (UniFi OS host) id from /v1/hosts
unifi_site_id   text NOT NULL                 -- site id from /v1/sites
unifi_host_name text                          -- denormalized for display
unifi_site_name text
wan_metrics     jsonb                          -- latest ISP/WAN snapshot (latency, packetLoss, uptime, isp)
wan_metrics_at  timestamptz
created_at      timestamptz NOT NULL DEFAULT now()
updated_at      timestamptz NOT NULL DEFAULT now()
```

- Unique index: `(integration_id, unifi_host_id, unifi_site_id)` — a UniFi site maps to exactly one Breeze site.
- `org_id` is denormalized from `site_id` (a site belongs to one org) so the table is direct-`org_id` (shape 1) and device routing has the org without a join. The route layer derives `org_id` from the chosen `site_id` on write.
- Policy: `breeze_has_org_access(org_id)` (FOR ALL). Partner admins reach these through org membership. Unmapped sites are simply not synced. Direct-`org_id` (shape 1) needs no allowlist entry.

#### `unifi_devices` — synced inventory at full fidelity (RLS shape 1, direct org_id)

```
id                 uuid PK
org_id             uuid NOT NULL REFERENCES organizations(id)
site_id            uuid NOT NULL REFERENCES sites(id)        -- from the mapping; needed for discovered_assets insert
integration_id     uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE
mapping_id         uuid NOT NULL REFERENCES unifi_site_mappings(id) ON DELETE CASCADE
discovered_asset_id uuid REFERENCES discovered_assets(id)   -- link into the generic network model
unifi_device_id    text NOT NULL                            -- device id from Site Manager
mac                text NOT NULL
name               text
model              text
device_type        varchar(40)                              -- normalized: gateway|switch|ap|other
ip_address         inet
firmware_version   text
firmware_updatable boolean
adoption_state     varchar(30)
uptime_seconds     bigint
last_seen_at       timestamptz
raw                jsonb NOT NULL                            -- full Site Manager device payload (fidelity, drift-proofing)
first_synced_at    timestamptz NOT NULL DEFAULT now()
last_synced_at     timestamptz NOT NULL DEFAULT now()
created_at         timestamptz NOT NULL DEFAULT now()
updated_at         timestamptz NOT NULL DEFAULT now()
```

- Unique index: `(integration_id, unifi_device_id)`.
- Index: `(org_id, mac)` for the discovered-asset reconciliation join.
- Policy: `breeze_has_org_access(org_id)` (FOR ALL).
- `raw` jsonb is deliberate: the Site Manager schema is young and version-dependent (research flagged `/statistics/latest` field drift), so we promote a stable subset to typed columns and keep the whole payload for forward-compat and debugging.

#### `unifi_sync_runs` — sync ledger (RLS shape 3, partner-axis via integration)

```
id              uuid PK
integration_id  uuid NOT NULL REFERENCES unifi_integrations(id) ON DELETE CASCADE
partner_id      uuid NOT NULL REFERENCES partners(id)        -- denormalized for partner-axis RLS
trigger         varchar(16) NOT NULL                          -- scheduled | manual
status          varchar(16) NOT NULL                          -- running | success | partial | failed
started_at      timestamptz NOT NULL DEFAULT now()
finished_at     timestamptz
hosts_seen      integer NOT NULL DEFAULT 0
devices_created integer NOT NULL DEFAULT 0
devices_updated integer NOT NULL DEFAULT 0
devices_unchanged integer NOT NULL DEFAULT 0
devices_removed integer NOT NULL DEFAULT 0                     -- present last run, absent now
error           text
```

- Policy: `breeze_has_partner_access(partner_id)`. Add to `PARTNER_TENANT_TABLES` allowlist.
- This is the "track syncing" answer: an append-only run history with per-record deltas. It is an audit/forensic trail (counts let you spot a sync that suddenly removed 80% of devices), **not** a rollback mechanism. `devices_removed` marks devices that disappeared from the API; Phase 1 marks the `unifi_devices` row stale (clears `discovered_asset_id` link, sets `last_seen_at`) rather than hard-deleting, so the generic network model's own change tracking stays authoritative.

### Service layer — `apps/api/src/services/unifi/`

- `unifiClient.ts` — thin typed client over the Site Manager API. Methods: `listHosts()`, `listSites()`, `listDevices({hostId})`, `getIspMetrics({siteId})`. Sets `X-API-KEY`, handles `429` + `Retry-After` (documented 10k req/min cloud limit), normalizes the `{meta:{rc},data}` envelope, throws a typed `UnifiApiError{status, code}` on `meta.rc==='error'`. Pure HTTP; no DB.
- `unifiConnectionService.ts` — parallel to `accountingConnectionService.ts`, with a `DbExecutor` seam. Exports `getConnection(partnerId)`, `upsertConnection()`, `markStatus()`, `deleteConnection()`. Encrypts/decrypts the key via `secretCrypto` (`encryptSecret` / `decryptForColumn`). All updates use `AND partner_id = $` guards + `RETURNING` to surface RLS mismatches instead of silent 0-row writes (per the RLS silent-write learnings).
- `unifiSyncService.ts` — the sync orchestration used by the worker (see below). Pure of HTTP transport details (takes a `unifiClient`), takes a DB executor; unit-testable with both mocked.

### Background sync — `apps/api/src/jobs/unifiWorker.ts`

- Queue created via `createInstrumentedQueue('unifi-sync')` (the instrumented factory guards against enqueueing inside a held DB transaction — the #1105 foot-gun).
- A repeatable job (default every 30 min) enqueues a sync per active integration; the route can also enqueue a one-off `manual` job. Enqueue happens **outside** any request DB context (`runOutsideDbContext` first if called from a request path).
- The worker processor runs under `withSystemDbAccessContext` and, per integration:
  1. Open a `unifi_sync_runs` row (`status='running'`, `trigger`).
  2. Decrypt key → `unifiClient`. On auth failure: `markStatus('reauth_required')`, finish run `failed`, stop.
  3. `listHosts()` + `listSites()`; for each **mapped** site, `listDevices()` + `getIspMetrics()`.
  4. Upsert `unifi_devices` (keyed `(integration_id, unifi_device_id)`), tallying created/updated/unchanged. Update `unifi_site_mappings.wan_metrics`.
  5. Mark devices absent-this-run stale; tally `devices_removed`.
  6. **Reconcile into `discovered_assets`** (see data flow).
  7. Close the run (`success` / `partial` if some sites errored), update `unifi_integrations.last_sync_*`.

### Routes — `apps/api/src/routes/unifi/index.ts` (partner-scoped, `requirePermission`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/unifi` | Connection status + last sync summary |
| POST | `/unifi/connect` | Body `{apiKey, baseUrl?}`; validate via `listHosts()`, store encrypted, return discovered hosts/sites for mapping |
| POST | `/unifi/test` | Re-validate stored key; update `status` |
| POST | `/unifi/disconnect` | Delete connection (cascades mappings/devices/runs) |
| GET | `/unifi/hosts` | List hosts/sites (live) + current mappings, for the mapping UI |
| PUT | `/unifi/mappings` | Set/clear `unifi_site_mappings` (site → org) |
| POST | `/unifi/sync` | Enqueue a `manual` sync |
| GET | `/unifi/sync-runs` | Paginated ledger history |

All mutating web handlers go through `runAction` on the web side (per the web mutation-feedback contract). Unlike the accounting OAuth flow there is **no redirect/callback** — the credential is a pasted API key — so the signed-state + binding-cookie machinery is not needed.

### Web UI — `apps/web/src/components/integrations/UnifiIntegration.tsx`

Mounted on the existing Integrations page (parallel to `QuickbooksIntegration.tsx`). States:
1. **Disconnected:** API-key input + "how to generate a Site Manager key at unifi.ui.com" help text → POST `/unifi/connect`.
2. **Connected — mapping:** table of discovered hosts/sites, each with a Breeze **site** selector (grouped by org) → PUT `/unifi/mappings`. The route derives `org_id` from the chosen site. Self-hosted / non-UniFi-OS consoles shown as unsupported.
3. **Connected — synced:** last sync time/status, "Sync now" button, and a collapsible **sync-run history** table (the ledger) showing per-run created/updated/removed counts. Disconnect button.

### Data flow

```
[Site Manager API  api.ui.com]
        │  X-API-KEY (per-partner, encrypted at rest)
        ▼
unifiClient ── listHosts/listSites/listDevices/getIspMetrics
        ▼
unifiSyncService (withSystemDbAccessContext)
        ├─ upsert unifi_devices (full raw + typed subset)
        ├─ update unifi_site_mappings.wan_metrics
        ├─ reconcile → discovered_assets (mapped site_id + org_id)
        │     • match existing by (org_id, mac_address); else by (org_id, ip_address) [the unique key]
        │     • match → enrich (manufacturer/model/hostname/asset_type/is_online/ip) + link discovered_asset_id
        │     • no match → insert (org_id, site_id, ip, mac, asset_type) via onConflict (org_id, ip) do update
        │     • never clobber an agent-owned asset's identity beyond enrichment; only unlink on disappearance
        └─ write unifi_sync_runs ledger row (counts, status)
        ▼
Existing network view + aiToolsNetwork see UniFi gear via discovered_assets
Drill-down reads unifi_devices for UniFi-specific fields
```

`discovered_assets` has **no `source`/provenance column** and its unique key is `(org_id, ip_address)` (mac is nullable, not unique). So the link of record is **`unifi_devices.discovered_asset_id`** — a discovered asset "is from UniFi" iff a `unifi_devices` row references it; no enum or schema change to `discovered_assets` is needed (the new nullable `discovered_asset_id` FK lives on `unifi_devices`, not the reverse). Reconciliation matches an existing asset first by `(org_id, mac_address)` (the stable identifier) and falls back to the `(org_id, ip_address)` unique key; on a match it **enriches** (UniFi is authoritative for `manufacturer='Ubiquiti'`, `model`, `hostname`, `asset_type`, `is_online`, `ip_address`) and stamps the link. Net-new gear is inserted with the mapped `site_id`/`org_id` using `onConflictDoUpdate` on `(org_id, ip_address)` to absorb a race with agent discovery. When a UniFi device disappears we only **unlink** (`discovered_asset_id = NULL`, device marked stale) — we never delete an agent-discovered asset.

## Error handling

- **Invalid/expired key:** `connect`/`test` return a readable error; worker sets `status='reauth_required'` and stops without writing partial garbage. UI shows a reconnect prompt.
- **Rate limit (429):** client honors `Retry-After` with bounded backoff; if still limited, the run finishes `partial` and the next scheduled run resumes.
- **Per-site failure:** one site erroring does not fail the whole run — that site is skipped, run status is `partial`, `error` notes which sites failed.
- **Read-only key guarantee:** Phase 1 issues only GETs; even a mis-scoped key cannot mutate UniFi. Documented as a safety property.
- **Self-signed TLS:** not applicable — Site Manager is `api.ui.com` with a public cert (the self-signed-cert wrinkle only affects the Phase 2 on-LAN path).
- **Tenant isolation:** all writes carry partner/org guards + `RETURNING`; a 0-row write throws rather than silently no-oping.

## Testing

- **`unifiClient`** unit tests: envelope parse, `meta.rc==='error'` → `UnifiApiError`, 429/`Retry-After` handling, header set. (Mock fetch.)
- **`unifiConnectionService`** tests: encrypt-on-write / decrypt-on-read round trip; partner-guarded update returns row; cross-partner update returns 0 rows → throws.
- **`unifiSyncService`** tests (mocked client + DB executor): create vs. update vs. unchanged tallies; removed-device staling; WAN metrics snapshot; ledger row counts; partial-failure status; discovered_assets reconciliation (new asset, enrich existing, no-clobber, no-duplicate).
- **Routes** tests: connect validates before store; mappings CRUD; sync enqueues; permission gating; `runAction`-compatible error bodies.
- **RLS contract:** `rls-coverage.integration.test.ts` extended — `unifi_integrations` + `unifi_sync_runs` in `PARTNER_TENANT_TABLES`, `unifi_devices` + `unifi_site_mappings` auto-covered as direct-`org_id`. Plus a **functional forge test** (cross-partner insert into `unifi_integrations`, cross-org insert into `unifi_devices`) must fail with `new row violates row-level security policy` — the contract test alone has known blind spots for second-axis/denormalized columns.
- **Migration:** applies idempotently from empty and from a warm DB; re-apply is a no-op; `db:check-drift` clean.

## Build sequence (for the implementation plan)

1. Migration + `db/schema/unifi.ts` (4 tables + RLS) → `db:check-drift` + RLS forge test.
2. `unifiClient.ts` + tests.
3. `unifiConnectionService.ts` (+ secretCrypto) + tests.
4. `unifiSyncService.ts` (incl. discovered_assets reconciliation) + tests.
5. `unifiWorker.ts` + instrumented queue + scheduler registration.
6. `routes/unifi/index.ts` + mount in `index.ts` + tests.
7. `UnifiIntegration.tsx` + Integrations page wiring (`runAction`).
8. `rls-coverage` allowlist + functional forge tests; full `test-api` + `test-web` green.

## Future Phases (out of scope, recorded for continuity)

- **Phase 2 — agent-side deep telemetry + control.** Breeze Go agent polls the **local** Network Integration API (`/proxy/network/integration/v1`, firmware ≥9.3) or legacy cookie API (read-only local admin to dodge mandatory MFA) for clients, PoE per-port, throughput, DPI, events. Surfaces control actions (restart, PoE power-cycle, block client, firmware upgrade) via the local API on-site, or the Connector Proxy (~800ms) when only the cloud key exists. This is the competitive differentiator and leverages the agent Breeze already deploys.
- **Phase 3 — event push.** Subscribe UniFi **Alarm Manager webhooks** (client connect/disconnect, WAN down, PoE loss, threats) into Breeze's alerting pipeline; optionally CEF syslog into the log pipeline. Replaces poll-only freshness with real-time events.
- **Cloud write:** when Ubiquiti enables write on Site Manager keys, control actions can move to the cloud path for sites without an agent.

## Rollback / risk

- Entirely additive: new tables, new service, new route, new component. No change to existing device/agent paths beyond an additive, idempotent `'unifi'` provenance value and a nullable enrich-only link into `discovered_assets`.
- The connection is opt-in per partner; disabling/deleting it cascades cleanly and leaves agent-discovered assets intact (only the UniFi link is removed).
- API immaturity is contained by the `raw` jsonb column (schema drift survives) and `partial` run status (per-site failures don't cascade).
- Reverting the feature is a migration-down of four isolated tables plus removing the route mount; no data outside these tables depends on them.

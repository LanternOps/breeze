# UniFi Self-Hosted Controller Support — Design

**Date:** 2026-06-29
**Status:** Draft (design)
**Related:** `2026-06-28-unifi-network-integration-design.md` (Phase 1 cloud inventory), `2026-06-29-unifi-phase2a-agent-telemetry-design.md` (Phase 2a agent telemetry)

## Problem

The UniFi integration as shipped assumes **cloud-registered UniFi-OS consoles**. Both the inventory path and the deep-telemetry path are anchored to a `unifi_host_id` that originates exclusively from Ubiquiti's Site Manager cloud (`https://api.ui.com/v1/hosts`, see `apps/api/src/services/unifi/unifiClient.ts:87`). This excludes a common MSP topology:

> A single **self-hosted UniFi Network application** running in one VM, with each customer represented as a *site* inside that one controller.

Two independent walls block that topology today:

1. **A self-hosted controller is never listed as a host.** Site Manager (`api.ui.com`) only returns cloud-adopted UniFi-OS consoles. A self-hosted software controller is, per the Phase-1 spec, explicitly out of scope: *"Self-hosted (non-UniFi-OS) Network Applications are not reachable via Site Manager; they are out of scope and surfaced as such in the UI"* (`2026-06-28-unifi-network-integration-design.md:35`). With zero hosts, the "Deep telemetry collectors" card never renders — it is gated on `hosts.length > 0` (`apps/web/src/components/integrations/UnifiIntegration.tsx:712`).

2. **One controller can only map to one site.** `unifi_collectors` has `unifi_host_id text NOT NULL` (`apps/api/src/db/schema/unifi.ts:114`) and a unique index `unifi_collectors_integration_host_idx` on `(integration_id, unifi_host_id)` (`schema/unifi.ts:129`). The upsert keys on exactly that tuple (`apps/api/src/services/unifi/unifiCollectorService.ts:91-92`), so a second collector for the same controller overwrites the first. A single VM = a single (at most) host id, so it cannot fan out to many customer sites.

The pieces that *would* scale already work: one agent can back many collectors (no unique constraint on `collector_device_id`; `listCollectorsForDevice` returns an array — `unifiCollectorService.ts:119-137`), and the agent loop iterates all assigned collectors (`agent/internal/unifi/collector.go:170`). The bottleneck is the host-centric config/discovery model upstream.

## Goal

Let a partner register a **self-hosted UniFi controller** by URL + collector agent + local API key, with **no cloud (`api.ui.com`) involvement**, and have that one controller fan out to **many customer sites and orgs**. The agent — the only component that reaches the controller, over the LAN — delivers **both inventory and deep telemetry**, achieving full parity with the cloud path.

### Non-goals

- **Mixed mode** (a single partner integration holding *both* cloud-adopted consoles *and* a self-hosted VM at the same time). One `connection_type` per integration. Revisit only if a real need appears.
- **Collector HA / failover** (multiple agents polling the same controller). One collector agent per controller for now.
- Changing the cloud path's behavior. Cloud integrations continue to work exactly as today.

## Approach

Extend the **existing** UniFi integration with a connection-type discriminator rather than introducing a parallel "self-hosted controller" subsystem. This reuses the agent collector loop, the telemetry ingest pipeline, the `discovered_assets` reconciliation, and the integrations UI — swapping only the host-id-keyed assumptions for controller-id-keyed ones.

## Data model

### `unifi_integrations`
- Add `connection_type text NOT NULL DEFAULT 'cloud'` — allowed values `'cloud' | 'self_hosted'`.
- For `self_hosted`, the cloud fields (`base_url`, `api_key_encrypted`) are unused; make them nullable. (They are currently `base_url text default 'https://api.ui.com'` and `api_key_encrypted text not null` — `schema/unifi.ts:25,30`. The migration relaxes `api_key_encrypted` to nullable and adds a `CHECK` that it is non-null when `connection_type = 'cloud'`.)
- Remains **partner-scoped** (one active row per partner; `requireScope('partner','system')`, `routes/unifi/index.ts:37`).

### `unifi_collectors` (becomes the controller registration for self-hosted)
- Make `unifi_host_id` **nullable** (currently `NOT NULL`, `schema/unifi.ts:114`). Null = self-hosted controller; non-null = cloud console (unchanged).
- Replace the unconditional unique index `(integration_id, unifi_host_id)` with a **partial** unique index `WHERE unifi_host_id IS NOT NULL` (preserves the cloud invariant only).
- Add a partial unique index `(integration_id, controller_url) WHERE unifi_host_id IS NULL` to prevent registering the same self-hosted controller twice.
- For self-hosted, **one row = one VM** (one controller), not one-per-site. Existing columns reused: `collector_device_id`, `controller_url`, `local_api_key_encrypted`, `poll_interval_seconds`, status fields.

### `unifi_controller_sites` (new)
The agent enumerates the controller's local sites so the UI has something to map.
- Columns: `id`, `collector_id` (FK → `unifi_collectors`), `local_site_id` (the controller's site id), `name`, `last_seen_at`, timestamps.
- Unique `(collector_id, local_site_id)`. Upserted by the server from the agent's reported site list.
- Tenancy shape: scoped through `collector_id → integration → partner`. Add to `PARTNER_TENANT_TABLES` (or the appropriate shape) in `rls-coverage.integration.test.ts` with policies created in the same migration. (See CLAUDE.md RLS workflow.)

### `unifi_site_mappings`
- Today keyed on cloud `unifi_host_id` + `unifi_site_id` → Breeze `site_id`. Extend so that when `unifi_host_id` is null, the mapping keys on `(collector_id, local_site_id) → site_id`.
- Add nullable `collector_id` and `local_site_id` columns; a `CHECK` enforces exactly one of {cloud host/site pair, self-hosted collector/local-site pair} is populated.
- Mapping a local site to a Breeze site **auto-assigns the org** (site → org), which is the mechanism that lets one MSP controller cleanly span many customers.

## Agent changes (`agent/internal/unifi`)

The agent is ~90% there. `collector.go:170` already iterates all assigned collectors; `client.go` already polls `/sites`, `/sites/{id}/devices`, `/sites/{id}/clients` over self-signed TLS with redirect refusal.

Changes:
1. **Self-hosted collector (no host id):** enumerate **all** sites on the controller and include the full discovered-site list (id + name) in the upload, so the server can populate `unifi_controller_sites`.
2. **Tag rows with `local_site_id`:** every device/client/telemetry row carries its `local_site_id` so the server routes it to the correct mapping/org.
3. No new static config on the agent — it continues to fetch assignments from `GET /agents/:id/unifi-collectors` and post to `POST /agents/:id/unifi-telemetry` (`routes/agents/unifiTelemetry.ts`). The collector config payload gains a flag/marker that this is a self-hosted controller (host id absent) so the agent knows to enumerate all sites.

## Server ingest = full parity

Extend the telemetry ingest worker so that for self-hosted uploads it additionally:
1. **Upserts `unifi_controller_sites`** from the reported site list (drives the mapping UI).
2. **Reconciles devices into `discovered_assets`**, reusing the cloud `reconcileDiscoveredAsset()` logic (`apps/api/src/services/unifi/unifiSyncService.ts:64+`) — match by MAC/IP within the mapped org, upsert, mark stale on disappearance.
3. **Routes telemetry and clients** to the correct org/site via the `(collector_id, local_site_id)` mapping.

Net result: a self-hosted controller populates **both** inventory (`discovered_assets`, plus the UniFi device/client tables) **and** deep telemetry, each routed to the right customer org.

Ingest must continue to enforce that the posting agent owns the collector — `getCollectorOwnerDeviceId` already does this (`unifiCollectorService.ts:143`). Self-hosted changes nothing about that check.

## UI (`/integrations` → UniFi tab)

`apps/web/src/components/integrations/UnifiIntegration.tsx` (partner-scoped; org-scoped users see the "partner accounts only" message — `IntegrationsPage.tsx:267-273`).

- **Connect step** gains a choice: **Cloud (Site Manager API key)** vs **Self-hosted controller**.
- **Self-hosted flow:** register a controller (Controller URL, Collector agent dropdown, Local API key — no cloud key). The agent's discovered sites then populate the mapping card.
- **Mapping card:** same UX as cloud, but sourced from `unifi_controller_sites` (agent-discovered) instead of cloud `/v1/sites`. Map each local site → Breeze site (→ org).
- For self-hosted, deep telemetry is **inherent**, not a separately gated card. The existing `hosts.length > 0` gate (`UnifiIntegration.tsx:712`) is replaced by a connection-type-aware condition.

## Tenancy / security

- Integration stays **partner-scoped**; site mappings fan out across multiple orgs; telemetry and inventory rows resolve their owning org through the mapping. No cross-tenant leakage provided ingest validates collector ownership (already enforced).
- `unifi_controller_sites` and any new columns get RLS policies in the same migration, with allowlist entries in `rls-coverage.integration.test.ts` (CLAUDE.md RLS workflow). Verify a cross-tenant insert fails as `breeze_app`.
- Local API key stored encrypted with the existing `aad` pattern (`unifiConnectionService.ts:92` style), pushed only to the assigned agent (existing collector-config delivery).
- Agent → local controller already uses `InsecureSkipVerify` for self-signed console certs plus explicit redirect refusal to prevent key leakage via SSRF (`client.go:88-101`). Unchanged.

## Migration notes

- Date-prefixed, idempotent migration(s) per CLAUDE.md. If altering `unifi_collectors` constraints and adding `unifi_controller_sites` in dependent steps on the same day, use `-a-` / `-b-` infixes.
- Dropping/recreating the `(integration_id, unifi_host_id)` unique index as a partial index must be idempotent (`DROP INDEX IF EXISTS` then `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE ...`).
- Relaxing `unifi_integrations.api_key_encrypted` to nullable + adding the `connection_type` CHECK must tolerate existing cloud rows (all have a key and default `connection_type='cloud'`).

## Phasing

Single spec; implementable in sequence:
1. Schema: `connection_type`, nullable host id + revised indexes, `unifi_controller_sites`, mapping columns + RLS.
2. Controller registration API + service (reuse `PUT /unifi/collectors`, drop the host-id requirement for self-hosted).
3. Agent: multi-site discovery + `local_site_id` tagging.
4. Server ingest: controller-site upsert + `discovered_assets` reconcile + telemetry routing.
5. UI: connection-type choice, self-hosted register flow, mapping sourced from controller sites.

## Open questions

- None blocking. Mixed-mode and collector HA are deliberately deferred (see Non-goals).

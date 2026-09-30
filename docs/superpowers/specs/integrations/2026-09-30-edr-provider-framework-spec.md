---
title: EDR provider framework + Sophos / Bitdefender / Emsisoft adapters
status: draft (spec — not a plan, nothing implemented)
date: 2026-09-30
anchor_issue: LanternOps/breeze#3135
cluster: [3136, 7436, 4620]
related_not_in_scope: [6960, 3695, 4621, 7139, 4103]
---

# EDR provider framework + first adapter set

## 1. Problem

Breeze has two EDR vendor integrations, SentinelOne and Huntress, and they are copy-paste
siblings. Each has its own tables (`s1_*` in `apps/api/src/db/schema/sentinelOne.ts`, `huntress_*`
in `huntress.ts`), its own client (`services/sentinelOne/client.ts`, `services/huntressClient.ts`),
its own BullMQ queue and sync job (`jobs/s1Sync.ts`, `jobs/huntressSync.ts`), its own route file
(`routes/sentinelOne.ts` mounted at `/s1`, `routes/huntress.ts` with an HMAC webhook), its own AI
tools (`aiToolsSentinelOne.ts`: `get_s1_status`, `get_s1_threats`, `s1_isolate_device`,
`s1_threat_action`; `aiToolsHuntress.ts`: `get_huntress_status`, `get_huntress_incidents`,
`sync_huntress_data`), and its own web panels. About 100 non-locale production files name one or
both vendors (`git grep -il 'huntress|sentinel ?one|s1_threats'` over `apps/`, `packages/`, 2026-09-30).

The vendor is hard-coded in every consumer, not just in the integration itself:

| Consumer | How it hard-codes the vendor (verified 2026-09-30) |
|---|---|
| Incidents feed | `routes/incidents.helpers.ts` builds a 3-leg `unionAll` (tracked, Huntress, S1) through a hand-written 8-way nested ternary; `incidents.validation.ts` has `source: z.enum(['breeze','huntress','s1'])` and `sourceType: z.enum(['huntress_incident','s1_threat'])`; web `lib/incidents.ts` and `IncidentsPage.tsx` mirror it |
| Installers | `builtinDeploymentPackages.ts` `type BuiltinProvider = 'huntress' \| 'sentinelone'`; `edrInstallerResolver.ts:60` is `if (provider === 'huntress') return resolveHuntress(...)` and **everything else falls into the SentinelOne branch**; the `software_catalog.integration_provider` CHECK (`2026-07-02-builtin-catalog-partner-read-rls.sql:23`) allows only those two values |
| Events | `eventBus.ts` event types `s1.*`, `huntress.*` |
| AI | two tool files, plus per-tool entries in `aiTools.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts` (tier + four-eyes maps keyed `s1_threat_action`, `s1_isolate_device`), `aiToolRateLimits.ts`, `aiAgentSdkTools.ts`, `mcpCoverage.ts`, `aiAgents/agentToolCatalog.ts` |
| Reports | `securityComplianceReport.ts`, `threatDetectionReport.ts`, shared `threatDetection.ts` |
| Portal | `portal/protection.ts`, `portal/securityReadModel.ts`, `shared/types/portalVisibility.ts` (`huntress: number`) |
| Readiness | `orgAccountReadinessIntegrations.ts` `type ConnectorSystem = ... \| 'huntress' \| 'sentinelone'` |
| Web | `lib/edr.ts` (calls `/s1/*`, `/huntress/*`), `DeviceEdrPanel.tsx`, `security/EdrPage.tsx` (per-vendor tabs, per `plans/integrations/2026-06-25-edr-operations-surfacing.md` D1), `IntegrationsPage.tsx` security sub-tab, `SecurityIntegration.tsx`, `HuntressIntegration.tsx` |

Three more vendors have been requested — Sophos Central (#3135, approved 2026-08-16), Bitdefender
GravityZone (#3136, approved, sequenced behind Sophos), Emsisoft Management Console (#7436, new) —
and a fourth is parked but must not be precluded (Microsoft Defender for Endpoint, #4620). Adding
each as a third, fourth and fifth copy-paste sibling multiplies every row of the table above, and
the installer resolver would silently route a third vendor through the S1 branch.

The repo already contains a working answer to this shape: the **backup-provider framework** (#6008,
spec `specs/integrations/2026-09-15-backup-provider-integration-cove-design.md`) —
`backup_provider_connections` with an open `provider varchar`, generic customer/device tables, a
`BackupProviderAdapter` interface (`services/backupProviders/types.ts`), a registry
(`registry.ts`), a shared device matcher (`deviceMatching.ts`), and one sync job
(`jobs/backupProviderSync.ts`). A second backup vendor is "a new file implementing the interface and
one line in `registry.ts`". This spec builds the EDR equivalent.

## 2. Users and scope

- **Who configures it: the MSP (partner scope).** A vendor console credential is the MSP's, and it
  usually sees every customer the MSP manages. Connections and vendor-tenant mappings are
  partner-owned and never visible to an org-scoped token (same gate as
  `routes/backup/providerAccess.ts` `resolveProviderPartnerId`: org scope → honest 403).
- **Who consumes it: techs at partner or org scope, and the client portal.** Endpoint health,
  detections and action history are org-scoped rows, readable through ordinary org RLS; the portal
  reads a vendor-neutral summary.
- **Per-org mapping.** Each vendor tenant (Sophos tenant, GravityZone company, Emsisoft workspace,
  S1 site, Huntress organization) maps to at most one Breeze organization. Unmapped tenants stay
  visible to the partner admin who must map them.
- **In scope:** the framework (tables, adapter interface, registry, sync, device matching, feed leg,
  routes, response actions + audit + AI guardrails, generic AI tools, web UI, installer hook) and
  adapters for Sophos Central, Bitdefender GravityZone and Emsisoft (scope of the last depends on
  Open Decision D9), plus agent-side detection signatures for vendors the agent cannot see today.
- **Must fit, not built:** Defender for Endpoint (#4620), generic "Security agents" auto-deploy
  (#6960), local Defender detections as a feed leg (#3695), local Defender actions (#4621).

## 3. Vendor API research

Researched 2026-09-30 against vendor documentation. Claims marked *(unconfirmed)* could not be
verified from a primary source and must be re-checked in the adapter's plan before code is written.

### 3.1 Capability matrix

| | **Sophos Central** (rebranded *Sophos Fusion* 07-2026) | **Bitdefender GravityZone** | **Emsisoft EMC (cloud)** | ESET PROTECT / Connect | ThreatDown OneView / Nebula | WithSecure Elements | MS Defender for Endpoint | CrowdStrike Falcon |
|---|---|---|---|---|---|---|---|---|
| Auth | OAuth2 client-credentials at `id.sophos.com`, 1 h JWT, then `whoami` → `idType` + `X-Partner-ID`/`X-Tenant-ID` headers | JSON-RPC 2.0; HTTP Basic with API key as user; key scoped to chosen APIs | `Api-Key` header (key issued via partner manager / profile — unclear) | OAuth2 **password grant** for a dedicated API user, 1 h JWT | OAuth2 client-credentials; `accountid` header | OAuth2 client-credentials, scopes `connect.api.read/write` | Multi-tenant Entra app + **per-customer-tenant consent**, token per tenant | OAuth2 client-credentials, ~30 min |
| Hosts (SSRF allowlist) | `id.sophos.com`, `api.central.sophos.com`, per-tenant `api-<region>.central.sophos.com` (eu01…ae01) returned by the API | per-account Access URL, `*.gravityzone.bitdefender.com` | single `api.emsisoft.com` | `{eu,de,us,jpn,ca}.<service>.eset.systems` | `api.malwarebytes.com` / `api.threatdown.com` | `api.connect.withsecure.com` | `graph.microsoft.com`, `api.security.microsoft.com` | `api.{,us-2.,eu-1.}crowdstrike.com`, GovCloud |
| **One partner credential sees all customers?** | **Yes** (partner → `/partner/v1/tenants`) | **Yes** (partner key → `getCompaniesList`) | **Probably** (`/v1/workspaces`; inferred from spec) | **No / unconfirmed** — assume per company | **Yes** (OneView, all permitted sites) | **Yes** (SOP-level key, `organizationId` filter) | **No** — per tenant | **Yes** (Flight Control parent; token per `member_cid`) |
| Endpoint IDs for matching | hostname, IPv4/6, **MACs**, id; serial *unconfirmed* | name, **FQDN**, IP, **MACs**, AD SID, id | name + domain only (**no IP/MAC/serial**) | hostname, **serial**, MACs, bios uuid | hostname, machine_id; MAC/serial *unconfirmed* | name, **serial**, MACs, IPs | computerDnsName, aadDeviceId, IPs (+MAC); no serial | hostname, **serial**, MAC, local IP |
| Detection model | Common `alerts` (+ Detections/Cases v1 REST, GraphQL v2; classic XDR API deprecated 2026-09-18) | Incidents API + quarantine items | workspace `incidents` with verdicts | detections (+ Inspect incidents) | detections (search / export) | security events + BCD incidents | Graph `alerts_v2` / `incidents` | detections / alerts |
| Response actions | isolate / unisolate (`PATCH …/isolation`), scan, update-check, tamper protection, alert actions (acknowledge, clean) | isolate / restore (needs incidents licence), scan, kill process, quarantine remove/restore, blocklist, incident status | scan, quarantine restore/delete, mark false positive, incident verdict; **no per-device isolation** (network lockdown is per policy group) | isolate, scan, kill process (async device tasks) | isolate (network/process/desktop), scan+remediate (async jobs) | isolate / release, scan (≤ 5 targets/call), kill process | isolate / unisolate, AV scan, restrict code exec, offboard (MDE API only; Graph cannot isolate) | contain / lift containment |
| Push | **None** — poll (SIEM feed only reaches back 24 h) | **Push Event Service** (`setPushEventSettings`: URL + custom `Authorization` header; built-in integrity header is weak md5 of api key) | **None** (email notifications; webhooks only for scheduled reports) | poll | Nebula webhook notifications (OneView *unconfirmed*) | poll | Event Hub streaming only; Graph webhooks do not cover alerts_v2 | Event Streams (long-lived HTTP) |
| Rate limits | **10/s, 100/min, 1,000/h, 200k/day** per credential+account+IP | 10 req/s per key; scan/quarantine tasks 30/min; push settings 5/min | undocumented | 10/s; bursts throttled | 429 leaky bucket; number *unconfirmed* | 300/min on EDR endpoints | isolate 100/min, 1,500/h | 6,000/min per CID |
| Installer via API | `GET /endpoint/v1/downloads` (per tenant; fields *unconfirmed*) | `getInstallationLinks` per company/OS | `GET /workspaces/{ws}/install` (token + URLs) | — | — | — | — (onboarding package) | sensor download API |

Sources: Sophos — developer.sophos.com/getting-started, /getting-started-tenant, /reference/endpoint-v1,
/reference/common-v1, /reference/siem-v1/events/get-events, /concepts/rate-limits, /whatsnew; Sophos
Fusion announcement community.sophos.com/sophos-fusion/b/blog/posts/sophos-central-is-evolving-to-sophos-fusion.
Bitdefender — bitdefender.com/business/support/en/77209-125277-public-api.html, …-128483-getendpointslist,
…-128484-getmanagedendpointdetails, 77211-128478-getcompanieslist, …-135330-createisolateendpointtask,
…-135319-setpusheventsettings, …-135325-push-event-json-rpc-messages, …-394430-api-rate-limits,
…-135297-getinstallationlinks. Emsisoft — api.emsisoft.com (OpenAPI at /swagger/v1.0/swagger.json),
emsisoft.com/en/help/3231/automation-guide-setting-up-new-customer-workspaces-via-api/,
emsisoft.com/en/third-party-integrations/. ESET — help.eset.com/eset_connect/en-US/{authenticate_api_user,prerequisites,multitenancy,automation,rate_limits}.html.
ThreatDown — support.threatdown.com (OneView/Nebula API articles; several returned 403, corroborated via
docs.swimlane.com/connectors/threatdown-oneview-api and xsoar.pan.dev/docs/reference/integrations/malwarebytes).
WithSecure — connect.withsecure.com/getting-started/elements and the Elements OpenAPI spec. Microsoft —
learn.microsoft.com/defender-endpoint/api/{exposed-apis-create-app-partners,machine,isolate-machine},
/graph/api/resources/security-api-overview, /graph/api/resources/subscription, /defender-xdr/streaming-api.
CrowdStrike — developer.crowdstrike.com/api-reference/collections/{mssp,hosts,event-streams}.

### 3.2 What the matrix changes in the design

1. **Rate budgets are first-class.** Sophos allows 1,000 calls/hour per credential. A partner with
   60 tenants polling endpoints + alerts every 5 minutes would need ~1,440+/h before paging. The
   adapter declares a budget and the sync job schedules within it (§4.4); Sophos defaults to a 15 min
   detection poll and 60 min endpoint inventory.
2. **Every vendor's actions are asynchronous** (task/job id + status). `performAction` returns a
   vendor action id; completion is polled. Batch caps differ (WithSecure 5 targets, GravityZone 1,000).
3. **Tokens are per tenant for some vendors** (CrowdStrike `member_cid`, Defender per tenant), so the
   token cache is keyed by `(connection, tenant)`, not by connection.
4. **Identifiers differ widely.** Emsisoft has no IP/MAC/serial, so its match rate will be the lowest
   and ambiguity must be surfaced, not guessed. Serial is present on ESET/WithSecure/CrowdStrike but
   not Sophos/GravityZone/Defender, so it can only be a tiebreak.
5. **Push is the exception.** Only GravityZone (and ThreatDown, CrowdStrike) push; polling is always
   the source of truth. GravityZone's built-in integrity header is `md5(apiKey + md5(body))` — we
   authenticate with our own generated `Authorization` secret instead.
6. **Credential shapes vary** (client secret, API key, ESET's user password, a reference to an M365
   consent for Defender) — `credentialsSchema` per adapter, never a fixed column.
7. **Per-endpoint capability.** GravityZone isolation needs an incidents-capable licence; Emsisoft has
   no per-device isolation at all. Hence `supportsAction(endpoint, action)` on top of the static flags.
8. **Sophos is mid-rename** to Sophos Fusion (API hosts still `*.central.sophos.com`); the allowlist
   lives in the adapter so a host change is a one-file edit.

### 3.3 Which additional vendors belong on the roadmap

Evidence and strength as labelled; order after Sophos / Bitdefender / Emsisoft:

1. **Microsoft Defender for Endpoint / Business (#4620)** — strong evidence: IDC ranks Microsoft #1 in
   modern endpoint security share (28.6%, 2024); many MSP customers already own it via M365 Business
   Premium; Datto RMM and Syncro integrate it. Costs: per-tenant consent, polling only, but Breeze's
   existing M365 consent plumbing lowers it. Recommend un-parking once the framework has two adapters.
2. **CrowdStrike Falcon** — strong evidence on share (IDC top tier) and API quality (Flight Control
   parent credential, streaming, serial in host records); NinjaOne integrates it natively.
3. **ThreatDown (Malwarebytes)** — moderate: native OneView integrations with Datto RMM, Kaseya VSA,
   ConnectWise Automate; MSP-priced; one credential for all sites; webhooks.
4. **ESET** — moderate: ESET ships its own plugins for NinjaOne, Datto, Automate, VSA, N-central;
   but password-grant auth, likely per-company credentials, 10 req/s.
5. **WithSecure** — weak on demand (no competitor RMM integrates it natively), cleanest MSP API; cheap
   once the framework exists; mainly European MSPs.

Not recommended: Datto EDR (a competitor platform's own product). Webroot appears in NinjaOne,
Datto and Pulseway integrations but was not API-researched here; agent-side detection (§4.14) covers
it for inventory purposes.

## 4. Proposed design

### 4.1 Shape at a glance

```
services/edrProviders/
  types.ts         EdrProviderAdapter, EdrCapabilities, Vendor* DTOs, EdrProviderRequestError
  registry.ts      EDR_PROVIDER_KEYS, getEdrProvider(key) (loud throw), listEdrProviders()
  normalize.ts     shared severity/status/health tuples + pure mappers (unit-tested)
  persist.ts       per-tenant upsert/delete of endpoints + detections (Phase 3 of sync)
  actions.ts       dispatchEdrAction(): capability check → audit row → adapter call → status
  webhook.ts       verify → resolve connection → enqueue targeted sync (never trust payload)
  sophos/{client,adapter,normalize}.ts
  bitdefender/{client,adapter,normalize}.ts
  emsisoft/{client,adapter,normalize}.ts
services/externalDeviceMatching/   (extracted from backupProviders/deviceMatching.ts, see 4.6)
jobs/edrProviderSync.ts            queue 'edr-provider-sync'
routes/edr/{connections,tenants,endpoints,detections,actions,webhook}.ts  mounted at /edr
```

Nothing above `types.ts` knows which vendors exist. SentinelOne and Huntress are **not** moved in
the first waves (see §6 and D2); the read-side consumers learn about the framework through one
generic leg each, next to the two legacy legs.

### 4.2 Tables

Five tables, all created with RLS in the same migration (CLAUDE.md step 1). Column lists are
indicative; the W01 plan owns exact types. Registrations for each are in §5.

**`edr_connections`** — one MSP-level connection to a vendor console. *Tenancy shape 3
(partner-axis), no `org_id`.* Mirrors `backup_provider_connections`.
`id, partner_id → partners, provider varchar(30)` (validated by `getEdrProvider`, open string so an
adapter needs no migration), `name, base_url` (nullable; per-adapter default + allowlist, §4.9),
`region varchar(40)` (nullable; Sophos/GravityZone/ESET-style data regions),
`credentials_encrypted text` (**`aadBinding: 'row'`** in `encryptedColumnRegistry`),
`webhook_secret_encrypted text` (row-bound AAD), `vendor_root_id, vendor_root_name`
(partner id / MSP company id / whoami result), `is_active, status ('connected'|'error'|'reauth_required')`,
`sync_interval_minutes`, `last_sync_*` counters (tenants, unmapped tenants, endpoints, linked,
ambiguous, detections), `capabilities_snapshot text[]` (the adapter's capability keys at last
successful test — lets the UI render without an adapter round trip and records drift),
`created_by, created_at, updated_at`. Unique `(id, partner_id)` for composite FKs; unique
`(partner_id, provider, name)`. **Multiple connections per partner per provider are allowed** (post-
acquisition MSPs run two consoles; the Cove precedent); see D3.

**`edr_tenants`** — a vendor tenant discovered under a connection and the Breeze org it maps to.
*Tenancy shape 3 (partner-axis) carrying a nullable `org_id` mapping target* — identical treatment
to `backup_provider_customers` / `huntress_org_mappings` / `s1_org_mappings`.
`id, connection_id, partner_id, vendor_tenant_id, vendor_tenant_name, vendor_parent_id,
vendor_tenant_type` (e.g. Sophos `tenant`, GravityZone `company`, Emsisoft `workspace`),
`api_host varchar(300)` (Sophos returns a per-tenant data-region host; validated against the
adapter's allowlist on write, never used unvalidated), `org_id → organizations ON DELETE SET NULL`,
`mapping_source ('manual'|'auto_external_code'|'manual_unmapped')` (name matches are suggestions only, §4.5),
`installer_secret_encrypted text` (per-tenant deploy token / installer link / site key, row-bound
AAD; replaces S1 `registration_token` and Huntress `huntress_org_key` in the generic model),
`endpoint_count, open_detection_count, last_seen_at, vendor_missing_since`, per-tenant sync state
`last_sync_at, last_sync_status, last_sync_error, detection_cursor text` (§4.4), `created_at,
updated_at`. FKs: `(connection_id, partner_id) → edr_connections(id, partner_id) ON DELETE CASCADE`;
`(org_id, partner_id) → organizations(id, partner_id)` **`DEFERRABLE INITIALLY IMMEDIATE`**
(org-merge contract). Unique `(connection_id, vendor_tenant_id)`, `(id, connection_id)`,
`(id, org_id)`. **One vendor tenant per org per connection is not enforced**: a customer may
legitimately own two tenants.

**`edr_endpoints`** — one vendor endpoint under a **mapped** tenant. *Tenancy shape 1 (direct
`org_id` NOT NULL).* Endpoints under unmapped tenants are counted, never stored (Cove D8
precedent, D5). `partner_id` is denormalized for the composite FK and partner overview scans and
is **not** a second RLS branch (a partner token with restricted org access must not read every
org's rows — same reasoning as `backup_provider_devices`).
`id, connection_id, partner_id, org_id, tenant_id, provider` (denormalized for org-token labeling),
`vendor_endpoint_id, hostname, fqdn, serial_number, mac_addresses text[]` (lower-case,
colon-separated, normalized by the adapter), `ip_addresses text[], os_platform
('windows'|'macos'|'linux'|'other'), os_name, endpoint_type ('workstation'|'server'|'mobile'|'unknown'),
agent_version, health ('healthy'|'degraded'|'unhealthy'|'unknown'), online boolean,
isolation_state ('isolated'|'not_isolated'|'pending'|'unknown'),
tamper_protection boolean null, policy_name, last_seen_at,
breeze_device_id uuid` (link, see below), `device_match_source ('auto_hostname'|'auto_mac'|'auto_serial'|'manual')`,
`first_seen_at, vendor_raw jsonb, created_at, updated_at`. Unique `(connection_id, vendor_endpoint_id)`,
`(id, org_id)`, partial unique `(connection_id, breeze_device_id) WHERE breeze_device_id IS NOT NULL`
— **per connection, not global**: a device legitimately runs two protection products (e.g. Sophos
plus an MDR, or two vendors during a migration), and a global unique index would make the second
permanently unlinkable. A device linked by two connections of the same provider is surfaced on the
device panel as a duplicate. The matcher's "claimed" set is scoped to the connection accordingly.
Composite FKs (all `DEFERRABLE INITIALLY IMMEDIATE` where they include `org_id`):
`(tenant_id, connection_id) → edr_tenants(id, connection_id)`, `(tenant_id, org_id) →
edr_tenants(id, org_id)`, `(connection_id, partner_id) → edr_connections`, and **mandatory**
`(breeze_device_id, org_id) → devices(id, org_id) ON DELETE SET NULL (breeze_device_id)` — org
coherence alone cannot stop a row mixing two tenants mapped to one org, so connection/tenant
coherence is enforced too (backup precedent, `backupProviders.ts:231`). `edr_detections` and
`edr_actions` carry the same set.

*Why `breeze_device_id`, not `device_id`:* the row's `org_id` comes from the **tenant mapping**,
not from the device. A column named `device_id` enrols the table in
`breeze_device_child_orgid_tables()` (the devices org-move trigger's generic `SET org_id` loop)
and in the `cascadeDelete.test.ts` `device_id` contract — both wrong for a link. The FK is
`ON DELETE SET NULL (breeze_device_id)` (PG15 column-list form, migration-authoritative, not
declared in Drizzle), and a device org-move detaches the link synchronously in
`services/deviceOrgMove/moveDeviceOrgInTransaction.ts`, exactly as it does for
`backup_provider_devices`. This deliberately differs from `s1_agents.device_id` /
`huntress_agents.device_id`; see D4.

**`edr_detections`** — one vendor alert / detection / threat / incident. *Tenancy shape 1.*
`id, connection_id, partner_id, org_id, tenant_id, endpoint_id` (nullable, composite
`(endpoint_id, org_id) → edr_endpoints(id, org_id) ON DELETE SET NULL (endpoint_id)`),
`breeze_device_id` (nullable, denormalized from the endpoint link at write time so the feed's
site predicate needs no join), `provider, vendor_detection_id, vendor_kind` (`alert`, `detection`,
`threat`, `incident`, `quarantine_item` — the vendor's own noun, kept for display), `severity`
(`critical|high|medium|low|info|unknown`), `vendor_severity`, `status`
(`open|in_progress|mitigated|resolved|false_positive|dismissed|unknown`), `notified_severity`
(severity last published as an event/alert; Phase 4 compares against it, §4.4), `detached_at`
(D13), `device_detached_at, last_site_id` (D14), `vendor_status, title, category,
threat_name, file_path, process_name, mitre_techniques text[]` (technique IDs as text, not jsonb, so
the column stays `included` in the export policy), `detected_at, resolved_at, last_vendor_update_at,
details jsonb, created_at, updated_at`. Unique `(connection_id, vendor_kind, vendor_detection_id)` —
some APIs only make ids unique per resource kind (GravityZone incidents vs quarantine items); each
adapter documents its id scope and the plan confirms it against fixtures. When a manual relink
changes an endpoint's `breeze_device_id`, the same transaction rewrites it on that endpoint's
**open** detections (closed ones keep the historical device), so site authorization never follows a
stale link. Indexes as
`s1_threats` (org+status, org+severity+status, org+detected_at partial, device).

**`edr_actions`** — the audit and status ledger for response actions (the generic `s1_actions`).
*Tenancy shape 1.* `id, connection_id, partner_id, org_id, tenant_id, endpoint_id, detection_id,
breeze_device_id, provider, action` (normalized key, §4.10), `requested_by → users ON DELETE SET
NULL, requested_via ('ui'|'ai'|'automation'|'api')`, `ai_session_id` (nullable), `approval_id`
(nullable, the AI approval that authorized it), `status ('queued'|'submitted'|'succeeded'|'failed')`,
`vendor_action_id, payload jsonb, error text, requested_at, submitted_at, completed_at`. Not
append-only (status advances), so not in `AUDIT_ADMIN_REQUIRED_TABLES`; every transition also
writes `audit_logs` via the normal audit path.

No history table in v1 (health history is a later ask). No webhook-event table: webhooks are
hints (§4.8), so there is nothing to dedupe beyond the detection upsert.

Normalized value sets are exported as tuples from `packages/shared/src/types/edr.ts` and enforced
with `CHECK` constraints (not pg enums — `ALTER TYPE ADD VALUE` has transaction restrictions and a
new vendor's odd status should map to an existing bucket, not grow the enum).

### 4.3 Adapter interface

The backup interface (`BackupProviderAdapter`) is three methods over one credential. EDR needs
more, because vendors differ on four axes the research surfaced: (1) tenant model — one partner
credential sees every customer (Sophos Partner, GravityZone MSP, ESET/ThreatDown/WithSecure MSP
consoles, S1, Huntress) vs one credential per customer tenant (Defender via Graph, likely
Emsisoft); (2) per-tenant routing — Sophos returns a different API host per tenant; (3) push vs
poll; (4) very different response-action sets. So the interface is small but capability-flagged.

```ts
export const EDR_ACTIONS = [
  'isolate', 'unisolate', 'scan', 'update_agent',
  'kill_process', 'rollback', 'resolve_detection', 'mark_false_positive',
  'quarantine_restore', 'quarantine_delete',
] as const;
export type EdrActionKey = (typeof EDR_ACTIONS)[number];

/** Targets are discriminated: an endpoint, a detection, a process and a quarantine item are not
 *  interchangeable, and each action accepts exactly one target kind. */
export type EdrActionRequest =
  | { action: 'isolate' | 'unisolate' | 'scan' | 'update_agent'; target: { kind: 'endpoints'; vendorEndpointIds: string[] } }
  | { action: 'kill_process'; target: { kind: 'process'; vendorEndpointId: string; pid: number } }
  | { action: 'rollback' | 'resolve_detection' | 'mark_false_positive'; target: { kind: 'detection'; vendorDetectionId: string } }
  | { action: 'quarantine_restore' | 'quarantine_delete'; target: { kind: 'quarantine_item'; vendorItemId: string } };
/** Every request carries a Breeze-generated idempotency key (the edr_actions row id), passed to the
 *  vendor where the API supports one and used to reconcile a crash between vendor acceptance and
 *  saving the handle (dispatch never blindly retries a consequential action). */

export interface EdrCapabilities {
  /** 'partner': one credential enumerates many customer tenants. 'single': the credential IS one tenant. */
  tenantModel: 'partner' | 'single';
  /** Does listTenants return a per-tenant API host that later calls must use (Sophos)? */
  perTenantHost: boolean;
  /** 'poll' only, or the vendor can push (webhook / push-event service) as a sync hint. */
  detectionDelivery: 'poll' | 'poll_and_push';
  /** Actions the adapter implements. Per-endpoint support is further narrowed by supportsAction(). */
  actions: readonly EdrActionKey[];
  /** Identifiers the vendor endpoint list reliably carries (drives device matching). */
  endpointIdentifiers: readonly ('hostname' | 'fqdn' | 'mac' | 'serial' | 'ip')[];
  /** How the adapter supplies an installer for #6960 / builtin packages. */
  installer: 'none' | 'static_url_with_token' | 'api_generated_link';
  /** Vendor request budget the sync scheduler must fit inside (Sophos: 1,000/h per credential). */
  requestBudget: { perSecond?: number; perMinute?: number; perHour?: number };
  /** Default poll cadence; the scheduler may lengthen these to fit requestBudget. */
  defaultIntervals: { detectionsMinutes: number; endpointsMinutes: number };
  /** Max endpoints per vendor action call (WithSecure 5, GravityZone 1,000). */
  maxActionTargets: number;
}

export interface EdrAdapterContext {
  creds: unknown;                 // already decrypted + validated by credentialsSchema
  baseUrl: string | null;
  region: string | null;
  fetch: GuardedFetch;            // urlSafety safeFetch pinned to the adapter's host allowlist
  /** In-process only; keyed by (connection id, credential version, tenant id | null) — some
   *  vendors mint a token per tenant (CrowdStrike member_cid, Defender per tenant). */
  tokenCache: EdrTokenCache;
  /** Shared per-connection limiter enforcing capabilities.requestBudget across tenants and jobs. */
  limiter: EdrRateLimiter;
}

export interface EdrProviderAdapter {
  readonly key: EdrProviderKey;
  readonly label: string;
  readonly credentialsSchema: z.ZodTypeAny;
  readonly capabilities: EdrCapabilities;
  /** Hostname suffixes this adapter may ever call, including per-tenant hosts. */
  readonly hostAllowlist: readonly string[];

  testConnection(ctx: EdrAdapterContext): Promise<EdrTestResult>;
  /** All tenants visible to the credential; ALL-OR-NOTHING. 'single' adapters return exactly one. */
  listTenants(ctx: EdrAdapterContext): Promise<VendorEdrTenant[]>;
  /** ALL-OR-NOTHING for one tenant: throws EdrProviderRequestError if any page fails. */
  listEndpoints(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef): Promise<VendorEdrEndpoint[]>;
  /** Incremental from an opaque cursor; returns the new cursor. First run uses a bounded lookback. */
  listDetections(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, cursor: string | null):
    Promise<{ detections: VendorEdrDetection[]; cursor: string | null }>;

  /** Present iff capabilities.actions is non-empty. */
  performAction?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, req: EdrActionRequest,
    idempotencyKey: string):
    Promise<EdrActionResult>;        // { status: 'succeeded' } | { status: 'submitted', vendorActionId } | throws
  supportsAction?(endpoint: VendorEdrEndpointRef, action: EdrActionKey): boolean;
  /** Required iff performAction can return 'submitted' (an async task/job handle — true of every
   *  researched vendor's isolate/scan). Polled by the sync job. Must distinguish a terminal vendor
   *  failure (action failed) from a transient failure to fetch status (retry, action unchanged). */
  getActionStatus?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, vendorActionId: string):
    Promise<EdrActionResult>;
  /** Optional targeted re-fetch of specific detections, used when a webhook hint names them.
   *  Adapters without it fall back to an immediate tenant-scoped listDetections. */
  getDetections?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, vendorDetectionIds: string[]):
    Promise<VendorEdrDetection[]>;

  /** Present iff detectionDelivery === 'poll_and_push'. Pure, constant-time; no DB. */
  verifyWebhook?(req: RawWebhookRequest, secret: string): { ok: true; hints: EdrWebhookHint[] } | { ok: false; error: string };
  /** Present iff installer !== 'none'. */
  getInstaller?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef & { installerSecret: string | null },
    platform: 'windows' | 'macos' | 'linux'): Promise<EdrInstallerSpec>;
}
```

`EdrProviderRequestError { code, reauth, scope, retryAfterMs? }` extends the backup
`ProviderRequestError` contract: `reauth` comes from the vendor's own signal (401 on the token
endpoint, a permission error code), never a message substring, because conflating "credential dead"
with "call failed" either spams a dead connection forever or disables a healthy one on a transient
500. `scope: 'connection' | 'tenant' | 'operation'` is new: a child tenant whose access was revoked or
whose licence lacks a module (GravityZone isolation needs an incidents licence) fails **that tenant**
(or that operation) — it must never flip the whole partner connection to `reauth_required`.

Detection cursors are opaque per adapter but must satisfy a written contract, tested with fixtures:
overlapping windows (re-reading the boundary is safe because upserts are idempotent), cursor expiry
(→ bounded re-backfill, not a silent gap — Sophos SIEM's 24 h horizon is the canonical case), a page
failure mid-delta (→ cursor not advanced), and **status changes on already-seen detections** (the
adapter either returns updated records in the delta, e.g. by `updatedAfter`, or the framework
re-reads open detections on the inventory cadence — each adapter declares which).

Registry: `EDR_PROVIDER_KEYS = ['sophos', ...] as const` and `getEdrProvider(key)` that throws on
an unknown key (through an `isEdrProviderKey` membership test, never a bare object index — the
`__proto__` guard in `backupProviders/registry.ts`). The registry is the only list of vendors in
the API; consumers that need exhaustiveness (`EdrProviderKey` in shared types, the incidents feed
`source` enum, the installer CHECK) derive from it and are guarded by a unit test that fails when a
key is added to one and not the others.

**Defender (#4620) fit check — fits the shape, not unchanged.** Defender for Endpoint is
per-customer-tenant (Graph `security/alerts_v2` + the MDE machine-actions API; Graph cannot isolate)
and its credential in Breeze would be an existing `m365_connections` consent, which is org-owned.
`tenantModel: 'single'` and a `credentialsSchema` of `{ m365ConnectionId }` (a reference, not a
secret) cover the shape, but the Defender plan must add: resolving the reference in a short DB phase
that validates partner/org/tenant ownership and binds the consent generation (fields already on
`m365_connections`), and a token cache keyed by audience/scope as well as tenant (Graph vs
`api.security.microsoft.com`). Recorded so W01 adds no "one secret blob per connection" assumption
anywhere else — the only W01 obligation is that `credentialsSchema` is opaque to the framework.

### 4.4 Sync job (`jobs/edrProviderSync.ts`)

Copied in shape from `backupProviderSync.ts`, which already honours the #1105 / #1896 rule (no
pooled DB connection held across vendor HTTP):

- Queue `edr-provider-sync`; repeatable `sync-all` every 5 min selects due work
  (`is_active AND status <> 'reauth_required'` and past the per-stream due time) under
  `withSystemDbAccessContext`. Every enqueue from a request path runs under `runOutsideDbContext`.
- **Coordination, not bare job-id coalescing.** `addUniqueJob` returns an in-flight job without
  merging the new payload (`services/bullmqUtils.ts:51`), so a webhook hint arriving mid-poll would be
  dropped. Pending hints are recorded durably per connection (a Redis set of hinted tenant/detection
  ids, plus `edr_tenants.pending_hint_at`), and the job reads-and-clears them at start and again
  before exit, re-enqueuing itself if new hints arrived. Inventory, detections and action-status
  polling are separate job types with separate job ids, serialized per connection by the advisory
  lock, each writing only its own `last_*_sync_*` columns so one healthy stream cannot mask a
  failing one.
- **Phase 1** (short system tx): load + decrypt connection, mark `running`.
- **Phase 2** (`runOutsideDbContext`, no DB): `listTenants`, then per tenant `listEndpoints`
  (inventory job) or `listDetections(cursor)` (detections job). Tenant fetches run with bounded concurrency (default 2, per-adapter
  override for strict vendors). A tenant whose fetch fails is recorded as failed and **skipped** —
  its existing rows are left untouched, not deleted. This is the key difference from Cove, whose
  whole subtree is one call: EDR vendors page per tenant, and one bad tenant must not wipe another's
  inventory or block the rest.
- **Phase 3** (one system tx per connection, `pg_advisory_xact_lock(hashtext('edr_provider:'||id))`):
  re-read the connection `FOR UPDATE` (abort if deleted/deactivated/credentials changed since
  phase 1); upsert tenants; a tenant absent from `listTenants` is marked `vendor_missing_since`
  and **tombstoned, never hard-deleted by sync** — its detections and action evidence survive a
  vendor-side glitch, a licence lapse or a customer offboarding (its endpoints are deleted after 7
  days missing; detections/actions follow D11 retention); auto-map; for each **successfully
  fetched, mapped** tenant upsert endpoints with `org_id = mapping.org_id`, delete vanished
  endpoints, upsert detections (never delete — detections close via status), advance
  `detection_cursor` only for that tenant; run device matching; write counters.
- **Phase 4** (after commit, idempotent): emit events and create alerts for new/escalated
  detections and newly unhealthy / unprotected linked endpoints. It evaluates **persisted rows**
  (`edr_detections` whose severity/status differs from `notified_severity`), not the fetched delta,
  and records publication by setting `notified_severity` — because the cursor already advanced in
  Phase 3, a delta-driven retry would never see a failed event again (backup's evaluator re-reads
  persisted inventory for the same reason, `backupProviders/alerts.ts:180`). Never inside the
  inventory transaction (`createSourcedAlert` publishes).
- Failure handling identical to backup: `reauth` → `UnrecoverableError` + `reauth_required`;
  other → `error` + BullMQ retry with backoff. Rate-limit responses (429 / vendor code) honour
  `Retry-After` and are **not** reauth.
- Worker registered in `workerRegistry.ts` (`placement: 'global'`) and
  `workerReadinessManifest.ts`.
- Detection cursors: the first sync of a tenant uses a bounded lookback (default 30 days,
  per-adapter cap where the vendor limits history — Sophos SIEM `/events` and `/alerts` only reach
  back 24 h, so the Sophos adapter reads the Common `alerts` API (and Detections v1 where licensed)
  and must never rely on SIEM for catch-up *(verify exact filter params in the W01 plan)*).
- **Two cadences, one budget.** Detections and endpoint inventory are separate job types on the
  same queue (`sync-detections`, `sync-inventory`) with separate due-times per connection, both
  drawing from `EdrRateLimiter`: Redis token buckets at **overlapping scopes** — a credential
  fingerprint (hash of vendor account id + client id, so two connections sharing one credential share
  one budget; vendors meter per credential/account/IP), per-tenant or per-CID where the vendor meters
  that way, and per-operation class (GravityZone scan/quarantine tasks 30/min, push settings 5/min),
  with hourly and daily windows where published. Token acquisition, pagination and action-status
  polls all count. Capacity is reserved for actions so polling cannot starve them, with a polling
  floor so actions cannot starve it either. When a connection's tenant
  count makes the defaults exceed `requestBudget`, the scheduler lengthens the intervals and shows
  the effective cadence on the connection card rather than tripping 429s. Actions take priority
  over polling within the budget.

### 4.5 Tenant auto-mapping

Reuse `services/backupProviders/mapping.ts` **as it is today**, including the restriction it
added deliberately: only an external code commits automatically — a vendor field whose **entire
trimmed value** is a Breeze org uuid → `auto_external_code` (`resolveCustomerAutoMappings`,
`mapping.ts:230-265`). A normalized-name match is **never** written automatically; it is surfaced as
a suggestion that a user passing `canManagePartnerWidePolicies` confirms through the manual remap
path (`resolveCustomerAutoMapNameSuggestions`). Auto-name mapping was removed from the backup
framework because renaming an org to match an unmapped vendor customer silently captured that
customer's inventory on the next sync — for EDR it would capture another customer's detections.
An org is claimed by at most one tenant per pass. Manual choices (`manual`, `manual_unmapped`) are
never overwritten. `mapping_source` therefore has no `auto_name` value. Extract the pure functions
into `services/externalTenantMapping.ts` shared by both frameworks (W01), backup tests moved
alongside and unchanged.

**Unmap / remap / disconnect semantics** differ from backup on purpose. Backup's remap deletes the
customer's device rows before changing ownership (`mapping.ts:123`) — acceptable for backup status,
destructive for security history. Repointing history to the new org would instead disclose one
customer's incidents to another. Proposal (D13): on unmap/remap, detections and actions stay
**tombstoned under the old org** (rows keep their `org_id`, flagged `detached_at`); endpoints are
deleted and re-created under the new org on the next sync.

### 4.6 Device matching

Extract the pure resolver in `services/backupProviders/deviceMatching.ts`
(`resolveDeviceMatches`: same-org candidates → exactly one hostname/display-name match →
`auto_hostname`; several → MAC intersection → `auto_mac`; else ambiguous; claimed devices make the
row ambiguous; deterministic ascending-id processing) into `services/externalDeviceMatching/`
and parameterize the candidate loader and link writer by table. Two EDR-specific extensions, both
additive to the pure function:

1. **Serial tiebreak.** Where the adapter lists `serial` in `endpointIdentifiers`, a serial match
   against `device_hardware.serial_number` wins over MAC in the multi-candidate case
   (`auto_serial`). Serial is only a tiebreak, never a sole key — VMs and whitebox machines share
   or blank serials.
2. **FQDN normalization.** Strip the domain suffix before hostname comparison (GravityZone reports
   FQDNs; Emsisoft reports name + domain separately), and compare against both `hostname` and the
   short name.
3. **Identifier-poor vendors are surfaced, not guessed.** Emsisoft exposes no IP, MAC or serial, so
   a same-org hostname collision stays ambiguous — there is no tiebreak — and is listed for manual
   linking. The matcher never falls back to cross-org or fuzzy matching.

Hostname/IP-only matching (today's S1/Huntress behaviour) is not reused. Manual override:
`PUT /edr/endpoints/:id/link { deviceId | null }` — the composite FK rejects a device outside the
row's org; the route turns that into a 422.

### 4.7 Incidents feed — one generic leg

`routes/incidents.helpers.ts` gets a fourth leg over `edr_detections` with
`source = edr_detections.provider` and `sourceId = edr_detections.id::text`, gated identically
(`hasDevicesRead`, `siteDevicePredicate(breeze_device_id)`, not already promoted). Two
refactors land with it:

- **Replace the nested ternary with a leg list folded pairwise through `unionAll`.** The existing
  comment says a dynamic spread loses Drizzle's table-name union type; the result is already typed
  `any` (`const baseQ: any`), so a fold loses nothing real and turns "add a vendor" from an
  exponential ternary edit into one list entry. A unit test enumerates every include-combination.
- **`source` filter becomes `'breeze' | 'huntress' | 's1' | EdrProviderKey`**, derived from the
  registry. Using the detection's own uuid as `sourceId` makes `(source, sourceId)` a complete key for
  the new leg, closing the tie-break caveat documented at the ORDER BY for this leg.

Promotion to a tracked incident uses `incidents.source_type = 'edr_detection'` and
`source_ref = edr_detections.id` (globally unique, unlike the vendor id the legacy legs use);
`incidents.validation.ts` `sourceType` gains `'edr_detection'`.

**Null-device findings.** The existing site predicate lets findings with no device through
(`incidents.helpers.ts:245`) — correct for a vendor alert that never matched a device. Under D4 a
device org-move detaches the link, which would turn a formerly site-restricted finding into a
null-device one visible to every site in the old org. The generic leg therefore distinguishes
"never linked" from "detached" (`edr_detections.device_detached_at`) and keeps detached findings
behind the site predicate of the device they were last linked to (D14).

#3695 (local Defender detections): the choice between a separate feed leg and a connection-less
pseudo-provider writing `edr_detections` is **deferred to #3695's own spec** — a nullable
`connection_id` would change framework invariants (composite FKs, rate scopes, the partner-admin
gate), and a separate leg is an equally valid design. W01 only avoids making the feed query depend
on anything #3695 could not supply.

### 4.8 Webhooks / push

Route `POST /edr/webhook/:connectionId` (public, no user auth). Rules, stricter than today's
Huntress receiver:

1. Resolve the connection by path id (uuid-validated) under system context; 404 on miss.
2. Mandatory secret: no configured secret → 403 (as Huntress does today). Verification is the
   adapter's `verifyWebhook` (HMAC + timestamp window for vendors that sign; a bearer/header secret
   Breeze generates for vendors that only support a static auth header — GravityZone's push service
   sends the `Authorization` string configured in `setPushEventSettings`; its own
   `Event-Push-Service-Md5` header is `md5(apiKey + md5(body))` and is ignored as an authenticator).
   Constant-time compare.
3. **The payload is a hint, not data.** The handler extracts only `{ vendorTenantId?,
   vendorDetectionId? }` hints, records them durably (§4.4 coordination) and enqueues the detections
   job, which uses `getDetections` for named ids or a tenant-scoped delta otherwise. Latency is "next
   available budget slot", not a promised number of seconds. The
   sync then fetches the authoritative record from the vendor API. A forged-but-signed or replayed
   payload can at worst cause an extra poll; it can never write a detection whose content Breeze
   did not fetch itself. This also removes per-vendor ingest parsers from the public surface.
4. Rate-limited per connection; body size capped.

For Bitdefender, W04 registers the push endpoint through `setPushEventSettings` when the MSP opts
in; polling remains the source of truth either way. Long-lived stream transports (CrowdStrike Event
Streams, a Defender Event Hub) are **not** forced through `verifyWebhook`; if added later they are an
optional transport feeding the same hint mechanism.

### 4.9 Credentials, hosts and SSRF

- `edr_connections.credentials_encrypted`, `webhook_secret_encrypted` and
  `edr_tenants.installer_secret_encrypted` are registered in `encryptedColumnRegistry.ts` with
  `aadBinding: 'row'` (a ciphertext copied to another partner's row does not decrypt). No route
  ever returns them; the credentials PATCH accepts write-only fields and resets `status`.
- `credentialsSchema` per adapter validates the blob before encryption (Sophos: `clientId,
  clientSecret`; GravityZone: `apiKey`; Emsisoft: per D9).
- Every adapter declares `hostAllowlist` (e.g. Sophos `['.central.sophos.com', 'id.sophos.com']`,
  GravityZone `['.gravityzone.bitdefender.com']`). All vendor HTTP goes through
  `urlSafety.safeFetch` with that allowlist; `ssrfGuard` validates any operator-supplied
  `base_url` in `strict-https` mode with the same allowlist at save time. **Vendor-returned hosts**
  (Sophos per-tenant `apiHost`) are validated against the same allowlist before being stored in
  `edr_tenants.api_host` and again at connect time — a compromised or spoofed whoami response must
  not be able to point the worker at an internal address.
- Tokens (OAuth access tokens) are cached in-process only, keyed by (connection id, `updated_at`,
  tenant, audience), never persisted, never logged; `logRedaction.ts` gains the credential field
  names.
- **Route gates.** Reads of connections/tenants: a `resolveProviderPartnerId`-style gate (org scope →
  403). **Every write** — create/rotate/delete a connection, map/unmap/remap a tenant, confirm a name
  suggestion, set the webhook secret — additionally requires `canManagePartnerWidePolicies` (the
  `requireProviderPartnerAdmin` gate in `routes/backup/providerAccess.ts`), because each takes effect
  for every org under the partner, including orgs a selected-org technician cannot see. A negative
  test for a selected-org partner user is required for each write route.

### 4.10 Response actions, audit and AI guardrail tiers

`POST /edr/actions` `{ action, endpointId? , detectionId?, reason? }` →
`dispatchEdrAction()`:

1. Resolve the endpoint/detection under the caller's RLS context (org access + `hasDeniedDeviceSite`
   site restriction, same as `/s1/isolate`).
2. Capability check: adapter declares the action and `supportsAction(endpoint)`; else 422
   `unsupported` (and a row with `status='unsupported'` is **not** written — nothing happened).
3. Insert `edr_actions` (`queued`) + `audit_logs`, commit. The row id is the idempotency key.
4. Call `performAction` under `runOutsideDbContext`; write `submitted`/`succeeded`/`failed`.
   Async vendor actions are polled by the action-status job via `getActionStatus`. A row left
   `queued` by a crash is **reconciled, not retried**: the status job asks the vendor (by idempotency
   key, or by the endpoint's current state — e.g. already isolated) and otherwise marks it `failed`
   for a human to re-issue; it never re-sends isolate/kill/rollback on its own.
5. Batch requests are split to `maxActionTargets`; one `edr_actions` row per target.

Gates: `devices.execute` + `requireMfa()` for all actions (the S1 bar); partner or org scope.
`unisolate`, `rollback` and `resolve_detection`/`mark_false_positive` are equally gated — releasing
containment and closing a detection are as consequential as imposing it.

**AI tiers** are keyed by normalized action, not by vendor, in `aiGuardrails.ts`, reproducing the
current S1 decisions (`aiGuardrails.ts:419-491`, `:819`): `isolate` = Tier 3 **supervised** — it
goes through the supervised authorization path but does not wait for a second approver (urgent
protective action); `unisolate` / `rollback` / `mark_false_positive` / `resolve_detection` /
`quarantine_restore` = Tier 3 four-eyes; `kill_process` / `quarantine_delete` = Tier 3 supervised
(as S1 kill/quarantine today); `scan` / `update_agent` = Tier 2. **Any normalized action without an
explicit tier entry fails closed** (a unit test enumerates `EDR_ACTIONS` against the tier map). A new
vendor never gets a weaker tier by arriving through a new adapter. Every AI-initiated action writes
`requested_via='ai'`, `ai_session_id`, `approval_id`.

`edr_actions.requested_by → users` is a user-owned write, so each generic action tool/action pair is
registered in the user-owned-action release list in `jobs/intentReleaseWorker.ts` (where
`s1_isolate_device:` and `s1_threat_action:*` sit today, ~`:893`) — an AI-agent principal must never
land an agent id in a users FK.

### 4.11 AI tools

Generic tools, provider resolved from data, never chosen by the model:
`get_edr_status` (connections, coverage, per-org health; Tier 1), `list_edr_detections` (filters:
org, device, severity, status, provider; Tier 1), `edr_endpoint_action` (`action` enum restricted to
endpoint actions; Tier by action), `edr_detection_action` (detection actions), `sync_edr_data`
(Tier 2). Each needs entries in `aiTools.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts`,
`aiToolRateLimits.ts`, `aiAgentSdkTools.ts`, `mcpCoverage.ts`, `agentToolCatalog.ts`, golden tasks,
and respects the description-budget and line-keyed `SAFE_WRITE_SITES` contract tests (known trap).
The existing seven S1/Huntress tools stay as they are until the legacy migration (D2) ships —
coexistence lasts until then, not a fixed release. Tool descriptions alone do not stop a model
reporting partial coverage as "no threats", so `get_edr_status` and `list_edr_detections` responses
**state which providers they covered** for the org, flag stale tenants (`last_sync_at` older than 2×
cadence), and point at `get_s1_threats` / `get_huntress_incidents` when the org also has a legacy
mapping. See D6.

### 4.12 Web UI

- **Integrations → Security:** an "EDR providers" section listing connections as cards
  (pattern: `BackupProviderConnectionCard.tsx`), "Add connection" → provider picker from
  `GET /edr/providers` (key, label, credential field descriptors, capabilities). Tenant mapping table
  with auto-map badges and a manual picker. S1 and Huntress cards remain as they are.
- **Security → EDR:** a third tab, "Other EDR" → renamed to the provider label when exactly one
  generic provider is connected, listing `edr_detections` with provider badge; the two legacy tabs
  remain (`2026-06-25` D1 per-vendor tabs is preserved for legacy vendors; the generic tab is one
  view for all framework vendors).
- **Device → Security → Endpoint protection (`DeviceEdrPanel.tsx`):** a generic section when the
  device has a linked `edr_endpoints` row: vendor, health, isolation state, last seen, open
  detections, and action buttons rendered from the adapter's capabilities (hidden when unsupported,
  disabled-with-reason when the endpoint does not support it). All mutations through `runAction`.
- **Unlinked / ambiguous endpoints** list per connection with the manual link picker.
- **Portal:** `portalVisibility` gains a vendor-neutral `edr` count; `portal/securityReadModel.ts`
  and `protection.ts` read `edr_endpoints` generically (vendor name hidden unless the connection
  opts in, D5-of-Cove precedent).
- Settings rule 9 (one concept, one home): EDR connections live only under Integrations → Security.

### 4.13 Installers and the #6960 hook

- `BuiltinProvider` becomes `'huntress' | 'sentinelone' | EdrProviderKey`-with-installer; the
  `software_catalog.integration_provider` CHECK is replaced in the adapter's wave with the extended
  list (fix-forward migration, idempotent drop-and-re-add).
- `edrInstallerResolver.ts` becomes a dispatch map with an **exhaustive switch that throws** on an
  unknown provider — closing today's fall-through where any non-Huntress value resolves as S1.
  **Tenant selection must be unambiguous:** with multiple connections (D3) and multiple tenants per
  org, `{provider, orgId}` can match several tenants. The catalog item or config-policy binding names
  the tenant explicitly when more than one matches; otherwise the resolver returns an ambiguity error
  ("Organization maps to 2 Sophos tenants — choose one"). Never `limit(1)`.
  Framework providers resolve through `adapter.getInstaller(tenant, platform)`, returning
  `{ downloadUrl, args, sha256? }` with the same failure strings the Huntress path uses
  ("Organization not mapped to Sophos", "Sophos integration is disconnected").
- #6960's "Security agents" config-policy feature enumerates installable agents from
  `listEdrProviders().filter(a => a.capabilities.installer !== 'none')` plus the two legacy
  vendors, and its coverage reconciliation compares `edr_endpoints` (vendor view) with agent-side
  `mgmtdetect` presence (device view). No part of #6960 is built here.

### 4.14 Agent-side detection additions

`agent/internal/mgmtdetect/signatures.go` recognises CrowdStrike, SentinelOne, Sophos, Bitdefender,
Malwarebytes, Carbon Black, Huntress and Defender. Add signatures (Windows service + process +
install path; macOS app/process where the vendor ships one) for **ESET, Emsisoft, Webroot,
ThreatDown** (Malwarebytes' business brand — extend the Malwarebytes signature's process/service
names rather than a new vendor), **WithSecure / F-Secure**, and **Trend Micro**. Extend
`agent/internal/security/status.go` `providerFromName` with `emsisoft`, `webroot`, `withsecure`
(matching `f-secure` too), `trend_micro`, `huntress`; order-sensitive cases (the existing
Bitdefender-before-Defender rule) get table tests. The `security_provider` pg enum needs
`ALTER TYPE security_provider ADD VALUE IF NOT EXISTS` for each new value — in its own migration,
since a value added in a transaction cannot be used in that same transaction. This wave is
agent-shipped code (needs an agent release) and independent of every API wave.

## 5. Tenancy and data-model impact

| Table | Shape | RLS policies | `org_id` cascade list | Merge policy | Export policy | RLS allowlists | Device lists |
|---|---|---|---|---|---|---|---|
| `edr_connections` | 3 partner-axis, **no org_id** | 4 × `breeze_has_partner_access(partner_id)` | — (erased by `cascadeDeletePartner`'s partner_id sweep) | — | — | `PARTNER_TENANT_TABLES` | — |
| `edr_tenants` | 3 partner-axis + nullable `org_id` mapping target | 4 × partner access; INSERT/UPDATE `WITH CHECK` re-checks parent connection's partner | `CORE_ORG_CASCADE_DELETE_ORDER` | `repoint` (no org-scoped unique key) | `tablePolicy('org_id')` — `installer_secret_encrypted` → `excludedSensitive` | `PARTNER_TENANT_TABLES` **and** `ORG_AXIS_POLICY_EXCLUDED_TABLES` (dual-list trap, as `backup_provider_customers`) | — |
| `edr_endpoints` | 1 direct org_id | 4 × `breeze_has_org_access(org_id)` | yes | `repoint` | `vendor_raw` → `excludedOpen` | auto-discovered | none (uses `breeze_device_id`); `cascadeDelete.test.ts` contract case pinning the name; org-move detach in `moveDeviceOrgInTransaction.ts` |
| `edr_detections` | 1 | 4 × org access | yes | `repoint` | `details` → `excludedOpen`; `mitre_techniques` text[] → `included` | auto-discovered | same as above |
| `edr_actions` | 1 | 4 × org access | yes | `repoint` | `payload` → `excludedOpen` | auto-discovered | same as above |

Required in the same PR as the migration (CLAUDE.md steps 1–4; the org cascade list and both
export-policy suites only fail under **Integration Tests**, the merge registry only in the **full**
Test API suite):

1. `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`), alphabetical:
   `edr_actions`, `edr_detections`, `edr_endpoints`, `edr_tenants`. FK direction: actions →
   detections/endpoints, detections → endpoints, endpoints → tenants — alphabetical happens to be
   children-before-parents here; every intra-framework FK carries an explicit `ON DELETE CASCADE`
   or `SET NULL (col)` so position is determinism, not correctness. Verify against
   `topologicalCascadeOrder()` in the test, do not assume.
2. `services/orgMergeRegistry.ts`: `repoint` for all four org_id tables. Every composite FK onto an
   `org_id` — `(org_id, partner_id) → organizations`, `(tenant_id, org_id)`, `(endpoint_id,
   org_id)`, `(breeze_device_id, org_id) → devices(id, org_id)` if used — is `DEFERRABLE INITIALLY
   IMMEDIATE`. No unique key is org-scoped, so no `repoint-dedupe`.
3. `services/tenantExportPolicyRegistry.ts` `CORE_TENANT_EXPORT_POLICY`: every column of all four
   classified; every jsonb → `excludedOpen`; every `*_encrypted` → `excludedSensitive`; any
   column whose name hits `SUSPICIOUS_NAME_PARTS` (e.g. `detection_cursor` does not; `installer_secret_*`
   does) classified deliberately.
4. `rls-coverage.integration.test.ts`: `PARTNER_TENANT_TABLES` (`edr_connections`, `edr_tenants`),
   `ORG_AXIS_POLICY_EXCLUDED_TABLES` (`edr_tenants`).
5. `encryptedColumnRegistry.ts`: three columns, `aadBinding: 'row'`.
6. `routes/devices/cascadeDelete.test.ts`: a contract case pinning `breeze_device_id` (so a
   future rename to `device_id` fails loudly), and the `ON DELETE SET NULL (breeze_device_id)`
   `confdelsetcols` assertion in the new `edrProviderRls.integration.test.ts`.
7. Not applicable, stated so no one adds them: `CORE_DEVICE_CASCADE_DELETE_TABLES`,
   `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (no `device_id` column), `TICKET_ORG_DENORMALIZED_TABLES`
   (no `ticket_id`), `AUDIT_ADMIN_REQUIRED_TABLES` (not append-only), `DUAL_AXIS_TENANT_TABLES` /
   partner-wide SELECT branch (connections are partner-only credentials, not an org-XOR-partner
   config table — Partner-Wide First does not apply; the Cove precedent).
8. New `edrProviderRls.integration.test.ts`: cross-partner forge on connections/tenants → 42501;
   `edr_tenants` with an org of another partner → composite FK 23503; org-token cannot read
   another org's endpoints/detections/actions; org-token cannot read connections/tenants at all.
9. Any migration that writes rows (backfills, the later S1/Huntress port) elects system scope first
   (`SELECT set_config('breeze.scope','system',true)`) — `migrationRlsScope.test.ts`.
10. `jobs/intentReleaseWorker.ts`: register every generic action tool/action pair that writes
    `edr_actions.requested_by` (§4.10).
11. `pnpm db:check-drift` clean; migration file named to sort after the newest committed migration
   (check at authoring time; do not assume today's date sorts last).

Retention: detections are never deleted by sync; a retention job prunes `resolved`/`dismissed`
detections older than D11's window. Actions are kept with detections.

## 6. SentinelOne and Huntress

| Option | What | Cost | Risk |
|---|---|---|---|
| **A. Leave as-is** | Legacy tables, routes, tools stay forever; consumers carry "legacy legs + one generic leg" | Lowest now; permanent 3-way branching in ~10 consumers | Two ways to do everything, forever; new consumers forget the generic leg or a legacy leg |
| **B. Leave now, migrate later (recommended)** | Framework ships with new vendors only. After two framework adapters are in production, port S1 then Huntress as adapters in a separate feature: backfill `s1_*`/`huntress_*` into `edr_*`, dual-read for one release, then drop legacy legs and tables | Moderate, deferred; migration is a well-defined project with the interface already proven by three vendors | Migration touches the richest action surface (S1 kill/quarantine/rollback, Huntress webhook) and AI guardrail keys — doing it last means doing it against a stable interface |
| **C. Backfill now** | W01 also migrates S1 + Huntress rows into the generic tables with dual-read | Highest up-front; doubles W01 blast radius (5 legacy tables, 6 AI tools, `incidents.source_type` rewrite, cascade/export/merge re-registration, webhook re-point) | Framework interface shaped around two legacy integrations' quirks instead of the three new vendors; a regression in production S1/Huntress (paying users) to ship Sophos |

Concrete backfill mechanics for B's later feature, so the choice is informed: `s1_org_mappings` →
`edr_tenants` (registration token → `installer_secret_encrypted` via decrypt/re-encrypt with the
new row AAD), `s1_agents` → `edr_endpoints` (`device_id` → `breeze_device_id` with
`device_match_source` = `auto_hostname`), `s1_threats` → `edr_detections`, `s1_actions` →
`edr_actions`, `incidents.source_type 's1_threat'` → `'edr_detection'` with `source_ref` rewritten
to the new uuid; AI tools aliased (`get_s1_threats` → `list_edr_detections provider=sentinelone`)
for one release, then removed; `eventBus` legacy event types kept as aliases for automations that
subscribe to them.

## 7. Proposed waves

Each wave is independently mergeable; W01–W03 is the minimum for Sophos to be useful.

| Wave | Content | Depends on | Blast radius |
|---|---|---|---|
| **W01 — Framework core + Sophos read path** | Migration (5 tables, RLS, all §5 registrations), `edrProviders/{types,registry,normalize,persist}`, extracted tenant-mapping + device-matching modules (backup tests keep passing), sync job, `/edr` connection/tenant/endpoint/detection routes, Sophos adapter read side (`testConnection`, `listTenants` with per-tenant host, `listEndpoints`, `listDetections`), recorded-fixture client tests, `edrProviderRls.integration.test.ts` | — | High (tenancy, migration, credentials) — full rigor, advisor-reviewed plan |
| **W02 — Surfacing** | Generic incidents-feed leg + ternary refactor + `edr_detection` promotion, EDR page tab, `DeviceEdrPanel` generic section (read), Integrations cards + mapping UI, portal/readiness/report consumers, events + alerts | W01 | Medium |
| **W03 — Actions + AI** | `edr_actions` dispatch, MFA/permission gates, Sophos isolate/unisolate/scan, generic AI tools + guardrail tiers keyed by action, webhook route (`verifyWebhook` framework; Sophos has none — delivered empty) | W01 | High (remote actions, AI guardrails) |
| **W04 — Bitdefender GravityZone adapter** | JSON-RPC client, companies → tenants, endpoints, incidents/quarantine → detections, isolate/restore, push-event opt-in, installer links | W01 (+W03 for actions) | Medium — adapter only if the interface held |
| **W05 — Emsisoft adapter** | Per D9: cloud EMC workspaces → tenants, devices (hostname+domain matching), incidents → detections, scan / quarantine / verdict actions, installer token; no isolation | W01 (+W03 for actions) | Low–medium |
| **W06 — Installer registry + #6960 hook** | Resolver dispatch map with throwing default, CHECK extension, Sophos/GravityZone `getInstaller` | W01, adapter waves | Medium (ships to customer machines via deploy) |
| **W07 — Agent detection signatures** | `mgmtdetect` + `providerFromName` + `security_provider` enum values | none | Agent-shipped — needs an agent release; lab check on Windows VM |

Later (separate feature, D2): S1 and Huntress port. Later: Defender for Endpoint (#4620) when
un-parked; ESET / ThreatDown / WithSecure as demand appears (§3 recommendation).

## 8. Out of scope

- A SIEM / raw telemetry store or an EDR of our own (discussion #7139, OpenEDR; Elastic / Wazuh
  #4103). Detections here are vendor verdicts, not event streams.
- Vendor policy management (exclusions, policy assignment, tamper-protection toggling) beyond the
  listed actions.
- Vendor licensing / subscription billing sync (Pax8 covers distribution-side licensing).
- Porting SentinelOne and Huntress (D2 — a later feature).
- Defender for Endpoint (#4620), local Defender detections (#3695) and actions (#4621), and the
  "Security agents" auto-deploy feature (#6960) — each only has to *fit* (§4.3, §4.7, §4.13).

## 9. Open decisions

Each decision: options, trade-offs, recommendation. D1 and D2 reverse or refine recorded decisions
and need Todd's explicit sign-off; the rest can be settled in the W01 plan.

**D1 — Framework-first, or Sophos-first-then-extract?** The 2026-08-16 decision on #3135/#3136 was
"Sophos first, so the abstraction is harvested from real code, not guessed."
- **A — Sophos as a third copy-paste sibling, extract when Bitdefender lands.** Pro: honours the
  recorded decision literally; fastest first vendor. Con: ~100 file touches now, a second ~100 to
  extract, plus a data migration of `sophos_*` into generic tables — the same migration §6 defers for
  S1/Huntress, now for three vendors; the installer resolver fall-through bites the moment a third
  value exists.
- **B — Framework-first, built in lockstep with the Sophos adapter (W01 ships both).** Pro: the
  abstraction is still harvested from real code — Sophos is the first implementation and nothing
  merges that Sophos does not exercise — and it is additionally checked on paper against eight other
  vendor APIs (§3), which is the "guess" the 2026-08 decision feared, replaced by evidence. The
  backup-provider framework (#6008) proved this exact sequence (framework + Cove in one wave) in the
  same codebase a month after that decision was made. Con: W01 is larger; an interface flaw found by
  Bitdefender means an interface change with one adapter to update (cheap) rather than zero.
- **C — Framework-first with no real adapter (fake adapter only).** Con: the guessed abstraction the
  decision warned about. Rejected.
- **Recommend B.** The 2026-08-16 intent (don't guess) is met better by B than by A: A defers the
  abstraction but guarantees a migration; B builds it against a real vendor and a researched matrix.
  Caveat (Codex, accepted): Cove proves the *implementation pattern* (adapter boundary, fetch-outside-DB
  sync, registry), not multi-vendor generality — it is still the only backup adapter. So W01 builds
  only what Sophos exercises; the matrix identifies *extension points* (optional methods, capability
  flags), and nothing is implemented for a hypothetical vendor. Needs Todd's sign-off: it reverses
  the recorded 2026-08-16 sequencing.

**D2 — SentinelOne and Huntress: leave, migrate later, or backfill now?** (§6)
**Recommend B (leave now, port later as a separate feature after two framework adapters ship).**
Keeps the richest, production-used action surface out of W01's blast radius and ports it onto an
interface proven by three vendors.

**D3 — One active connection per partner per provider, or many?** S1/Huntress enforce one active
per partner; Cove allows many (unique on partner+provider+name).
- One: simpler UI, matches legacy. Many: post-acquisition MSPs with two consoles; per-customer-tenant
  vendors (Defender, likely Emsisoft, possibly ESET) *need* many.
- **Recommend many.** Per-tenant-credential vendors make it mandatory, not optional.

**D4 — Link column `breeze_device_id` (Cove precedent) or `device_id` (S1/Huntress precedent)?**
- `device_id`: joins the device cascade + org-move re-stamp machinery automatically; but that
  machinery re-stamps `org_id` from the device, which is wrong when `org_id` comes from the vendor
  tenant mapping (a moved device would drag vendor rows into an org whose tenant is not mapped there).
- `breeze_device_id`: `ON DELETE SET NULL (col)` + explicit detach on org move; consistent with the
  newest framework; needs a pinning contract case.
- **Recommend `breeze_device_id`.**

**D5 — Store endpoints of unmapped tenants?**
- Store: the mapping UI can show "this tenant has 42 endpoints named …" and matching can pre-compute.
  But rows need an `org_id` (shape 1) — a nullable org_id on a shape-1 table breaks the RLS model.
- Count only (Cove D8): `edr_tenants.endpoint_count` is enough to map; rows appear on the first sync
  after mapping.
- **Recommend count only.**

**D6 — AI tools: generic `edr_*` or per-vendor?**
- Per-vendor (`get_sophos_threats`, …): matches today; each vendor adds ~4 tools and ~8 registry
  edits; the tool list grows linearly and the model must pick the vendor.
- Generic: five tools total regardless of vendor count; provider comes from data; guardrails keyed by
  normalized action so a new vendor inherits vetted tiers; costs an overlap with the seven legacy
  tools that lasts until D2's migration ships (§4.11).
- **Recommend generic.** Tool-list size is a measured cost (#6147 cut chat context 71% partly by
  trimming tools).

**D7 — Webhook payloads: ingest, or treat as sync hints?** (§4.8)
- Ingest: lower latency by one API round trip; but every vendor parser becomes public attack surface
  and a replayed signed payload can write stale state.
- Hint + targeted fetch: detection content is always fetched by Breeze from the vendor.
- **Recommend hint + fetch.** Seconds of latency against a class of forgery bugs.

**D8 — Incidents feed `source` value: per-provider key, or a single `'edr'` source with a provider
field?**
- Per-provider (`sophos`, `bitdefender`, …): the filter dropdown lists vendors, consistent with
  `huntress`/`s1`; the zod enum derives from the registry.
- Single `'edr'`: stable API enum, but the UI needs a second filter and legacy legs stay per-vendor
  — two conventions.
- **Recommend per-provider key.**

**D9 — Emsisoft scope (#7436): cloud EMC, on-prem Enterprise Console, or defer?**
The cloud EMC has a real but narrow public API (`api.emsisoft.com`, OpenAPI published): partner
workspaces, devices (name/domain/OS only — no IP, MAC or serial), incidents with verdicts, scans,
quarantine restore/delete, false-positive marking, and an installer-token endpoint. It has **no
per-device isolation** (network lockdown is a policy-group setting) and **no event webhooks**. The
on-prem Enterprise Console has no public API that we found.
- **A — Cloud EMC, read + scan + verdict + installer, no isolation.** Pro: covers the request's
  stated needs (map workspaces, sync protection state, pull detections); installer enables #6960.
  Con: weakest device matching of any vendor; unknown rate limits; key issuance is via the partner
  manager.
- **B — Also support Enterprise Console.** No documented API — not buildable.
- **C — Defer until the requester confirms cloud.** Pro: no work on a guess. Con: the question has
  been open since 2026-09-29.
- **Recommend A, gated on the requester confirming cloud EMC** (ask via the discussion #7139 thread,
  Discord-reporter rule: do not block on a GitHub reply). Ship read-only first; add actions in the
  same wave only if the sandbox key shows they work with an API key's permissions.

**D10 — Per-tenant sync failure semantics.** A tenant whose fetch fails keeps its old rows (stale but
present) vs is marked and emptied. **Recommend keep + mark stale** (`edr_tenants.last_sync_status`),
with the UI showing "last synced N h ago" per tenant, and an alert after 24 h stale — an empty
inventory reads as "no threats", the dangerous direction.

**D11 — Detection retention.** Legacy tables never prune. Options: never; prune resolved/dismissed
after 180 days; per-partner setting. **Recommend 180 days for resolved/dismissed, open never pruned**,
no setting until someone asks (one concept, one home — a retention setting would be a new concept).

**D12 — Normalized severity/status as pg enum (Cove precedent) or `CHECK` on varchar?** Cove used a
pg enum mirrored by a shared tuple. **Recommend CHECK** — cheaper to extend (drop/re-add inside a
normal transaction) and a new vendor's odd value should map into an existing bucket, not grow the set.

**D13 — History lifecycle on unmap / remap / disconnect / vendor disappearance.** (§4.5)
- **A — Backup semantics (delete children, re-sync under new owner).** Simple; destroys security
  history and action evidence.
- **B — Repoint history to the new org.** Keeps history; discloses the old customer's incidents to
  the new org — a tenant-isolation breach by design.
- **C — Tombstone under the old org.** Detections/actions keep their `org_id` with `detached_at`;
  endpoints are deleted; the new mapping starts clean; retention (D11) eventually prunes. Connection
  delete is the one path that hard-deletes, behind a confirm that names the counts.
- **Recommend C.** Raised by Codex; I agree it is a real gap in the first draft.

**D14 — Visibility of detections whose device link was detached by an org move.** (§4.7)
- Treat as null-device (today's predicate): visible to all sites in the org — a site-restricted
  tech gains visibility they did not have.
- Keep the last-linked device's site restriction (store `last_site_id` at detach time).
- **Recommend the latter** — never widen visibility as a side effect of a move.

## 10. Test and rollout notes

- **Contract suites that only fail in Integration Tests:** the org cascade list
  (`tenantCascade.integration.test.ts`), both export-policy suites, `orgMergeRegistry.integration`,
  the org-merge "merge contract" (non-deferrable composite FK → 23503), and the RLS coverage
  contract (`DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` — its own
  config; pointing another config at it prints "No test files found"). `orgMerge.test.ts` only reds
  in the **full** Test API suite. Run all of them locally with `pnpm test-stack up` before opening
  W01, and tear the stack down after.
- **Stacked PRs get no CI** (`ci.yml` triggers on `pull_request: branches: [main]`). If W02/W03
  are stacked on W01, dispatch `gh workflow run CI --ref <branch>` per branch before merging.
- **AI tool contract traps:** description budget (300/160), line-keyed `SAFE_WRITE_SITES`,
  `mcpCoverage` entry per route, and no `z.undefined()` in any tool schema (it strips every tool).
- **Vendor HTTP in CI:** recorded fixtures only (`__fixtures__/sophos/*.json` etc.), covering: token
  refresh, whoami for partner vs tenant credential, per-tenant host, a page failure mid-enumeration
  (must throw, not return partial), 401 → reauth, 429 → retry, an unknown severity/status string
  (→ `unknown` bucket, never a throw).
- **Device matching regression:** the extracted module keeps every existing
  `backupProviders/deviceMatching.test.ts` case green unchanged, plus serial/FQDN cases.
- **Rollout:** each adapter behind the registry only (no feature flag needed — a vendor with no
  connection does nothing), but W01 ships the Sophos adapter registered only after a live
  sandbox run against a Sophos Central Partner trial; record the run in the PR.
- **Lab:** W03 isolation must be proven against a real Sophos-managed VM (nested brzlab VM, never a
  host with an installed Breeze agent), including unisolate; W07 needs the Windows lab VM.

## 11. Advisor quorum

Independent review by Codex (`codex exec -s read-only`, `model_reasoning_effort=xhigh`,
2026-09-30) against this draft and the cited code. Codex verified claims at file:line; the points
below were re-checked by the author before being accepted.

**Agreed (both positions independently):** D1 framework-first in lockstep with Sophos (with the
caveat now recorded under D1); D2 leave S1/Huntress and port later as a tracked migration with
parity/rollback criteria (Codex adds: `s1_actions` lacks connection/tenant/detection ids, so the
port must preserve unknown provenance rather than invent it); all five tenancy shapes, the dual-list
treatment of `edr_tenants`, the cascade/merge/export/encrypted-column registrations; D4
`breeze_device_id`; D6 generic tools with normalized-action tiers; D7 webhooks as hints; D8
provider-key feed source and the ternary fold; the Partner-Wide First exemption for connections.

**Codex disagreed; the author verified and accepted — spec amended:**

1. *Automatic name mapping* (§4.5): the first draft re-introduced `auto_name`, which
   `backupProviders/mapping.ts:230-265` deliberately removed (an org rename captured another
   customer's inventory). Verified; now suggestions-only with full-partner confirmation.
2. *Global device-link uniqueness* (§4.2): would forbid a device running two protection products.
   Now unique per connection.
3. *Connection-only limiter and error scope* (§4.3, §4.4): vendors meter per credential/account/IP,
   per CID and per operation; a child tenant's failure must not disable the partner connection. Now
   overlapping limiter scopes and `EdrProviderRequestError.scope`.
4. *Mandatory action polling* (§4.3): now required only when an action returns an async handle.
5. *Defender "fits unchanged"* (§4.3): softened; consent-generation binding and audience-keyed tokens
   are named as Defender-plan work.
6. *Seven-day hard delete of missing tenants* (§4.4): replaced by tombstoning; new D13.
7. *"Next sync retries" publication* (§4.4 Phase 4): false once the cursor advanced; now evaluates
   persisted rows against `notified_severity`.

**Gaps Codex found that the draft missed (verified, added):** the partner-admin write gate
(`requireProviderPartnerAdmin`, `routes/backup/providerAccess.ts`); the user-owned-action release
registration in `jobs/intentReleaseWorker.ts`; connection/tenant composite FKs and a mandatory
`(breeze_device_id, org_id)` FK; `addUniqueJob` dropping mid-flight hints
(`services/bullmqUtils.ts:51`); discriminated action targets + quarantine actions; action
idempotency / crash reconciliation; the cursor contract; an `unknown` severity/status bucket;
installer tenant ambiguity; stale denormalized `breeze_device_id` after relink; null-device
visibility after an org move (D14); deferring the #3695 pseudo-provider choice.

**Unresolved disagreements:** none remain between the two reviewers. D1, D2 and D13 still need
Todd's decision because they set product direction or reverse a recorded decision, not because the
reviewers split.

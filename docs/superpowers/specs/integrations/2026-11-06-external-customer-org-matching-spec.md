---
title: Match outside customers to organizations by name (UniFi sites, Pax8 companies) + UniFi direct controller connection
issue: 10358
folds_in: [11245]
status: draft
date: 2026-11-06
base: main @ bef484ca8b
---

# Match outside customers to organizations by name

Evidence labels: **verified** = read in code at `bef484ca8b`; **inferred** = reasoned, not run or not read end to end; **not checked** = an open fact the plan must confirm. Line numbers are at that SHA.

## 1. Problem

Two community requests ask for the same thing from two integrations.

- **#10358 (UniFi).** An MSP runs every customer as a site on one controller. Today each UniFi site is mapped to a Breeze site by hand, one dropdown per row (verified: `apps/web/src/components/integrations/unifi/SiteMappingCard.tsx`). The requester wants to connect once, see every site, and have the sites matched to organizations. They also want the Breeze server to talk to their controller directly. Their controller is self-hosted but reachable on the internet, so routing through an agent collector adds a dependency they do not need.
- **#11245 (Pax8).** Pax8 companies are mapped to orgs by hand, one dropdown per company (verified: `apps/web/src/components/integrations/Pax8Integration.tsx:782-800`). New clients get forgotten. The requester asks for matching by name that ignores corporate suffixes like Inc and Corp.

What exists today (verified unless marked):

1. **A shared matcher already exists, but it is narrow.** `apps/api/src/services/externalTenantMapping.ts` is the pure vendor-tenant → org rule set shared by backup providers and EDR. Its normalizer is trim + lowercase only (`:35-39`). It returns a name match only when exactly one org has the key, and the first tenant to reach an org claims it, so the result depends on input order (`:76-102`). It does not strip suffixes, punctuation or diacritics.
2. **Name matches are deliberately suggestions only.** Both callers say why: renaming an org to match an unmapped vendor record "used to silently capture that customer's backup inventory on the next sync" (`backupProviders/mapping.ts:225-236`; same rule in `externalTenantMapping.ts:41-49`). EDR computes suggestions on read and never persists them (`edrProviders/mapping.ts:97-114`), and its UI shows a per-row "Suggested: <org>" chip with an accept button (`EdrTenantMapping.tsx:144-214`).
3. **A second normalizer exists in accounting.** `normalizeMatchValue` (NFKC, trim, collapse whitespace, `en-US` lowercase) and `findExactMatch` with an explicit `ambiguous` result (`services/accounting/accountingMappingService.ts:203-205`, `:426-436`). The web copies it (`AccountingMappingWorkbench.tsx:86-90`). That makes three normalizers.
4. **Pax8** keeps every company it has seen in `pax8_company_mappings` (partner-axis RLS, nullable `org_id`, an `ignored` flag; `db/schema/pax8.ts:49-77`). Every sync upserts all companies and never touches `org_id` (`pax8SyncService.ts:146-174`). `POST /pax8/companies/map` maps one company and writes an audit row (`routes/pax8.ts:361-393`).
5. **UniFi cloud** does not persist the external site list. `GET /unifi/hosts` reads `/v1/hosts` + `/v1/sites` live for the mapping card (`routes/unifi/index.ts:191-211`). Sites are parsed with `meta.name` as the display name (`unifiClient.ts:126`). **Inferred, not checked against a live payload:** in Site Manager `meta.name` is the controller's short internal name (`default`, or a random slug on multi-site controllers), and the human label is `meta.desc`. Matching on `meta.name` would match almost nothing.
6. **UniFi self-hosted** controllers are polled by an agent collector. Discovered sites are persisted in `unifi_controller_sites` (org-axis; `org_id` is the collector agent's org; migration `2026-06-29-unifi-self-hosted-collectors-and-sites.sql`). The mapping row reuses `unifi_site_mappings` with `unifi_host_id = <collector id>` (`unifiTelemetryService.ts:141`).
7. **UniFi maps to a Breeze site, not an org.** `unifi_site_mappings.org_id` is derived from the chosen site (`routes/unifi/index.ts:214-260`).
8. **UniFi mapping writes are not audited.** `PUT /unifi/mappings` and `PUT /unifi/controllers` write no audit row (verified by grep: no `audit` in `routes/unifi/index.ts` or `services/unifi/`).
9. **Registering a self-hosted controller needs a Breeze site** for the collector agent, and the agent must belong to that site's org (`routes/unifi/index.ts:396-424`). This is the "you have to select which customer you are allocating this to" friction in #10358. The site can be the MSP's own internal org (`org_type` has `internal`, `db/schema/orgs.ts:27`), but the UI does not say so.
10. **Devices from unmapped self-hosted sites land in the collector's org.** `reconcileTelemetry` routes a device or client whose UniFi site has no mapping to the collector's own org and site (`unifiTelemetryService.ts:148-150`). On a self-hosted controller that serves many customers, a site nobody has mapped yet is attributed to whichever org hosts the collector agent. Clients are also keyed by `(collector_id, mac)` and re-stamp `org_id`/`site_id` on conflict (`:257-265`). A MAC seen at two sites of one controller moves between orgs on each poll.
11. **The server cannot reach a self-signed controller today.** Server-side calls go through `safeFetch`, which never disables certificate chain validation (`services/urlSafety.ts:14`) and allows private ranges only on self-hosted installs (`selfHostAllowsPrivateNetwork()`, `config/env.ts:755-757`). The agent skips verification for self-signed controllers (`agent/internal/unifi/client.go:184-198`).

## 2. Users and scope

| Concern | Level | Who |
|---|---|---|
| Pax8 and UniFi integrations (connection, credentials) | **Partner** (`pax8_integrations`, `unifi_integrations`, both partner-axis) | Partner users with full partner scope. Every UniFi and Pax8 route already requires `canManagePartnerWidePolicies` (`routes/unifi/index.ts:86`, `routes/pax8.ts:158-168`). |
| Reviewing and accepting suggestions | **Partner** | Same users. Suggestions list every mappable org of the partner, so a user restricted to some orgs must never see them. This holds already because both mapping screens are full-partner only. |
| Mapping rows | Land on the **org**: `unifi_site_mappings.org_id` (org-axis, NOT NULL) and `pax8_company_mappings.org_id` (partner-axis row, nullable org) | Org users see the outcome (telemetry, subscriptions) through existing org-scoped reads. |
| Direct controller connection (§3.6) | **Partner** | Full partner scope. A controller that serves many customers belongs to the partner, not to any one customer org. |

Out of scope for users: org-scoped users and restricted partner users get no new surface.

## 3. Proposed design

### 3.1 One shared matcher

Grow `externalTenantMapping.ts` into the single name-matching capability, and move the corporate-name normalizer to `packages/shared/src/utils/orgNameMatch.ts` so the API and web share one implementation. The web uses it only to explain a match ("matched on *acme*"). It never decides one. Accounting's `normalizeMatchValue` stays as it is: it also normalizes emails and SKUs, where stripping suffixes would be wrong. External-code auto-mapping (`resolveAutoMappings`) stays separate and unchanged. It is the only automatic path, and it is not name-based.

**Normalizer** `normalizeOrgMatchName(value)`:

1. NFKC, then remove diacritics (NFD + strip combining marks), then lowercase with a fixed `en-US` locale (the accounting rule, so results do not depend on the viewer's browser).
2. `&` and `+` become `and`. Apostrophes are dropped (`O'Brien` → `obrien`). Other punctuation becomes a space. Whitespace collapses.
3. Strip one leading `the`.
4. Repeatedly strip a trailing legal-entity token from a fixed list: `inc incorporated llc l l c lc ltd limited corp corporation co company plc pllc pc lp llp gmbh ag kg ug sa sas sarl srl spa bv nv pty pte oy ab as aps kk` and the compound `pty ltd`. Stop if stripping would leave an empty string, so `Company Inc` stays `company`.
5. Return `null` for an empty result.

The suffix list is a constant with a unit test per entry. Changing it changes suggestions only (§3.2), never stored mappings.

**Match tiers**, best first:

| Tier | Key | Meaning |
|---|---|---|
| `exact` | trim + lowercase (today's key, `:35-39`) | The names are the same apart from case. |
| `normalized` | `normalizeOrgMatchName` | The names are the same after suffix, punctuation and diacritic removal. |

No fuzzy or edit-distance tier. `Acme Dental` and `Acme Dentistry` are different customers, and a near-miss shown as a suggestion trains people to click Accept without reading. The manual dropdown stays for everything the two tiers miss. A future fuzzy tier is Open Decision 3.

**Result per external record** (one shape for all consumers):

```ts
type OrgNameMatch =
  | { status: 'match'; orgId: string; tier: 'exact' | 'normalized' }
  | { status: 'ambiguous'; candidateOrgIds: string[]; tier: 'exact' | 'normalized' } // ≥2 orgs share the key
  | { status: 'contested'; orgId: string; tier: 'exact' | 'normalized' }             // see cardinality
  | { status: 'none' };
```

Collision handling:

- **Two orgs match one external record** (`Acme LLC` and `Acme Inc` both normalize to `acme`): `ambiguous`. The candidates are returned, nothing is preselected, and the row is left out of bulk accept. An `exact`-tier hit on one org beats a `normalized`-tier tie. `Acme Inc` still matches the org named `Acme Inc` exactly even when `Acme LLC` exists.
- **Two external records match one org.** This depends on the consumer, so the matcher takes a `cardinality` argument:
  - `one_to_one` (Pax8, backup, EDR): every record that reaches the same org is `contested`. None of them is offered for bulk accept. Each row shows "also matches <other record>". This replaces today's first-come claim (`:96-99`), whose result depends on input order.
  - `many_to_one` (UniFi): several sites legitimately belong to one customer. No contest.
- **Orgs already mapped.** In `one_to_one` mode, an org that already holds a confirmed mapping is excluded from candidates, which is today's `alreadyClaimedOrgIds` behavior. In `many_to_one` mode it stays a candidate.
- **Cardinality is a suggestion policy only.** It decides what Breeze *suggests*, not what a person may save. Pax8 today lets several companies map to one org (`mapPax8Company` has no uniqueness check, `pax8SyncService.ts:446-489`), and the manual dropdown keeps allowing it.

**Mappable orgs.** Hoist `loadMappableOrgs` out of `edrProviders/mapping.ts:28-41` into the shared module and use it everywhere: the partner's orgs that are not deleted, archived, purging or merging, not `quick_support`, and not the `unassigned_pool` holding org.

Backup and EDR keep their behavior apart from the better normalizer and the order-independent contest rule. Their suggestions get wider, which is safe because they are suggestions. Accounting keeps its own email-first proposal flow. Moving it onto the shared normalizer is a follow-up (§5).

### 3.2 Suggest and confirm, not silent auto-apply

A name match is never written without a person confirming it. This keeps the existing security rule. Org rename is open to partner users restricted to a subset of orgs (`routes/orgs.ts:2654-2671`). If name matches applied themselves, such a user could rename an org they can see to `Acme Corp` and have the next sync map Acme's network inventory or subscriptions into it. Confirmation by a full-partner user closes that path.

How "new clients get forgotten" is answered without auto-apply:

1. **Re-matched on every read, so on every sync.** Suggestions are computed when the mapping screen loads, against the current external list and the current org names, the same way EDR does it (`edrProviders/mapping.ts:97-114`). A company that first appears in tonight's Pax8 sync has its suggestion waiting the next time anyone opens the tab. Nothing is stored, so nothing goes stale when an org is renamed.
2. **Per-row chip.** Each unmapped row with a `match` shows "Suggested: <org> · matched on <normalized key>" and an **Accept** button. `ambiguous` rows show "2 possible matches" and narrow the dropdown to those orgs. `contested` rows show which other record claims the same org.
3. **Bulk review.** A "Review N suggested matches" button above the table opens a modal. It lists every `match` row with a checkbox, checked by default, showing the external name, the org name, the tier and the matched key. Confirm writes the checked rows through the normal mapping write path in one request (§3.4). `ambiguous` and `contested` rows are listed underneath, unchecked and not selectable, with a "resolve in the table" note.
4. **Unmapped count where people already look.** A count badge on the integration's tab ("4 unmapped · 3 suggested") and a line in the sync result ("2 new companies since last sync"). Pax8 has `last_seen_at` and `created_at` per company, so "new since last sync" needs no schema change. UniFi cloud counts come from the live site list (§3.3).
5. **Dismiss.** A dismissed suggestion is not the same as an ignored company. Pax8's `ignored` also clears the org on that company's subscription snapshots (`pax8SyncService.ts:477-485`). It stays an explicit "Ignore company" action with its existing restore path. Ignored companies get no suggestion and are not counted as unmapped. In v1, neither integration persists "not this match" (Open Decision 4). The chip only appears on unmapped rows, and bulk review has checkboxes.
6. **Refresh after the sync finishes.** Today the Pax8 tab re-fetches right after it *enqueues* a sync, so it can show the old list (advisor finding, inferred from the UI flow). The badge and suggestions must refresh when the sync completes, by polling `last_sync_at` the way the sync-status line does.

Opt-in auto-apply is Open Decision 1. It is recommended to defer.

### 3.3 Integration specifics

**Pax8.** The matching key is `pax8_company_name` with `one_to_one` cardinality. Suggestions are added to `GET /pax8/companies` as a `suggestion` field per row. Rows that are ignored or already mapped get none. No schema change.

**UniFi.** The matcher picks an **org**, and the mapping needs a **site**:

1. If the org has exactly one site, that site is used. `sites` has no status column (`db/schema/orgs.ts:342-360`), so "one site" means one row.
2. Otherwise, if **exactly one** site in the org has the same name as the UniFi site, that site is used. Site names are compared with the conservative `exact` key (case, whitespace, NFKC). Corporate suffixes are not stripped, because site names are not company names.
3. Otherwise the suggestion is org-level. The dropdown is narrowed to that org's sites with nothing preselected, and the row is left out of bulk accept ("pick a site").

The person can always pick a different org and site in the dropdown. Bulk review shows both the org and the site for each row.

The UniFi match key:

- **Self-hosted:** the agent-reported site name from the Integration API, which is the human name (inferred from `agent/internal/unifi/client.go` decoding `name` on `/v1/sites`; not checked against a multi-site controller). Discovery stores only that name (`unifiControllerSiteService.ts:7-23`). There is no host label to fall back on, so a generic self-hosted site name gets no suggestion.
- **Cloud:** the site's human description (`meta.desc`). Falling back to the console (host) name is allowed only when Site Manager reports exactly one site for that console, the site is the generic default, and the host name is a real label (not `Unknown console`, `unifiMappingHosts.ts:3`). `parseSites` must start carrying `desc` alongside `name` (`unifiClient.ts:117-140`). Both points are inferred and must be confirmed against a captured `/v1/sites` payload before Wave 2 is built.
- Generic names (`default`, `site`, empty) never match on their own.

**Unmapped self-hosted sites become discovery-only (Wave 2).** §1 item 10 means an unmapped site's devices are attributed to the collector's org. Once matching makes "connect first, map later" the normal flow, that fallback puts one customer's inventory into another customer's org. For collectors with `unifi_host_id IS NULL` (self-hosted), `reconcileTelemetry` drops devices and clients whose site has no mapping, and records the site in `unifi_controller_sites` only. Cloud collectors are bound to one console and keep today's fallback. This is a behavior change (Open Decision 8). The client key collision (§1 item 10) is fixed in the same wave by widening the client identity to `(collector_id, local_site_id, mac)`. That widening needs a migration on an org-cascade table, so the plan checks export-policy classification for the new column.

Cardinality is `many_to_one`. Suggestions are added to `GET /unifi/hosts` (cloud) and `GET /unifi/controller-sites` (self-hosted) as a `suggestion` per site. UniFi cloud sites still are not persisted. The live list is the source, and the unmapped count is computed from it on read. Scheduled sync already lists every site (`listSitesForSync`, `unifiSyncService.ts:272-274`). It may also record `sites_unmapped` on `unifi_sync_runs`, a partner-axis table with no `org_id`, so no cascade or export-policy change. That column is optional (Open Decision 5).

### 3.4 Write path and audit

Accepting a suggestion uses the same write path as a manual mapping, so every existing check still runs: org belongs to the partner, holding org refused, MFA, `canAccessOrg`.

- **Pax8:** new `POST /pax8/companies/map-bulk` takes `{ integrationId, items: [{ pax8CompanyId, orgId, expectedOrgId: null }] }` (max 200). It calls `mapPax8Company` per item inside one `withDbTransaction`. Every target is resolved and authorized before any write, which is the `PUT /unifi/mappings` all-or-nothing rule (`routes/unifi/index.ts:221-247`). The single-row route stays.
- **UniFi:** new `POST /unifi/mappings/accept` takes `{ items: [{ unifiHostId, unifiSiteId, siteId, expectedSiteId: null }] }` and is additive only. It shares the validation in `PUT /unifi/mappings` but has no `hostIds` parameter, so it can never reach the replace-all delete (`:263-300`).
- **Stale reviews.** Every bulk item carries the state the reviewer saw (`expectedOrgId` / `expectedSiteId`, `null` for unmapped). If any row has changed since then, the whole batch is refused with 409 and the modal reloads. A suggestion can never overwrite a mapping someone made in another tab. All-or-nothing in one transaction, so a retry is safe.
- **Web:** both buttons go through `runAction` and follow the `ActionError` catch rule. Modal open state is local, not URL state.

Audit (one row per mapping changed, via `writeRouteAudit`, with `orgId` = the target org):

| Action | When | Details |
|---|---|---|
| `pax8.company.map` / `pax8.company.unmap` (exists) | any Pax8 map | add `previousOrgId`, `source: 'manual' \| 'suggestion' \| 'bulk_suggestion'`, `matchTier`, `matchKey` |
| `unifi.site.map` / `unifi.site.unmap` (**new**) | every mapping row change from `PUT /unifi/mappings` or the accept route, including the replace-all deletes | `integrationId`, `unifiHostId`, `unifiSiteId`, `siteId`, `previousOrgId`, `previousSiteId`, `source`, `matchTier`, `matchKey` |
| `unifi.controller.register` / `unifi.controller.remove` (**new**) | `PUT /unifi/controllers`, `PUT /unifi/collectors`, `DELETE /unifi/collectors/:hostId` | `integrationId`, `transport`, `controllerHost` (host only, never the key) |

`source` is a client claim. The server checks only that a `suggestion` source matches what the matcher returns for that row at write time, and records `manual` when it does not. That is enough for an audit trail without trusting the client.

### 3.5 UniFi controller registration copy (cheap fix for #10358's first message)

Before any new transport: the self-hosted "register controller" form asks for a Breeze site for the collector agent. Rename that field to "Collector agent location". Default the org picker to the partner's `internal` org when exactly one exists, and add a help line saying the controller's sites are mapped to customers in the next step. This does not change the API.

### 3.6 Direct server-to-controller connection (UniFi)

**What it adds.** A self-hosted controller can be polled by the Breeze API instead of an agent: no collector agent, no customer org to pick, nothing that depends on an endpoint being online. This suits the #10358 requester, whose controller is on the internet.

**Before building it, note that two cheaper paths exist** (inferred):

- Since #10570 (closed #10491/#10492), a self-hosted Network Application linked to the MSP's UniFi account appears in the cloud Site Manager path as a `network-server` host with all its sites. If the requester's controller is linked to their UI account, the cloud connection may already cover inventory. Not checked: whether Site Manager `/v1/devices` returns devices for `network-server` hosts.
- An agent anywhere that can reach an internet-hosted controller can collect for it. It does not have to be on the customer LAN, so the MSP's own office agent works (§3.5).

**Transport.** Add `transport: 'agent' | 'server'` to a self-hosted controller registration. A `server` controller is polled by a BullMQ repeatable job per controller. The job reads `/proxy/network/integration/v1/sites`, `/sites/{id}/devices` and `/sites/{id}/clients`, the same endpoints the agent uses (`client.go:18`). It builds the same payload the agent posts and hands it to the existing `reconcileTelemetry` pipeline, so mapping, inventory and the `discovered_assets` reconcile are shared. In v1, topology v2 and Wi-Fi radio detail stay agent-only. They are a large Go surface (`agent/internal/unifi/topology_v2.go`, `wifi_*.go`) and are not needed for site matching or inventory.

**Ingest rules that differ from the agent path:**

- **Mapped sites only.** A server controller has no org of its own, so it has nothing to fall back to. Unmapped sites are discovery-only (§3.3), and the job never writes a device or client row for them.
- **Authorization of its own.** The agent path's ownership gate (posting device must own the collector, `jobs/unifiTelemetryWorker.ts:31-40`) stays exactly as it is. The server job enters `reconcileTelemetry` through a separate entry point. That entry point loads the collector, requires `transport = 'server'`, an active integration of the same partner, and a matching `topology_generation`, so a poll queued before an edit or delete is dropped.
- **Scheduler.** `processScheduler` queues every active integration into the cloud sync path (`jobs/unifiWorker.ts:67-80`). Server controllers get their own repeatable job, and self-hosted integrations no longer enter the cloud path.
- **Bounded polls.** The job follows pagination on every list. Each poll has a total deadline and a request budget, because `safeFetch`'s `timeoutMs` covers one request, not the whole poll. A partial poll writes nothing stale-marking: no device is marked gone because a page was not read. All network calls run outside any DB transaction (`runOutsideDbContext`), and only the reconcile runs under `withSystemDbAccessContext`.
- **HTTPS only** on hosted. A `server` controller URL must be `https:`, with `http:` allowed only on self-hosted installs and only to private addresses.
- **Stable identity.** Switching a controller between `agent` and `server` keeps the same collector row id, so mappings (`unifi_host_id = collector id`) survive the switch. The generation bump revokes topology sources the old transport authorized.

**Data model.** A server-polled controller is a partner asset, so it follows the partner-wide-first rule:

- `unifi_collectors` gains `transport text NOT NULL DEFAULT 'agent'`, `partner_id uuid` (backfilled from the integration), `tls_pin_sha256 text NULL` (only if Open Decision 6 picks pinning), and a CHECK:
  - `transport = 'agent'` → `org_id`, `site_id`, `collector_device_id` NOT NULL (unchanged rows).
  - `transport = 'server'` → `org_id`, `site_id`, `collector_device_id` NULL and `partner_id` NOT NULL.
- `unifi_controller_sites.org_id` becomes nullable, plus a `partner_id` column. Rows under a server controller are partner-owned.
- Both tables move from org-only policies to the dual-axis policy from `docs/agents/tenancy-rls.md`: system, or org access on `org_id`, or `org_id IS NULL AND breeze_has_partner_access(partner_id)`. They are registered in `DUAL_AXIS_TENANT_TABLES`.
- Ownership is bound by composite FKs, not just by app code: `unifi_collectors (integration_id, partner_id) → unifi_integrations (id, partner_id)` and `unifi_controller_sites (collector_id, partner_id) → unifi_collectors (id, partner_id)`. This needs a unique `(id, partner_id)` on each parent.
- Telemetry and client tables are unchanged. Their `org_id` already comes from the mapping, not the collector.
- **Advisor alternative (Open Decision 2):** a separate partner-axis `unifi_server_controllers` table, keeping `unifi_collectors` org-only.

**Credential storage.** The local API key is stored encrypted in the existing `local_api_key_encrypted` column, with the same AAD binding as today's collectors (`unifiCollectorService.ts`). It stays classified `excludedSensitive` in `CORE_TENANT_EXPORT_POLICY`. It is write-only from the UI: responses carry `hasApiKey`, never the value. Rotation means entering a new key. The key is decrypted only inside the poll job, and only for the request.

**Reachability and egress.**

- All requests go through `safeFetch`. Only the methods the job needs (GET) are allowed. Redirects are refused, because the API key header must not follow one (the agent refuses for the same reason, `client.go:199`). Every call has a timeout and a `maxBytes` cap, `Retry-After` is honored, and polling is at most once every 60 seconds per controller.
- **Hosted Breeze:** the controller must be reachable from the internet over HTTPS. Private, loopback, link-local, metadata and CGNAT targets are refused by the existing SSRF guard. The docs list the hosted egress addresses so an MSP can allowlist them on the controller's firewall. That list lives in the docs and the gitignored ops notes, not in this spec.
- **Self-hosted Breeze:** private targets are allowed through `selfHostAllowsPrivateNetwork()`, as for webhooks, S3 and SSO. Cleartext `http:` is allowed only to private addresses (`requirePrivateForCleartext: true`). The API container needs a network route to the controller. The self-host docs say so.
- **TLS:** `safeFetch` keeps chain validation on. v1 requires a publicly trusted certificate on the controller. A self-hosted Network Application ships a self-signed certificate by default, so Open Decision 6 asks whether to add SHA-256 pinning (shown on registration, confirmed by the user, stored per controller) as a new `safeFetch` option. Until then a self-signed controller keeps using an agent collector, and the registration form says so when the TLS handshake fails.

**Health.** Poll results write the existing `status` / `last_poll_*` columns. The UniFi connection-health source reads only the integration row today (`services/connectionHealth/sources/unifi.ts`), so it gains an arm for a failing or stale server controller. Without that, a dead poll job would go unnoticed, because no agent heartbeat exists to show it.

## 4. Tenancy and data model impact

**Matching: no new table.** Suggestions are computed on read in the request's `withDbAccessContext`. The callers are full-partner users, so partner-axis RLS returns exactly the partner's orgs. Mapping writes use existing tables. Wave 1 has no migration. Wave 2 has one small migration: the client identity fix (§3.3) and the optional sync-run counter. Like every migration here, it is hand-written, idempotent and named to sort after the newest committed one at build time. Inferred, not checked: the agent already tags each client row with its local site id, as the 2026-06-29 self-hosted design requires. If it does not, the agent change ships first.

| Table | Shape | Change | Registration |
|---|---|---|---|
| `pax8_company_mappings` | 3 (partner-axis, nullable `org_id`, composite `(org_id, partner_id)` FK) | none | already in cascade (`tenantCascade.ts:894`), merge registry, export policy (`tenantExportPolicyRegistry.ts:757`) |
| `unifi_site_mappings` | 1 (direct `org_id`, NOT NULL) | none | already registered (`tenantCascade.ts:1186`, `tenantExportPolicyRegistry.ts:1124`) |
| `unifi_clients` | 1 | Wave 2: `local_site_id text` + unique `(collector_id, local_site_id, mac)` replacing `(collector_id, mac)` | already in cascade and merge. The new column needs an `included` export-policy classification. |
| `unifi_sync_runs` | 3 | optional `sites_unmapped integer` | none (no `org_id`) |

**Direct connection (Wave 3): one migration**, named to sort after the newest committed migration at build time (today `2027-01-22-200300-*`), idempotent, no inner `BEGIN`/`COMMIT`:

| Table | Today | After |
|---|---|---|
| `unifi_collectors` | shape 1, `org_id`/`site_id`/`collector_device_id` NOT NULL | dual-owner: org XOR partner by `transport` CHECK, dual-axis RLS in the same migration, `DUAL_AXIS_TENANT_TABLES` entry. New columns classified in `CORE_TENANT_EXPORT_POLICY`: `transport` and `partner_id` `included`, `tls_pin_sha256` `included` (a public certificate hash, not a secret; name-check reviewed). Stays in `CORE_ORG_CASCADE_DELETE_ORDER`. Org delete removes only org-owned rows, and partner-owned rows go with the partner. |
| `unifi_controller_sites` | shape 1, `org_id` NOT NULL | same dual-owner treatment, `partner_id` `included` |

Composite FKs that reference `org_id` stay `DEFERRABLE INITIALLY IMMEDIATE`. Org merge (`orgMergeRegistry.ts`) keeps `repoint` for both, and partner-owned rows have no `org_id` to repoint. Then `pnpm db:check-drift`, and the `rls-coverage`, `tenantCascade`, `tenant-export-policy` and `orgMergeRegistry` integration suites. These run only under **Integration Tests**, never `pnpm test`.

**Settings (rule 9).** Waves 1-3 add no setting. Home: n/a. Level: n/a. Places name matching is configured: 0 before, 0 after. If Open Decision 1 picks auto-apply, it adds one partner-level switch per integration on that integration's card (home = Integrations → Pax8 / UniFi, level = partner, no org override because the mapping decides which org, resolver = the integration row). The count goes 0 → 2 and needs the rule-9 statement in that PR.

**AI tools.** None added. No chat tool-index bytes and no `WISP_TOOL_SUBJECTS` change.

## 5. Out of scope

- Fuzzy, phonetic or embedding matching (Open Decision 3).
- Moving accounting's proposal flow onto the shared normalizer (follow-up issue).
- Other integrations' mapping screens (Huntress, SentinelOne, PSA company import, M365 tenants). They can adopt the matcher later, one PR each.
- Creating Breeze orgs from unmatched external records ("create org from Pax8 company").
- UniFi topology v2 and Wi-Fi radio detail over the server transport.
- Collector HA and mixed cloud + self-hosted on one integration (non-goals in the 2026-06-29 self-hosted design).
- Write actions on the UniFi controller. The server transport is read-only.

## 6. Open Decisions

1. **Auto-apply name matches on sync?**
   - A. Never. Suggest and confirm only, with bulk review (§3.2).
   - B. Opt-in partner switch per integration that auto-applies `match` rows at the `exact` tier only, only for external records first seen in that sync, with an audit row and a notification per auto-map.
   - C. Opt-in switch at both tiers.
   - **Recommend A** for this spec. B narrows the rename-capture path (§3.2) but does not close it: the rename can happen before the customer first appears in Pax8. Bulk review answers "forgotten clients" in one click. Revisit B if people still ask after bulk review ships.
2. **Where a server-polled controller lives.**
   - A. Make `unifi_collectors` + `unifi_controller_sites` dual-owner (§3.6), so one pipeline handles both transports.
   - B. A new partner-axis `unifi_server_controllers` table, with the telemetry tables' `collector_id` widened to reference either.
   - **Recommend A.** The whole telemetry pipeline keys on `collector_id`, and B forks it. A is the documented partner-wide-first pattern.
3. **A fuzzy tier?**
   - A. None.
   - B. A third, lower tier (token-set similarity ≥ 0.9) shown as "possible match", never in bulk accept.
   - **Recommend A** in v1. Measure how many rows the two tiers leave unmatched on real partner data before adding B.
4. **Persist "not this match" dismissals?** This applies to both integrations. Pax8's `ignored` is not a dismissal, because it also detaches subscriptions (§3.2).
   - A. No dismissal in v1. The chip shows only on unmapped rows, and bulk review has checkboxes.
   - B. A small partner-axis table keyed `(integration_kind, integration_id, external_key, org_id)` that hides one specific suggestion.
   - **Recommend A.** Add B only if people say the chips nag. UniFi has no per-site row to hang a flag on, so B would be a new table.
5. **Record `sites_unmapped` on `unifi_sync_runs`?**
   - A. Yes, so the sync history card shows drift over time.
   - B. No, compute on read only.
   - **Recommend A.** It is one integer on a partner-axis table.
6. **TLS for server-polled controllers.**
   - A. Publicly trusted certificate only.
   - B. A plus SHA-256 pinning: a new `safeFetch` option that replaces chain validation with a pin check, captured and confirmed at registration.
   - C. Skip verification.
   - **Recommend A for v1, B as a follow-up in its own security-reviewed PR.** C is refused because the request carries the API key.
7. **How Wave 3 ships.**
   - A. Build it as a wave of this feature.
   - B. Split it into a linked implementation spec and plan with its own tenancy, lifecycle and transport acceptance criteria. Keep it as an explicit deliverable on the parent feature, so #10358 does not close on matching alone. Before building, ask the requester whether the cloud path (#10570) or an office agent already covers their controller.
   - C. Drop it.
   - **Recommend B** (the advisor's view, which this draft adopted). Wave 3 is the only part with a migration on a credential table and new server egress, and §3.6 is a design, not a build-ready contract. Matching alone does not answer the second half of #10358.
8. **Make unmapped self-hosted sites discovery-only (§3.3)?**
   - A. Yes, in Wave 2. Devices and clients of an unmapped site on a self-hosted controller are no longer written to the collector's org.
   - B. Keep today's fallback to the collector's org.
   - **Recommend A.** "Connect, then match" is the flow this spec creates, and under B every not-yet-matched customer's inventory lands in someone else's org. An MSP that put the collector in a customer org today will see those devices disappear from that org until the site is mapped, and the release note must say so.

## 7. Test and rollout notes

**Wave 1: shared matcher + Pax8.**
- Red first: a `orgNameMatch.test.ts` table covering each suffix, `the`, `&`, diacritics, the never-empty rule and generic names. Matcher tests for `ambiguous`, `contested` (`one_to_one`), no contest (`many_to_one`), exact beating normalized, and order independence (shuffle the inputs, get the same output).
- `backupProviders/mapping.test.ts` and `edrProviders/mapping.test.ts` updated for the contest rule.
- Route tests for `GET /pax8/companies` suggestions, `POST /pax8/companies/map-bulk` all-or-nothing (one foreign org → 403 and zero rows written), holding org refused, MFA, audit `source`.
- Eligibility: hidden, archived, merging, `quick_support` and holding orgs never appear as candidates. Ignored and already-mapped companies get no suggestion. A cross-partner org is refused on write. A rename-capture regression test renames an org to match an unmapped company and asserts that nothing is written until a full-partner user accepts.
- Stale review: an item whose row changed since it was reviewed gets 409 and the whole batch writes nothing.
- Web: chip, bulk modal, `runAction` path, `data-testid`s, a refresh after the sync completes, and the new keys in every shipped locale.

**Wave 2: UniFi suggestions + audit.**
- Capture a real `/v1/sites` payload (single-site and multi-site) into `services/unifi` fixtures first, and confirm `meta.desc` (§3.3).
- Site-resolution tests for the three cases, plus the default-site fallback guards. Audit rows on map, unmap and replace-all delete. The accept route has no delete path, and a test proves an existing mapping outside the batch survives.
- Discovery-only: a device on an unmapped self-hosted site writes no `unifi_device_telemetry` or `unifi_clients` row. The same MAC on two sites of one controller keeps two rows in two orgs.

**Wave 3 (if Open Decision 7 = A): server transport.**
- Migration + `<table>PartnerRls.integration.test.ts`: cross-partner forge fails with 42501, the transport CHECK fails with 23514, org isolation holds for agent rows.
- Poll job: SSRF refusal (private target on hosted), redirect refusal, timeout and `maxBytes`, `Retry-After`, untrusted certificate surfaced as a clear status. A fixture controller in tests, no live controller in CI.
- This is a stacked-PR trap: a branch based on another wave runs no CI. Dispatch `gh workflow run CI --ref <branch>`. The cascade, export and RLS suites run only under Integration Tests.

**Rollout.** Matching is additive and read-only until someone clicks Accept, so it needs no flag. The one behavior change is Wave 2's discovery-only rule (Open Decision 8). It goes in the release notes for self-hosters, with the step to take: map the controller's sites before upgrading, or expect unmapped sites' devices to leave the collector's org. Wave 3 sits behind the self-hosted registration form's transport choice and touches no existing rows (the default `transport = 'agent'`). Docs update `apps/docs/src/content/docs/features/unifi-integration.mdx` and the Pax8 page.

## 8. Advisor quorum

An independent read-only review (Codex, `gpt-6-astra`, xhigh) was given the draft's six key choices.

| Choice | Advisor | Outcome |
|---|---|---|
| Shared deterministic matcher, two tiers, no fuzzy tier, contested instead of first-wins | Agree | Adopted, plus its refinements: cardinality is a suggestion policy only, corporate normalizer kept separate from accounting's generic one, external-code auto-map unchanged. |
| Suggest and confirm only, auto-apply deferred | Agree | Adopted (Open Decision 1). |
| UniFi org-then-site resolution | Disagree as drafted | Fixed: "only site" (no status column), exactly one name-equal site with conservative compare, guarded default-site fallback, no fallback for self-hosted, org and site shown in review (§3.3). |
| Pax8 dismiss = `ignored` | Disagree | Fixed: `ignored` stays an explicit action because it detaches subscriptions. Dismissal persistence is Open Decision 4. |
| Server transport, partner-owned dual-axis rows, trusted TLS only in v1 | Agree, with conditions | Adopted the conditions: mapped-sites-only ingest, separate server-job authorization, scheduler split, bounded paginated polls, HTTPS only, composite ownership FKs (§3.6). |
| Phasing | Agree, Wave 3 as a linked spec | Adopted (Open Decision 7 B). |

The advisor also found two existing hazards that this draft had missed, both verified in code: unmapped self-hosted sites land in the collector's org, and the client key collides across sites (§1 item 10, Open Decision 8). It also required additive, stale-safe bulk acceptance (§3.4). No disagreement is left open.

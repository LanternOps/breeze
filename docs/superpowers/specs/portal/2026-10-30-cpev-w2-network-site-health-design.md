---
title: CPEV-W2 — Network Site Health (implementation spec)
issue: LanternOps/breeze discussion #8775
status: draft (implementation detail of §8 of the CPEV spec; for maintainer review)
depends_on:
  - docs/superpowers/specs/portal/2026-10-14-customer-portal-environment-visibility-design.md
  - docs/superpowers/specs/portal/2026-10-01-portal-advanced-visibility-design.md
---

# CPEV-W2 — Network Site Health

## 1. Scope

Detail of CPEV spec §8. Per-site aggregation of the signals Network Visibility already derives for the whole organization. No new health score, no new flag, no migration.

Delivered as two PRs, in the order W1 used:

1. API: shared DTO, read model, route, tests.
2. Portal UI: per-site summary on the Network page.

Everything in the CPEV spec still applies (§5.1 fail closed, §6 closed allowlists, §14 tenancy, §15 leakage tests). This document only adds what §8 leaves open.

## 2. Findings that shape the design

| # | Finding | Source |
|---|---|---|
| F1 | `networkOverview()` counts every `discovered_assets` row of the org, including `approval_status = 'dismissed'`. `networkAssets()` and `networkSites()` exclude dismissed assets. The org totals and the asset list already disagree when dismissed assets exist. | Confirmed in code (`networkVisibilityReadModel.ts`) |
| F2 | `monitorsDown` is computed org-wide from the latest `network_monitor_results` row per active monitor, `status = 'offline'`, inside `max(2 × polling_interval, 5 min)`. No site is involved. | Confirmed in code |
| F3 | `network_monitors.site_id` and `asset_id` are both nullable. The only CHECK is `site_id IS NULL OR org_id IS NOT NULL`. The composite FK `network_monitors_asset_site_scope_fk` uses default MATCH SIMPLE, so it is enforced only when `site_id` is set; then the monitor's site equals the asset's site. A monitor with a null `site_id` may still have an `asset_id`. A partner-wide monitor (`org_id` null) has no site, and an org-owned monitor with neither site nor asset also exists. | Confirmed in code (`db/schema/monitors.ts:21,60,68`) |
| F4 | Alert enrichment (`loadNetworkAssetAlertEnrichment`) joins alert → monitor → asset, and only for monitors with an `asset_id`. Alerts of a site-level monitor (`asset_id` null, `site_id` set) never reach an asset. Its `ALERT_SEVERITY_RANK` is a non-exported `const` and it types `highestAlertSeverity` as `string \| null`. | Confirmed in code |
| F5 | `GET /portal/network/sites` feeds the table's Site filter on every page load and returns `{ id, name }`. It answers 403 when the portal user has no `partnerId`, and runs in `withDbAccessContext(portalOrgContext(orgId, partnerId))`. The shared `cached()` helper (30 s private, ETag) types its payload as `NetworkOverviewDto \| NetworkAssetsDto \| NetworkSitesDto`. | Confirmed in code (`routes/portal/network.ts`) |

## 3. Decisions

| # | Decision | Why | Status |
|---|---|---|---|
| D1 | New endpoint `GET /portal/network/sites/health`. `/network/sites` is not extended. | F5: the filter call must stay cheap; per-site health needs reachability for every asset. Separate contracts. | Our suggestion |
| D2 | The per-site asset set is the same as `networkAssets()` and `networkSites()` (non-dismissed). | A site's counts must match the table filtered by that site. | Our suggestion |
| D3 | F1 is reported, not fixed here. A follow-up decides whether the overview should also exclude dismissed assets. | Out of W2 scope; changing the overview changes a shipped contract. | Our suggestion |
| D4 | A monitor's site is `network_monitors.site_id` when set, otherwise the site of its `asset_id`. A monitor with neither (partner-wide, or org-owned with no site and no asset) counts only in the org total. No "unknown site" bucket. | F3. A bucket would invent a site the customer does not have. | Our suggestion |
| D5 | Site alert counts include alerts of site-level monitors (F4), attributed by the D4 rule. Alerts of monitors whose asset is dismissed are excluded. | Otherwise a site with a down site-level monitor shows zero alerts. | Our suggestion, needs maintainer confirmation |
| D6 | The row carries `siteId` in addition to the §8.4 allowlist. | Already exposed by `/network/sites` (F5); the UI needs it to link a site to the `#site=` filter. | Our suggestion, needs maintainer confirmation |

Consequence of D3 and D4, stated so nobody files it as a bug: the sum of the per-site rows is less than or equal to the org overview for `totalAssets`, `onlineAssets`, `offlineAssets`, `snmpDevicesPolling` and `monitorsDown`.

## 4. Contract

### 4.1 Gate

`enableNetworkVisibility` only, with the `not_enabled` pattern of §5.1.2: HTTP 200, `dataStatus: 'not_enabled'`, `data: []`. Alert fields depend on `enableNetworkAlerts` and follow the conditional-omission pattern: absent when the flag is off, never null-filled.

No new flag. Nothing changes in `PORTAL_SENSITIVE_FLAG_KEYS`, `enableAllVisibility()`, `CORE_TENANT_EXPORT_POLICY` or migrations.

### 4.2 DTO (`packages/shared/src/types/portalVisibility.ts`)

```ts
export interface NetworkSiteHealthRowDto {
  siteId: string;                       // D6
  siteName: string;
  totalAssets: number;
  onlineAssets: number;
  offlineAssets: number;
  unverifiedAssets: number;
  snmpDevicesPolling: number;
  monitorsDown: number;
  // only when enableNetworkAlerts is on; omitted otherwise
  activeAlertCount?: number;
  highestAlertSeverity?: NetworkAssetAlertSeverity | null; // null when activeAlertCount is 0
}

export interface NetworkSiteHealthDto {
  dataStatus: 'ok' | 'no_data' | 'not_enabled';
  data: NetworkSiteHealthRowDto[];      // [] unless 'ok'
}
```

Exactly these keys. Nothing from §8.5 is selected into the response objects; the DTO is built field by field, never spread from a query row.

### 4.3 Aggregation rules

- **Rows:** one per site that owns at least one non-dismissed asset (D2). Ordered by `sites.name`, then `sites.id`, as `networkSites()` does. No pagination, like `/network/sites`.
- **Reachability:** `loadReachability()` over all asset ids, batched, as the overview does. `responding` → online, `not_responding` → offline, `unverified` → unverified. The three always sum to `totalAssets`. `discovered_assets.isOnline` is never the authority.
- **`snmpDevicesPolling`:** assets whose `detail.snmp?.state === 'ok'`, same predicate as the overview.
- **`monitorsDown`:** same predicate as the overview (active monitor, latest result, `offline`, inside its freshness window), attributed per D4. The predicate is extracted into one helper used by both the overview and W2, with no behavior change to the overview. It is not reimplemented.
- **Alerts (flag on):** active alerts with `context.source = 'network_monitor'` whose monitor is active, attributed per D5. `highestAlertSeverity` uses the existing `ALERT_SEVERITY_RANK`.
- **`dataStatus`:** `no_data` when the org has no non-dismissed asset with a site; `ok` otherwise. `ok` is never returned with zeros fabricated from an unavailable source: if reachability or the monitor read fails, the route fails like the other network routes do.
- **`lastValidObservationAt`:** not included (§8.4). No synthesized timestamp.

### 4.4 Tenancy

Same as `/network/sites` and `/network/overview`: `orgId` from `portalAuth`, read inside `withDbAccessContext(portalOrgContext(orgId, partnerId))` with `currentPartnerId` populated, so partner-wide monitor definitions stay readable through the SELECT-only branch while results remain org-scoped by RLS. Like `/network/sites`, it answers 403 when the portal user has no `partnerId`. The route takes no `orgId`, `siteId` or `assetId` parameter, so there is no client-selected scope to forge.

Caching reuses the shared `cached()` helper (30 s private, ETag) already used by the other network routes. This spec introduces no new TTL. The helper's payload union is widened with `NetworkSiteHealthDto`.

Alert severity: `ALERT_SEVERITY_RANK` is exported (or the new function lives in the same module) and the severity is narrowed to `NetworkAssetAlertSeverity` in one place, not cast at each use.

## 5. Exclusions

Everything in §8.5. In particular: monitor ids and configuration, polling interval, thresholds, monitor result rows, raw alert context, alert-rule configuration, ticket internals, discovery evidence, SNMP credentials or raw metrics, any score. Also excluded: open ticket counts (not in §8.4), asset ids, hostnames, IPs.

## 6. Tests (CPEV §15 mapped)

| §15 | Test |
|---|---|
| 1 | Route unit: flag absent / false / true for `enableNetworkVisibility`; alert fields absent when `enableNetworkAlerts` is off, present when on, including `activeAlertCount: 0` with `highestAlertSeverity: null`. |
| 2 | Real Postgres: A→A, B→B, A↛B, B↛A for assets, monitors, results and alerts. |
| 3, 4 | Real Postgres: sources populated with sensitive values (monitor name, target host, config jsonb, alert context, asset hostname and IP). The serialized body is asserted to contain exactly the §4.2 keys and none of those values. |
| 5 | `no_data` with an empty list. |
| 6 | Reachability source failure does not produce `ok` with zeros. |
| 7 | The route accepts no org, site or asset parameter; a query-string `orgId` or `siteId` changes nothing. |
| 8 | N/A: no new flag. |
| 9 | Real Postgres for every read that relies on RLS or org-scoped joins. |

W2-specific cases:

- **Parity with the list:** for each site, `totalAssets`, `onlineAssets`, `offlineAssets` and `unverifiedAssets` equal the counts of `networkAssets()` filtered by that `siteId` (D2).
- **Dismissed assets** are excluded from every counter, including alerts (D5).
- **Partner-wide monitor**, and an **org-owned monitor with neither site nor asset**, that are down count in the org overview and in no site (D4).
- **Monitor with `asset_id` and a null `site_id`** is attributed to its asset's site (D4).
- **No `partnerId`** answers 403, like `/network/sites`.
- **Site-level monitor alert** counts toward its site (D5).
- **Overview extraction:** existing overview tests stay green with the shared `monitorsDown` helper.

## 7. PR plan

1. **API PR:** DTO, read model function, helper extraction, route, route unit tests, real-Postgres integration tests. No schema change, so `db:check-drift` and `rls-coverage` are expected to be unaffected; CI confirms.
2. **UI PR:** per-site summary in the Network page, using the existing `#site=` hash convention to hand a site over to the asset table. Layout decided by precedent in that PR, with no open question to the maintainer unless the precedent is missing.

## 8. Open for the maintainer

1. D5: should site-level monitor alerts count toward a site?
2. D6: may the row carry `siteId`?
3. D3: is a separate follow-up for the dismissed-asset mismatch (F1) acceptable?

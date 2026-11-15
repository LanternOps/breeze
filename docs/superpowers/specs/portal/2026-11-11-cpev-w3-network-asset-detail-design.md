---
title: CPEV-W3 — Network Asset Detail (implementation spec)
issue: LanternOps/breeze discussion #8775
status: draft (implementation detail of §9 of the CPEV spec; for maintainer review)
depends_on:
  - docs/superpowers/specs/portal/2026-10-14-customer-portal-environment-visibility-design.md
  - docs/superpowers/specs/portal/2026-10-01-portal-advanced-visibility-design.md
---

# CPEV-W3 — Network Asset Detail

## 1. Scope

Detail of CPEV spec §9 and of the §17 note "detail the endpoint/UX in its own wave". A customer-safe, per-asset read of what Network Visibility already derives for the asset list. No new data, no new flag, no migration.

Delivered as two PRs after this spec, in the order W1 and W2 used:

1. API: shared DTO, read model function, route (mounted through the existing `portalNetworkRoutes`), `SELF_MANAGED_DB_CONTEXT_ROUTES` entry, tests.
2. Portal UI: asset detail opened from the Network table and addressed by the URL hash.

A tracking issue under #11213 precedes the API PR, since the CPEV waves originate in a Discussion.

Everything in the CPEV spec still applies (§5.1 fail closed, §6 closed allowlists, §14 tenancy, §15 leakage tests). This document only adds what §9 leaves open.

## 2. Findings that shape the design

| # | Finding | Source |
|---|---|---|
| F1 | The list row already carries the whole §9.3 base allowlist. `toAssetRow()` builds `id`, `hostname`, `label`, `ipAddress`, `macAddress`, `assetType`, `onlineState`, `lastSeenAt`, `firstSeenAt`, `manufacturer`, `model` and `siteName`, plus `activeAlertCount`, `highestAlertSeverity` and `openTicketCount` when `enableNetworkAlerts` is on. `withPhysicalPlacement()` adds the W1 `physicalPlacement` block when `enablePhysicalPlacement` is on and a placement exists. A detail read has no field to add today. | Confirmed in code (`networkVisibilityReadModel.ts`; `NetworkAssetRowDto` in `packages/shared/src/types/portalVisibility.ts`) |
| F2 | There is no per-asset surface. The portal network routes are `/network/overview`, `/network/sites`, `/network/sites/health` and the `/network/assets` list (`siteId`, `assetType`, `status`, `page`, `limit`). `NetworkAssetTable` has no row detail; its UI state lives in the URL hash, read with `URLSearchParams`. | Confirmed in code (`routes/portal/network.ts`, `NetworkAssetTable.tsx`) |
| F3 | The loaders already take id lists: `loadReachability(assetIds)`, `loadNetworkAssetAlertEnrichment(orgId, assetIds)` and `loadPhysicalPlacements(orgId, [{ id, siteId }])`. A one-element list reuses them unchanged. `toAssetRow()` and `withPhysicalPlacement()` are private to the read model, and `AssetQueryRow` carries no `siteId`, which `loadPhysicalPlacements` needs; the list selects it alongside. | Confirmed in code (`networkVisibilityReadModel.ts`) |
| F4 | The list route reads `enableNetworkVisibility`, `enableNetworkAlerts` and `enablePhysicalPlacement` from `portal_branding` in one select, inside `withDbAccessContext(portalOrgContext(orgId, partnerId))`. It answers `not_enabled` unless visibility is exactly `true`, 403 without `partnerId`, and responds through the shared `cached()` helper (30 s private, ETag). | Confirmed in code (`routes/portal/network.ts`) |
| F5 | `/network/overview` and `/network/assets` are entries of `SELF_MANAGED_DB_CONTEXT_ROUTES`, each an exact path regex, so the handler's own context is the one in effect. The list's pattern does not match `/network/assets/:id`. A route not listed there runs nested in the middleware's ambient context, whose `currentPartnerId` is null (raised in the review of #11215 for `/network/sites` and `/network/sites/health`). | Confirmed in code (`middleware/selfManagedDbContextRoutes.ts`); review of #11215 |
| F6 | Not-found precedent: the portal checkout route in `routes/portal/assets.ts` validates `:id` with `zValidator('param', assetParamSchema)` (`id: z.string().guid()`) and answers `404 { error: 'Asset not found' }` for an id outside the caller's organization. The advanced-visibility spec states the tenancy test as "Per-device routes forge another organization's device id and expect 404", and the maintainer review of #8790 notes that "the forged-id → 404 rule carries over". | Confirmed in code and in the existing specs |

## 3. Decisions

| # | Decision | Why | Status |
|---|---|---|---|
| D1 | New endpoint `GET /portal/network/assets/:id`. `/network/assets` is not extended with an id filter. | A deep link must not depend on pagination, filters or the page the asset sits on. It is also the single place where later waves compose their blocks (§9.4, §16.1). F1 means W3 adds no field; the value is addressability and composition. | Our suggestion, needs maintainer confirmation (Q1) |
| D2 | Not-found is uniform. A malformed id gets the standard 400 of the param validator. An id that does not exist, belongs to another organization, or is `dismissed` answers the same `404 { error: 'Asset not found' }`, with no way to tell the cases apart. | §14.2 and F6. `dismissed` assets are hidden from the customer by the list and by the sites, so the detail must not reveal them. | Our suggestion, needs maintainer confirmation (Q2) |
| D3 | Order of checks: param validation, then the gate, then the lookup. `enableNetworkVisibility` off or absent answers HTTP 200 `{ dataStatus: 'not_enabled', data: null }` before any asset lookup, so an organization without the flag cannot probe ids. | §5.1.2 pattern, same as the list (F4). | Our suggestion |
| D4 | `data` is a `NetworkAssetRowDto`, built by the same `toAssetRow()` and `withPhysicalPlacement()` as the list, not a second implementation. Alert fields and `physicalPlacement` keep the conditional-omission pattern. No field is added in W3. | F1 and F3. A field cannot be visible in the detail and hidden in the list. | Our suggestion |
| D5 | SNMP (W4), topology relationships (W5) and observed location (W6) are not part of W3. Each is added to this response only behind its own flag and allowlist, as optional keys omitted when off. | §9.4 and §16.1. | Our suggestion |
| D6 | `orgId` comes from `portalAuth`; the only input is `:id`. 403 without `partnerId`, like the sibling routes. The read runs in `withDbAccessContext(portalOrgContext(orgId, partnerId))`. The route gets its own `SELF_MANAGED_DB_CONTEXT_ROUTES` entry and a case in `selfManagedDbContextRoutes.test.ts`, in the same PR. The entry is UUID-shaped (`[0-9a-f-]{36}`, case-insensitive, like the other id entries), so the existing negative case `GET /network/assets/extra` still does not match. Caching reuses `cached()`, with its payload union widened by the new DTO. | F4 and F5. | Our suggestion |

## 4. Contract

### 4.1 Gate

`enableNetworkVisibility` only, with the `not_enabled` pattern of §5.1.2 (D3). Alert fields depend on `enableNetworkAlerts` and `physicalPlacement` on `enablePhysicalPlacement`; both are omitted when their flag is off, never null-filled. No new flag. Nothing changes in `PORTAL_SENSITIVE_FLAG_KEYS`, `enableAllVisibility()`, `CORE_TENANT_EXPORT_POLICY` or migrations.

### 4.2 DTO (`packages/shared/src/types/portalVisibility.ts`)

```ts
export interface NetworkAssetDetailDto {
  dataStatus: 'ok' | 'not_enabled';
  data: NetworkAssetRowDto | null;      // null unless 'ok'
}
```

Exactly the keys of `NetworkAssetRowDto`. The object is built field by field through `toAssetRow()`, never spread from a query row. There is no `no_data`: a missing asset is a 404 (D2), not an empty result.

### 4.3 Behavior

- **Asset:** the `discovered_assets` row with `org_id` equal to the authenticated organization and `approval_status` different from `dismissed`, joined to `sites` as the list does.
- **`onlineState`:** from `loadReachability` for that id. `responding` gives `online`, `not_responding` gives `offline`, anything else gives `null`. `null` means unverified and is never converted to `offline`. If the reachability lookup fails, the request fails like the other network routes; it never becomes `ok` with a fabricated state.
- **Alerts (flag on):** from `loadNetworkAssetAlertEnrichment(orgId, [id])`, zero-filled (`0`, `null`, `0`) when the asset has none, exactly as in the list. Flag off: the three keys are absent.
- **Placement:** `loadPhysicalPlacements(orgId, [{ id, siteId }])` only when `enablePhysicalPlacement` is on. No placement: the block is omitted.
- **Parity:** the returned object equals the row the list returns for the same asset under the same flags. The parity test pins `now`, because `onlineState` depends on it.

### 4.4 Tenancy

As D6. The id works only as a selector inside the authenticated organization (§14.2); it never changes the organization context.

## 5. Exclusions

Everything in §9.4: raw fingerprints, open ports, discovery payloads and evidence, collector data, monitor ids, configuration and thresholds, raw alert context, raw neighbor rows, raw SNMP state and OIDs, inference and debug metadata. Also excluded: `siteId` (not part of `NetworkAssetRowDto`), credentials, management data and any write.

## 6. Tests (CPEV §15 mapped)

| §15 | Test |
|---|---|
| 1 | Route unit: `enableNetworkVisibility` absent / false / true; alert fields absent with alerts off, present as `0` / `null` / `0` when on and the asset has none; `physicalPlacement` absent when its flag is off. |
| 2 | Real Postgres: A→A, B→B, A↛B and B↛A. A forged id from the other organization answers the same 404 body as a random uuid. |
| 3, 4 | Real Postgres: source rows populated with sensitive values (fingerprint, open ports, discovery evidence, SNMP jsonb, monitor configuration, alert context). The serialized body is asserted to contain exactly the `NetworkAssetRowDto` keys and none of those values. |
| 5 | N/A: there is no `no_data`; a missing asset is a 404. |
| 6 | A reachability source failure does not produce `ok`. An unverified asset keeps `onlineState: null`. |
| 7 | Only `:id` is read; a query-string `orgId` or `siteId` changes nothing; a malformed id answers 400. |
| 8 | N/A: no new flag. |
| 9 | Real Postgres for every read that relies on RLS or org-scoped joins. |

W3-specific cases:

- **Parity with the list** for the same asset, with alerts on and off and placement on and off.
- **Dismissed asset** answers 404; an asset of another site of the same organization is readable.
- **No `partnerId`** answers 403, like the sibling routes.
- **Registration:** `selfManagedDbContextRoutes.test.ts` matches the new path with a UUID and still rejects `/network/assets/extra`. An integration test through the production mount path shows the handler's own context, with `currentPartnerId` populated, is the one in effect; a route test with a mocked database layer does not prove that.

## 7. UI (second PR)

- Opening an asset from the table sets `#asset=<id>` in the hash, next to the existing site, filter and page keys. That is the repo convention for transient UI state. `writeHash()` in `NetworkAssetTable.tsx` rebuilds the hash from the filter state alone (`type`, `site`, `status`, `page`), so the UI PR must carry `asset` through it; otherwise changing a filter or the page drops the key.
- The panel fetches the detail on demand. Layout is decided by precedent in that PR (`NetworkOverview`, `apps/portal/DESIGN.md`), with no open question to the maintainer unless the precedent is missing.
- A 404 shows a quiet "asset not found" state and removes the `asset` key from the hash. `not_enabled` never reaches the panel, because the page already redirects, as it does for the list. Blocks whose fields are absent (alerts, placement) are not rendered.

## 8. PR plan

1. This spec (documentation only).
2. Tracking issue under #11213; the maintainer asked for one in the review of #10810.
3. API PR: DTO, `networkAssetDetail()`, route, `SELF_MANAGED_DB_CONTEXT_ROUTES` entry and test, route unit tests, real-Postgres tests. No schema change, so `db:check-drift` and `rls-coverage` are expected to be unaffected; CI confirms.
4. UI PR. Our suggestion: after the W2 UI PR, since both touch the Network page.

## 9. Open for the maintainer

1. **Q1 (D1):** endpoint plus UI, or UI only from the row the table already loaded? UI only adds no surface, but an `#asset=` link breaks when the asset is not on the loaded page or filter, and the W4 to W6 blocks will need an endpoint anyway.
2. **Q2 (D2):** is the uniform 404 for unknown, other-organization and `dismissed` ids acceptable?

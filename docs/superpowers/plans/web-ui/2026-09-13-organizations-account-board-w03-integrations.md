---
tracking_issue: LanternOps/breeze#5721
---
# Organizations Account Board W03: Integrations, Contracts and Backup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the account board: partner-level connector state and per-org integration mapping state (with reason codes) on `GET /orgs/account-readiness`, the Integrations column with "not linked" badges, the Unlinked filter and band cell, the partner-level connector repair line, the "No active contract" chip from the `contracts` table, and the backup chip with an explicit applicability rule.

**Architecture:** Two new API service modules hold every new query — `services/orgAccountReadinessIntegrations.ts` (connectors + eight mapping sources, pure state derivation + worst-state aggregation, tested without a DB) and `services/orgAccountReadinessCommercial.ts` (active-contract counts, backup applicability) — and a third, `services/orgAccountReadinessExtras.ts`, gates them by capability. W01's route keeps owning validation, accepted-id resolution and shaping: it gains three capability flags and `shapeOrg` gains one parameter. On the web, every applicability rule lands in W02's `lib/orgReadiness.ts` (pure, unit-tested); `board/IntegrationBadges.tsx` renders it; W02's `AccountBoardTable`, `RollupBand`, `OrganizationsBoardPage` and `useAccountReadiness` are extended, never rewritten. No new tables, no migrations, no English sentence crosses the API.

**Tech Stack:** Hono + Drizzle ORM (PostgreSQL, forced RLS), Vitest (API unit with table-keyed Drizzle mocks; API integration on real Postgres via `pnpm test-stack up`), Astro + React islands, react-i18next, Testing Library, Playwright (`data-testid` only).

**Spec:** `docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md` — this plan is the W03 row of its Rollout table: "Integrations cell (W03)", the `connectors?` / `integrations?` members of `AccountReadinessResponse`, the Unlinked filter/band cell, the "No active contract" and backup items from the cut lists, and "W03 adds the mapping/connector matrix" under Testing. Sibling plans: `2026-09-13-organizations-account-board-w01-api.md` (API base) and `2026-09-13-organizations-account-board-w02-board-page.md` (board page); this plan names their exports exactly. Where this plan is more specific than the spec (field names, module names, the backup applicability rule, the decisions in "Spec ambiguities resolved"), the plan wins.

## Global Constraints

- **No new tables, no new columns, no migrations.** Every signal is derived from data that already exists (spec Non-goals). Therefore no cascade, export-policy or merge-registry registration.
- **Reason codes, never sentences.** `reason` values on the wire are exactly the spec's union: `suggested_match | sync_error | consent_pending | expired | degraded | suspended | error | never_synced | sync_failed | disabled | connector_error`. The web translates every one of them in all eight locales.
- **Capability gating.** `capabilities.integrations` = `connected_apps:read`. Accounting connector and accounting badges additionally require `accounting:read`; Pax8 connector and Pax8 badges additionally require `billing:manage` (the grant `routes/pax8.ts:52` uses for every Pax8 read). `capabilities.contracts` = `contracts:read AND service_management_mode = 'native'`. `capabilities.backup` = `backup:read`. A withheld section is absent from the response, never zeroed, and the web hides its column, band cell and filter chip.
- **Tenancy predicates are explicit.** `accounting_entity_mappings` is partner-axis RLS with no `org_id`: the join to `accounting_connections` carries `partner_id = <partner>` and the mapping is restricted to `breeze_entity_type = 'org' AND breeze_entity_id = ANY(accepted ids)`. Pax8 mappings are restricted to the partner's single **active** `pax8_integrations` row. Every other source is restricted to the accepted org ids. All reads run under the request's `withDbAccessContext` (never `runOutsideDbContext` / `withSystemDbAccessContext`).
- **No giant joins.** One query per source; aggregation (worst state per system per org) happens in TypeScript. `Promise.all` is orchestration only — the request runs inside one transaction.
- **Eight-locale parity.** Every new key in `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/organizations.json` with real translations; `localeParity`, `translationCoverage` (baselines bumped with a comment; brand names live in code, not catalogs), `keyUsage` (dynamic keys carry `/* i18n-dynamic */`) and `terminologyQuality` stay green.
- **Mutations through `runAction`** — W03 adds no mutation; the band's Try again is a refetch. Do not touch `runActionAllowlist.ts` or the `no-silent-mutations` `TARGET_GLOBS` (W02 already adopted the board files).
- **UI state in the hash only** (`#lens=…&filter=unlinked` through W02's `parseBoardHash` / `serializeBoardHash`); the lens stays in `localStorage` under W02's key. No `?query` state.
- **Semantic colour tokens only** (`success` / `warning` / `destructive` / `muted`), as `apps/web/src/lib/orgStatus.ts` does. No raw hues.
- **One-file vitest form:** `cd apps/api && npx vitest run <path>` / `cd apps/web && npx vitest run <path>`. Never `pnpm … test -- --run`. A trailing slash or `*` in the filter silently narrows the run — list dotted siblings explicitly.
- **Branch:** `feature/5721-organizations-account-board/wave-5724`; PR body `Closes #5724`. Commit after every task. The two issue numbers are the only permitted placeholders in this plan.

---

## The W01 / W02 surface this plan extends

Taken from the sibling plans. Names marked **(assumed)** belong to W02 tasks that were not yet written when this plan was authored; Task 1 Step 0 reconciles them once against the merged code.

**W01 — `apps/api/src/routes/orgAccountReadiness.ts`** (the route file owns every wire type):
- `AccountReadinessCapabilities { sites; devices; policies; contacts; portalUsers; invoices; tickets; integrations: boolean }` — `integrations` is hard-coded `false` in W01.
- `ConnectorSystem`, `ConnectorState`, `AccountReadinessConnector { system; state; provider? }`, `IntegrationSystem`, `IntegrationState`, `IntegrationReason`, `AccountReadinessIntegration { system; state; reason?; label? }` — declared by W01 "so W02's client types and W03's fill-in share one definition"; W03 turns them into re-exports of the service module (Task 5).
- `AccountReadinessOrg { orgId; type: OrgType; status: string; setup: { sites?; devices?; lastSeenAt?; policyAssigned }; account: { primaryContact; billingRoleContact; billingAddress; pendingInvitations?; overdueInvoices? }; integrations?: AccountReadinessIntegration[]; tickets?: TicketCounts }`.
- `AccountReadinessResponse { partnerId; capabilities; serviceManagementMode; connectors?: AccountReadinessConnector[]; orgs }`.
- `parseOrgIdsParam`, `MAX_ACCOUNT_READINESS_ORG_IDS`, router `orgAccountReadinessRoutes` (`GET /account-readiness`, mounted at `/orgs`). Handler locals: `partnerId`, `can(grant)`, `serviceManagementMode = await getServiceManagementMode(partnerId)` (from `../services/serviceManagement`), `native`, `capabilities`, `accepted: AcceptedOrg[]`, `signals: Map<string, OrgReadinessSignals>`, module-private `shapeOrg(org, signals, capabilities): AccountReadinessOrg`.
- Route unit test `routes/orgAccountReadiness.test.ts` mocks `../middleware/auth`, `../db`, `../services/serviceManagement` (`getServiceManagementMode`) and `../services/orgAccountReadiness` (`resolveAcceptedOrgs`, `loadAccountReadiness`); its `buildApp({ scope, partnerId, accessibleOrgIds, grants, before })` sets `auth` and `permissions` on the context.

**W01 — `apps/api/src/services/orgAccountReadiness.ts`:** `resolveAcceptedOrgs({ orgIds, partnerId, accessibleOrgIds }): Promise<AcceptedOrg[]>`, `loadAccountReadiness({ orgIds, partnerId, sections }): Promise<Map<string, OrgReadinessSignals>>`, `AcceptedOrg { id; type; status; billingAddress }`, `OrgType`, `ReadinessSections`, `OrgReadinessSignals`, `PrimaryContact`, `TicketCounts`. Integration suite `__tests__/integration/orgAccountReadiness.integration.test.ts`.

**W02 — `apps/web/src/lib/orgReadiness.ts`:**
- Wire mirrors `ReadinessCapabilities`, `ReadinessPrimaryContact`, `ReadinessTickets`, `ReadinessOrg` (with the slot `integrations?: unknown[]`), `AccountReadinessResponse`, `ReadinessRowState = 'pending' | 'ready' | 'failed'`.
- Chips: `SetupChipKey`, `AccountChipKey`, `ChipKey`, `RepairTarget = 'sites' | 'devices' | 'policies' | 'contacts' | 'settings' | 'billing'`, `ReadinessChip { key; tone: 'warning' | 'destructive'; target; href; count? }`, `DerivedChips { setup; account; accountApplicable }`, `REPAIR_TARGETS: Record<ChipKey, RepairTarget>`, `repairHref(target, orgId)`, module-private `chip(key, orgId, tone, count?)`, `ReadinessOrgRow = Pick<Organization, 'id' | 'status' | 'type' | 'archived'>`, `deriveReadinessChips(org, readiness, capabilities, mode, now): DerivedChips | null` (setup block ends with the `noPolicy` push; the account block is guarded by `accountApplicable = type === 'customer'` and uses `billingApplies = status === 'active'`).
- Board config: `BOARD_FILTERS = ['all','setupIncomplete','accountMissing','openTickets','trial','archived']` (its comment reserves the `'unlinked'` slot between `accountMissing` and `openTickets`), `BoardFilter`, `BOARD_COLUMNS = ['setup','account','integrations','tickets']`, `BoardColumn`, module-private `INTEGRATIONS_COLUMN_ENABLED = false`, `LENS_HIDES`, `FILTER_EVIDENCE`, `visibleColumns(lens, capabilities)`, `visibleFilters(capabilities)`, `lensForFilter`, `matchesFilter(filter, row)`, `BoardRow { org: Organization; readiness: ReadinessOrg | undefined; state: ReadinessRowState; chips: DerivedChips | null }`.
- `Organization` comes from `@/components/settings/organizationTypes` (`{ id; name; status; type?; deviceCount?; createdAt; archived?; purgeAt?; offboardingTarget? }`), `ServiceManagementMode` from `@/stores/orgStore`.

**W02 — components (`apps/web/src/components/organizations/board/`):**
- `ReadinessChips({ row, section: 'setup' | 'account' | 'all', testIdPrefix = 'org-board-chip' })` — label `t(\`orgBoard.chips.${key}\`, { count })`, `aria-label` `orgBoard.chips.link`, title `orgBoard.repair.${target}`; pending → `org-board-chips-pending`, failed → `org-board-chips-unavailable`.
- `RollupBand({ cells: RollupCell[]; status: RollupStatus; onRetry })`, `RollupCell { key: BoardFilter; count: number | null; sub?; subTone?; pressed; onPress }`; cell testids `org-board-band-<key>`, `org-board-band-<key>-count`, `org-board-band-partial`, `org-board-band-retry`. The page builds one cell per `visibleFilters(capabilities)` entry **(assumed)**, labelled `t(\`orgBoard.band.${key}\`)` **(assumed)**.
- `AccountBoardTable(props: AccountBoardTableProps)` with `rows`, `columns: BoardColumn[]`, `sort`, `onSortChange`, `activeRowId`, `onRowKeyDown`, `registerRowRef`, `onOpenRecord`, `highlightedOrgId`, `workspaceOrgId`, `manualOrder`, `menuItemsFor`, `archivedView`, `now`; internal flags `showSetup / showAccount / showTickets = !archivedView && columns.includes(…)`; desktop header/cells in that order, phone `DataCard` with a "Still needed" block then a tickets block.
- `useAccountReadiness(orgIds): AccountReadinessState { capabilities; mode; byOrg; rowState; status; retry }` — sets `capabilities` / `mode` from every successful batch (`setCapabilities(response.capabilities)`), resets state at the top of its effect.
- `OrganizationsBoardPage.tsx` **(assumed)**: builds `BoardRow`s from `byOrg` / `rowState` / `deriveReadinessChips`, band cells from `visibleFilters`, filter chips with testid `org-board-filter-<key>` (the spec's E2E list), and passes `columns = visibleColumns(lens, capabilities)` to the table. Page tests are `OrganizationsBoardPage.<aspect>.test.tsx` using an inline `vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }))` and a URL-routed `fetchWithAuth` implementation; a shared `boardTestKit.ts` **(assumed)** holds the fixtures.
- i18n `orgBoard.{columns,filters,band,chips,repair,…}` groups in all eight `organizations.json`; coverage baselines after W02: pt-BR 6, es-419 1, fr-FR 10, fr-CA 9, de-DE 3, it-IT 3, tr-TR 2.
- E2E **(assumed)**: `e2e-tests/pages/OrganizationsBoardPage.ts` (`goto()`, `row(id)`), `e2e-tests/tests/organizations-board.spec.ts` (serial, one login, `orgA`/`orgB` created via the API with `readAccessToken` / `apiJson` from `organization-record.spec.ts`).

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/orgAccountReadinessIntegrations.ts` (+ `.test.ts`, `.loaders.test.ts`) | wire types for connectors/integrations, pure state derivations, worst-state aggregation, the eight source loaders, `loadIntegrationReadiness` |
| `apps/api/src/services/orgAccountReadinessCommercial.ts` (+ `.test.ts`) | `loadActiveContractCounts`, `loadBackupReadiness` |
| `apps/api/src/services/orgAccountReadinessExtras.ts` (+ `.test.ts`) | `computeAccountReadinessExtras` (capability gating) and `extrasForOrg` |
| `apps/api/src/routes/orgAccountReadiness.ts` (W01, modify) + `routes/orgAccountReadiness.integrations.test.ts` | type re-exports + three new fields, three capability gates, `shapeOrg` merge, response composition |
| `apps/api/src/__tests__/integration/orgAccountReadinessIntegrations.integration.test.ts` | real-Postgres matrix |
| `apps/web/src/locales/*/organizations.json` | `orgBoard.integrations.*`, `orgBoard.columns.integrations`, `orgBoard.filters.unlinked`, `orgBoard.band.unlinked`, `orgBoard.chips.{noActiveContract,noBackup}`, `orgBoard.repair.backup` |
| `apps/web/src/lib/i18n/translationCoverage.test.ts` | `organizations.json` baselines |
| `apps/web/src/lib/orgReadiness.ts` (W02, modify) + `orgReadiness.integrations.test.ts` | typed `integrations`, `connectors`; `deriveIntegrationBadges`, `hasUnlinked`, `connectorRepairs`; `'unlinked'` filter + `'integrations'` column enabled; two new chips inside `deriveReadinessChips` |
| `apps/web/src/components/organizations/board/IntegrationBadges.tsx` (+ `.test.tsx`) | badges, "not linked", "Nothing linked", muted-by-connector, pending/failed states |
| `board/AccountBoardTable.tsx` (W02, modify) + `AccountBoardTable.integrations.test.tsx` | Integrations column in every lens + phone card section |
| `board/RollupBand.tsx` (W02, modify) + `RollupBand.integrations.test.tsx` | connector repair lines |
| `board/useAccountReadiness.ts`, `board/OrganizationsBoardPage.tsx` (W02, modify) + `OrganizationsBoardPage.integrations.test.tsx` | connectors from the batch response, badges per row, connectors passed down |
| `e2e-tests/pages/OrganizationsBoardPage.ts`, `e2e-tests/tests/organizations-board.spec.ts` (W02, modify) | badge / filter / band selectors and one added scenario |

## Spec ambiguities resolved (the plan's decisions)

1. **Backup applicability.** No entitlement signal exists: `grep -rniE "backupEnabled|backup_enabled|entitle.*backup|backup.*edition" apps/api/src packages/shared/src` returns nothing; backup surfaces are gated only on `backup:read` (`Sidebar.tsx:304`); `partners.plan` (`free|pro|enterprise|unlimited`) is not tied to backup anywhere; `'backup'` in `CONFIG_FEATURE_TYPES` is a config-policy feature link, and the spec already rejected "policy ownership implies applicability" for alert rules. Therefore: **`backupApplicable` = the partner has at least one `backup_configs` row with `is_active = true` under any non-deleted org of the partner** (computed once per request, copied onto every org's `setup` so the field stays per-org if a real entitlement ever arrives). The chip fires when `backupApplicable && !backupConfigured`. A partner that has never configured a destination sees no backup chips at all.
2. **Mapping state is independent of connector state.** The API reports what the mapping table says; the web mutes every badge for a system whose connector is not `connected` and does not evaluate "not linked" for that system (spec: "mutes every org's badge … never renders as N per-org problems"). `linked` on the wire therefore means "mapping confirmed and syncing", not "and the connector is up".
3. **Pax8 / Huntress / SentinelOne connector when no row is active.** Each has a partial unique index on `(partner_id) WHERE is_active`. If the partner has rows but none active → connector state `disabled` (one repair line, badges muted, no "not linked"); if no rows at all → the system is never mentioned. Active row: Pax8 `last_sync_status = 'failed'` → `error` (the value `pax8SyncService.ts:428` writes); Huntress/S1 `last_sync_status = 'error'` → `error` (`huntressSync.ts:944`, `s1Sync.ts:912`); otherwise `connected`.
4. **DNS success value.** `dnsSyncJob.ts:614` writes `'success'`, not the spec's `'ok'`. Rule: `NULL` → pending `never_synced`; `'error'` → error `sync_error`; any other non-null value → linked (exception-only display; an unknown value is not evidence of a problem).
5. **Huntress / S1 parent `'running'` / `'partial'`.** `'running'` (`huntressSync.ts:782`) is a run in flight, `'partial'` (`s1Sync.ts:883`) is a truncated success; neither is an exception → linked. Only `NULL` is `never_synced`, only `'error'` / inactive is `connector_error`.
6. **External links consumed by PSA.** An `organization_external_links` row whose `system` equals the provider of any partner-level `psa_connections` row is the PSA mapping (linked when that connection is enabled) and is **not** also rendered as an identity badge. Every other system (`datto_rmm`, `csv`, `quickbooks`, …) is an identity badge labelled with the raw `system` value (provenance, muted, never green).
7. **"Not linked" applicability.** Evaluated only for `type = 'customer'` orgs, only for connectors the caller may see, only when that connector is `connected`. Internal orgs and orgs with a withheld section never get a dashed badge (the spec's applicability principle: no chip for a condition that may not apply). Real linked/pending/error badges render for internal orgs.
8. **Contract chip applicability** mirrors W02's billing chips: inside the `accountApplicable` block, under `billingApplies`, with `capabilities.contracts` (which already encodes native mode), `mode === 'native'` re-checked as the invoices chip does, and `activeContracts === 0`. Repair target `'billing'` (the record's Billing tab). Backup is a **setup** chip (internal orgs included), repair target `'backup'` → `/backup`.
9. **Brand names are code, not copy.** "QuickBooks", "Xero", "Pax8", "Microsoft 365", "Huntress", "SentinelOne", "ConnectWise", … are constants in `orgReadiness.ts`; only "PSA", "DNS filter", states, reasons and sentences are translated. This keeps the `translationCoverage` duplicate baselines honest.
10. **Badges are not links; the repair line is.** The spec specifies no per-badge link. Each badge carries a `title` and an accessible name with the org name; the band's connector repair line links to the connector's settings tab (`/integrations#quickbooks`, `/integrations#accounting` for Xero, `/integrations/psa`, `/integrations#pax8`, `/integrations#huntress`, `/integrations#sentinelone` — the hashes `IntegrationsPage.tsx:46-100` routes).
11. **Accounting connector `status` outside the four known values** (`accountingConnectionService.ts:15`) → `error`. An accounting `provider` other than `'xero'` → system `quickbooks` (the column comment allows only the two).
12. **One wire-type definition.** W01 declared the connector/integration types in the route file for W02's benefit; W03 defines them once in `services/orgAccountReadinessIntegrations.ts` (where they are produced) and the route re-exports them under W01's names, so no importer changes.

---

### Task 1: Wire types and pure state derivations

**Files:**
- Create: `apps/api/src/services/orgAccountReadinessIntegrations.ts`
- Test: `apps/api/src/services/orgAccountReadinessIntegrations.test.ts`

**Interfaces:**
- Consumes: Drizzle tables `accountingConnections`, `accountingEntityMappings` from `apps/api/src/db/schema` (for the join predicate only).
- Produces: types `ConnectorSystem`, `ConnectorState`, `Connector`, `IntegrationSystem`, `IntegrationState`, `IntegrationReason`, `OrgIntegration`, `IntegrationGrants`, `IntegrationReadiness`; functions `worstState(rows)`, `accountingConnectorState(status)`, `accountingMappingState(row)`, `parentMappingState(parent)`, `activeRowConnectorState(rows, failedValue)`, `m365State(row, now)`, `dnsState(row)`, `pax8MappingState(connector)`, `accountingConnectionJoin(partnerId)`, `aggregateIntegrations(orgIds, rows)`. Tasks 2–3 add the loaders to this same file.

- [ ] **Step 0: Reconcile the four (assumed) W02 pieces (once, for the whole plan)**

Run:
```bash
grep -n "^export" apps/api/src/routes/orgAccountReadiness.ts apps/api/src/services/orgAccountReadiness.ts
grep -n "^export" apps/web/src/lib/orgReadiness.ts apps/web/src/components/organizations/board/useAccountReadiness.ts apps/web/src/components/organizations/board/RollupBand.tsx apps/web/src/components/organizations/board/AccountBoardTable.tsx
grep -n "org-board-filter\|visibleFilters(\|deriveReadinessChips(\|boardTestKit" apps/web/src/components/organizations/board/OrganizationsBoardPage.tsx apps/web/src/components/organizations/board/*.test.tsx | head -20
ls apps/web/src/components/organizations/board/ e2e-tests/tests | grep -i "kit\|board"
```
Expected: the names in "The W01 / W02 surface this plan extends". For the four items marked **(assumed)** there — the page's row / cell / filter-chip construction, `boardTestKit.ts`, the E2E page object and spec, the `org-board-filter-<key>` testid — write the merged names into a scratch note and use them in Tasks 10–11. Do not rename W01/W02 exports to match this plan.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/orgAccountReadinessIntegrations.test.ts
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  accountingConnectionJoin,
  accountingConnectorState,
  accountingMappingState,
  activeRowConnectorState,
  aggregateIntegrations,
  dnsState,
  m365State,
  parentMappingState,
  pax8MappingState,
  worstState,
  type OrgIntegration,
} from './orgAccountReadinessIntegrations';

const NOW = new Date('2026-09-13T12:00:00.000Z');

describe('worstState', () => {
  it('ranks error > pending > linked > identity and keeps the first of equals', () => {
    const rows: OrgIntegration[] = [
      { system: 'm365', state: 'linked' },
      { system: 'm365', state: 'pending', reason: 'consent_pending' },
      { system: 'm365', state: 'error', reason: 'degraded' },
      { system: 'm365', state: 'error', reason: 'suspended' },
    ];
    expect(worstState(rows)).toEqual({ system: 'm365', state: 'error', reason: 'degraded' });
    expect(worstState(rows.slice(0, 2))).toEqual({ system: 'm365', state: 'pending', reason: 'consent_pending' });
    expect(worstState([])).toBeNull();
  });
});

describe('accountingConnectorState', () => {
  it.each([
    ['connected', 'connected'],
    ['reauth_required', 'reauth_required'],
    ['disconnected', 'disconnected'],
    ['error', 'error'],
    ['something-new', 'error'],
  ])('%s → %s', (status, expected) => {
    expect(accountingConnectorState(status)).toBe(expected);
  });
});

describe('accountingMappingState', () => {
  it('confirmed + synced is linked', () => {
    expect(accountingMappingState({ linkStatus: 'confirmed', syncStatus: 'synced', lastError: null })).toEqual({ state: 'linked' });
  });
  it('confirmed + pending and synced_with_tax_variance are linked', () => {
    expect(accountingMappingState({ linkStatus: 'confirmed', syncStatus: 'pending', lastError: null })).toEqual({ state: 'linked' });
    expect(accountingMappingState({ linkStatus: 'confirmed', syncStatus: 'synced_with_tax_variance', lastError: null })).toEqual({ state: 'linked' });
  });
  it('suggested and create_new are pending suggested_match', () => {
    expect(accountingMappingState({ linkStatus: 'suggested', syncStatus: 'pending', lastError: null })).toEqual({ state: 'pending', reason: 'suggested_match' });
    expect(accountingMappingState({ linkStatus: 'create_new', syncStatus: 'pending', lastError: null })).toEqual({ state: 'pending', reason: 'suggested_match' });
  });
  it('sync error or a last_error is error sync_error', () => {
    expect(accountingMappingState({ linkStatus: 'confirmed', syncStatus: 'error', lastError: null })).toEqual({ state: 'error', reason: 'sync_error' });
    expect(accountingMappingState({ linkStatus: 'confirmed', syncStatus: 'synced', lastError: 'boom' })).toEqual({ state: 'error', reason: 'sync_error' });
  });
  it('unlinked is not a mapping', () => {
    expect(accountingMappingState({ linkStatus: 'unlinked', syncStatus: 'synced', lastError: null })).toBeNull();
  });
});

describe('activeRowConnectorState', () => {
  it('is null with no rows, disabled with only inactive rows', () => {
    expect(activeRowConnectorState([], 'failed')).toBeNull();
    expect(activeRowConnectorState([{ isActive: false, lastSyncStatus: 'success' }], 'failed')).toBe('disabled');
  });
  it('reads the active row: failed value → error, anything else → connected', () => {
    expect(activeRowConnectorState([{ isActive: false, lastSyncStatus: null }, { isActive: true, lastSyncStatus: 'failed' }], 'failed')).toBe('error');
    expect(activeRowConnectorState([{ isActive: true, lastSyncStatus: null }], 'failed')).toBe('connected');
    expect(activeRowConnectorState([{ isActive: true, lastSyncStatus: 'error' }], 'error')).toBe('error');
  });
});

describe('parentMappingState (Huntress / SentinelOne)', () => {
  it.each([
    [{ isActive: false, lastSyncStatus: 'success' }, { state: 'error', reason: 'connector_error' }],
    [{ isActive: true, lastSyncStatus: 'error' }, { state: 'error', reason: 'connector_error' }],
    [{ isActive: true, lastSyncStatus: null }, { state: 'pending', reason: 'never_synced' }],
    [{ isActive: true, lastSyncStatus: 'running' }, { state: 'linked' }],
    [{ isActive: true, lastSyncStatus: 'partial' }, { state: 'linked' }],
    [{ isActive: true, lastSyncStatus: 'success' }, { state: 'linked' }],
  ])('%o → %o', (parent, expected) => {
    expect(parentMappingState(parent)).toEqual(expected);
  });
});

describe('m365State', () => {
  const base = { status: 'active', expiresAt: null, lastErrorCode: null };
  it.each([
    [{ ...base }, { state: 'linked' }],
    [{ ...base, status: 'degraded' }, { state: 'error', reason: 'degraded' }],
    [{ ...base, status: 'suspended' }, { state: 'error', reason: 'suspended' }],
    [{ ...base, lastErrorCode: 'token_refresh_failed' }, { state: 'error', reason: 'error' }],
    [{ ...base, status: 'pending-consent' }, { state: 'pending', reason: 'consent_pending' }],
    [{ ...base, status: 'verifying' }, { state: 'pending', reason: 'consent_pending' }],
    [{ ...base, expiresAt: new Date('2026-09-01T00:00:00.000Z') }, { state: 'pending', reason: 'expired' }],
    [{ ...base, expiresAt: new Date('2027-09-01T00:00:00.000Z') }, { state: 'linked' }],
  ])('%o → %o', (row, expected) => {
    expect(m365State(row, NOW)).toEqual(expected);
  });
  it('error states win over pending ones on the same row', () => {
    expect(m365State({ status: 'pending-consent', expiresAt: null, lastErrorCode: 'x' }, NOW)).toEqual({ state: 'error', reason: 'error' });
  });
});

describe('dnsState', () => {
  it.each([
    [null, { state: 'pending', reason: 'never_synced' }],
    ['error', { state: 'error', reason: 'sync_error' }],
    ['success', { state: 'linked' }],
    ['ok', { state: 'linked' }],
  ])('%s → %o', (lastSyncStatus, expected) => {
    expect(dnsState({ lastSyncStatus })).toEqual(expected);
  });
});

describe('pax8MappingState', () => {
  it('mirrors the connector: error → sync_failed, else linked', () => {
    expect(pax8MappingState('error')).toEqual({ state: 'error', reason: 'sync_failed' });
    expect(pax8MappingState('connected')).toEqual({ state: 'linked' });
  });
});

describe('accountingConnectionJoin', () => {
  it('carries the partner predicate on accounting_connections — the tenancy predicate for a partner-axis table', () => {
    const query = new PgDialect().sqlToQuery(accountingConnectionJoin('partner-1'));
    expect(query.sql).toContain('"accounting_entity_mappings"."integration_id" = "accounting_connections"."id"');
    expect(query.sql).toContain('"accounting_connections"."partner_id" = ');
    expect(query.params).toEqual(['partner-1']);
  });
});

describe('aggregateIntegrations', () => {
  it('collapses several rows for one system into the worst, keeps external rows per label, and orders systems', () => {
    const out = aggregateIntegrations(['org-a', 'org-b'], [
      { orgId: 'org-a', integration: { system: 'external', state: 'identity', label: 'datto_rmm' } },
      { orgId: 'org-a', integration: { system: 'm365', state: 'linked' } },
      { orgId: 'org-a', integration: { system: 'm365', state: 'error', reason: 'degraded' } },
      { orgId: 'org-a', integration: { system: 'quickbooks', state: 'linked' } },
      { orgId: 'org-a', integration: { system: 'external', state: 'identity', label: 'csv' } },
      { orgId: 'org-zzz', integration: { system: 'pax8', state: 'linked' } },
    ]);
    expect(out.get('org-a')).toEqual([
      { system: 'quickbooks', state: 'linked' },
      { system: 'm365', state: 'error', reason: 'degraded' },
      { system: 'external', state: 'identity', label: 'csv' },
      { system: 'external', state: 'identity', label: 'datto_rmm' },
    ]);
    expect(out.get('org-b')).toEqual([]);
    expect(out.has('org-zzz')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadinessIntegrations.test.ts`
Expected: FAIL — `Cannot find module './orgAccountReadinessIntegrations'`.

- [ ] **Step 3: Write the module (types + pure functions; loaders come in Tasks 2–3)**

```ts
// apps/api/src/services/orgAccountReadinessIntegrations.ts
/**
 * Organizations account board — W03 integrations (spec
 * docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md,
 * "Integrations cell").
 *
 * Connector state (partner-level, once per response) and org mapping state are
 * modelled separately. Everything on the wire is a CODE; the web translates.
 * The pure functions below are the whole state contract and are unit-tested
 * without a database; the loaders (further down) only fetch rows and feed them
 * through these functions.
 */
import { and, eq, type SQL } from 'drizzle-orm';
import { accountingConnections, accountingEntityMappings } from '../db/schema';

export type ConnectorSystem = 'quickbooks' | 'xero' | 'psa' | 'pax8' | 'huntress' | 'sentinelone';
export type ConnectorState = 'connected' | 'reauth_required' | 'disconnected' | 'error' | 'disabled';
export interface Connector {
  system: ConnectorSystem;
  state: ConnectorState;
  /** PSA provider id (`connectwise`, `autotask`, …) — PSA only. */
  provider?: string;
}

export type IntegrationSystem = ConnectorSystem | 'm365' | 'dns_filter' | 'external';
export type IntegrationState = 'linked' | 'pending' | 'error' | 'identity';
export type IntegrationReason =
  | 'suggested_match'
  | 'sync_error'
  | 'consent_pending'
  | 'expired'
  | 'degraded'
  | 'suspended'
  | 'error'
  | 'never_synced'
  | 'sync_failed'
  | 'disabled'
  | 'connector_error';
export interface OrgIntegration {
  system: IntegrationSystem;
  state: IntegrationState;
  reason?: IntegrationReason;
  /** `external` rows only: the raw `organization_external_links.system` value. */
  label?: string;
}

/** Sub-grants that gate individual connectors (spec: accounting needs accounting:read, Pax8 needs billing:manage). */
export interface IntegrationGrants {
  accounting: boolean;
  pax8: boolean;
}

export interface IntegrationReadiness {
  connectors: Connector[];
  /** Every accepted org id is a key; an org with nothing linked maps to `[]`. */
  byOrg: Map<string, OrgIntegration[]>;
}

/** A mapping state without its system — what each per-source derivation returns. */
export type MappingState = Omit<OrgIntegration, 'system'>;

const STATE_RANK: Record<IntegrationState, number> = { identity: 0, linked: 1, pending: 2, error: 3 };

/** Worst state wins (error > pending > linked > identity); among equals the first row is kept. */
export function worstState(rows: readonly OrgIntegration[]): OrgIntegration | null {
  let worst: OrgIntegration | null = null;
  for (const row of rows) {
    if (worst === null || STATE_RANK[row.state] > STATE_RANK[worst.state]) worst = row;
  }
  return worst;
}

export function accountingConnectorState(status: string): ConnectorState {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'reauth_required':
      return 'reauth_required';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'error';
  }
}

export interface AccountingMappingRow {
  linkStatus: string;
  syncStatus: string;
  lastError: string | null;
}

/** `null` = not a mapping at all (`unlinked`); the web then treats the system as "not linked". */
export function accountingMappingState(row: AccountingMappingRow): MappingState | null {
  if (row.linkStatus === 'unlinked') return null;
  if (row.linkStatus === 'suggested' || row.linkStatus === 'create_new') {
    return { state: 'pending', reason: 'suggested_match' };
  }
  if (row.syncStatus === 'error' || row.lastError !== null) return { state: 'error', reason: 'sync_error' };
  return { state: 'linked' };
}

export interface ParentIntegrationRow {
  isActive: boolean;
  lastSyncStatus: string | null;
}

/** Huntress / SentinelOne: the parent integration decides the org mapping's state. */
export function parentMappingState(parent: ParentIntegrationRow): MappingState {
  if (!parent.isActive || parent.lastSyncStatus === 'error') return { state: 'error', reason: 'connector_error' };
  if (parent.lastSyncStatus === null) return { state: 'pending', reason: 'never_synced' };
  return { state: 'linked' };
}

/**
 * Pax8 / Huntress / SentinelOne connector state from every row the partner has.
 * `null` = the partner has no row, so the system is never mentioned.
 * `failedValue` is what the sync worker writes on failure: 'failed' for Pax8
 * (pax8SyncService.ts), 'error' for Huntress/S1 (huntressSync.ts, s1Sync.ts).
 */
export function activeRowConnectorState(
  rows: readonly ParentIntegrationRow[],
  failedValue: string,
): ConnectorState | null {
  if (rows.length === 0) return null;
  const active = rows.find((row) => row.isActive);
  if (!active) return 'disabled';
  return active.lastSyncStatus === failedValue ? 'error' : 'connected';
}

export interface M365Row {
  status: string;
  expiresAt: Date | null;
  lastErrorCode: string | null;
}

export function m365State(row: M365Row, now: Date): MappingState {
  if (row.status === 'degraded') return { state: 'error', reason: 'degraded' };
  if (row.status === 'suspended') return { state: 'error', reason: 'suspended' };
  if (row.lastErrorCode !== null) return { state: 'error', reason: 'error' };
  if (row.status === 'pending-consent' || row.status === 'verifying') return { state: 'pending', reason: 'consent_pending' };
  if (row.expiresAt !== null && row.expiresAt.getTime() < now.getTime()) return { state: 'pending', reason: 'expired' };
  return { state: 'linked' };
}

export interface DnsRow {
  lastSyncStatus: string | null;
}

/** dnsSyncJob writes 'success' / 'error'; NULL means the integration never ran. */
export function dnsState(row: DnsRow): MappingState {
  if (row.lastSyncStatus === null) return { state: 'pending', reason: 'never_synced' };
  if (row.lastSyncStatus === 'error') return { state: 'error', reason: 'sync_error' };
  return { state: 'linked' };
}

export function pax8MappingState(connector: ConnectorState): MappingState {
  return connector === 'error' ? { state: 'error', reason: 'sync_failed' } : { state: 'linked' };
}

/**
 * The accounting join IS the tenancy predicate: accounting_entity_mappings is
 * partner-axis RLS and has no org_id, so the mapping → connection join must
 * carry the partner explicitly (spec, Integrations table row 1).
 */
export function accountingConnectionJoin(partnerId: string): SQL {
  return and(
    eq(accountingEntityMappings.integrationId, accountingConnections.id),
    eq(accountingConnections.partnerId, partnerId),
  ) as SQL;
}

const SYSTEM_ORDER: Record<IntegrationSystem, number> = {
  quickbooks: 0,
  xero: 1,
  psa: 2,
  pax8: 3,
  m365: 4,
  dns_filter: 5,
  huntress: 6,
  sentinelone: 7,
  external: 8,
};

export interface OrgIntegrationRow {
  orgId: string;
  integration: OrgIntegration;
}

/** Group per (org, system) — external rows per (org, label) — collapse each group to its worst state, order systems. */
export function aggregateIntegrations(
  orgIds: readonly string[],
  rows: readonly OrgIntegrationRow[],
): Map<string, OrgIntegration[]> {
  const groups = new Map<string, Map<string, OrgIntegration[]>>();
  for (const id of orgIds) groups.set(id, new Map());
  for (const { orgId, integration } of rows) {
    const orgGroups = groups.get(orgId);
    if (!orgGroups) continue;
    const key = integration.system === 'external' ? `external:${integration.label ?? ''}` : integration.system;
    const bucket = orgGroups.get(key);
    if (bucket) bucket.push(integration);
    else orgGroups.set(key, [integration]);
  }
  const out = new Map<string, OrgIntegration[]>();
  for (const [orgId, orgGroups] of groups) {
    const collapsed: OrgIntegration[] = [];
    for (const bucket of orgGroups.values()) {
      const worst = worstState(bucket);
      if (worst) collapsed.push(worst);
    }
    collapsed.sort(
      (a, b) =>
        SYSTEM_ORDER[a.system] - SYSTEM_ORDER[b.system] || (a.label ?? '').localeCompare(b.label ?? ''),
    );
    out.set(orgId, collapsed);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadinessIntegrations.test.ts`
Expected: PASS (11 describe blocks, every `it.each` row green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/orgAccountReadinessIntegrations.ts apps/api/src/services/orgAccountReadinessIntegrations.test.ts
git commit -m "feat(api): account-readiness integration state contract — connector/mapping types, reason codes, worst-state aggregation (W03 #5724)"
```

---

### Task 2: Loaders — accounting, PSA and external identity

**Files:**
- Modify: `apps/api/src/services/orgAccountReadinessIntegrations.ts` (append below `aggregateIntegrations`)
- Test: `apps/api/src/services/orgAccountReadinessIntegrations.loaders.test.ts`

**Interfaces:**
- Consumes: Task 1's types and pure functions; `db` from `apps/api/src/db`; tables `accountingConnections`, `accountingEntityMappings`, `psaConnections`, `organizationExternalLinks`.
- Produces: `loadAccounting(partnerId, orgIds, grants): Promise<SourceResult>`, `loadPsaAndExternal(partnerId, orgIds): Promise<SourceResult>`, `interface SourceResult { connectors: Connector[]; rows: OrgIntegrationRow[] }`. Task 3 adds the remaining sources and `loadIntegrationReadiness`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/orgAccountReadinessIntegrations.loaders.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: { select: vi.fn(), selectDistinct: vi.fn() },
}));

import { db } from '../db';
import {
  accountingConnections,
  accountingEntityMappings,
  organizationExternalLinks,
  psaConnections,
} from '../db/schema';
import { loadAccounting, loadPsaAndExternal } from './orgAccountReadinessIntegrations';

const PARTNER = '00000000-0000-0000-0000-00000000aaaa';
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

/** Table-keyed row stubs (the orgSummary.test.ts pattern): `db.select().from(table)`
 * looks rows up by the table object, so tests read as "these rows exist". Every
 * chain method is captured per table so a test can compile the real SQL. */
const joins = new Map<unknown, unknown>();
const wheres = new Map<unknown, unknown>();

function chain(table: unknown, rows: unknown[]) {
  const result = Promise.resolve(rows) as Promise<unknown[]> & Record<string, (...args: never[]) => unknown>;
  const self = result as unknown as Record<string, unknown>;
  self.innerJoin = (_other: unknown, condition: unknown) => { joins.set(table, condition); return result; };
  self.where = (condition: unknown) => { wheres.set(table, condition); return result; };
  self.groupBy = () => result;
  self.limit = () => result;
  return result;
}

function setupDb(rowsByTable: Map<unknown, unknown[]>) {
  const impl = () => ({ from: (table: unknown) => chain(table, rowsByTable.get(table) ?? []) }) as never;
  vi.mocked(db.select).mockImplementation(impl);
  vi.mocked(db.selectDistinct).mockImplementation(impl);
}

function compiled(captured: Map<unknown, unknown>, table: unknown) {
  const condition = captured.get(table);
  if (!condition) throw new Error('nothing captured for that table');
  return new PgDialect().sqlToQuery(condition as SQL);
}

beforeEach(() => {
  vi.clearAllMocks();
  joins.clear();
  wheres.clear();
});

describe('loadAccounting', () => {
  it('returns nothing without accounting:read and never touches the database', async () => {
    setupDb(new Map());
    const out = await loadAccounting(PARTNER, [ORG_A], { accounting: false, pax8: true });
    expect(out).toEqual({ connectors: [], rows: [] });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('emits one connector per connection and one row per non-unlinked org mapping', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [accountingConnections, [{ id: 'conn-1', provider: 'quickbooks', status: 'reauth_required' }]],
      [accountingEntityMappings, [
        { orgId: ORG_A, provider: 'quickbooks', linkStatus: 'confirmed', syncStatus: 'synced', lastError: null },
        { orgId: ORG_B, provider: 'quickbooks', linkStatus: 'unlinked', syncStatus: 'pending', lastError: null },
      ]],
    ]));
    const out = await loadAccounting(PARTNER, [ORG_A, ORG_B], { accounting: true, pax8: false });
    expect(out.connectors).toEqual([{ system: 'quickbooks', state: 'reauth_required' }]);
    expect(out.rows).toEqual([{ orgId: ORG_A, integration: { system: 'quickbooks', state: 'linked' } }]);
  });

  it('joins mappings to connections on integration_id AND partner_id, restricted to org mappings of the accepted ids', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [accountingConnections, [{ id: 'conn-1', provider: 'xero', status: 'connected' }]],
      [accountingEntityMappings, []],
    ]));
    await loadAccounting(PARTNER, [ORG_A], { accounting: true, pax8: false });
    const join = compiled(joins, accountingEntityMappings);
    expect(join.sql).toContain('"accounting_connections"."partner_id" = ');
    expect(join.params).toContain(PARTNER);
    const where = compiled(wheres, accountingEntityMappings);
    expect(where.sql).toContain('"accounting_entity_mappings"."breeze_entity_type" = ');
    expect(where.sql).toContain('"accounting_entity_mappings"."breeze_entity_id" in (');
    expect(where.params).toEqual(['org', ORG_A]);
  });

  it('skips the mapping query when the partner has no connection or no org survived', async () => {
    setupDb(new Map<unknown, unknown[]>([[accountingConnections, []]]));
    await loadAccounting(PARTNER, [ORG_A], { accounting: true, pax8: false });
    expect(wheres.has(accountingEntityMappings)).toBe(false);
    setupDb(new Map<unknown, unknown[]>([[accountingConnections, [{ id: 'c', provider: 'quickbooks', status: 'connected' }]]]));
    await loadAccounting(PARTNER, [], { accounting: true, pax8: false });
    expect(wheres.has(accountingEntityMappings)).toBe(false);
  });
});

describe('loadPsaAndExternal', () => {
  it('partner-level connections become connectors; org-level rows, provider-matching links and other links become rows', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [psaConnections, [
        { orgId: null, provider: 'connectwise', enabled: true },
        { orgId: null, provider: 'autotask', enabled: false },
        { orgId: ORG_B, provider: 'jira', enabled: false },
      ]],
      [organizationExternalLinks, [
        { orgId: ORG_A, system: 'connectwise' },
        { orgId: ORG_A, system: 'autotask' },
        { orgId: ORG_A, system: 'datto_rmm' },
        { orgId: ORG_B, system: 'csv' },
      ]],
    ]));
    const out = await loadPsaAndExternal(PARTNER, [ORG_A, ORG_B]);
    expect(out.connectors).toEqual([
      { system: 'psa', state: 'connected', provider: 'connectwise' },
      { system: 'psa', state: 'disabled', provider: 'autotask' },
    ]);
    expect(out.rows).toEqual([
      { orgId: ORG_B, integration: { system: 'psa', state: 'error', reason: 'disabled' } },
      { orgId: ORG_A, integration: { system: 'psa', state: 'linked' } },
      { orgId: ORG_A, integration: { system: 'external', state: 'identity', label: 'datto_rmm' } },
      { orgId: ORG_B, integration: { system: 'external', state: 'identity', label: 'csv' } },
    ]);
  });

  it('scopes psa_connections to the partner axis OR the accepted org ids, and links to the accepted ids', async () => {
    setupDb(new Map<unknown, unknown[]>([[psaConnections, []], [organizationExternalLinks, []]]));
    await loadPsaAndExternal(PARTNER, [ORG_A]);
    const psaWhere = compiled(wheres, psaConnections);
    expect(psaWhere.sql).toContain('"psa_connections"."partner_id" = ');
    expect(psaWhere.sql).toContain('"psa_connections"."org_id" is null');
    expect(psaWhere.sql).toContain('"psa_connections"."org_id" in (');
    expect(psaWhere.params).toEqual([PARTNER, ORG_A]);
    const linkWhere = compiled(wheres, organizationExternalLinks);
    expect(linkWhere.sql).toContain('"organization_external_links"."org_id" in (');
    expect(linkWhere.params).toEqual([ORG_A]);
  });

  it('with no accepted org still reports partner-level connectors and reads no links', async () => {
    setupDb(new Map<unknown, unknown[]>([[psaConnections, [{ orgId: null, provider: 'zendesk', enabled: true }]]]));
    const out = await loadPsaAndExternal(PARTNER, []);
    expect(out.connectors).toEqual([{ system: 'psa', state: 'connected', provider: 'zendesk' }]);
    expect(out.rows).toEqual([]);
    expect(wheres.has(organizationExternalLinks)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadinessIntegrations.loaders.test.ts`
Expected: FAIL — `loadAccounting is not a function` / `loadPsaAndExternal is not a function`.

- [ ] **Step 3: Append the two loaders**

Add to the imports at the top of `orgAccountReadinessIntegrations.ts`:

```ts
import { and, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  accountingConnections,
  accountingEntityMappings,
  organizationExternalLinks,
  psaConnections,
} from '../db/schema';
```
(replace the Task 1 import lines for `drizzle-orm` and `../db/schema`.)

Append at the end of the file:

```ts
export interface SourceResult {
  connectors: Connector[];
  rows: OrgIntegrationRow[];
}

const EMPTY: SourceResult = { connectors: [], rows: [] };

function accountingSystem(provider: string): 'quickbooks' | 'xero' {
  return provider === 'xero' ? 'xero' : 'quickbooks';
}

/**
 * QuickBooks / Xero. Gated on accounting:read (spec: "accounting additionally
 * accounting:read"): without it neither the connector nor any org badge exists.
 */
export async function loadAccounting(
  partnerId: string,
  orgIds: readonly string[],
  grants: IntegrationGrants,
): Promise<SourceResult> {
  if (!grants.accounting) return EMPTY;
  const connections = await db
    .select({
      id: accountingConnections.id,
      provider: accountingConnections.provider,
      status: accountingConnections.status,
    })
    .from(accountingConnections)
    .where(eq(accountingConnections.partnerId, partnerId));
  const connectors: Connector[] = connections.map((c) => ({
    system: accountingSystem(c.provider),
    state: accountingConnectorState(c.status),
  }));
  if (connections.length === 0 || orgIds.length === 0) return { connectors, rows: [] };

  const mappings = await db
    .select({
      orgId: accountingEntityMappings.breezeEntityId,
      provider: accountingConnections.provider,
      linkStatus: accountingEntityMappings.linkStatus,
      syncStatus: accountingEntityMappings.syncStatus,
      lastError: accountingEntityMappings.lastError,
    })
    .from(accountingEntityMappings)
    .innerJoin(accountingConnections, accountingConnectionJoin(partnerId))
    .where(
      and(
        eq(accountingEntityMappings.breezeEntityType, 'org'),
        inArray(accountingEntityMappings.breezeEntityId, [...orgIds]),
      ),
    );
  const rows: OrgIntegrationRow[] = [];
  for (const m of mappings) {
    const state = accountingMappingState(m);
    if (state) rows.push({ orgId: m.orgId, integration: { system: accountingSystem(m.provider), ...state } });
  }
  return { connectors, rows };
}

/**
 * PSA (partner-level connections + org-level connections + provider-matching
 * external links) and external identity (every other external link). One
 * psa_connections query — partner axis OR accepted org ids — and one
 * organization_external_links query; the split happens here.
 */
export async function loadPsaAndExternal(
  partnerId: string,
  orgIds: readonly string[],
): Promise<SourceResult> {
  const partnerLevel = and(eq(psaConnections.partnerId, partnerId), isNull(psaConnections.orgId)) as SQL;
  const connections = await db
    .select({ orgId: psaConnections.orgId, provider: psaConnections.provider, enabled: psaConnections.enabled })
    .from(psaConnections)
    .where(orgIds.length === 0 ? partnerLevel : (or(partnerLevel, inArray(psaConnections.orgId, [...orgIds])) as SQL));

  const connectors: Connector[] = [];
  const psaProviders = new Set<string>();
  const enabledProviders = new Set<string>();
  const rows: OrgIntegrationRow[] = [];
  for (const c of connections) {
    if (c.orgId === null) {
      connectors.push({ system: 'psa', state: c.enabled ? 'connected' : 'disabled', provider: c.provider });
      psaProviders.add(c.provider);
      if (c.enabled) enabledProviders.add(c.provider);
    } else {
      rows.push({
        orgId: c.orgId,
        integration: c.enabled ? { system: 'psa', state: 'linked' } : { system: 'psa', state: 'error', reason: 'disabled' },
      });
    }
  }
  if (orgIds.length === 0) return { connectors, rows };

  const links = await db
    .select({ orgId: organizationExternalLinks.orgId, system: organizationExternalLinks.system })
    .from(organizationExternalLinks)
    .where(inArray(organizationExternalLinks.orgId, [...orgIds]));
  const identity: OrgIntegrationRow[] = [];
  for (const link of links) {
    if (enabledProviders.has(link.system)) {
      rows.push({ orgId: link.orgId, integration: { system: 'psa', state: 'linked' } });
    } else if (!psaProviders.has(link.system)) {
      identity.push({ orgId: link.orgId, integration: { system: 'external', state: 'identity', label: link.system } });
    }
    // A link for a partner-level provider that is DISABLED is consumed by the
    // PSA check (its repair is the connector, reported once in the band) and
    // is deliberately neither a PSA row nor an identity badge.
  }
  return { connectors, rows: [...rows, ...identity] };
}
```

- [ ] **Step 4: Run both test files to verify they pass**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadinessIntegrations.test.ts src/services/orgAccountReadinessIntegrations.loaders.test.ts`
Expected: PASS, 2 files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/orgAccountReadinessIntegrations.ts apps/api/src/services/orgAccountReadinessIntegrations.loaders.test.ts
git commit -m "feat(api): account-readiness loaders for accounting, PSA and external identity with explicit partner join (W03 #5724)"
```

---

### Task 3: Loaders — Pax8, Microsoft 365, DNS filter, Huntress, SentinelOne, and `loadIntegrationReadiness`

**Files:**
- Modify: `apps/api/src/services/orgAccountReadinessIntegrations.ts` (append)
- Test: `apps/api/src/services/orgAccountReadinessIntegrations.loaders.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 1–2; tables `pax8Integrations`, `pax8CompanyMappings`, `m365Connections`, `dnsFilterIntegrations`, `huntressIntegrations`, `huntressOrgMappings`, `s1Integrations`, `s1OrgMappings`.
- Produces: `loadPax8(partnerId, orgIds, grants)`, `loadM365(orgIds, now)`, `loadDns(orgIds)`, `loadHuntress(partnerId, orgIds)`, `loadSentinelOne(partnerId, orgIds)` (all `Promise<SourceResult>`), and `loadIntegrationReadiness(input: { partnerId: string; orgIds: readonly string[]; grants: IntegrationGrants; now: Date }): Promise<IntegrationReadiness>` — the single entry point Task 5 calls.

- [ ] **Step 1: Append the failing tests**

Add these imports to the existing import from `'../db/schema'` and `'./orgAccountReadinessIntegrations'` in the loaders test:

```ts
import {
  accountingConnections,
  accountingEntityMappings,
  dnsFilterIntegrations,
  huntressIntegrations,
  huntressOrgMappings,
  m365Connections,
  organizationExternalLinks,
  pax8CompanyMappings,
  pax8Integrations,
  psaConnections,
  s1Integrations,
  s1OrgMappings,
} from '../db/schema';
import {
  loadAccounting,
  loadDns,
  loadHuntress,
  loadIntegrationReadiness,
  loadM365,
  loadPax8,
  loadPsaAndExternal,
  loadSentinelOne,
} from './orgAccountReadinessIntegrations';
```

Append:

```ts
const NOW = new Date('2026-09-13T12:00:00.000Z');

describe('loadPax8', () => {
  it('returns nothing without billing:manage', async () => {
    setupDb(new Map());
    expect(await loadPax8(PARTNER, [ORG_A], { accounting: true, pax8: false })).toEqual({ connectors: [], rows: [] });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('reads mappings only under the ACTIVE integration and mirrors its sync state', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [pax8Integrations, [
        { id: 'old', isActive: false, lastSyncStatus: 'success' },
        { id: 'live', isActive: true, lastSyncStatus: 'failed' },
      ]],
      [pax8CompanyMappings, [{ orgId: ORG_A }]],
    ]));
    const out = await loadPax8(PARTNER, [ORG_A, ORG_B], { accounting: false, pax8: true });
    expect(out.connectors).toEqual([{ system: 'pax8', state: 'error' }]);
    expect(out.rows).toEqual([{ orgId: ORG_A, integration: { system: 'pax8', state: 'error', reason: 'sync_failed' } }]);
    const where = compiled(wheres, pax8CompanyMappings);
    expect(where.sql).toContain('"pax8_company_mappings"."integration_id" = ');
    expect(where.sql).toContain('"pax8_company_mappings"."partner_id" = ');
    expect(where.sql).toContain('"pax8_company_mappings"."ignored" = ');
    expect(where.sql).toContain('"pax8_company_mappings"."org_id" in (');
    expect(where.params).toEqual(['live', PARTNER, false, ORG_A, ORG_B]);
  });

  it('with only inactive integrations reports disabled and reads no mappings', async () => {
    setupDb(new Map<unknown, unknown[]>([[pax8Integrations, [{ id: 'old', isActive: false, lastSyncStatus: null }]]]));
    const out = await loadPax8(PARTNER, [ORG_A], { accounting: false, pax8: true });
    expect(out).toEqual({ connectors: [{ system: 'pax8', state: 'disabled' }], rows: [] });
    expect(wheres.has(pax8CompanyMappings)).toBe(false);
  });
});

describe('loadM365', () => {
  it('excludes revoked rows in SQL and derives one row per profile', async () => {
    setupDb(new Map<unknown, unknown[]>([[m365Connections, [
      { orgId: ORG_A, status: 'active', expiresAt: null, lastErrorCode: null },
      { orgId: ORG_A, status: 'degraded', expiresAt: null, lastErrorCode: null },
    ]]]));
    const out = await loadM365([ORG_A], NOW);
    expect(out.connectors).toEqual([]);
    expect(out.rows).toEqual([
      { orgId: ORG_A, integration: { system: 'm365', state: 'linked' } },
      { orgId: ORG_A, integration: { system: 'm365', state: 'error', reason: 'degraded' } },
    ]);
    const where = compiled(wheres, m365Connections);
    expect(where.sql).toContain('"m365_connections"."org_id" in (');
    expect(where.sql).toContain('"m365_connections"."revoked_at" is null');
    expect(where.sql).toContain('"m365_connections"."status" <> ');
    expect(where.params).toEqual([ORG_A, 'revoked']);
  });
});

describe('loadDns', () => {
  it('reads active integrations of the accepted orgs', async () => {
    setupDb(new Map<unknown, unknown[]>([[dnsFilterIntegrations, [{ orgId: ORG_A, lastSyncStatus: null }]]]));
    const out = await loadDns([ORG_A]);
    expect(out.rows).toEqual([{ orgId: ORG_A, integration: { system: 'dns_filter', state: 'pending', reason: 'never_synced' } }]);
    const where = compiled(wheres, dnsFilterIntegrations);
    expect(where.sql).toContain('"dns_filter_integrations"."is_active" = ');
    expect(where.params).toEqual([ORG_A, true]);
  });
});

describe('loadHuntress / loadSentinelOne', () => {
  it('Huntress: connector from all rows, mapping state from the joined parent, join carries the partner', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [huntressIntegrations, [{ id: 'h1', isActive: false, lastSyncStatus: 'success' }]],
      [huntressOrgMappings, [{ orgId: ORG_A, isActive: false, lastSyncStatus: 'success' }]],
    ]));
    const out = await loadHuntress(PARTNER, [ORG_A]);
    expect(out.connectors).toEqual([{ system: 'huntress', state: 'disabled' }]);
    expect(out.rows).toEqual([{ orgId: ORG_A, integration: { system: 'huntress', state: 'error', reason: 'connector_error' } }]);
    const join = compiled(joins, huntressOrgMappings);
    expect(join.sql).toContain('"huntress_integrations"."partner_id" = ');
    expect(join.params).toEqual([PARTNER]);
    const where = compiled(wheres, huntressOrgMappings);
    expect(where.sql).toContain('"huntress_org_mappings"."partner_id" = ');
    expect(where.sql).toContain('"huntress_org_mappings"."org_id" in (');
    expect(where.params).toEqual([PARTNER, ORG_A]);
  });

  it('SentinelOne: active parent never synced → pending never_synced; a partial sync is linked', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [s1Integrations, [{ id: 's1', isActive: true, lastSyncStatus: null }]],
      [s1OrgMappings, [
        { orgId: ORG_A, isActive: true, lastSyncStatus: null },
        { orgId: ORG_B, isActive: true, lastSyncStatus: 'partial' },
      ]],
    ]));
    const out = await loadSentinelOne(PARTNER, [ORG_A, ORG_B]);
    expect(out.connectors).toEqual([{ system: 'sentinelone', state: 'connected' }]);
    expect(out.rows).toEqual([
      { orgId: ORG_A, integration: { system: 'sentinelone', state: 'pending', reason: 'never_synced' } },
      { orgId: ORG_B, integration: { system: 'sentinelone', state: 'linked' } },
    ]);
  });

  it('a partner with no Huntress row mentions no connector and reads no mappings', async () => {
    setupDb(new Map<unknown, unknown[]>([[huntressIntegrations, []]]));
    expect(await loadHuntress(PARTNER, [ORG_A])).toEqual({ connectors: [], rows: [] });
    expect(wheres.has(huntressOrgMappings)).toBe(false);
  });
});

describe('loadIntegrationReadiness', () => {
  it('composes every source, aggregates per org and keys every accepted org', async () => {
    setupDb(new Map<unknown, unknown[]>([
      [accountingConnections, [{ id: 'c1', provider: 'quickbooks', status: 'connected' }]],
      [accountingEntityMappings, [{ orgId: ORG_A, provider: 'quickbooks', linkStatus: 'confirmed', syncStatus: 'synced', lastError: null }]],
      [psaConnections, []],
      [organizationExternalLinks, []],
      [pax8Integrations, []],
      [m365Connections, [
        { orgId: ORG_A, status: 'active', expiresAt: null, lastErrorCode: null },
        { orgId: ORG_A, status: 'verifying', expiresAt: null, lastErrorCode: null },
      ]],
      [dnsFilterIntegrations, []],
      [huntressIntegrations, []],
      [s1Integrations, []],
    ]));
    const out = await loadIntegrationReadiness({ partnerId: PARTNER, orgIds: [ORG_A, ORG_B], grants: { accounting: true, pax8: true }, now: NOW });
    expect(out.connectors).toEqual([{ system: 'quickbooks', state: 'connected' }]);
    expect(out.byOrg.get(ORG_A)).toEqual([
      { system: 'quickbooks', state: 'linked' },
      { system: 'm365', state: 'pending', reason: 'consent_pending' },
    ]);
    expect(out.byOrg.get(ORG_B)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the file to verify the new blocks fail**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadinessIntegrations.loaders.test.ts`
Expected: FAIL — `loadPax8 is not a function` (and the four siblings); Task 2's blocks still pass.

- [ ] **Step 3: Append the loaders and the entry point**

Extend the schema import to:

```ts
import {
  accountingConnections,
  accountingEntityMappings,
  dnsFilterIntegrations,
  huntressIntegrations,
  huntressOrgMappings,
  m365Connections,
  organizationExternalLinks,
  pax8CompanyMappings,
  pax8Integrations,
  psaConnections,
  s1Integrations,
  s1OrgMappings,
} from '../db/schema';
```
and the drizzle import to `import { and, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';`.

Append:

```ts
/** Pax8. Gated on billing:manage — the grant every Pax8 read route requires (routes/pax8.ts). */
export async function loadPax8(
  partnerId: string,
  orgIds: readonly string[],
  grants: IntegrationGrants,
): Promise<SourceResult> {
  if (!grants.pax8) return EMPTY;
  const integrations = await db
    .select({ id: pax8Integrations.id, isActive: pax8Integrations.isActive, lastSyncStatus: pax8Integrations.lastSyncStatus })
    .from(pax8Integrations)
    .where(eq(pax8Integrations.partnerId, partnerId));
  const state = activeRowConnectorState(integrations, 'failed');
  if (state === null) return EMPTY;
  const connectors: Connector[] = [{ system: 'pax8', state }];
  const active = integrations.find((row) => row.isActive);
  if (!active || orgIds.length === 0) return { connectors, rows: [] };

  const mappings = await db
    .select({ orgId: pax8CompanyMappings.orgId })
    .from(pax8CompanyMappings)
    .where(
      and(
        eq(pax8CompanyMappings.integrationId, active.id),
        eq(pax8CompanyMappings.partnerId, partnerId),
        eq(pax8CompanyMappings.ignored, false),
        inArray(pax8CompanyMappings.orgId, [...orgIds]),
      ),
    );
  const mappingState = pax8MappingState(state);
  const rows: OrgIntegrationRow[] = [];
  for (const m of mappings) {
    if (m.orgId !== null) rows.push({ orgId: m.orgId, integration: { system: 'pax8', ...mappingState } });
  }
  return { connectors, rows };
}

/** Microsoft 365: one row per (org, profile); revoked rows are excluded in SQL. No partner connector exists. */
export async function loadM365(orgIds: readonly string[], now: Date): Promise<SourceResult> {
  if (orgIds.length === 0) return EMPTY;
  const connections = await db
    .select({
      orgId: m365Connections.orgId,
      status: m365Connections.status,
      expiresAt: m365Connections.expiresAt,
      lastErrorCode: m365Connections.lastErrorCode,
    })
    .from(m365Connections)
    .where(
      and(
        inArray(m365Connections.orgId, [...orgIds]),
        isNull(m365Connections.revokedAt),
        ne(m365Connections.status, 'revoked'),
      ),
    );
  const rows: OrgIntegrationRow[] = [];
  for (const c of connections) {
    if (c.orgId !== null) rows.push({ orgId: c.orgId, integration: { system: 'm365', ...m365State(c, now) } });
  }
  return { connectors: [], rows };
}

/** DNS filter: active integrations of the accepted orgs. No partner connector exists. */
export async function loadDns(orgIds: readonly string[]): Promise<SourceResult> {
  if (orgIds.length === 0) return EMPTY;
  const integrations = await db
    .select({ orgId: dnsFilterIntegrations.orgId, lastSyncStatus: dnsFilterIntegrations.lastSyncStatus })
    .from(dnsFilterIntegrations)
    .where(and(inArray(dnsFilterIntegrations.orgId, [...orgIds]), eq(dnsFilterIntegrations.isActive, true)));
  return {
    connectors: [],
    rows: integrations.map((row) => ({ orgId: row.orgId, integration: { system: 'dns_filter', ...dnsState(row) } })),
  };
}

export async function loadHuntress(partnerId: string, orgIds: readonly string[]): Promise<SourceResult> {
  const integrations = await db
    .select({ id: huntressIntegrations.id, isActive: huntressIntegrations.isActive, lastSyncStatus: huntressIntegrations.lastSyncStatus })
    .from(huntressIntegrations)
    .where(eq(huntressIntegrations.partnerId, partnerId));
  const state = activeRowConnectorState(integrations, 'error');
  if (state === null) return EMPTY;
  const connectors: Connector[] = [{ system: 'huntress', state }];
  if (orgIds.length === 0) return { connectors, rows: [] };

  const mappings = await db
    .select({
      orgId: huntressOrgMappings.orgId,
      isActive: huntressIntegrations.isActive,
      lastSyncStatus: huntressIntegrations.lastSyncStatus,
    })
    .from(huntressOrgMappings)
    .innerJoin(
      huntressIntegrations,
      and(eq(huntressOrgMappings.integrationId, huntressIntegrations.id), eq(huntressIntegrations.partnerId, partnerId)),
    )
    .where(and(eq(huntressOrgMappings.partnerId, partnerId), inArray(huntressOrgMappings.orgId, [...orgIds])));
  const rows: OrgIntegrationRow[] = [];
  for (const m of mappings) {
    if (m.orgId !== null) rows.push({ orgId: m.orgId, integration: { system: 'huntress', ...parentMappingState(m) } });
  }
  return { connectors, rows };
}

export async function loadSentinelOne(partnerId: string, orgIds: readonly string[]): Promise<SourceResult> {
  const integrations = await db
    .select({ id: s1Integrations.id, isActive: s1Integrations.isActive, lastSyncStatus: s1Integrations.lastSyncStatus })
    .from(s1Integrations)
    .where(eq(s1Integrations.partnerId, partnerId));
  const state = activeRowConnectorState(integrations, 'error');
  if (state === null) return EMPTY;
  const connectors: Connector[] = [{ system: 'sentinelone', state }];
  if (orgIds.length === 0) return { connectors, rows: [] };

  const mappings = await db
    .select({
      orgId: s1OrgMappings.orgId,
      isActive: s1Integrations.isActive,
      lastSyncStatus: s1Integrations.lastSyncStatus,
    })
    .from(s1OrgMappings)
    .innerJoin(
      s1Integrations,
      and(eq(s1OrgMappings.integrationId, s1Integrations.id), eq(s1Integrations.partnerId, partnerId)),
    )
    .where(and(eq(s1OrgMappings.partnerId, partnerId), inArray(s1OrgMappings.orgId, [...orgIds])));
  const rows: OrgIntegrationRow[] = [];
  for (const m of mappings) {
    if (m.orgId !== null) rows.push({ orgId: m.orgId, integration: { system: 'sentinelone', ...parentMappingState(m) } });
  }
  return { connectors, rows };
}

/**
 * Entry point. Runs inside the caller's request transaction (single
 * connection): Promise.all is orchestration only, not parallelism. Never
 * escape the context to get parallelism (spec, implementation rules).
 */
export async function loadIntegrationReadiness(input: {
  partnerId: string;
  orgIds: readonly string[];
  grants: IntegrationGrants;
  now: Date;
}): Promise<IntegrationReadiness> {
  const { partnerId, orgIds, grants, now } = input;
  const sources = await Promise.all([
    loadAccounting(partnerId, orgIds, grants),
    loadPsaAndExternal(partnerId, orgIds),
    loadPax8(partnerId, orgIds, grants),
    loadM365(orgIds, now),
    loadDns(orgIds),
    loadHuntress(partnerId, orgIds),
    loadSentinelOne(partnerId, orgIds),
  ]);
  const connectors = sources.flatMap((s) => s.connectors);
  const rows = sources.flatMap((s) => s.rows);
  return { connectors, byOrg: aggregateIntegrations(orgIds, rows) };
}
```

- [ ] **Step 4: Run both test files to verify they pass**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadinessIntegrations.test.ts src/services/orgAccountReadinessIntegrations.loaders.test.ts`
Expected: PASS, 2 files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/orgAccountReadinessIntegrations.ts apps/api/src/services/orgAccountReadinessIntegrations.loaders.test.ts
git commit -m "feat(api): account-readiness loaders for Pax8, M365, DNS, Huntress, SentinelOne + loadIntegrationReadiness (W03 #5724)"
```

---

### Task 4: Commercial loaders — active contracts and backup applicability

**Files:**
- Create: `apps/api/src/services/orgAccountReadinessCommercial.ts`
- Test: `apps/api/src/services/orgAccountReadinessCommercial.test.ts`

**Interfaces:**
- Consumes: `db`; tables `contracts`, `backupConfigs`, `organizations`.
- Produces: `loadActiveContractCounts(orgIds: readonly string[]): Promise<Map<string, number>>` (only orgs with ≥1 active contract are keys); `interface BackupReadiness { applicable: boolean; configuredOrgIds: Set<string> }`; `loadBackupReadiness(partnerId: string, orgIds: readonly string[]): Promise<BackupReadiness>`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/orgAccountReadinessCommercial.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: { select: vi.fn(), selectDistinct: vi.fn() },
}));

import { db } from '../db';
import { backupConfigs, contracts } from '../db/schema';
import { loadActiveContractCounts, loadBackupReadiness } from './orgAccountReadinessCommercial';

const PARTNER = '00000000-0000-0000-0000-00000000aaaa';
const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const joins = new Map<unknown, unknown>();
const wheres = new Map<unknown, unknown>();

function chain(table: unknown, rows: unknown[]) {
  const result = Promise.resolve(rows) as Promise<unknown[]>;
  const self = result as unknown as Record<string, unknown>;
  self.innerJoin = (_other: unknown, condition: unknown) => { joins.set(table, condition); return result; };
  self.where = (condition: unknown) => { wheres.set(table, condition); return result; };
  self.groupBy = () => result;
  self.limit = () => result;
  return result;
}

/** `sequence` lets one table answer two different queries in call order —
 * loadBackupReadiness reads backup_configs twice (partner-wide EXISTS, then per-org). */
function setupDb(rowsByTable: Map<unknown, unknown[] | { sequence: unknown[][] }>) {
  const impl = () => ({
    from: (table: unknown) => {
      const spec = rowsByTable.get(table);
      if (spec && !Array.isArray(spec)) return chain(table, spec.sequence.shift() ?? []);
      return chain(table, spec ?? []);
    },
  }) as never;
  vi.mocked(db.select).mockImplementation(impl);
  vi.mocked(db.selectDistinct).mockImplementation(impl);
}

function compiled(captured: Map<unknown, unknown>, table: unknown) {
  const condition = captured.get(table);
  if (!condition) throw new Error('nothing captured for that table');
  return new PgDialect().sqlToQuery(condition as SQL);
}

beforeEach(() => {
  vi.clearAllMocks();
  joins.clear();
  wheres.clear();
});

describe('loadActiveContractCounts', () => {
  it('counts active contracts that have no end date or end today or later, per org', async () => {
    setupDb(new Map<unknown, unknown[]>([[contracts, [{ orgId: ORG_A, active: '2' }]]]));
    const out = await loadActiveContractCounts([ORG_A, ORG_B]);
    expect(out.get(ORG_A)).toBe(2);
    expect(out.has(ORG_B)).toBe(false);
    const where = compiled(wheres, contracts);
    expect(where.sql).toContain('"contracts"."org_id" in (');
    expect(where.sql).toContain('"contracts"."status" = ');
    expect(where.sql).toContain('"contracts"."end_date" is null');
    expect(where.sql).toContain('"contracts"."end_date" >= CURRENT_DATE');
    expect(where.params).toEqual([ORG_A, ORG_B, 'active']);
  });

  it('reads nothing for an empty id list', async () => {
    setupDb(new Map());
    expect(await loadActiveContractCounts([])).toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('loadBackupReadiness', () => {
  it('is applicable when ANY non-deleted org of the partner has an active config, and reports which accepted orgs have one', async () => {
    setupDb(new Map<unknown, unknown[] | { sequence: unknown[][] }>([
      [backupConfigs, { sequence: [[{ id: 'cfg-1' }], [{ orgId: ORG_A }]] }],
    ]));
    const out = await loadBackupReadiness(PARTNER, [ORG_A, ORG_B]);
    expect(out.applicable).toBe(true);
    expect(out.configuredOrgIds).toEqual(new Set([ORG_A]));
    const join = compiled(joins, backupConfigs);
    expect(join.sql).toContain('"organizations"."id" = "backup_configs"."org_id"');
    const where = compiled(wheres, backupConfigs);
    // The last captured WHERE is the per-org query.
    expect(where.sql).toContain('"backup_configs"."org_id" in (');
    expect(where.sql).toContain('"backup_configs"."is_active" = ');
    expect(where.params).toEqual([ORG_A, ORG_B, true]);
  });

  it('is not applicable for a partner with no active config anywhere, and skips the per-org read', async () => {
    setupDb(new Map<unknown, unknown[] | { sequence: unknown[][] }>([[backupConfigs, { sequence: [[]] }]]));
    const out = await loadBackupReadiness(PARTNER, [ORG_A]);
    expect(out).toEqual({ applicable: false, configuredOrgIds: new Set() });
    expect(db.selectDistinct).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadinessCommercial.test.ts`
Expected: FAIL — `Cannot find module './orgAccountReadinessCommercial'`.

- [ ] **Step 3: Write the module**

```ts
// apps/api/src/services/orgAccountReadinessCommercial.ts
/**
 * Organizations account board — W03 "No active contract" and backup inputs
 * (spec: cut lists under "Setup cell" and "Account data cell", resolved in
 * the W03 plan's "Spec ambiguities resolved" §1 and §8).
 */
import { and, eq, gte, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { backupConfigs, contracts, organizations } from '../db/schema';

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Active contracts per org: `status = 'active' AND (end_date IS NULL OR
 * end_date >= CURRENT_DATE)`. Evergreen terms (NULL end_date) count — the
 * `contracts` table is the source of truth, not organizations.contract_*.
 * Only orgs with at least one such contract are keys.
 */
export async function loadActiveContractCounts(orgIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orgIds.length === 0) return out;
  const rows = await db
    .select({ orgId: contracts.orgId, active: sql<string>`count(*)` })
    .from(contracts)
    .where(
      and(
        inArray(contracts.orgId, [...orgIds]),
        eq(contracts.status, 'active'),
        or(isNull(contracts.endDate), gte(contracts.endDate, sql`CURRENT_DATE`)) as SQL,
      ),
    )
    .groupBy(contracts.orgId);
  for (const row of rows) out.set(row.orgId, toCount(row.active));
  return out;
}

export interface BackupReadiness {
  /** The partner has at least one active backup_configs row under any non-deleted org. */
  applicable: boolean;
  /** Accepted org ids that have at least one active backup_configs row. */
  configuredOrgIds: Set<string>;
}

/**
 * Applicability = the partner uses backup at all. There is no entitlement
 * signal to read (no plan/edition/feature flag ties to backup; `backup:read`
 * is the only gate), so a partner that never configured a destination gets no
 * backup chips — "backup is an entitlement, not a requirement" (spec). Under a
 * partner-scope RLS context the EXISTS only sees the caller's accessible orgs,
 * which is the intended visibility.
 */
export async function loadBackupReadiness(partnerId: string, orgIds: readonly string[]): Promise<BackupReadiness> {
  const [anyActive] = await db
    .select({ id: backupConfigs.id })
    .from(backupConfigs)
    .innerJoin(organizations, eq(organizations.id, backupConfigs.orgId))
    .where(
      and(
        eq(organizations.partnerId, partnerId),
        isNull(organizations.deletedAt),
        eq(backupConfigs.isActive, true),
      ),
    )
    .limit(1);
  if (!anyActive) return { applicable: false, configuredOrgIds: new Set() };
  if (orgIds.length === 0) return { applicable: true, configuredOrgIds: new Set() };

  const configured = await db
    .selectDistinct({ orgId: backupConfigs.orgId })
    .from(backupConfigs)
    .where(and(inArray(backupConfigs.orgId, [...orgIds]), eq(backupConfigs.isActive, true)));
  return { applicable: true, configuredOrgIds: new Set(configured.map((row) => row.orgId)) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadinessCommercial.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/orgAccountReadinessCommercial.ts apps/api/src/services/orgAccountReadinessCommercial.test.ts
git commit -m "feat(api): account-readiness active-contract counts and backup applicability (W03 #5724)"
```

---

### Task 5: Wire the response — extras module, route re-exports, `shapeOrg` merge, capability gates, route tests

**Files:**
- Create: `apps/api/src/services/orgAccountReadinessExtras.ts`
- Test: `apps/api/src/services/orgAccountReadinessExtras.test.ts`
- Modify: `apps/api/src/routes/orgAccountReadiness.ts` (W01)
- Test: `apps/api/src/routes/orgAccountReadiness.integrations.test.ts`

**Interfaces:**
- Consumes: W01's route file (`AccountReadinessCapabilities`, `AccountReadinessOrg`, `AccountReadinessResponse`, `shapeOrg`, the handler locals `partnerId`, `can`, `native`, `capabilities`, `accepted`, `signals`); W01's service (`resolveAcceptedOrgs`, `loadAccountReadiness`), `getServiceManagementMode` from `services/serviceManagement`; Tasks 3–4 (`loadIntegrationReadiness`, `loadActiveContractCounts`, `loadBackupReadiness`, `Connector`, `OrgIntegration`, `IntegrationGrants`, `BackupReadiness`).
- Produces: `services/orgAccountReadinessExtras.ts` — `interface AccountReadinessExtras { connectors: Connector[] | null; integrationsByOrg: Map<string, OrgIntegration[]> | null; activeContracts: Map<string, number> | null; backup: BackupReadiness | null }`, `computeAccountReadinessExtras(input: { partnerId; orgIds; capabilities: Pick<…,'integrations'|'contracts'|'backup'>; grants: IntegrationGrants; now: Date }): Promise<AccountReadinessExtras>`, `interface OrgExtraFields { integrations?: OrgIntegration[]; activeContracts?: number; backupApplicable?: boolean; backupConfigured?: boolean }`, `extrasForOrg(orgId, extras): OrgExtraFields`, `EMPTY_EXTRAS`. Route: `AccountReadinessCapabilities` gains `contracts: boolean; backup: boolean`; `AccountReadinessOrg.setup` gains `backupConfigured?; backupApplicable?`; `AccountReadinessOrg.account` gains `activeContracts?`; `AccountReadinessConnector` / `AccountReadinessIntegration` / `ConnectorSystem` / `ConnectorState` / `IntegrationSystem` / `IntegrationState` / `IntegrationReason` become re-exports; `shapeOrg(org, signals, capabilities, extras)`. Wire: `GET /orgs/account-readiness` returns `capabilities.{integrations,contracts,backup}`, `connectors?`, `orgs[].integrations?`, `orgs[].account.activeContracts?`, `orgs[].setup.backupConfigured?/backupApplicable?`.

- [ ] **Step 1: Write the failing extras test**

```ts
// apps/api/src/services/orgAccountReadinessExtras.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./orgAccountReadinessIntegrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./orgAccountReadinessIntegrations')>();
  return { ...actual, loadIntegrationReadiness: vi.fn() };
});
vi.mock('./orgAccountReadinessCommercial', () => ({ loadActiveContractCounts: vi.fn(), loadBackupReadiness: vi.fn() }));
vi.mock('../db', () => ({ db: { select: vi.fn(), selectDistinct: vi.fn() } }));

import { loadIntegrationReadiness } from './orgAccountReadinessIntegrations';
import { loadActiveContractCounts, loadBackupReadiness } from './orgAccountReadinessCommercial';
import { computeAccountReadinessExtras, extrasForOrg, EMPTY_EXTRAS } from './orgAccountReadinessExtras';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const ORG_A = '11111111-1111-4111-8111-111111111111';
const CAPS_ALL = { integrations: true, contracts: true, backup: true };
const GRANTS = { accounting: true, pax8: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadIntegrationReadiness).mockResolvedValue({
    connectors: [{ system: 'quickbooks', state: 'connected' }],
    byOrg: new Map([[ORG_A, [{ system: 'quickbooks', state: 'linked' }]]]),
  });
  vi.mocked(loadActiveContractCounts).mockResolvedValue(new Map([[ORG_A, 1]]));
  vi.mocked(loadBackupReadiness).mockResolvedValue({ applicable: true, configuredOrgIds: new Set([ORG_A]) });
});

describe('computeAccountReadinessExtras', () => {
  it('loads every section when every capability is on and forwards the sub-grants', async () => {
    const extras = await computeAccountReadinessExtras({ partnerId: 'p', orgIds: [ORG_A], capabilities: CAPS_ALL, grants: GRANTS, now: NOW });
    expect(loadIntegrationReadiness).toHaveBeenCalledWith({ partnerId: 'p', orgIds: [ORG_A], grants: GRANTS, now: NOW });
    expect(loadActiveContractCounts).toHaveBeenCalledWith([ORG_A]);
    expect(loadBackupReadiness).toHaveBeenCalledWith('p', [ORG_A]);
    expect(extras.connectors).toEqual([{ system: 'quickbooks', state: 'connected' }]);
    expect(extras.integrationsByOrg?.get(ORG_A)).toEqual([{ system: 'quickbooks', state: 'linked' }]);
    expect(extras.activeContracts?.get(ORG_A)).toBe(1);
    expect(extras.backup?.applicable).toBe(true);
  });

  it('withholds a section — and never queries it — when its capability is off', async () => {
    const extras = await computeAccountReadinessExtras({
      partnerId: 'p', orgIds: [ORG_A], capabilities: { integrations: false, contracts: false, backup: false }, grants: GRANTS, now: NOW,
    });
    expect(loadIntegrationReadiness).not.toHaveBeenCalled();
    expect(loadActiveContractCounts).not.toHaveBeenCalled();
    expect(loadBackupReadiness).not.toHaveBeenCalled();
    expect(extras).toEqual(EMPTY_EXTRAS);
  });
});

describe('extrasForOrg', () => {
  it('returns the org\'s fields from every loaded section', async () => {
    const extras = await computeAccountReadinessExtras({ partnerId: 'p', orgIds: [ORG_A], capabilities: CAPS_ALL, grants: GRANTS, now: NOW });
    expect(extrasForOrg(ORG_A, extras)).toEqual({
      integrations: [{ system: 'quickbooks', state: 'linked' }],
      activeContracts: 1,
      backupApplicable: true,
      backupConfigured: true,
    });
  });

  it('fills [] / 0 / false for an org absent from a loaded section and omits withheld sections', () => {
    expect(extrasForOrg(ORG_A, {
      connectors: [],
      integrationsByOrg: new Map(),
      activeContracts: new Map(),
      backup: { applicable: false, configuredOrgIds: new Set() },
    })).toEqual({ integrations: [], activeContracts: 0, backupApplicable: false, backupConfigured: false });
    expect(extrasForOrg(ORG_A, EMPTY_EXTRAS)).toEqual({});
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadinessExtras.test.ts`
Expected: FAIL — `Cannot find module './orgAccountReadinessExtras'`.

- [ ] **Step 3: Write the extras module**

```ts
// apps/api/src/services/orgAccountReadinessExtras.ts
/**
 * W03 sections of GET /orgs/account-readiness, gated by capability so a
 * withheld section is never queried (spec: "Section omitted from the API
 * response and from capabilities"). The route keeps owning shaping; this
 * module only decides what to load and hands back per-org fields.
 */
import { loadIntegrationReadiness, type Connector, type IntegrationGrants, type OrgIntegration } from './orgAccountReadinessIntegrations';
import { loadActiveContractCounts, loadBackupReadiness, type BackupReadiness } from './orgAccountReadinessCommercial';

export interface AccountReadinessExtras {
  /** null = withheld (no connected_apps:read). */
  connectors: Connector[] | null;
  integrationsByOrg: Map<string, OrgIntegration[]> | null;
  /** null = withheld (no contracts:read, or not native mode). */
  activeContracts: Map<string, number> | null;
  /** null = withheld (no backup:read). */
  backup: BackupReadiness | null;
}

export const EMPTY_EXTRAS: AccountReadinessExtras = {
  connectors: null,
  integrationsByOrg: null,
  activeContracts: null,
  backup: null,
};

export interface ExtrasCapabilities {
  integrations: boolean;
  contracts: boolean;
  backup: boolean;
}

/**
 * Runs inside the caller's request transaction (single connection):
 * Promise.all is orchestration only, not parallelism.
 */
export async function computeAccountReadinessExtras(input: {
  partnerId: string;
  orgIds: readonly string[];
  capabilities: ExtrasCapabilities;
  grants: IntegrationGrants;
  now: Date;
}): Promise<AccountReadinessExtras> {
  const { partnerId, orgIds, capabilities, grants, now } = input;
  const [integrations, activeContracts, backup] = await Promise.all([
    capabilities.integrations ? loadIntegrationReadiness({ partnerId, orgIds, grants, now }) : null,
    capabilities.contracts ? loadActiveContractCounts(orgIds) : null,
    capabilities.backup ? loadBackupReadiness(partnerId, orgIds) : null,
  ]);
  return {
    connectors: integrations ? integrations.connectors : null,
    integrationsByOrg: integrations ? integrations.byOrg : null,
    activeContracts,
    backup,
  };
}

export interface OrgExtraFields {
  integrations?: OrgIntegration[];
  activeContracts?: number;
  backupApplicable?: boolean;
  backupConfigured?: boolean;
}

/** The W03 fields for one org — absent when the section was withheld, defaulted when the org simply has none. */
export function extrasForOrg(orgId: string, extras: AccountReadinessExtras): OrgExtraFields {
  const fields: OrgExtraFields = {};
  if (extras.integrationsByOrg) fields.integrations = extras.integrationsByOrg.get(orgId) ?? [];
  if (extras.activeContracts) fields.activeContracts = extras.activeContracts.get(orgId) ?? 0;
  if (extras.backup) {
    fields.backupApplicable = extras.backup.applicable;
    fields.backupConfigured = extras.backup.configuredOrgIds.has(orgId);
  }
  return fields;
}
```

- [ ] **Step 4: Run the extras test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/orgAccountReadinessExtras.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

```ts
// apps/api/src/routes/orgAccountReadiness.integrations.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PERMISSIONS } from '../services/permissions';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((_c: any, next: any) => next()),
  requireScope: vi.fn((...scopes: string[]) => (c: any, next: any) => {
    const auth = c.get('auth');
    if (!scopes.includes(auth?.scope)) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => (c: any, next: any) => {
    const perms = c.get('permissions');
    const granted = Array.isArray(perms?.permissions) && perms.permissions.some(
      (p: { resource: string; action: string }) =>
        (p.resource === resource || p.resource === '*') && (p.action === action || p.action === '*'),
    );
    if (!granted) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
}));

// services/permissions imports ../db; keep the pool out of the unit run.
vi.mock('../db', () => ({ db: { select: vi.fn(), selectDistinct: vi.fn() } }));
vi.mock('../services/serviceManagement', () => ({ getServiceManagementMode: vi.fn() }));
// W01's resolution and base aggregates are not under test here.
vi.mock('../services/orgAccountReadiness', () => ({ resolveAcceptedOrgs: vi.fn(), loadAccountReadiness: vi.fn() }));
// The W03 loaders are mocked at their modules; the extras composer runs for real.
vi.mock('../services/orgAccountReadinessIntegrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/orgAccountReadinessIntegrations')>();
  return { ...actual, loadIntegrationReadiness: vi.fn() };
});
vi.mock('../services/orgAccountReadinessCommercial', () => ({ loadActiveContractCounts: vi.fn(), loadBackupReadiness: vi.fn() }));

import { getServiceManagementMode } from '../services/serviceManagement';
import { loadAccountReadiness, resolveAcceptedOrgs } from '../services/orgAccountReadiness';
import { loadIntegrationReadiness } from '../services/orgAccountReadinessIntegrations';
import { loadActiveContractCounts, loadBackupReadiness } from '../services/orgAccountReadinessCommercial';
import { orgAccountReadinessRoutes } from './orgAccountReadiness';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_A = '11111111-1111-4111-8111-111111111111';

function buildApp(grants: Array<{ resource: string; action: string }>) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
      scope: 'partner',
      partnerId: PARTNER_ID,
      orgId: null,
      accessibleOrgIds: [ORG_A],
      canAccessOrg: () => true,
    } as any);
    c.set('permissions', { permissions: grants, scope: 'partner', partnerId: PARTNER_ID, orgId: null, roleId: 'role-1' } as any);
    await next();
  });
  app.route('/orgs', orgAccountReadinessRoutes);
  return app;
}

const BASE_GRANTS = [PERMISSIONS.ORGS_READ];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServiceManagementMode).mockResolvedValue('native');
  vi.mocked(resolveAcceptedOrgs).mockResolvedValue([{ id: ORG_A, type: 'customer', status: 'active', billingAddress: true }]);
  vi.mocked(loadAccountReadiness).mockResolvedValue(new Map());
  vi.mocked(loadIntegrationReadiness).mockResolvedValue({
    connectors: [{ system: 'pax8', state: 'connected' }],
    byOrg: new Map([[ORG_A, [{ system: 'pax8', state: 'linked' }]]]),
  });
  vi.mocked(loadActiveContractCounts).mockResolvedValue(new Map([[ORG_A, 2]]));
  vi.mocked(loadBackupReadiness).mockResolvedValue({ applicable: true, configuredOrgIds: new Set() });
});

async function call(grants: Array<{ resource: string; action: string }>) {
  const res = await buildApp(grants).request(`/orgs/account-readiness?orgIds=${ORG_A}`);
  expect(res.status).toBe(200);
  return res.json();
}

describe('GET /orgs/account-readiness — W03 gates', () => {
  it('without connected_apps:read: capabilities.integrations false, no connectors, no integrations, loader never called', async () => {
    const body = await call([...BASE_GRANTS, PERMISSIONS.CONTRACTS_READ, PERMISSIONS.BACKUP_READ]);
    expect(body.capabilities.integrations).toBe(false);
    expect(body).not.toHaveProperty('connectors');
    expect(body.orgs[0]).not.toHaveProperty('integrations');
    expect(loadIntegrationReadiness).not.toHaveBeenCalled();
  });

  it('with connected_apps:read only: sub-grants are false, connectors and integrations present', async () => {
    const body = await call([...BASE_GRANTS, PERMISSIONS.CONNECTED_APPS_READ]);
    expect(body.capabilities.integrations).toBe(true);
    expect(loadIntegrationReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: PARTNER_ID, orgIds: [ORG_A], grants: { accounting: false, pax8: false } }),
    );
    expect(body.connectors).toEqual([{ system: 'pax8', state: 'connected' }]);
    expect(body.orgs[0].integrations).toEqual([{ system: 'pax8', state: 'linked' }]);
  });

  it('accounting:read and billing:manage flow through as sub-grants', async () => {
    await call([...BASE_GRANTS, PERMISSIONS.CONNECTED_APPS_READ, PERMISSIONS.ACCOUNTING_READ, PERMISSIONS.BILLING_MANAGE]);
    expect(loadIntegrationReadiness).toHaveBeenCalledWith(expect.objectContaining({ grants: { accounting: true, pax8: true } }));
  });

  it('contracts: needs contracts:read AND native mode', async () => {
    let body = await call([...BASE_GRANTS, PERMISSIONS.CONTRACTS_READ]);
    expect(body.capabilities.contracts).toBe(true);
    expect(body.orgs[0].account.activeContracts).toBe(2);

    vi.mocked(getServiceManagementMode).mockResolvedValue('external');
    body = await call([...BASE_GRANTS, PERMISSIONS.CONTRACTS_READ]);
    expect(body.capabilities.contracts).toBe(false);
    expect(body.orgs[0].account).not.toHaveProperty('activeContracts');

    vi.mocked(getServiceManagementMode).mockResolvedValue('native');
    body = await call(BASE_GRANTS);
    expect(body.capabilities.contracts).toBe(false);
    expect(loadActiveContractCounts).toHaveBeenCalledTimes(1);
  });

  it('backup: needs backup:read; both booleans land on setup', async () => {
    let body = await call([...BASE_GRANTS, PERMISSIONS.BACKUP_READ]);
    expect(body.capabilities.backup).toBe(true);
    expect(body.orgs[0].setup.backupApplicable).toBe(true);
    expect(body.orgs[0].setup.backupConfigured).toBe(false);

    body = await call(BASE_GRANTS);
    expect(body.capabilities.backup).toBe(false);
    expect(body.orgs[0].setup).not.toHaveProperty('backupApplicable');
    expect(loadBackupReadiness).toHaveBeenCalledTimes(1);
  });

  it('with no accepted org the extras are still computed for zero ids (connectors are partner-level)', async () => {
    vi.mocked(resolveAcceptedOrgs).mockResolvedValue([]);
    vi.mocked(loadIntegrationReadiness).mockResolvedValue({ connectors: [{ system: 'huntress', state: 'disabled' }], byOrg: new Map() });
    const body = await call([...BASE_GRANTS, PERMISSIONS.CONNECTED_APPS_READ]);
    expect(body.orgs).toEqual([]);
    expect(body.connectors).toEqual([{ system: 'huntress', state: 'disabled' }]);
    expect(loadIntegrationReadiness).toHaveBeenCalledWith(expect.objectContaining({ orgIds: [] }));
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/orgAccountReadiness.integrations.test.ts`
Expected: FAIL — `capabilities.contracts` undefined / `connectors` absent with the grant.

- [ ] **Step 7: Extend the W01 route**

In `apps/api/src/routes/orgAccountReadiness.ts`:

1. Replace W01's inline declarations of `ConnectorSystem`, `ConnectorState`, `AccountReadinessConnector`, `IntegrationSystem`, `IntegrationState`, `IntegrationReason`, `AccountReadinessIntegration` with re-exports (the service module is where they are produced; the names W01 published stay valid for W02's imports):
```ts
export type {
  ConnectorSystem,
  ConnectorState,
  IntegrationSystem,
  IntegrationState,
  IntegrationReason,
  Connector as AccountReadinessConnector,
  OrgIntegration as AccountReadinessIntegration,
} from '../services/orgAccountReadinessIntegrations';
import type { AccountReadinessConnector, AccountReadinessIntegration } from './orgAccountReadiness';
```
(the self-import is type-only and keeps the interfaces below readable; if the linter objects to a self-import, import the two under their service names and use those in the interfaces instead.)

2. Add the imports:
```ts
import {
  computeAccountReadinessExtras,
  extrasForOrg,
  type AccountReadinessExtras,
} from '../services/orgAccountReadinessExtras';
```

3. In `AccountReadinessCapabilities` replace the `integrations` comment and add two members:
```ts
  /** W03: connected_apps:read. */
  integrations: boolean;
  /** W03: contracts:read AND service_management_mode = 'native'. */
  contracts: boolean;
  /** W03: backup:read. */
  backup: boolean;
```

4. In `AccountReadinessOrg` add:
```ts
  setup: {
    // …W01 members…
    /** W03, capabilities.backup: at least one active backup_configs row for this org. */
    backupConfigured?: boolean;
    /** W03, capabilities.backup: the partner has any active backup_configs row (plan §1); same value on every org. */
    backupApplicable?: boolean;
  };
  account: {
    // …W01 members…
    /** W03, capabilities.contracts: contracts with status 'active' and no end date or an end date ≥ today. */
    activeContracts?: number;
  };
```

5. Extend `shapeOrg` with a fourth parameter and merge the fields before returning:
```ts
function shapeOrg(
  org: AcceptedOrg,
  signals: OrgReadinessSignals | undefined,
  capabilities: AccountReadinessCapabilities,
  extras: AccountReadinessExtras,
): AccountReadinessOrg {
  // …W01 body unchanged up to `const shaped …` and the tickets line…
  const fields = extrasForOrg(org.id, extras);
  if (fields.integrations) shaped.integrations = fields.integrations;
  if (fields.activeContracts !== undefined) shaped.account.activeContracts = fields.activeContracts;
  if (fields.backupApplicable !== undefined) {
    shaped.setup.backupApplicable = fields.backupApplicable;
    shaped.setup.backupConfigured = fields.backupConfigured;
  }
  return shaped;
}
```

6. In the handler, set the three gates in the `capabilities` literal:
```ts
      integrations: can(PERMISSIONS.CONNECTED_APPS_READ),
      contracts: can(PERMISSIONS.CONTRACTS_READ) && native,
      backup: can(PERMISSIONS.BACKUP_READ),
```

7. After W01's `const signals = …` block, add:
```ts
    const extras = await computeAccountReadinessExtras({
      partnerId,
      orgIds: accepted.map((org) => org.id),
      capabilities,
      grants: { accounting: can(PERMISSIONS.ACCOUNTING_READ), pax8: can(PERMISSIONS.BILLING_MANAGE) },
      now: new Date(),
    });
```
and change the response literal to:
```ts
    const response: AccountReadinessResponse = {
      partnerId,
      capabilities,
      serviceManagementMode,
      ...(extras.connectors ? { connectors: extras.connectors } : {}),
      orgs: accepted.map((org) => shapeOrg(org, signals.get(org.id), capabilities, extras)),
    };
```

- [ ] **Step 8: Run W01's route test, the new sibling, and the extras test**

Run: `cd apps/api && npx vitest run src/routes/orgAccountReadiness.test.ts src/routes/orgAccountReadiness.integrations.test.ts src/services/orgAccountReadinessExtras.test.ts`
Expected: PASS, 3 files. W01's `capabilities` assertions compare whole objects (`ALL_FALSE`, `integrations: false`): add `contracts: false, backup: false` to those expected literals — W01's tests grant no `contracts:read` / `backup:read`, so the values are false. W01's test file mocks `../db` only; because `services/orgAccountReadinessExtras` imports the two W03 loader modules (which import `../db`), that mock already covers them, and with every W03 capability false no loader is called.

- [ ] **Step 9: Typecheck and commit**

Run: `cd apps/api && npx tsc --noEmit -p . && npx eslint src/routes/orgAccountReadiness.ts src/services/orgAccountReadinessExtras.ts`
Expected: clean.

```bash
git add apps/api/src/services/orgAccountReadinessExtras.ts apps/api/src/services/orgAccountReadinessExtras.test.ts apps/api/src/routes/orgAccountReadiness.ts apps/api/src/routes/orgAccountReadiness.test.ts apps/api/src/routes/orgAccountReadiness.integrations.test.ts
git commit -m "feat(api): account-readiness returns connectors, per-org integrations, active contracts and backup fields behind capability gates (W03 #5724)"
```

---

### Task 6: Integration test — the mapping/connector matrix on real Postgres

**Files:**
- Test: `apps/api/src/__tests__/integration/orgAccountReadinessIntegrations.integration.test.ts`

**Interfaces:**
- Consumes: `orgAccountReadinessRoutes` (composed at `/api/v1/orgs`), `createIntegrationTestClient`, `createOrganization`, `createPartner`, `createUser`, `createRole`, `grantRolePermissions`, `assignUserToPartner` from `./db-utils`; `getTestDb` from `./setup`; `createAccessToken` from `../../services/jwt`.
- Produces: nothing; proves the Task 2–5 SQL against forced RLS as the real `breeze_app` role goes through the route.

- [ ] **Step 1: Bring up a private test stack**

Run (repo root): `pnpm test-stack up`
Expected: `.env.test` written for this worktree; Postgres + Redis healthy. (Tear down with `pnpm test-stack down` at the end of the task.)

- [ ] **Step 2: Write the test**

```ts
// apps/api/src/__tests__/integration/orgAccountReadinessIntegrations.integration.test.ts
/**
 * W03 account-board integration matrix (spec Testing: "W03 adds the
 * mapping/connector matrix"). One partner P is seeded with every source in
 * every state across four orgs; a foreign partner Q proves nothing of Q's leaks
 * into P's response. Requests go through the real route with a partner-scope
 * token, so every read runs as breeze_app under forced RLS.
 */
import './setup';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  accountingConnections,
  accountingEntityMappings,
  backupConfigs,
  contracts,
  dnsFilterIntegrations,
  huntressIntegrations,
  huntressOrgMappings,
  m365Connections,
  organizationExternalLinks,
  pax8CompanyMappings,
  pax8Integrations,
  psaConnections,
  s1Integrations,
  s1OrgMappings,
} from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { PERMISSIONS } from '../../services/permissions';
import { orgAccountReadinessRoutes } from '../../routes/orgAccountReadiness';
import {
  assignUserToPartner,
  createIntegrationTestClient,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = describe.runIf(!!process.env.DATABASE_URL);

const FULL_GRANTS = [
  PERMISSIONS.ORGS_READ,
  PERMISSIONS.CONNECTED_APPS_READ,
  PERMISSIONS.ACCOUNTING_READ,
  PERMISSIONS.BILLING_MANAGE,
  PERMISSIONS.CONTRACTS_READ,
  PERMISSIONS.BACKUP_READ,
];

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/orgs', orgAccountReadinessRoutes);
  return app;
}

interface Badge { system: string; state: string; reason?: string; label?: string }
interface ReadinessBody {
  capabilities: Record<string, boolean>;
  connectors?: Array<{ system: string; state: string; provider?: string }>;
  orgs: Array<{
    orgId: string;
    integrations?: Badge[];
    account: { activeContracts?: number };
    setup: { backupApplicable?: boolean; backupConfigured?: boolean };
  }>;
}

/** A second partner-scope token for the SAME partner with a narrower role. */
async function tokenFor(partnerId: string, grants: Array<{ resource: string; action: string }>): Promise<string> {
  const user = await createUser({ partnerId, orgId: null });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, grants);
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return createAccessToken({
    sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId,
    scope: 'partner', mfa: false, aep: 1, mep: 1, sid: randomUUID(),
  });
}

runDb('GET /orgs/account-readiness — W03 integrations, contracts, backup', () => {
  const app = buildApp();
  let client: Awaited<ReturnType<typeof createIntegrationTestClient>>;
  let partnerId: string;
  let linked: string;   // everything linked and healthy
  let pending: string;  // every pending shape
  let broken: string;   // every error shape
  let bare: string;     // nothing at all (the client's own org)
  let foreignPartnerId: string;
  let foreignOrg: string;

  async function fetchBoard(token: string, orgIds: string[]): Promise<ReadinessBody> {
    const res = await app.request(`/api/v1/orgs/account-readiness?orgIds=${orgIds.join(',')}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as ReadinessBody;
  }

  function badges(body: ReadinessBody, orgId: string): Badge[] {
    const row = body.orgs.find((o) => o.orgId === orgId);
    if (!row) throw new Error(`org ${orgId} missing from response`);
    return row.integrations ?? [];
  }

  beforeAll(async () => {
    client = await createIntegrationTestClient(app, { scope: 'partner', rolePermissions: FULL_GRANTS });
    partnerId = client.env.partner.id;
    bare = client.env.organization.id;
    linked = (await createOrganization({ partnerId, name: 'Linked Co' })).id;
    pending = (await createOrganization({ partnerId, name: 'Pending Co' })).id;
    broken = (await createOrganization({ partnerId, name: 'Broken Co' })).id;

    const db = getTestDb();

    // --- Accounting: one connected QuickBooks realm; confirmed+synced, suggested, unlinked, sync error
    const [qbo] = await db.insert(accountingConnections)
      .values({ partnerId, provider: 'quickbooks', environment: 'sandbox', status: 'connected' })
      .returning({ id: accountingConnections.id });
    await db.insert(accountingEntityMappings).values([
      { integrationId: qbo.id, partnerId, breezeEntityType: 'org', breezeEntityId: linked, remoteEntityType: 'Customer', remoteEntityId: 'cust-linked', linkStatus: 'confirmed', syncStatus: 'synced' },
      { integrationId: qbo.id, partnerId, breezeEntityType: 'org', breezeEntityId: pending, remoteEntityType: 'Customer', remoteEntityId: 'cust-pending', linkStatus: 'suggested', syncStatus: 'pending' },
      { integrationId: qbo.id, partnerId, breezeEntityType: 'org', breezeEntityId: broken, remoteEntityType: 'Customer', remoteEntityId: 'cust-broken', linkStatus: 'confirmed', syncStatus: 'error', lastError: 'QBO 400' },
      { integrationId: qbo.id, partnerId, breezeEntityType: 'org', breezeEntityId: bare, remoteEntityType: 'Customer', remoteEntityId: 'cust-bare', linkStatus: 'unlinked', syncStatus: 'pending' },
    ]);

    // --- PSA: partner-level ConnectWise enabled + link on `linked`; org-level disabled Jira on `broken`; a Datto identity link on `linked`
    await db.insert(psaConnections).values([
      { partnerId, orgId: null, provider: 'connectwise', name: 'CW', credentials: {}, enabled: true },
      { partnerId: null, orgId: broken, provider: 'jira', name: 'Jira', credentials: {}, enabled: false },
    ]);
    await db.insert(organizationExternalLinks).values([
      { orgId: linked, partnerId, system: 'connectwise', externalId: 'cw-1' },
      { orgId: linked, partnerId, system: 'datto_rmm', externalId: 'datto-1' },
    ]);

    // --- Pax8: an INACTIVE integration mapping `pending` (must be ignored) and the ACTIVE one mapping `linked`
    const [pax8Old] = await db.insert(pax8Integrations)
      .values({ partnerId, name: 'Pax8 old', clientIdEncrypted: 'x', clientSecretEncrypted: 'y', tokenUrl: 'https://login.pax8.com/oauth/token', isActive: false, lastSyncStatus: 'success' })
      .returning({ id: pax8Integrations.id });
    const [pax8Live] = await db.insert(pax8Integrations)
      .values({ partnerId, name: 'Pax8', clientIdEncrypted: 'x', clientSecretEncrypted: 'y', tokenUrl: 'https://login.pax8.com/oauth/token', isActive: true, lastSyncStatus: 'success' })
      .returning({ id: pax8Integrations.id });
    await db.insert(pax8CompanyMappings).values([
      { integrationId: pax8Old.id, partnerId, pax8CompanyId: 'c-old', pax8CompanyName: 'Old', orgId: pending, ignored: false },
      { integrationId: pax8Live.id, partnerId, pax8CompanyId: 'c-live', pax8CompanyName: 'Live', orgId: linked, ignored: false },
      { integrationId: pax8Live.id, partnerId, pax8CompanyId: 'c-ignored', pax8CompanyName: 'Ignored', orgId: broken, ignored: true },
    ]);

    // --- Microsoft 365: two profiles on `linked` (active + degraded → worst wins), consent pending on `pending`, a revoked row on `bare`
    const m365Base = { clientId: 'client-1', authMode: 'application-certificate' as const, credentialDomain: 'customer-graph-read' as const };
    await db.insert(m365Connections).values([
      { ...m365Base, orgId: linked, profile: 'customer-graph-read', status: 'active' },
      { ...m365Base, orgId: linked, profile: 'customer-graph-actions', status: 'degraded' },
      { ...m365Base, orgId: pending, profile: 'customer-graph-read', status: 'pending-consent' },
      { ...m365Base, orgId: bare, profile: 'customer-graph-read', status: 'revoked', revokedAt: new Date() },
    ]);

    // --- DNS filter: never synced on `pending`, success on `linked`, error on `broken`, inactive on `bare`
    await db.insert(dnsFilterIntegrations).values([
      { orgId: pending, provider: 'pihole', name: 'PH', isActive: true, lastSyncStatus: null },
      { orgId: linked, provider: 'pihole', name: 'PH', isActive: true, lastSyncStatus: 'success' },
      { orgId: broken, provider: 'pihole', name: 'PH', isActive: true, lastSyncStatus: 'error', lastSyncError: 'timeout' },
      { orgId: bare, provider: 'pihole', name: 'PH', isActive: false, lastSyncStatus: null },
    ]);

    // --- Huntress: the partner's only integration is INACTIVE → connector disabled, mapping connector_error
    const [huntress] = await db.insert(huntressIntegrations)
      .values({ partnerId, name: 'Huntress', apiKeyEncrypted: 'k', isActive: false, lastSyncStatus: 'success' })
      .returning({ id: huntressIntegrations.id });
    await db.insert(huntressOrgMappings).values({ integrationId: huntress.id, partnerId, huntressOrgId: 'h-1', orgId: broken });

    // --- SentinelOne: active, synced → linked on `linked`; never synced would be pending (covered by unit tests)
    const [s1] = await db.insert(s1Integrations)
      .values({ partnerId, name: 'S1', apiTokenEncrypted: 't', managementUrl: 'https://example.sentinelone.net', isActive: true, lastSyncStatus: 'success' })
      .returning({ id: s1Integrations.id });
    await db.insert(s1OrgMappings).values({ integrationId: s1.id, partnerId, s1SiteId: 's-1', orgId: linked });

    // --- Contracts: evergreen active on `linked`; expired active on `pending`; paused on `broken`
    await db.insert(contracts).values([
      { partnerId, orgId: linked, name: 'MSA', status: 'active', intervalMonths: 1, startDate: '2026-01-01', endDate: null, currencyCode: 'USD' },
      { partnerId, orgId: pending, name: 'Old MSA', status: 'active', intervalMonths: 1, startDate: '2025-01-01', endDate: '2025-12-31', currencyCode: 'USD' },
      { partnerId, orgId: broken, name: 'Paused', status: 'paused', intervalMonths: 1, startDate: '2026-01-01', endDate: null, currencyCode: 'USD' },
    ]);

    // --- Backup: one active config on `linked` makes backup applicable partner-wide
    await db.insert(backupConfigs).values({ orgId: linked, name: 'Local', type: 'file', provider: 'local', providerConfig: {}, isActive: true });

    // --- Foreign partner Q with its own connector, mapping, Pax8 and Huntress
    const q = await createPartner({ name: 'Foreign Partner' });
    foreignPartnerId = q.id;
    foreignOrg = (await createOrganization({ partnerId: q.id, name: 'Foreign Co' })).id;
    const [qConn] = await db.insert(accountingConnections)
      .values({ partnerId: q.id, provider: 'xero', environment: 'sandbox', status: 'reauth_required' })
      .returning({ id: accountingConnections.id });
    await db.insert(accountingEntityMappings).values({
      integrationId: qConn.id, partnerId: q.id, breezeEntityType: 'org', breezeEntityId: foreignOrg,
      remoteEntityType: 'Customer', remoteEntityId: 'xero-1', linkStatus: 'confirmed', syncStatus: 'synced',
    });
    await db.insert(pax8Integrations).values({ partnerId: q.id, name: 'Q Pax8', clientIdEncrypted: 'x', clientSecretEncrypted: 'y', tokenUrl: 'https://login.pax8.com/oauth/token', isActive: true, lastSyncStatus: 'failed' });
  });

  it('reports every connector of the partner once, and none of the foreign partner', async () => {
    const body = await fetchBoard(client.token, [linked, pending, broken, bare]);
    expect(body.capabilities).toMatchObject({ integrations: true, contracts: true, backup: true });
    expect(body.connectors).toEqual(
      expect.arrayContaining([
        { system: 'quickbooks', state: 'connected' },
        { system: 'psa', state: 'connected', provider: 'connectwise' },
        { system: 'pax8', state: 'connected' },
        { system: 'huntress', state: 'disabled' },
        { system: 'sentinelone', state: 'connected' },
      ]),
    );
    expect(body.connectors).toHaveLength(5);
    expect(body.connectors!.some((c) => c.system === 'xero')).toBe(false);
  });

  it('linked org: confirmed+synced, PSA via link, Pax8 under the active integration, M365 worst-state, DNS success, S1 synced, Datto identity', async () => {
    const body = await fetchBoard(client.token, [linked]);
    expect(badges(body, linked)).toEqual([
      { system: 'quickbooks', state: 'linked' },
      { system: 'psa', state: 'linked' },
      { system: 'pax8', state: 'linked' },
      { system: 'm365', state: 'error', reason: 'degraded' },
      { system: 'dns_filter', state: 'linked' },
      { system: 'sentinelone', state: 'linked' },
      { system: 'external', state: 'identity', label: 'datto_rmm' },
    ]);
  });

  it('pending org: suggested match, consent pending, DNS never synced; the inactive Pax8 integration is ignored', async () => {
    const body = await fetchBoard(client.token, [pending]);
    expect(badges(body, pending)).toEqual([
      { system: 'quickbooks', state: 'pending', reason: 'suggested_match' },
      { system: 'm365', state: 'pending', reason: 'consent_pending' },
      { system: 'dns_filter', state: 'pending', reason: 'never_synced' },
    ]);
  });

  it('broken org: accounting sync error, disabled org-level PSA, DNS error, Huntress under an inactive parent; ignored Pax8 mapping absent', async () => {
    const body = await fetchBoard(client.token, [broken]);
    expect(badges(body, broken)).toEqual([
      { system: 'quickbooks', state: 'error', reason: 'sync_error' },
      { system: 'psa', state: 'error', reason: 'disabled' },
      { system: 'dns_filter', state: 'error', reason: 'sync_error' },
      { system: 'huntress', state: 'error', reason: 'connector_error' },
    ]);
  });

  it('bare org: an unlinked mapping, a revoked M365 row and an inactive DNS integration produce no badges', async () => {
    const body = await fetchBoard(client.token, [bare]);
    expect(badges(body, bare)).toEqual([]);
  });

  it('the foreign partner\'s org is dropped from P\'s response entirely (accepted-id resolution), and Q sees only its own mapping', async () => {
    const body = await fetchBoard(client.token, [linked, foreignOrg]);
    expect(body.orgs.map((o) => o.orgId)).toEqual([linked]);

    const qToken = await tokenFor(foreignPartnerId, FULL_GRANTS);
    const qBody = await fetchBoard(qToken, [foreignOrg]);
    expect(qBody.connectors).toEqual(expect.arrayContaining([{ system: 'xero', state: 'reauth_required' }, { system: 'pax8', state: 'error' }]));
    expect(badges(qBody, foreignOrg)).toEqual([{ system: 'xero', state: 'linked' }]);
  });

  it('Pax8 sync failure flips the connector to error and every mapped org to sync_failed', async () => {
    await getTestDb()
      .update(pax8Integrations)
      .set({ lastSyncStatus: 'failed' })
      .where(and(eq(pax8Integrations.partnerId, partnerId), eq(pax8Integrations.isActive, true)));
    const body = await fetchBoard(client.token, [linked]);
    expect(body.connectors).toEqual(expect.arrayContaining([{ system: 'pax8', state: 'error' }]));
    expect(badges(body, linked)).toEqual(expect.arrayContaining([{ system: 'pax8', state: 'error', reason: 'sync_failed' }]));
  });

  it('active contracts: evergreen counts, an ended term does not, paused does not', async () => {
    const body = await fetchBoard(client.token, [linked, pending, broken]);
    const byOrg = new Map(body.orgs.map((o) => [o.orgId, o.account.activeContracts]));
    expect(byOrg.get(linked)).toBe(1);
    expect(byOrg.get(pending)).toBe(0);
    expect(byOrg.get(broken)).toBe(0);
  });

  it('backup: applicable partner-wide because one org has an active config; only that org is configured', async () => {
    const body = await fetchBoard(client.token, [linked, bare]);
    const rows = new Map(body.orgs.map((o) => [o.orgId, o.setup]));
    expect(rows.get(linked)).toMatchObject({ backupApplicable: true, backupConfigured: true });
    expect(rows.get(bare)).toMatchObject({ backupApplicable: true, backupConfigured: false });
  });

  it('a caller without connected_apps:read gets no connectors and no integrations; without accounting:read no QuickBooks; without billing:manage no Pax8', async () => {
    const noApps = await fetchBoard(await tokenFor(partnerId, [PERMISSIONS.ORGS_READ, PERMISSIONS.CONTRACTS_READ, PERMISSIONS.BACKUP_READ]), [linked]);
    expect(noApps.capabilities.integrations).toBe(false);
    expect(noApps).not.toHaveProperty('connectors');
    expect(noApps.orgs[0]).not.toHaveProperty('integrations');
    expect(noApps.capabilities.contracts).toBe(true);
    expect(noApps.capabilities.backup).toBe(true);

    const appsOnly = await fetchBoard(await tokenFor(partnerId, [PERMISSIONS.ORGS_READ, PERMISSIONS.CONNECTED_APPS_READ]), [linked]);
    expect(appsOnly.capabilities).toMatchObject({ integrations: true, contracts: false, backup: false });
    expect(appsOnly.connectors!.map((c) => c.system).sort()).toEqual(['huntress', 'psa', 'sentinelone']);
    expect(badges(appsOnly, linked).map((b) => b.system)).toEqual(['psa', 'm365', 'dns_filter', 'sentinelone', 'external']);
    expect(appsOnly.orgs[0].account).not.toHaveProperty('activeContracts');
    expect(appsOnly.orgs[0].setup).not.toHaveProperty('backupApplicable');
  });
});
```

- [ ] **Step 3: Run it against the private stack**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgAccountReadinessIntegrations.integration.test.ts`
Expected: PASS, 10 tests. If the `m365_connections` insert fails a CHECK, read the constraint named in the error (`m365_connections_owner_check` / `_delegated_identity_check`, migration `2026-08-06-f-m365-comms-delegated.sql`) and add the column it requires for an org-axis row; do not weaken the assertions.

- [ ] **Step 4: Also run the RLS coverage contract (nothing should change, prove it)**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts`
Expected: PASS — W03 adds no tables.

- [ ] **Step 5: Commit, then tear down**

```bash
git add apps/api/src/__tests__/integration/orgAccountReadinessIntegrations.integration.test.ts
git commit -m "test(api): account-readiness integration matrix — mapping states, connector states, foreign-partner isolation, contracts, backup (W03 #5724)"
pnpm test-stack down
```

---

### Task 7: i18n — `orgBoard.integrations.*`, the Unlinked filter/band, two chips, one repair title, eight locales

**Files:**
- Modify: `apps/web/src/locales/en/organizations.json`, `de-DE/organizations.json`, `es-419/organizations.json`, `fr-CA/organizations.json`, `fr-FR/organizations.json`, `it-IT/organizations.json`, `pt-BR/organizations.json`, `tr-TR/organizations.json` (all inside W02's existing `orgBoard` object)
- Modify: `apps/web/src/lib/i18n/translationCoverage.test.ts` (the seven `'organizations.json'` baselines)

**Interfaces:**
- Consumes: W02's groups `orgBoard.columns`, `orgBoard.filters`, `orgBoard.band`, `orgBoard.chips`, `orgBoard.repair`.
- Produces: new group `orgBoard.integrations.{system.psa, system.dns_filter, state.*, reason.*, notLinked, nothingLinked, connectorMuted, badgeLabel, badgeLabelWithReason, connectors.repair.*, connectors.openSettings}`; new keys `orgBoard.columns.integrations`, `orgBoard.filters.unlinked`, `orgBoard.band.unlinked`, `orgBoard.chips.noActiveContract`, `orgBoard.chips.noBackup`, `orgBoard.repair.backup`. Tasks 8–10 reference exactly these. W02's `orgBoard.chips.link` ("{{chip}} for {{orgName}}") and `orgBoard.repair.billing` are reused unchanged for the contract chip's accessible name and title.

- [ ] **Step 1: Run the parity contract to see the current baseline is green**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts`
Expected: PASS (nothing changed yet — this is the control).

- [ ] **Step 2: Add the English keys**

In `apps/web/src/locales/en/organizations.json`, inside `orgBoard`: add the `integrations` object as a new sibling of `columns`, and add the single keys to the existing groups shown:

```json
"columns": { "integrations": "Integrations" },
"filters": { "unlinked": "Unlinked" },
"band": { "unlinked": "Unlinked" },
"chips": {
  "noActiveContract": "No active contract",
  "noBackup": "No backup configured"
},
"repair": { "backup": "Open backup for {{orgName}}" },
"integrations": {
  "system": { "psa": "PSA", "dns_filter": "DNS filter" },
  "state": {
    "linked": "Linked",
    "pending": "Pending",
    "error": "Needs attention",
    "identity": "Identity only",
    "not_linked": "Not linked"
  },
  "reason": {
    "suggested_match": "Suggested match, not yet confirmed",
    "sync_error": "Last sync failed",
    "consent_pending": "Waiting for Microsoft consent",
    "expired": "Connection expired",
    "degraded": "Connection degraded",
    "suspended": "Connection suspended",
    "error": "Connection reported an error",
    "never_synced": "Never synced",
    "sync_failed": "Connector sync failed",
    "disabled": "Connection disabled",
    "connector_error": "Connector inactive or failing"
  },
  "notLinked": "{{system}} not linked",
  "nothingLinked": "Nothing linked",
  "connectorMuted": "{{system}} connector is not connected",
  "badgeLabel": "{{orgName}}: {{system}}, {{state}}",
  "badgeLabelWithReason": "{{orgName}}: {{system}}, {{state}} ({{reason}})",
  "connectors": {
    "repair": {
      "reauth_required": "{{system}} needs reconnecting",
      "disconnected": "{{system}} is disconnected",
      "error": "{{system}} connector has an error",
      "disabled": "{{system}} connector is disabled"
    },
    "openSettings": "Open {{system}} settings"
  }
}
```
(The one-key objects above mean "add this key to that existing group" — do not replace the groups.)

- [ ] **Step 3: Add the seven translations, merged the same way**

`de-DE/organizations.json`:
```json
"columns": { "integrations": "Integrationen" },
"filters": { "unlinked": "Nicht verknüpft" },
"band": { "unlinked": "Nicht verknüpft" },
"chips": { "noActiveContract": "Kein aktiver Vertrag", "noBackup": "Kein Backup konfiguriert" },
"repair": { "backup": "Backup für {{orgName}} öffnen" },
"integrations": {
  "system": { "psa": "PSA", "dns_filter": "DNS-Filter" },
  "state": { "linked": "Verknüpft", "pending": "Ausstehend", "error": "Erfordert Aufmerksamkeit", "identity": "Nur Identität", "not_linked": "Nicht verknüpft" },
  "reason": {
    "suggested_match": "Vorgeschlagene Zuordnung, noch nicht bestätigt",
    "sync_error": "Letzte Synchronisierung fehlgeschlagen",
    "consent_pending": "Wartet auf Microsoft-Einwilligung",
    "expired": "Verbindung abgelaufen",
    "degraded": "Verbindung eingeschränkt",
    "suspended": "Verbindung ausgesetzt",
    "error": "Verbindung hat einen Fehler gemeldet",
    "never_synced": "Noch nie synchronisiert",
    "sync_failed": "Connector-Synchronisierung fehlgeschlagen",
    "disabled": "Verbindung deaktiviert",
    "connector_error": "Connector inaktiv oder fehlerhaft"
  },
  "notLinked": "{{system}} nicht verknüpft",
  "nothingLinked": "Nichts verknüpft",
  "connectorMuted": "{{system}}-Connector ist nicht verbunden",
  "badgeLabel": "{{orgName}}: {{system}}, {{state}}",
  "badgeLabelWithReason": "{{orgName}}: {{system}}, {{state}} ({{reason}})",
  "connectors": {
    "repair": {
      "reauth_required": "{{system}} muss neu verbunden werden",
      "disconnected": "{{system}} ist getrennt",
      "error": "{{system}}-Connector hat einen Fehler",
      "disabled": "{{system}}-Connector ist deaktiviert"
    },
    "openSettings": "{{system}}-Einstellungen öffnen"
  }
}
```

`es-419/organizations.json`:
```json
"columns": { "integrations": "Integraciones" },
"filters": { "unlinked": "Sin vincular" },
"band": { "unlinked": "Sin vincular" },
"chips": { "noActiveContract": "Sin contrato activo", "noBackup": "Sin respaldo configurado" },
"repair": { "backup": "Abrir el respaldo de {{orgName}}" },
"integrations": {
  "system": { "psa": "PSA", "dns_filter": "Filtro DNS" },
  "state": { "linked": "Vinculado", "pending": "Pendiente", "error": "Requiere atención", "identity": "Solo identidad", "not_linked": "Sin vincular" },
  "reason": {
    "suggested_match": "Coincidencia sugerida, aún sin confirmar",
    "sync_error": "La última sincronización falló",
    "consent_pending": "Esperando el consentimiento de Microsoft",
    "expired": "Conexión vencida",
    "degraded": "Conexión degradada",
    "suspended": "Conexión suspendida",
    "error": "La conexión informó un error",
    "never_synced": "Nunca sincronizado",
    "sync_failed": "La sincronización del conector falló",
    "disabled": "Conexión deshabilitada",
    "connector_error": "Conector inactivo o con fallas"
  },
  "notLinked": "{{system}} sin vincular",
  "nothingLinked": "Nada vinculado",
  "connectorMuted": "El conector de {{system}} no está conectado",
  "badgeLabel": "{{orgName}}: {{system}}, {{state}}",
  "badgeLabelWithReason": "{{orgName}}: {{system}}, {{state}} ({{reason}})",
  "connectors": {
    "repair": {
      "reauth_required": "{{system}} necesita reconectarse",
      "disconnected": "{{system}} está desconectado",
      "error": "El conector de {{system}} tiene un error",
      "disabled": "El conector de {{system}} está deshabilitado"
    },
    "openSettings": "Abrir la configuración de {{system}}"
  }
}
```

`fr-FR/organizations.json`:
```json
"columns": { "integrations": "Intégrations" },
"filters": { "unlinked": "Non liés" },
"band": { "unlinked": "Non liés" },
"chips": { "noActiveContract": "Aucun contrat actif", "noBackup": "Aucune sauvegarde configurée" },
"repair": { "backup": "Ouvrir la sauvegarde de {{orgName}}" },
"integrations": {
  "system": { "psa": "PSA", "dns_filter": "Filtre DNS" },
  "state": { "linked": "Lié", "pending": "En attente", "error": "Nécessite une attention", "identity": "Identité seulement", "not_linked": "Non lié" },
  "reason": {
    "suggested_match": "Correspondance suggérée, pas encore confirmée",
    "sync_error": "Échec de la dernière synchronisation",
    "consent_pending": "En attente du consentement Microsoft",
    "expired": "Connexion expirée",
    "degraded": "Connexion dégradée",
    "suspended": "Connexion suspendue",
    "error": "La connexion a signalé une erreur",
    "never_synced": "Jamais synchronisé",
    "sync_failed": "Échec de la synchronisation du connecteur",
    "disabled": "Connexion désactivée",
    "connector_error": "Connecteur inactif ou en échec"
  },
  "notLinked": "{{system}} non lié",
  "nothingLinked": "Rien de lié",
  "connectorMuted": "Le connecteur {{system}} n'est pas connecté",
  "badgeLabel": "{{orgName}} : {{system}}, {{state}}",
  "badgeLabelWithReason": "{{orgName}} : {{system}}, {{state}} ({{reason}})",
  "connectors": {
    "repair": {
      "reauth_required": "{{system}} doit être reconnecté",
      "disconnected": "{{system}} est déconnecté",
      "error": "Le connecteur {{system}} a une erreur",
      "disabled": "Le connecteur {{system}} est désactivé"
    },
    "openSettings": "Ouvrir les paramètres {{system}}"
  }
}
```

`fr-CA/organizations.json`:
```json
"columns": { "integrations": "Intégrations" },
"filters": { "unlinked": "Non liés" },
"band": { "unlinked": "Non liés" },
"chips": { "noActiveContract": "Aucun contrat actif", "noBackup": "Aucune sauvegarde configurée" },
"repair": { "backup": "Ouvrir la sauvegarde pour {{orgName}}" },
"integrations": {
  "system": { "psa": "PSA", "dns_filter": "Filtre DNS" },
  "state": { "linked": "Lié", "pending": "En attente", "error": "Nécessite une attention", "identity": "Identité seulement", "not_linked": "Non lié" },
  "reason": {
    "suggested_match": "Correspondance suggérée, pas encore confirmée",
    "sync_error": "Échec de la dernière synchronisation",
    "consent_pending": "En attente du consentement Microsoft",
    "expired": "Connexion expirée",
    "degraded": "Connexion dégradée",
    "suspended": "Connexion suspendue",
    "error": "La connexion a signalé une erreur",
    "never_synced": "Jamais synchronisé",
    "sync_failed": "Échec de la synchronisation du connecteur",
    "disabled": "Connexion désactivée",
    "connector_error": "Connecteur inactif ou en échec"
  },
  "notLinked": "{{system}} non lié",
  "nothingLinked": "Rien de lié",
  "connectorMuted": "Le connecteur {{system}} n'est pas connecté",
  "badgeLabel": "{{orgName}} : {{system}}, {{state}}",
  "badgeLabelWithReason": "{{orgName}} : {{system}}, {{state}} ({{reason}})",
  "connectors": {
    "repair": {
      "reauth_required": "{{system}} doit être reconnecté",
      "disconnected": "{{system}} est déconnecté",
      "error": "Le connecteur {{system}} a une erreur",
      "disabled": "Le connecteur {{system}} est désactivé"
    },
    "openSettings": "Ouvrir les paramètres de {{system}}"
  }
}
```

`it-IT/organizations.json`:
```json
"columns": { "integrations": "Integrazioni" },
"filters": { "unlinked": "Non collegati" },
"band": { "unlinked": "Non collegati" },
"chips": { "noActiveContract": "Nessun contratto attivo", "noBackup": "Nessun backup configurato" },
"repair": { "backup": "Apri il backup di {{orgName}}" },
"integrations": {
  "system": { "psa": "PSA", "dns_filter": "Filtro DNS" },
  "state": { "linked": "Collegato", "pending": "In sospeso", "error": "Richiede attenzione", "identity": "Solo identità", "not_linked": "Non collegato" },
  "reason": {
    "suggested_match": "Corrispondenza suggerita, non ancora confermata",
    "sync_error": "Ultima sincronizzazione non riuscita",
    "consent_pending": "In attesa del consenso Microsoft",
    "expired": "Connessione scaduta",
    "degraded": "Connessione degradata",
    "suspended": "Connessione sospesa",
    "error": "La connessione ha segnalato un errore",
    "never_synced": "Mai sincronizzato",
    "sync_failed": "Sincronizzazione del connettore non riuscita",
    "disabled": "Connessione disattivata",
    "connector_error": "Connettore inattivo o in errore"
  },
  "notLinked": "{{system}} non collegato",
  "nothingLinked": "Nessun collegamento",
  "connectorMuted": "Il connettore {{system}} non è connesso",
  "badgeLabel": "{{orgName}}: {{system}}, {{state}}",
  "badgeLabelWithReason": "{{orgName}}: {{system}}, {{state}} ({{reason}})",
  "connectors": {
    "repair": {
      "reauth_required": "{{system}} deve essere riconnesso",
      "disconnected": "{{system}} è disconnesso",
      "error": "Il connettore {{system}} ha un errore",
      "disabled": "Il connettore {{system}} è disattivato"
    },
    "openSettings": "Apri le impostazioni di {{system}}"
  }
}
```

`pt-BR/organizations.json`:
```json
"columns": { "integrations": "Integrações" },
"filters": { "unlinked": "Sem vínculo" },
"band": { "unlinked": "Sem vínculo" },
"chips": { "noActiveContract": "Nenhum contrato ativo", "noBackup": "Nenhum backup configurado" },
"repair": { "backup": "Abrir o backup de {{orgName}}" },
"integrations": {
  "system": { "psa": "PSA", "dns_filter": "Filtro DNS" },
  "state": { "linked": "Vinculado", "pending": "Pendente", "error": "Requer atenção", "identity": "Somente identidade", "not_linked": "Não vinculado" },
  "reason": {
    "suggested_match": "Correspondência sugerida, ainda não confirmada",
    "sync_error": "Falha na última sincronização",
    "consent_pending": "Aguardando o consentimento da Microsoft",
    "expired": "Conexão expirada",
    "degraded": "Conexão degradada",
    "suspended": "Conexão suspensa",
    "error": "A conexão informou um erro",
    "never_synced": "Nunca sincronizado",
    "sync_failed": "Falha na sincronização do conector",
    "disabled": "Conexão desativada",
    "connector_error": "Conector inativo ou com falha"
  },
  "notLinked": "{{system}} não vinculado",
  "nothingLinked": "Nada vinculado",
  "connectorMuted": "O conector do {{system}} não está conectado",
  "badgeLabel": "{{orgName}}: {{system}}, {{state}}",
  "badgeLabelWithReason": "{{orgName}}: {{system}}, {{state}} ({{reason}})",
  "connectors": {
    "repair": {
      "reauth_required": "{{system}} precisa ser reconectado",
      "disconnected": "{{system}} está desconectado",
      "error": "O conector do {{system}} tem um erro",
      "disabled": "O conector do {{system}} está desativado"
    },
    "openSettings": "Abrir as configurações do {{system}}"
  }
}
```

`tr-TR/organizations.json`:
```json
"columns": { "integrations": "Entegrasyonlar" },
"filters": { "unlinked": "Bağlı olmayan" },
"band": { "unlinked": "Bağlı olmayan" },
"chips": { "noActiveContract": "Etkin sözleşme yok", "noBackup": "Yedekleme yapılandırılmamış" },
"repair": { "backup": "{{orgName}} yedeklemesini aç" },
"integrations": {
  "system": { "psa": "PSA", "dns_filter": "DNS filtresi" },
  "state": { "linked": "Bağlı", "pending": "Beklemede", "error": "İlgilenilmesi gerekiyor", "identity": "Yalnızca kimlik", "not_linked": "Bağlı değil" },
  "reason": {
    "suggested_match": "Önerilen eşleşme, henüz onaylanmadı",
    "sync_error": "Son eşitleme başarısız oldu",
    "consent_pending": "Microsoft onayı bekleniyor",
    "expired": "Bağlantının süresi doldu",
    "degraded": "Bağlantı bozulmuş",
    "suspended": "Bağlantı askıya alındı",
    "error": "Bağlantı bir hata bildirdi",
    "never_synced": "Hiç eşitlenmedi",
    "sync_failed": "Bağlayıcı eşitlemesi başarısız oldu",
    "disabled": "Bağlantı devre dışı",
    "connector_error": "Bağlayıcı etkin değil veya hatalı"
  },
  "notLinked": "{{system}} bağlı değil",
  "nothingLinked": "Hiçbir şey bağlı değil",
  "connectorMuted": "{{system}} bağlayıcısı bağlı değil",
  "badgeLabel": "{{orgName}}: {{system}}, {{state}}",
  "badgeLabelWithReason": "{{orgName}}: {{system}}, {{state}} ({{reason}})",
  "connectors": {
    "repair": {
      "reauth_required": "{{system}} yeniden bağlanmalı",
      "disconnected": "{{system}} bağlantısı kesildi",
      "error": "{{system}} bağlayıcısında bir hata var",
      "disabled": "{{system}} bağlayıcısı devre dışı"
    },
    "openSettings": "{{system}} ayarlarını aç"
  }
}
```

- [ ] **Step 4: Run the coverage contract to see the baseline breach (the red)**

Run: `cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts`
Expected: FAIL — `organizations.json: N exact-English duplicates exceeds baseline M` for de-DE, es-419, it-IT, pt-BR, tr-TR (three new duplicates each: `"PSA"` and the two pure-interpolation `badgeLabel*` literals) and for fr-FR / fr-CA (one each: `"PSA"` — French puts a space before the colon, so the badge labels differ).

- [ ] **Step 5: Bump the seven `organizations.json` baselines by exactly that delta, with the file's comment convention**

In `apps/web/src/lib/i18n/translationCoverage.test.ts` change the `'organizations.json'` line in each locale block (values as W02 left them → new): `pt-BR` 6 → 9, `es-419` 1 → 4, `de-DE` 3 → 6, `it-IT` 3 → 6, `tr-TR` 2 → 5, `fr-FR` 10 → 11, `fr-CA` 9 → 10. If W02 landed with different numbers, add 3 (or 1 for the two French catalogs) to whatever is there. Append to each line's existing trailing comment:

```ts
    // +3 W03 account board: "PSA" is a locale-invariant acronym; orgBoard.integrations.badgeLabel /
    // badgeLabelWithReason are pure-interpolation literals ("{{orgName}}: {{system}}, {{state}}").
```
(for fr-FR / fr-CA: `// +1 W03 account board: "PSA" is a locale-invariant acronym.`)

- [ ] **Step 6: Run the four i18n contracts**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/terminologyQuality.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS, 4 files (keyUsage passes because unused catalog keys are allowed; Tasks 8–10 make them used).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/locales/*/organizations.json apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "i18n(web): account board integrations, Unlinked filter, contract and backup chips in eight locales (W03 #5724)"
```

---

### Task 8: Web derivations — typed integrations, badges, "not linked", the Unlinked filter, the Integrations column switch, two new chips

**Files:**
- Modify: `apps/web/src/lib/orgReadiness.ts` (W02)
- Modify: `apps/web/src/lib/orgReadiness.test.ts` (W02 — two assertions that pinned the W03 slots closed)
- Test: `apps/web/src/lib/orgReadiness.integrations.test.ts`

**Interfaces:**
- Consumes (W02): `ReadinessCapabilities`, `ReadinessOrg`, `AccountReadinessResponse`, `ReadinessRowState`, `SetupChipKey`, `AccountChipKey`, `ChipKey`, `RepairTarget`, `REPAIR_TARGETS`, `repairHref`, module-private `chip(key, orgId, tone, count?)`, `deriveReadinessChips`, `BOARD_FILTERS`, `BoardFilter`, `BOARD_COLUMNS`, `INTEGRATIONS_COLUMN_ENABLED`, `FILTER_EVIDENCE`, `visibleColumns`, `visibleFilters`, `matchesFilter`, `BoardRow`; `Organization` from `@/components/settings/organizationTypes`.
- Produces: types `ConnectorSystem`, `ConnectorState`, `ReadinessConnector { system; state; provider? }`, `IntegrationSystem`, `IntegrationState`, `IntegrationReason`, `ReadinessIntegration { system; state; reason?; label? }` (web mirrors of Task 1), `IntegrationBadge { system; state: IntegrationState | 'not_linked'; reason?; label?; muted: boolean }`, `ConnectorRepair { system; state: Exclude<ConnectorState,'connected'>; provider?; href }`; constants `SYSTEM_DISPLAY_NAMES`, `PSA_PROVIDER_NAMES`, `CONNECTOR_SETTINGS_HREF`, `NOT_LINKED_CONNECTOR_SYSTEMS`; functions `deriveIntegrationBadges(readiness, connectors, capabilities): IntegrationBadge[] | null`, `hasUnlinked(badges)`, `connectorRepairs(connectors)`. Changed: `ReadinessCapabilities` gains `contracts; backup`; `ReadinessOrg.setup` gains `backupConfigured?; backupApplicable?`, `.account` gains `activeContracts?`, `integrations?` becomes `ReadinessIntegration[]`; `AccountReadinessResponse` gains `connectors?`; `SetupChipKey` gains `'noBackup'`, `AccountChipKey` gains `'noActiveContract'`, `RepairTarget` gains `'backup'`; `BOARD_FILTERS` gains `'unlinked'` (between `accountMissing` and `openTickets`); `BoardRow` gains `badges: IntegrationBadge[] | null`; `visibleColumns` enables `'integrations'` on the capability; `visibleFilters` gates `'unlinked'` on it; `matchesFilter('unlinked', row)`; `deriveReadinessChips` emits `noBackup` (setup) and `noActiveContract` (account).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/lib/orgReadiness.integrations.test.ts
import { describe, expect, it } from 'vitest';
import {
  BOARD_FILTERS,
  connectorRepairs,
  deriveIntegrationBadges,
  deriveReadinessChips,
  hasUnlinked,
  matchesFilter,
  repairHref,
  visibleColumns,
  visibleFilters,
  type BoardRow,
  type ReadinessCapabilities,
  type ReadinessConnector,
  type ReadinessOrg,
} from './orgReadiness';
import type { Organization } from '@/components/settings/organizationTypes';

const NOW = new Date('2026-09-13T12:00:00.000Z');

const CAPS: ReadinessCapabilities = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true,
  invoices: true, tickets: true, integrations: true, contracts: true, backup: true,
};

function org(overrides: Partial<Organization> = {}): Organization {
  return { id: 'org-1', name: 'Acme', status: 'active', type: 'customer', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

function readiness(overrides: Partial<ReadinessOrg> = {}): ReadinessOrg {
  return {
    orgId: 'org-1',
    type: 'customer',
    status: 'active',
    setup: { sites: 1, devices: 2, lastSeenAt: NOW.toISOString(), policyAssigned: true, backupApplicable: true, backupConfigured: true },
    account: {
      primaryContact: { name: 'Jo', email: 'jo@acme.example', phone: '1', mobile: null },
      billingRoleContact: true, billingAddress: true, pendingInvitations: 0, overdueInvoices: 0, activeContracts: 1,
    },
    integrations: [],
    ...overrides,
  };
}

const CONNECTED: ReadinessConnector[] = [
  { system: 'quickbooks', state: 'connected' },
  { system: 'psa', state: 'connected', provider: 'connectwise' },
  { system: 'pax8', state: 'connected' },
  { system: 'huntress', state: 'connected' },
];

describe('deriveIntegrationBadges', () => {
  it('returns null when the section is withheld or the payload is missing', () => {
    expect(deriveIntegrationBadges(readiness({ integrations: undefined }), CONNECTED, { ...CAPS, integrations: false })).toBeNull();
    expect(deriveIntegrationBadges(readiness({ integrations: undefined }), CONNECTED, CAPS)).toBeNull();
    expect(deriveIntegrationBadges(undefined, CONNECTED, CAPS)).toBeNull();
    expect(deriveIntegrationBadges(readiness(), CONNECTED, null)).toBeNull();
  });

  it('keeps real badges in order and appends a dashed "not linked" for each connected connector the customer org lacks', () => {
    expect(deriveIntegrationBadges(
      readiness({ integrations: [{ system: 'quickbooks', state: 'linked' }, { system: 'm365', state: 'pending', reason: 'consent_pending' }] }),
      CONNECTED,
      CAPS,
    )).toEqual([
      { system: 'quickbooks', state: 'linked', muted: false },
      { system: 'm365', state: 'pending', reason: 'consent_pending', muted: false },
      { system: 'psa', state: 'not_linked', muted: false },
      { system: 'pax8', state: 'not_linked', muted: false },
      { system: 'huntress', state: 'not_linked', muted: false },
    ]);
  });

  it('mutes badges of a connector that is not connected and does not evaluate "not linked" for it', () => {
    expect(deriveIntegrationBadges(
      readiness({ integrations: [{ system: 'quickbooks', state: 'error', reason: 'sync_error' }] }),
      [{ system: 'quickbooks', state: 'reauth_required' }, { system: 'pax8', state: 'disabled' }],
      CAPS,
    )).toEqual([{ system: 'quickbooks', state: 'error', reason: 'sync_error', muted: true }]);
  });

  it('never evaluates "not linked" for an internal org, nor when the partner has no connectors', () => {
    expect(deriveIntegrationBadges(readiness({ type: 'internal', integrations: [{ system: 'huntress', state: 'linked' }] }), CONNECTED, CAPS))
      .toEqual([{ system: 'huntress', state: 'linked', muted: false }]);
    expect(deriveIntegrationBadges(readiness({ integrations: [] }), [], CAPS)).toEqual([]);
    expect(deriveIntegrationBadges(readiness({ integrations: [] }), undefined, CAPS)).toEqual([]);
  });

  it('a Xero connector expects a xero badge, not a quickbooks one', () => {
    expect(deriveIntegrationBadges(readiness({ integrations: [{ system: 'quickbooks', state: 'linked' }] }), [{ system: 'xero', state: 'connected' }], CAPS))
      .toEqual([
        { system: 'quickbooks', state: 'linked', muted: false },
        { system: 'xero', state: 'not_linked', muted: false },
      ]);
  });
});

describe('the Unlinked filter and the Integrations column', () => {
  const row = (badges: BoardRow['badges']): BoardRow => ({ org: org(), readiness: readiness(), state: 'ready', chips: null, badges });

  it('BOARD_FILTERS carries unlinked between accountMissing and openTickets', () => {
    expect([...BOARD_FILTERS]).toEqual(['all', 'setupIncomplete', 'accountMissing', 'unlinked', 'openTickets', 'trial', 'archived']);
  });

  it('hasUnlinked is true only with at least one not_linked badge; matchesFilter uses it', () => {
    expect(hasUnlinked(null)).toBe(false);
    expect(hasUnlinked([])).toBe(false);
    expect(hasUnlinked([{ system: 'pax8', state: 'linked', muted: false }])).toBe(false);
    expect(hasUnlinked([{ system: 'pax8', state: 'not_linked', muted: false }])).toBe(true);
    expect(matchesFilter('unlinked', row([{ system: 'pax8', state: 'not_linked', muted: false }]))).toBe(true);
    expect(matchesFilter('unlinked', row([]))).toBe(false);
    expect(matchesFilter('unlinked', row(null))).toBe(false);
  });

  it('the filter and the column follow capabilities.integrations', () => {
    expect(visibleFilters(CAPS)).toContain('unlinked');
    expect(visibleFilters({ ...CAPS, integrations: false })).not.toContain('unlinked');
    expect(visibleFilters(null)).not.toContain('unlinked');
    expect(visibleColumns('both', CAPS)).toEqual(['setup', 'account', 'integrations', 'tickets']);
    expect(visibleColumns('setup', CAPS)).toEqual(['setup', 'integrations', 'tickets']);
    expect(visibleColumns('account', CAPS)).toEqual(['account', 'integrations', 'tickets']);
    expect(visibleColumns('both', { ...CAPS, integrations: false })).toEqual(['setup', 'account', 'tickets']);
  });
});

describe('connectorRepairs', () => {
  it('lists every connector that is not connected, once, with its settings link', () => {
    expect(connectorRepairs([
      { system: 'quickbooks', state: 'reauth_required' },
      { system: 'xero', state: 'disconnected' },
      { system: 'psa', state: 'disabled', provider: 'autotask' },
      { system: 'pax8', state: 'error' },
      { system: 'huntress', state: 'connected' },
      { system: 'sentinelone', state: 'disabled' },
    ])).toEqual([
      { system: 'quickbooks', state: 'reauth_required', href: '/integrations#quickbooks' },
      { system: 'xero', state: 'disconnected', href: '/integrations#accounting' },
      { system: 'psa', state: 'disabled', provider: 'autotask', href: '/integrations/psa' },
      { system: 'pax8', state: 'error', href: '/integrations#pax8' },
      { system: 'sentinelone', state: 'disabled', href: '/integrations#sentinelone' },
    ]);
    expect(connectorRepairs(undefined)).toEqual([]);
    expect(connectorRepairs(null)).toEqual([]);
  });
});

describe('deriveReadinessChips — noActiveContract and noBackup', () => {
  const keys = (list: Array<{ key: string }>) => list.map((c) => c.key);
  const derive = (r: ReadinessOrg, caps = CAPS, mode: 'native' | 'external' | 'off' = 'native', o = org()) =>
    deriveReadinessChips(o, r, caps, mode, NOW);

  it('noActiveContract: active customer org, native, contracts section present, zero active contracts', () => {
    const chips = derive(readiness({ account: { ...readiness().account, activeContracts: 0 } }));
    expect(keys(chips!.account)).toContain('noActiveContract');
    const contract = chips!.account.find((c) => c.key === 'noActiveContract')!;
    expect(contract).toMatchObject({ tone: 'warning', target: 'billing', href: '/organizations/org-1#billing' });
  });

  it.each([
    ['section withheld', readiness({ account: { ...readiness().account, activeContracts: undefined } }), { ...CAPS, contracts: false }, 'native'],
    ['has a contract', readiness(), CAPS, 'native'],
    ['internal org', readiness({ type: 'internal', account: { ...readiness().account, activeContracts: 0 } }), CAPS, 'native'],
    ['trial org', readiness({ status: 'trial', account: { ...readiness().account, activeContracts: 0 } }), CAPS, 'native'],
    ['suspended org', readiness({ status: 'suspended', account: { ...readiness().account, activeContracts: 0 } }), CAPS, 'native'],
    ['external service mode', readiness({ account: { ...readiness().account, activeContracts: 0 } }), CAPS, 'external'],
  ] as const)('noActiveContract does not fire: %s', (_label, r, caps, mode) => {
    expect(keys(derive(r, caps, mode)!.account)).not.toContain('noActiveContract');
  });

  it('noBackup: partner uses backup, this org has no active config — a setup chip, internal orgs included', () => {
    const chips = derive(readiness({ setup: { ...readiness().setup, backupConfigured: false } }));
    const backup = chips!.setup.find((c) => c.key === 'noBackup')!;
    expect(backup).toMatchObject({ tone: 'warning', target: 'backup', href: '/backup' });
    expect(keys(derive(readiness({ type: 'internal', setup: { ...readiness().setup, backupConfigured: false } }))!.setup)).toContain('noBackup');
    expect(repairHref('backup', 'org-1')).toBe('/backup');
  });

  it('noBackup does not fire when withheld, not applicable, or configured', () => {
    expect(keys(derive(readiness({ setup: { ...readiness().setup, backupApplicable: undefined, backupConfigured: undefined } }), { ...CAPS, backup: false })!.setup)).not.toContain('noBackup');
    expect(keys(derive(readiness({ setup: { ...readiness().setup, backupApplicable: false, backupConfigured: false } }))!.setup)).not.toContain('noBackup');
    expect(keys(derive(readiness())!.setup)).not.toContain('noBackup');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/orgReadiness.integrations.test.ts`
Expected: FAIL — `deriveIntegrationBadges` is not exported.

- [ ] **Step 3: Extend `lib/orgReadiness.ts`**

1. Replace the wire slots W02 left with typed members (add the types right after `ReadinessTickets`):
```ts
/* ---- W03 wire shapes (mirror apps/api/src/services/orgAccountReadinessIntegrations.ts) ---- */
export type ConnectorSystem = 'quickbooks' | 'xero' | 'psa' | 'pax8' | 'huntress' | 'sentinelone';
export type ConnectorState = 'connected' | 'reauth_required' | 'disconnected' | 'error' | 'disabled';
export interface ReadinessConnector {
  system: ConnectorSystem;
  state: ConnectorState;
  /** PSA provider id — PSA only. */
  provider?: string;
}
export type IntegrationSystem = ConnectorSystem | 'm365' | 'dns_filter' | 'external';
export type IntegrationState = 'linked' | 'pending' | 'error' | 'identity';
export type IntegrationReason =
  | 'suggested_match' | 'sync_error' | 'consent_pending' | 'expired' | 'degraded' | 'suspended'
  | 'error' | 'never_synced' | 'sync_failed' | 'disabled' | 'connector_error';
export interface ReadinessIntegration {
  system: IntegrationSystem;
  state: IntegrationState;
  /** A code; translated under orgBoard.integrations.reason.* */
  reason?: IntegrationReason;
  /** 'external' rows: the raw organization_external_links.system value. */
  label?: string;
}
```
In `ReadinessCapabilities` add:
```ts
  /** W03: contracts:read AND native mode. */
  contracts: boolean;
  /** W03: backup:read. */
  backup: boolean;
```
In `ReadinessOrg.setup` add `backupConfigured?: boolean; backupApplicable?: boolean;`; in `ReadinessOrg.account` add `activeContracts?: number;`; replace `integrations?: unknown[]` with `integrations?: ReadinessIntegration[]`. In `AccountReadinessResponse` add `connectors?: ReadinessConnector[];`.

2. Chips: change the unions and maps —
```ts
export type SetupChipKey = 'noSite' | 'noDevices' | 'noCheckIn' | 'staleCheckIn' | 'noPolicy' | 'noBackup';
export type AccountChipKey =
  | 'primaryContact' | 'contactEmail' | 'contactPhone' | 'billingContact' | 'billingAddress'
  | 'noActiveContract' | 'overdueInvoices' | 'invitation';
export type RepairTarget = 'sites' | 'devices' | 'policies' | 'contacts' | 'settings' | 'billing' | 'backup';
```
add to `REPAIR_TARGETS`: `noBackup: 'backup',` and `noActiveContract: 'billing',`; add to `repairHref`'s switch: `case 'backup': return '/backup';`.

3. Inside `deriveReadinessChips`, directly after the `noPolicy` line:
```ts
  // W03: applicable only when the partner uses backup at all (plan §1); a setup chip, so internal orgs count.
  if (capabilities.backup && readiness.setup.backupApplicable === true && readiness.setup.backupConfigured === false) {
    setup.push(chip('noBackup', org.id, 'warning'));
  }
```
and inside the `accountApplicable` block, directly after the `billingAddress` line (before the overdue-invoices line):
```ts
    // W03: the contracts table is the source of truth; evergreen terms count as active (plan §8).
    if (billingApplies && capabilities.contracts && mode === 'native' && readiness.account.activeContracts === 0) {
      account.push(chip('noActiveContract', org.id, 'warning'));
    }
```

4. Board config:
```ts
export const BOARD_FILTERS = ['all', 'setupIncomplete', 'accountMissing', 'unlinked', 'openTickets', 'trial', 'archived'] as const;
```
delete `INTEGRATIONS_COLUMN_ENABLED` and its comment; in `visibleColumns` change the integrations line to `if (column === 'integrations') return capabilities?.integrations === true;`; in `visibleFilters` change the predicate to
```ts
  return BOARD_FILTERS.filter((filter) => {
    if (filter === 'openTickets') return capabilities?.tickets === true;
    if (filter === 'unlinked') return capabilities?.integrations === true;
    return true;
  });
```
add `unlinked: 'integrations',` to `FILTER_EVIDENCE` (the column is never lens-hidden, so `lensForFilter` never forces Both for it — the entry documents the evidence column); add `badges: IntegrationBadge[] | null;` to `BoardRow` (with the comment `/** null = integrations withheld, or the row's batch not landed. */`); add to `matchesFilter`:
```ts
    case 'unlinked':
      return hasUnlinked(row.badges);
```

5. Append the W03 block (after `searchMatches`):
```ts
/* ------------------------------ W03 integrations ------------------------------ */
// Spec "Integrations cell"; plan "Spec ambiguities resolved" §2, §7, §9, §10.

export interface IntegrationBadge {
  system: IntegrationSystem;
  state: IntegrationState | 'not_linked';
  reason?: IntegrationReason;
  label?: string;
  /** The system's partner connector is not connected: render quietly, never as a problem. */
  muted: boolean;
}

export interface ConnectorRepair {
  system: ConnectorSystem;
  state: Exclude<ConnectorState, 'connected'>;
  provider?: string;
  href: string;
}

/** Brand names are locale-invariant product names, so they live here rather than in eight catalogs. */
export const SYSTEM_DISPLAY_NAMES: Record<Exclude<IntegrationSystem, 'psa' | 'dns_filter' | 'external'>, string> = {
  quickbooks: 'QuickBooks',
  xero: 'Xero',
  pax8: 'Pax8',
  m365: 'Microsoft 365',
  huntress: 'Huntress',
  sentinelone: 'SentinelOne',
};

/** PSA provider ids from PSA_PROVIDERS (@breeze/shared validators/psa.ts) → product names. */
export const PSA_PROVIDER_NAMES: Record<string, string> = {
  connectwise: 'ConnectWise',
  autotask: 'Autotask',
  jira: 'Jira',
  servicenow: 'ServiceNow',
  freshservice: 'Freshservice',
  zendesk: 'Zendesk',
};

/** Where a connector is repaired — the /integrations hub tab hashes (IntegrationsPage.tsx) and the PSA page. */
export const CONNECTOR_SETTINGS_HREF: Record<ConnectorSystem, string> = {
  quickbooks: '/integrations#quickbooks',
  xero: '/integrations#accounting',
  psa: '/integrations/psa',
  pax8: '/integrations#pax8',
  huntress: '/integrations#huntress',
  sentinelone: '/integrations#sentinelone',
};

/** Connectors that imply a per-org mapping (a dashed "not linked" is meaningful). M365 / DNS / external have no partner connector. */
export const NOT_LINKED_CONNECTOR_SYSTEMS: readonly ConnectorSystem[] = ['quickbooks', 'xero', 'psa', 'pax8', 'huntress', 'sentinelone'];

export function deriveIntegrationBadges(
  readiness: ReadinessOrg | undefined,
  connectors: ReadinessConnector[] | null | undefined,
  capabilities: ReadinessCapabilities | null,
): IntegrationBadge[] | null {
  if (!capabilities?.integrations || !readiness?.integrations) return null;
  const connected = new Set<ConnectorSystem>();
  const notConnected = new Set<ConnectorSystem>();
  for (const connector of connectors ?? []) {
    if (connector.state === 'connected') connected.add(connector.system);
    else notConnected.add(connector.system);
  }
  const badges: IntegrationBadge[] = readiness.integrations.map((row) => ({
    ...row,
    muted: notConnected.has(row.system as ConnectorSystem) && !connected.has(row.system as ConnectorSystem),
  }));
  if (readiness.type !== 'customer') return badges;
  const present = new Set(readiness.integrations.map((row) => row.system));
  for (const system of NOT_LINKED_CONNECTOR_SYSTEMS) {
    if (connected.has(system) && !present.has(system)) badges.push({ system, state: 'not_linked', muted: false });
  }
  return badges;
}

export function hasUnlinked(badges: IntegrationBadge[] | null): boolean {
  return badges !== null && badges.some((badge) => badge.state === 'not_linked');
}

/** One repair line per connector that is not connected — never N per-org problems. */
export function connectorRepairs(connectors: ReadinessConnector[] | null | undefined): ConnectorRepair[] {
  const repairs: ConnectorRepair[] = [];
  for (const connector of connectors ?? []) {
    if (connector.state === 'connected') continue;
    repairs.push({
      system: connector.system,
      state: connector.state,
      ...(connector.provider ? { provider: connector.provider } : {}),
      href: CONNECTOR_SETTINGS_HREF[connector.system],
    });
  }
  return repairs;
}
```

- [ ] **Step 4: Update the two W02 assertions that pinned the slots closed, then run both files**

In `apps/web/src/lib/orgReadiness.test.ts`: the `visibleFilters` case that expects `[...BOARD_FILTERS]` for `{ ...caps, tickets: true }` now needs `integrations: true` as well (or expect the list without `'unlinked'`); any `visibleColumns` case asserting `'integrations'` absent with `integrations: true` now expects it present. Add `badges: null` to W02's `BoardRow` factory. W02's `ReadinessCapabilities` fixtures gain `contracts: false, backup: false` (type-only change).

Run: `cd apps/web && npx vitest run src/lib/orgReadiness.test.ts src/lib/orgReadiness.integrations.test.ts`
Expected: PASS, 2 files.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/orgReadiness.ts apps/web/src/lib/orgReadiness.test.ts apps/web/src/lib/orgReadiness.integrations.test.ts
git commit -m "feat(web): account board integration badges, Unlinked filter, Integrations column switch, contract and backup chips (W03 #5724)"
```

---

### Task 9: `IntegrationBadges` and the Integrations column in every lens

**Files:**
- Create: `apps/web/src/components/organizations/board/IntegrationBadges.tsx`
- Test: `apps/web/src/components/organizations/board/IntegrationBadges.test.tsx`
- Modify: `apps/web/src/components/organizations/board/AccountBoardTable.tsx` (W02)
- Test: `apps/web/src/components/organizations/board/AccountBoardTable.integrations.test.tsx`

**Interfaces:**
- Consumes: Task 8's `IntegrationBadge`, `ReadinessConnector`, `SYSTEM_DISPLAY_NAMES`, `PSA_PROVIDER_NAMES`, `BoardRow` (`state`, `badges`, `org`); Task 7's keys; W02's `AccountBoardTableProps`, `showSetup/showAccount/showTickets`, `ReadinessChips`' pending/failed conventions, `DataCard`.
- Produces: `IntegrationBadges({ row, psaProvider, testIdPrefix = 'org-board-badge' }: { row: BoardRow; psaProvider?: string; testIdPrefix?: string })` (default export) and `integrationSystemName(t, system, opts?)` (named). Testids: `org-board-badges-pending`, `org-board-badges-unavailable`, `org-board-badges-<orgId>` (the list), `<prefix>-<orgId>-<system>` (external: `<prefix>-<orgId>-external-<label>`), `org-board-nothing-linked-<orgId>`; the phone cards use prefix `org-board-card-badge`. Table: `AccountBoardTableProps.connectors?: ReadinessConnector[] | null`; header testid `org-board-col-integrations`, rendered whenever `columns` contains `'integrations'` (every lens — `visibleColumns` never lens-hides it).

- [ ] **Step 1: Write the failing badge tests**

```tsx
// apps/web/src/components/organizations/board/IntegrationBadges.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';
import IntegrationBadges from './IntegrationBadges';
import type { BoardRow, IntegrationBadge, ReadinessRowState } from '@/lib/orgReadiness';

const ORG = 'org-1';

function row(badges: IntegrationBadge[] | null, state: ReadinessRowState = 'ready'): BoardRow {
  return {
    org: { id: ORG, name: 'Acme', status: 'active', type: 'customer', createdAt: '2026-01-01T00:00:00.000Z' },
    readiness: undefined,
    state,
    chips: null,
    badges,
  };
}

describe('IntegrationBadges', () => {
  it('renders a skeleton while the batch is in flight and "Unavailable" when it failed', () => {
    const { rerender } = render(<IntegrationBadges row={row(null, 'pending')} />);
    expect(screen.getByTestId('org-board-badges-pending')).toBeInTheDocument();
    rerender(<IntegrationBadges row={row(null, 'failed')} />);
    expect(screen.getByTestId('org-board-badges-unavailable')).toHaveTextContent('Unavailable');
  });

  it('renders a dash when the section is withheld', () => {
    render(<IntegrationBadges row={row(null)} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows "Nothing linked" muted for an empty list', () => {
    render(<IntegrationBadges row={row([])} />);
    expect(screen.getByTestId(`org-board-nothing-linked-${ORG}`)).toHaveTextContent('Nothing linked');
  });

  it('renders one badge per system with the state colour, the brand name, and an accessible name carrying the org and reason', () => {
    render(
      <IntegrationBadges
        row={row([
          { system: 'quickbooks', state: 'linked', muted: false },
          { system: 'm365', state: 'pending', reason: 'consent_pending', muted: false },
          { system: 'dns_filter', state: 'error', reason: 'sync_error', muted: false },
          { system: 'external', state: 'identity', label: 'datto_rmm', muted: false },
          { system: 'psa', state: 'not_linked', muted: false },
        ])}
        psaProvider="connectwise"
      />,
    );
    const qbo = screen.getByTestId(`org-board-badge-${ORG}-quickbooks`);
    expect(qbo).toHaveTextContent('QuickBooks');
    expect(qbo).toHaveAttribute('aria-label', 'Acme: QuickBooks, Linked');
    expect(qbo.querySelector('[data-dot]')?.className).toContain('bg-success');

    const m365 = screen.getByTestId(`org-board-badge-${ORG}-m365`);
    expect(m365).toHaveAttribute('aria-label', 'Acme: Microsoft 365, Pending (Waiting for Microsoft consent)');
    expect(m365).toHaveAttribute('title', 'Waiting for Microsoft consent');
    expect(m365.querySelector('[data-dot]')?.className).toContain('bg-warning');

    const dns = screen.getByTestId(`org-board-badge-${ORG}-dns_filter`);
    expect(dns).toHaveTextContent('DNS filter');
    expect(dns.querySelector('[data-dot]')?.className).toContain('bg-destructive');

    const ext = screen.getByTestId(`org-board-badge-${ORG}-external-datto_rmm`);
    expect(ext).toHaveTextContent('datto_rmm');
    expect(ext).toHaveAttribute('aria-label', 'Acme: datto_rmm, Identity only');

    const psa = screen.getByTestId(`org-board-badge-${ORG}-psa`);
    expect(psa).toHaveTextContent('ConnectWise not linked');
    expect(psa.className).toContain('border-dashed');
  });

  it('a muted badge is dimmed and explains why in its title; the card prefix changes the testids', () => {
    render(<IntegrationBadges row={row([{ system: 'pax8', state: 'error', reason: 'sync_failed', muted: true }])} testIdPrefix="org-board-card-badge" />);
    const badge = screen.getByTestId(`org-board-card-badge-${ORG}-pax8`);
    expect(badge.className).toContain('opacity-60');
    expect(badge).toHaveAttribute('title', 'Pax8 connector is not connected');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/organizations/board/IntegrationBadges.test.tsx`
Expected: FAIL — cannot resolve `./IntegrationBadges`.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/organizations/board/IntegrationBadges.tsx
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '@/lib/i18n';
import {
  PSA_PROVIDER_NAMES,
  SYSTEM_DISPLAY_NAMES,
  type BoardRow,
  type IntegrationBadge,
  type IntegrationSystem,
} from '@/lib/orgReadiness';

/** Brand names come from code; only PSA, DNS filter and the external label are locale-dependent. */
export function integrationSystemName(
  t: TFunction,
  system: IntegrationSystem,
  opts: { provider?: string; label?: string } = {},
): string {
  if (system === 'psa') return (opts.provider && PSA_PROVIDER_NAMES[opts.provider]) || t('orgBoard.integrations.system.psa');
  if (system === 'dns_filter') return t('orgBoard.integrations.system.dns_filter');
  if (system === 'external') return opts.label ?? '';
  return SYSTEM_DISPLAY_NAMES[system];
}

/** Semantic tokens only, as lib/orgStatus.ts does — dark mode themes itself. */
const DOT_CLASS: Record<IntegrationBadge['state'], string> = {
  linked: 'bg-success',
  pending: 'bg-warning',
  error: 'bg-destructive',
  identity: 'bg-muted-foreground/60',
  not_linked: 'border border-dashed border-muted-foreground/60 bg-transparent',
};

/**
 * The Integrations cell. Same state conventions as ReadinessChips: a skeleton
 * while the row's batch is in flight, "Unavailable" when it failed, a dash when
 * the section is withheld, "Nothing linked" when the org has no mapping, else
 * one badge per system (dot = state, label = system, reason in the title).
 * Badges are not links (plan §10); they stop propagation so the row's
 * open-record hit area does not fire on a click meant to read the title.
 */
export default function IntegrationBadges({
  row,
  psaProvider,
  testIdPrefix = 'org-board-badge',
}: {
  row: BoardRow;
  /** Provider of the partner-level PSA connection, for the PSA badge's label. */
  psaProvider?: string;
  /** `org-board-badge` on the table, `org-board-card-badge` on the phone cards. */
  testIdPrefix?: string;
}) {
  const { t } = useTranslation('organizations');
  const orgId = row.org.id;
  const orgName = row.org.name;

  if (row.state === 'pending') {
    return (
      <span data-testid="org-board-badges-pending" className="inline-flex items-center gap-1.5" aria-busy="true">
        <span className="skeleton h-5 w-20 rounded-full" aria-hidden="true" />
        <span className="sr-only">{t('orgBoard.band.pending')}</span>
      </span>
    );
  }
  if (row.state === 'failed') {
    return (
      <span data-testid="org-board-badges-unavailable" className="text-xs text-muted-foreground">
        {t('orgBoard.chips.unavailable')}
      </span>
    );
  }
  const badges = row.badges;
  if (badges === null) return <span className="text-muted-foreground">—</span>;
  if (badges.length === 0) {
    return (
      <span className="text-xs text-muted-foreground" data-testid={`org-board-nothing-linked-${orgId}`}>
        {t('orgBoard.integrations.nothingLinked')}
      </span>
    );
  }
  return (
    <ul className="flex flex-wrap gap-1.5" data-testid={`org-board-badges-${orgId}`} onClick={(event) => event.stopPropagation()}>
      {badges.map((badge) => {
        const system = integrationSystemName(t, badge.system, { provider: psaProvider, label: badge.label });
        const stateLabel = t(/* i18n-dynamic */ `orgBoard.integrations.state.${badge.state}`);
        const reasonText = badge.reason ? t(/* i18n-dynamic */ `orgBoard.integrations.reason.${badge.reason}`) : null;
        const ariaLabel = reasonText
          ? t('orgBoard.integrations.badgeLabelWithReason', { orgName, system, state: stateLabel, reason: reasonText })
          : t('orgBoard.integrations.badgeLabel', { orgName, system, state: stateLabel });
        const title = badge.muted ? t('orgBoard.integrations.connectorMuted', { system }) : (reasonText ?? undefined);
        const testId = badge.system === 'external'
          ? `${testIdPrefix}-${orgId}-external-${badge.label ?? ''}`
          : `${testIdPrefix}-${orgId}-${badge.system}`;
        const text = badge.state === 'not_linked' ? t('orgBoard.integrations.notLinked', { system }) : system;
        return (
          <li
            key={testId}
            data-testid={testId}
            aria-label={ariaLabel}
            title={title}
            className={[
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs leading-none',
              badge.state === 'not_linked' ? 'border-dashed text-muted-foreground' : 'border-border text-foreground',
              badge.muted ? 'opacity-60' : '',
            ].join(' ')}
          >
            <span data-dot aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${DOT_CLASS[badge.state]}`} />
            {text}
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 4: Run the badge test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/organizations/board/IntegrationBadges.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing table test**

```tsx
// apps/web/src/components/organizations/board/AccountBoardTable.integrations.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '@/lib/i18n';
import { AccountBoardTable } from './AccountBoardTable';
import { visibleColumns, type BoardRow, type ReadinessCapabilities } from '@/lib/orgReadiness';

const CAPS: ReadinessCapabilities = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true,
  invoices: false, tickets: false, integrations: true, contracts: false, backup: false,
};
const A_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const B_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

function row(id: string, name: string, badges: BoardRow['badges']): BoardRow {
  return {
    org: { id, name, status: 'active', type: 'customer', createdAt: '2026-01-01T00:00:00.000Z' },
    readiness: {
      orgId: id, type: 'customer', status: 'active',
      setup: { sites: 1, devices: 1, lastSeenAt: null, policyAssigned: true },
      account: { primaryContact: null, billingRoleContact: true, billingAddress: true },
      integrations: [],
    },
    state: 'ready',
    chips: { setup: [], account: [], accountApplicable: true },
    badges,
  };
}

function renderTable(lens: 'setup' | 'account' | 'both', capabilities: ReadinessCapabilities) {
  return render(
    <AccountBoardTable
      rows={[row(A_ID, 'Alpha', [{ system: 'pax8', state: 'not_linked', muted: false }]), row(B_ID, 'Beta', [])]}
      columns={visibleColumns(lens, capabilities)}
      sort="manual"
      onSortChange={vi.fn()}
      activeRowId={A_ID}
      onRowKeyDown={vi.fn()}
      registerRowRef={vi.fn()}
      onOpenRecord={vi.fn()}
      highlightedOrgId={null}
      workspaceOrgId={null}
      manualOrder={null}
      menuItemsFor={() => []}
      archivedView={false}
      now={new Date('2026-09-13T12:00:00.000Z')}
      connectors={[{ system: 'pax8', state: 'connected' }]}
    />,
  );
}

const desktop = () => within(screen.getByTestId('responsive-table-desktop'));
const cards = () => within(screen.getByTestId('responsive-table-cards'));

describe('AccountBoardTable — Integrations column', () => {
  it.each(['setup', 'account', 'both'] as const)('renders the column and the badges in the %s lens', (lens) => {
    renderTable(lens, CAPS);
    expect(desktop().getByTestId('org-board-col-integrations')).toHaveTextContent('Integrations');
    expect(desktop().getByTestId(`org-board-badge-${A_ID}-pax8`)).toHaveTextContent('Pax8 not linked');
    expect(desktop().getByTestId(`org-board-nothing-linked-${B_ID}`)).toBeInTheDocument();
  });

  it('hides the column entirely when the caller lacks connected_apps:read', () => {
    renderTable('both', { ...CAPS, integrations: false });
    expect(screen.queryByTestId('org-board-col-integrations')).not.toBeInTheDocument();
    expect(screen.queryByTestId(`org-board-badge-${A_ID}-pax8`)).not.toBeInTheDocument();
  });

  it('renders the badges on the phone cards too, with the card prefix', () => {
    renderTable('both', CAPS);
    expect(cards().getByTestId(`org-board-card-badge-${A_ID}-pax8`)).toHaveTextContent('Pax8 not linked');
    expect(cards().getByText('Integrations')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/organizations/board/AccountBoardTable.integrations.test.tsx`
Expected: FAIL — `org-board-col-integrations` not found.

- [ ] **Step 7: Extend `AccountBoardTable.tsx`**

1. Imports and prop:
```tsx
import IntegrationBadges from './IntegrationBadges';
import type { ReadinessConnector } from '@/lib/orgReadiness';
// in AccountBoardTableProps:
  /** Partner-level connectors from the readiness response; null until the first batch lands or when withheld. */
  connectors?: ReadinessConnector[] | null;
```
Destructure `connectors` in the component and add, next to the three existing flags:
```tsx
  const showIntegrations = !archivedView && columns.includes('integrations');
  const psaProvider = connectors?.find((c) => c.system === 'psa')?.provider;
```

2. Desktop header — between the Account data `<th>` and the tickets `SortableTh`:
```tsx
          {showIntegrations && (
            <th className="px-3 py-3 font-medium" data-testid="org-board-col-integrations">
              {t('orgBoard.columns.integrations')}
            </th>
          )}
```

3. Desktop row — between the account `<td>` and the tickets `<td>`:
```tsx
              {showIntegrations && (
                <td className="px-3 py-3">
                  <IntegrationBadges row={row} psaProvider={psaProvider} />
                </td>
              )}
```

4. Phone card — after the "Still needed" block and before the tickets block:
```tsx
          {showIntegrations && (
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('orgBoard.columns.integrations')}</p>
              <div className="mt-1">
                <IntegrationBadges row={row} psaProvider={psaProvider} testIdPrefix="org-board-card-badge" />
              </div>
            </div>
          )}
```

5. The column is not sortable (no `SortableTh`, no `aria-sort`) — badge sets have no natural order. The table's `min-w-[1040px]` stays: the extra column is what that width was reserved for.

- [ ] **Step 8: Run W02's table test, the sibling, the badge test and the clipped-tables contract**

Run: `cd apps/web && npx vitest run src/components/organizations/board/AccountBoardTable.test.tsx src/components/organizations/board/AccountBoardTable.integrations.test.tsx src/components/organizations/board/IntegrationBadges.test.tsx src/lib/__tests__/no-clipped-tables.test.ts`
Expected: PASS, 4 files. If W02's table test builds rows without `badges`, add `badges: null` to its row factory.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/organizations/board/IntegrationBadges.tsx apps/web/src/components/organizations/board/IntegrationBadges.test.tsx apps/web/src/components/organizations/board/AccountBoardTable.tsx apps/web/src/components/organizations/board/AccountBoardTable.test.tsx apps/web/src/components/organizations/board/AccountBoardTable.integrations.test.tsx
git commit -m "feat(web): Integrations column with linked/pending/error/identity/not-linked badges in every board lens (W03 #5724)"
```

---

### Task 10: Connectors through the hook, repair lines in the band, badges on every row, the Unlinked cell and filter

**Files:**
- Modify: `apps/web/src/components/organizations/board/useAccountReadiness.ts` (W02)
- Modify: `apps/web/src/components/organizations/board/RollupBand.tsx` (W02)
- Modify: `apps/web/src/components/organizations/board/OrganizationsBoardPage.tsx` (W02)
- Test: `apps/web/src/components/organizations/board/RollupBand.integrations.test.tsx`
- Test: `apps/web/src/components/organizations/board/OrganizationsBoardPage.integrations.test.tsx`

**Interfaces:**
- Consumes: Task 8's `deriveIntegrationBadges`, `connectorRepairs`, `ReadinessConnector`, `visibleFilters` (now including `'unlinked'`), `matchesFilter`; Task 9's `integrationSystemName` and the table's `connectors` prop; W02's `AccountReadinessState`, `RollupBandProps { cells; status; onRetry }`, `RollupCell`, the page's row / cell / filter-chip construction.
- Produces: `AccountReadinessState.connectors: ReadinessConnector[] | null` (from the first successful batch; reset with the id set; `null` while nothing landed or when withheld); `RollupBandProps.connectors?: ReadinessConnector[] | null` rendering `org-board-repairs` with one `org-board-repair-<system>` anchor per not-connected connector; the page sets `badges` on every `BoardRow` and passes `connectors` to both components. The Unlinked band cell (`org-board-band-unlinked`) and filter chip (`org-board-filter-unlinked`) come from W02's `visibleFilters`-driven rendering once Task 8 added the filter — no new markup, only the counts and labels flow through.

- [ ] **Step 1: Extend the hook**

In `useAccountReadiness.ts`:
```ts
import type { ReadinessConnector } from '@/lib/orgReadiness';
// AccountReadinessState: add
  /** Partner-level connectors, identical across batches — the first successful batch wins. null until then, or when withheld. */
  connectors: ReadinessConnector[] | null;
// state:
  const [connectors, setConnectors] = useState<ReadinessConnector[] | null>(null);
// in the `kind === 'ok'` branch, next to setCapabilities / setMode:
          setConnectors((current) => current ?? (response.capabilities.integrations ? (response.connectors ?? []) : null));
// in the effect that resets state for a new id set, next to setByOrg(new Map()):
    setConnectors(null);
// returned object: add `connectors`.
```
`retry()` re-requests failed batches only; a connector set that already landed stays (it is partner-level and does not depend on which batch answered).

- [ ] **Step 2: Write the failing band test**

```tsx
// apps/web/src/components/organizations/board/RollupBand.integrations.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@/lib/i18n';
import { RollupBand, type RollupCell } from './RollupBand';

function cells(overrides: Partial<Record<RollupCell['key'], Partial<RollupCell>>> = {}): RollupCell[] {
  const make = (key: RollupCell['key'], count: number | null): RollupCell => ({ key, count, pressed: false, onPress: vi.fn(), ...overrides[key] });
  return [make('all', 12), make('setupIncomplete', 3), make('accountMissing', 2), make('unlinked', 4), make('openTickets', 5)];
}

describe('RollupBand — W03', () => {
  it('renders the Unlinked cell as a filter button with its count and label', () => {
    const onPress = vi.fn();
    render(<RollupBand cells={cells({ unlinked: { onPress } })} status="ready" onRetry={() => undefined} connectors={[]} />);
    const cell = screen.getByTestId('org-board-band-unlinked');
    expect(cell).toHaveTextContent('Unlinked');
    expect(screen.getByTestId('org-board-band-unlinked-count')).toHaveTextContent('4');
    expect(cell).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(cell);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders one repair line per connector that is not connected, linking to its settings tab', () => {
    render(
      <RollupBand
        cells={cells()}
        status="ready"
        onRetry={() => undefined}
        connectors={[
          { system: 'quickbooks', state: 'reauth_required' },
          { system: 'psa', state: 'disabled', provider: 'autotask' },
          { system: 'pax8', state: 'connected' },
        ]}
      />,
    );
    const qbo = screen.getByTestId('org-board-repair-quickbooks');
    expect(qbo).toHaveTextContent('QuickBooks needs reconnecting');
    expect(qbo).toHaveAttribute('href', '/integrations#quickbooks');
    expect(qbo).toHaveAttribute('aria-label', 'Open QuickBooks settings');
    const psa = screen.getByTestId('org-board-repair-psa');
    expect(psa).toHaveTextContent('Autotask connector is disabled');
    expect(psa).toHaveAttribute('href', '/integrations/psa');
    expect(screen.queryByTestId('org-board-repair-pax8')).not.toBeInTheDocument();
  });

  it('renders no repair region when every connector is connected, or before connectors are known', () => {
    const { rerender } = render(<RollupBand cells={cells()} status="ready" onRetry={() => undefined} connectors={[{ system: 'pax8', state: 'connected' }]} />);
    expect(screen.queryByTestId('org-board-repairs')).not.toBeInTheDocument();
    rerender(<RollupBand cells={cells()} status="loading" onRetry={() => undefined} connectors={null} />);
    expect(screen.queryByTestId('org-board-repairs')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/organizations/board/RollupBand.integrations.test.tsx`
Expected: FAIL — `org-board-repair-quickbooks` not found (the Unlinked cell case may already pass: the band renders whatever cells it is given and labels them from `orgBoard.band.<key>`; if W02 labels cells through a static record instead of the dynamic key, add the `unlinked` entry to that record).

- [ ] **Step 4: Extend `RollupBand.tsx`**

1. Props and imports:
```tsx
import { connectorRepairs, type ReadinessConnector } from '@/lib/orgReadiness';
import { integrationSystemName } from './IntegrationBadges';
// RollupBandProps: add
  /** Partner-level connector state; every not-connected connector renders ONE repair line here (spec: never N per-org problems). */
  connectors?: ReadinessConnector[] | null;
```

2. Inside the band's outer container, after the cells grid and before the partial / Try again line:
```tsx
      {repairs.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs" data-testid="org-board-repairs">
          {repairs.map((repair) => {
            const system = integrationSystemName(t, repair.system, { provider: repair.provider });
            return (
              <li key={`${repair.system}:${repair.provider ?? ''}`} className="flex items-center gap-1 text-warning-strong">
                <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-warning" />
                <a
                  href={repair.href}
                  className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  data-testid={`org-board-repair-${repair.system}`}
                  aria-label={t('orgBoard.integrations.connectors.openSettings', { system })}
                >
                  {t(/* i18n-dynamic */ `orgBoard.integrations.connectors.repair.${repair.state}`, { system })}
                </a>
              </li>
            );
          })}
        </ul>
      )}
```
with `const repairs = connectorRepairs(connectors);` computed at the top of the component.

- [ ] **Step 5: Run W02's band test and the sibling**

Run: `cd apps/web && npx vitest run src/components/organizations/board/RollupBand.test.tsx src/components/organizations/board/RollupBand.integrations.test.tsx`
Expected: PASS, 2 files.

- [ ] **Step 6: Write the failing page test**

```tsx
// apps/web/src/components/organizations/board/OrganizationsBoardPage.integrations.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import type { AccountReadinessResponse } from '@/lib/orgReadiness';
import { fetchWithAuth } from '@/stores/auth';
import OrganizationsBoardPage from './OrganizationsBoardPage';

// Same mocking convention as W02's page tests. If W02's boardTestKit.ts exports a
// fetch router (`mockBoardApi` or similar), use it instead of `mockApi` below so
// the org-list and readiness fixtures have one definition.
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const A_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const B_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const ALPHA: Organization = { id: A_ID, name: 'Alpha Ltd', status: 'active', type: 'customer', createdAt: '2026-01-01T00:00:00Z' };
const BETA: Organization = { id: B_ID, name: 'Beta Inc', status: 'active', type: 'customer', createdAt: '2026-01-02T00:00:00Z' };

const CAPS = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true,
  invoices: true, tickets: true, integrations: true, contracts: true, backup: true,
};

function orgRow(orgId: string, extra: Partial<AccountReadinessResponse['orgs'][number]> = {}): AccountReadinessResponse['orgs'][number] {
  return {
    orgId, type: 'customer', status: 'active',
    setup: { sites: 1, devices: 1, lastSeenAt: '2026-09-13T00:00:00.000Z', policyAssigned: true, backupApplicable: true, backupConfigured: true },
    account: { primaryContact: { name: 'Jo', email: 'jo@a.example', phone: '1', mobile: null }, billingRoleContact: true, billingAddress: true, pendingInvitations: 0, overdueInvoices: 0, activeContracts: 1 },
    tickets: { open: 0, awaitingCustomer: 0, slaBreached: 0 },
    integrations: [],
    ...extra,
  };
}

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/** Routes by URL: the org list (fetchAllOrganizations) and the readiness batches; everything else answers `{}`. */
function mockApi(readiness: () => Omit<AccountReadinessResponse, 'partnerId'>) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/orgs/account-readiness')) return jsonResponse({ partnerId: 'p', ...readiness() });
    if (url.includes('/orgs/organizations')) return jsonResponse({ data: [ALPHA, BETA], pagination: { page: 1, limit: 100, total: 2 } });
    return jsonResponse({});
  });
}

const fullReadiness = () => ({
  capabilities: CAPS,
  serviceManagementMode: 'native' as const,
  connectors: [{ system: 'quickbooks' as const, state: 'reauth_required' as const }, { system: 'pax8' as const, state: 'connected' as const }],
  orgs: [
    orgRow(A_ID, { integrations: [{ system: 'pax8', state: 'linked' }] }),
    orgRow(B_ID, {
      integrations: [],
      account: { ...orgRow(B_ID).account, activeContracts: 0 },
      setup: { ...orgRow(B_ID).setup, backupConfigured: false },
    }),
  ],
});

beforeEach(() => {
  window.location.hash = '';
  fetchMock.mockReset();
});
afterEach(() => {
  window.location.hash = '';
});

describe('OrganizationsBoardPage — W03', () => {
  it('shows the Integrations column, the Unlinked band cell and filter, and one QuickBooks repair line', async () => {
    mockApi(fullReadiness);
    render(<OrganizationsBoardPage />);
    await waitFor(() => expect(screen.getByTestId(`org-board-badge-${A_ID}-pax8`)).toBeInTheDocument());
    expect(screen.getByTestId(`org-board-badge-${B_ID}-pax8`)).toHaveTextContent('Pax8 not linked');
    // QuickBooks is reauth_required: no "QuickBooks not linked" on either org, one repair line in the band.
    expect(screen.queryByTestId(`org-board-badge-${A_ID}-quickbooks`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`org-board-badge-${B_ID}-quickbooks`)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('org-board-repair-quickbooks')).toHaveLength(1);
    expect(screen.getByTestId('org-board-band-unlinked-count')).toHaveTextContent('1');
    expect(screen.getByTestId('org-board-filter-unlinked')).toBeInTheDocument();
  });

  it('the Unlinked filter keeps only rows with a not-linked badge, presses the band cell and writes the hash', async () => {
    mockApi(fullReadiness);
    render(<OrganizationsBoardPage />);
    await waitFor(() => expect(screen.getByTestId(`org-board-badge-${A_ID}-pax8`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-board-filter-unlinked'));
    await waitFor(() => expect(screen.queryByTestId(`org-board-row-${A_ID}`)).not.toBeInTheDocument());
    expect(screen.getByTestId(`org-board-row-${B_ID}`)).toBeInTheDocument();
    expect(window.location.hash).toContain('filter=unlinked');
    expect(screen.getByTestId('org-board-band-unlinked')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the "No active contract" and "No backup configured" chips as repair links', async () => {
    mockApi(fullReadiness);
    render(<OrganizationsBoardPage />);
    await waitFor(() => expect(screen.getByTestId(`org-board-row-${B_ID}`)).toBeInTheDocument());
    const rowB = within(screen.getByTestId(`org-board-row-${B_ID}`));
    const contract = rowB.getByTestId('org-board-chip-noActiveContract');
    expect(contract).toHaveTextContent('No active contract');
    expect(contract).toHaveAttribute('href', `/organizations/${B_ID}#billing`);
    expect(contract).toHaveAttribute('title', 'Open the Billing tab for Beta Inc');
    const backup = rowB.getByTestId('org-board-chip-noBackup');
    expect(backup).toHaveAttribute('href', '/backup');
    expect(backup).toHaveAttribute('title', 'Open backup for Beta Inc');
    expect(within(screen.getByTestId(`org-board-row-${A_ID}`)).queryByTestId('org-board-chip-noActiveContract')).not.toBeInTheDocument();
  });

  it('hides column, band cell, filter chip and repair lines when integrations are withheld', async () => {
    mockApi(() => ({
      capabilities: { ...CAPS, integrations: false },
      serviceManagementMode: 'native' as const,
      orgs: [orgRow(A_ID), orgRow(B_ID)],
    }));
    render(<OrganizationsBoardPage />);
    await waitFor(() => expect(screen.getByTestId(`org-board-row-${A_ID}`)).toBeInTheDocument());
    expect(screen.queryByTestId('org-board-col-integrations')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-board-band-unlinked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-board-filter-unlinked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-board-repairs')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd apps/web && npx vitest run src/components/organizations/board/OrganizationsBoardPage.integrations.test.tsx`
Expected: FAIL — `org-board-badge-…-pax8` not found (the page does not set `badges` yet).

- [ ] **Step 8: Extend `OrganizationsBoardPage.tsx`**

1. Read `connectors` from the hook alongside `capabilities`, `mode`, `byOrg`, `rowState`, `status`, `retry`.

2. Where the page builds each `BoardRow` (the memo that pairs `org` with `byOrg.get(org.id)`, `rowState.get(org.id)` and `deriveReadinessChips(...)`), add the badges:
```tsx
        const readiness = byOrg.get(org.id);
        const state = rowState.get(org.id) ?? 'pending';
        return {
          org,
          readiness,
          state,
          chips: deriveReadinessChips(org, readiness, capabilities, mode ?? 'native', now),
          badges: state === 'ready' ? deriveIntegrationBadges(readiness, connectors, capabilities) : null,
        };
```
(import `deriveIntegrationBadges` from `@/lib/orgReadiness`; add `connectors` to the memo's dependency list; keep W02's exact expressions for `chips` and `state` if they differ from the sketch — only the `badges` line is new).

3. Band cells and filter chips: nothing to add — the page already maps `visibleFilters(capabilities)` to `RollupCell`s (count = live rows matching `matchesFilter`) and to toolbar chips; with Task 8 the `unlinked` entry appears in both, labelled from `orgBoard.band.unlinked` / `orgBoard.filters.unlinked`. Verify the page's counting helper uses `matchesFilter` (not a per-filter switch); if it switches, add `case 'unlinked': return hasUnlinked(row.badges)` there too.

4. Pass the connectors down: `<RollupBand … connectors={connectors} />` and `<AccountBoardTable … connectors={connectors} />`.

5. `lensForFilter('unlinked', lens)` returns `lens` unchanged (the Integrations column is visible in every lens), so W02's "filter forces Both" handler needs no change.

- [ ] **Step 9: Run every board and readiness test file**

Run: `cd apps/web && npx vitest run src/components/organizations/board src/lib/orgReadiness`
Expected: PASS — W02's files plus the five W03 files (`IntegrationBadges.test.tsx`, `AccountBoardTable.integrations.test.tsx`, `RollupBand.integrations.test.tsx`, `OrganizationsBoardPage.integrations.test.tsx`, `orgReadiness.integrations.test.ts`); check the reported file count includes W02's `OrganizationsBoardPage.*.test.tsx` suite and `useAccountReadiness.test.tsx`. If a W02 page test asserts the exact filter list or band cell count with `integrations: true` in its capabilities fixture, it now sees `unlinked` too — update that expectation.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/organizations/board/
git commit -m "feat(web): account board Unlinked filter and band cell, connector repair lines, badges per row (W03 #5724)"
```

---

### Task 11: E2E scenario, contract suites, full verification

**Files:**
- Modify: `e2e-tests/pages/OrganizationsBoardPage.ts` (W02)
- Modify: `e2e-tests/tests/organizations-board.spec.ts` (W02)

**Interfaces:**
- Consumes: W02's page object and serial spec (one login, `orgA` / `orgB` created inline via the API with the `readAccessToken` / `apiJson` helpers `organization-record.spec.ts` established); the DNS integration create route `POST /api/v1/dns-security/integrations` (inserts the row directly, no provider call — `routes/dnsSecurity.ts`; needs `organizations:write`, which the E2E admin has).
- Produces: page-object selectors `badge(orgId, system)`, `nothingLinked(orgId)`, `bandUnlinked()`, `bandUnlinkedCount()`, `filterUnlinked()`, `repairLine(system)`, `columnIntegrations()`; one added scenario.

- [ ] **Step 1: Extend the page object**

Add to the `OrganizationsBoardPage` class in `e2e-tests/pages/OrganizationsBoardPage.ts`:
```ts
  columnIntegrations = () => this.page.getByTestId('org-board-col-integrations');
  badge = (orgId: string, system: string) => this.page.getByTestId(`org-board-badge-${orgId}-${system}`);
  nothingLinked = (orgId: string) => this.page.getByTestId(`org-board-nothing-linked-${orgId}`);
  bandUnlinked = () => this.page.getByTestId('org-board-band-unlinked');
  bandUnlinkedCount = () => this.page.getByTestId('org-board-band-unlinked-count');
  filterUnlinked = () => this.page.getByTestId('org-board-filter-unlinked');
  repairLine = (system: string) => this.page.getByTestId(`org-board-repair-${system}`);
```

- [ ] **Step 2: Add the scenario to W02's serial spec (after its last step, inside the same `test` so it shares the login and the created orgs)**

```ts
  // --- W03: Integrations column. A DNS filter integration is the one mapping that can be
  // created through the API without an external system (POST /dns-security/integrations
  // inserts the row directly), so it is the seed for a visible badge.
  await test.step('Integrations column shows a never-synced DNS badge and Nothing linked; the Unlinked filter is reachable', async () => {
    await apiJson(request, token, 'post', '/api/v1/dns-security/integrations', {
      orgId: orgA.id,
      provider: 'pihole',
      name: 'E2E Pi-hole',
      apiKey: 'e2e-not-a-real-key',
    });
    await board.goto();
    await expect(board.columnIntegrations()).toBeVisible();
    const dns = board.badge(orgA.id, 'dns_filter');
    await expect(dns).toBeVisible();
    await expect(dns).toHaveAttribute('title', 'Never synced');
    await expect(board.nothingLinked(orgB.id)).toBeVisible();

    // No partner connector is configured in the E2E stack, so no org can be "not linked":
    // the Unlinked cell and filter exist (the caller has connected_apps:read) and count 0.
    await expect(board.bandUnlinkedCount()).toHaveText('0');
    await board.filterUnlinked().click();
    await expect(board.bandUnlinked()).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/filter=unlinked/);
    await expect(board.row(orgA.id)).toHaveCount(0);
    await expect(board.row(orgB.id)).toHaveCount(0);
  });
```
`orgA` / `orgB`, `board`, `request`, `token` and `page` are the spec's existing locals; `board.row(id)` is its row selector.

- [ ] **Step 3: Run the E2E spec against a worktree stack**

Run (repo root): `pnpm wt-stack up` then `cd e2e-tests && npx playwright test tests/organizations-board.spec.ts`
Expected: PASS. Tear down with `pnpm wt-stack down` when finished.

- [ ] **Step 4: Web contract suites**

Run: `cd apps/web && npx vitest run src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/no-hash-in-usestate.test.ts src/lib/__tests__/no-clipped-tables.test.ts`
Expected: PASS (if a contract lives elsewhere: `grep -rl "no-silent-mutations\|no-hash-in-usestate\|no-clipped-tables" apps/web/src --include='*.test.ts'`).

- [ ] **Step 5: Full unit runs and typechecks**

Run:
```bash
cd apps/api && npx vitest run && npx tsc --noEmit -p .
cd ../web && npx vitest run && npx tsc --noEmit -p .
cd .. && pnpm lint
```
Expected: all green. The full runs are required — a touched-file sweep misses Test API contracts (`partner-wide-write-coverage`, `orgCascadeFkOnDelete`, `migrationRlsScope`) that read the whole tree; W03 adds no writers or migrations, so they must stay green.

- [ ] **Step 6: Integration shard locally (tenancy-adjacent reads were added)**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgAccountReadinessIntegrations.integration.test.ts src/__tests__/integration/orgAccountReadiness.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts; cd ../.. && pnpm test-stack down`
Expected: PASS, 3 files. W01's suite must keep passing untouched: its route calls now also run the W03 loaders with every W03 capability false (the E2E admin role there grants `*`, so `integrations` / `contracts` / `backup` come back `true` and the sections are simply empty for its fixtures — if one of its whole-object `capabilities` assertions fails, extend the expected literal with the three new flags).

- [ ] **Step 7: Commit, push, open the PR**

```bash
git add e2e-tests/pages/OrganizationsBoardPage.ts e2e-tests/tests/organizations-board.spec.ts
git commit -m "test(e2e): account board Integrations column, DNS badge, Unlinked filter (W03 #5724)"
git push -u origin feature/5721-organizations-account-board/wave-5724
gh pr create --title "feat: Organizations account board W03 — integrations, contracts, backup (#5724)" --body-file - <<'EOF'
Closes #5724

W03 of the Organizations Account Board (spec docs/superpowers/specs/web-ui/2026-09-13-organizations-account-board-design.md).

API: `GET /orgs/account-readiness` gains `capabilities.{integrations,contracts,backup}`, partner-level `connectors`, per-org `integrations[]` with reason codes (worst state per system), `account.activeContracts`, `setup.backupConfigured/backupApplicable`. Accounting mappings join `accounting_connections` on `partner_id` (tenancy predicate); Pax8 mappings only under the active integration; M365 excludes revoked; DNS `NULL` = never synced.
Web: Integrations column in every lens, dashed "not linked" badges, Unlinked filter + band cell, one repair line per not-connected connector, "No active contract" and "No backup configured" chips, eight locales.

Decisions: backup applicability = partner has any active backup_configs (no entitlement signal exists); brand names are code constants; badges are not links, the band repair line is. Full list in the plan's "Spec ambiguities resolved".

Tests: service unit (state contract, loaders with compiled-SQL predicates, extras gating), route gates, real-Postgres matrix (10 cases), web unit + page tests, one E2E scenario.
EOF
```
Then record the `/pr-review-toolkit:review-pr` pass on the PR before enqueuing (`gh pr merge <N>`, no flags).

---

## Self-review (run by the plan author; findings fixed inline)

**Spec coverage** — every W03 item in the spec maps to a task:
- Connectors (accounting status four values, PSA provider+enabled, Pax8 active + `'failed'`, Huntress/S1 active + sync) → Tasks 1–3. Rendered once in the band as a partner-level repair, muting per-org badges → Tasks 8, 10.
- Mapping table, every row: accounting (join = tenancy predicate, `unlinked` is not linked, `suggested`/`create_new` pending, `error`/`last_error` error) → Tasks 1–2, 6; PSA (org-level enabled / partner-level + external link / disabled) → Task 2; external identity muted → Tasks 2, 9; Pax8 under the active integration, `sync_failed` → Task 3; M365 excludes revoked, multi-profile worst state, `consent_pending`/`expired`/`degraded`/`suspended`/`error` → Tasks 1, 3, 6; DNS `never_synced`/`sync_error` → Tasks 1, 3; Huntress/S1 `never_synced`/`connector_error` → Tasks 1, 3, 6.
- "Not linked" only for connectors the partner has, only when visible (`connected_apps:read`, `accounting:read`, `billing:manage`); "Nothing linked" muted → Tasks 5, 8, 9.
- `capabilities.integrations`, `connectors?`, `orgs[].integrations?` shape and reason-code union → Tasks 1, 5 (W01's names kept as re-exports).
- Unlinked filter chip + band cell, counts over the live list, `aria-pressed`, hash `filter=unlinked` → Tasks 8, 10.
- Integrations column in every lens; phone cards carry the badges → Tasks 8 (`visibleColumns`), 9.
- "No active contract" from `contracts` for active customer orgs in native mode under `contracts:read` → Tasks 4, 5, 8.
- Backup chip with an explicit applicability rule → Tasks 4, 5, 8 (+ decision §1).
- Eight-locale reason-code translations; keyUsage / parity / coverage contracts → Task 7.
- Tests: route unit per gate, service unit per state incl. the accounting join predicate, integration matrix (confirmed+synced, suggested, unlinked, sync error, foreign-partner isolation, Pax8 inactive ignored, M365 multi-profile, DNS null, Huntress inactive parent, contracts, backup, permission trims), web unit + page tests, E2E step → Tasks 1–6, 8–11.
- Roll-up expansion (Rollout table) = the Unlinked cell + repair lines → Task 10.

**Placeholder scan** — no TBD/TODO/"similar to"; every code step carries the code. The only placeholders are `5721` and `5724` (permitted). W01/W02 names are taken from the sibling plans; the four items W02 had not yet written (page composition, `boardTestKit`, E2E page object/spec, filter-chip testid) are marked **(assumed)** in the surface section, each with the spec-mandated name, and Task 1 Step 0 reconciles them once.

**Type consistency** — `IntegrationGrants { accounting; pax8 }` is identical in Tasks 1, 3, 5, and the route passes `{ accounting: can(ACCOUNTING_READ), pax8: can(BILLING_MANAGE) }`. `activeRowConnectorState(rows, failedValue)` is called with `'failed'` (Pax8) and `'error'` (Huntress/S1) in Task 3, matching the Task 1 tests. `BackupReadiness { applicable; configuredOrgIds: Set }` matches between Tasks 4 and 5; `extrasForOrg` returns `{ integrations?; activeContracts?; backupApplicable?; backupConfigured? }` and `shapeOrg` copies exactly those (Task 5). The API `Connector` / `OrgIntegration` are re-exported as W01's `AccountReadinessConnector` / `AccountReadinessIntegration`; the web mirrors are `ReadinessConnector` / `ReadinessIntegration` (Task 8) and every web task uses those names. `IntegrationBadge.state` includes `'not_linked'`, and `DOT_CLASS` in Task 9 is keyed on exactly that union. `CONNECTOR_SETTINGS_HREF` values in Task 8 equal the hrefs asserted in Tasks 8 and 10. `BoardRow` gains `badges` (Task 8) and every W03 test builds rows with `org / readiness / state / chips / badges`. i18n keys used in Tasks 8–10 (`orgBoard.integrations.*`, `orgBoard.columns.integrations`, `orgBoard.filters.unlinked`, `orgBoard.band.unlinked`, `orgBoard.chips.noActiveContract`, `orgBoard.chips.noBackup`, `orgBoard.repair.backup`, plus W02's `orgBoard.chips.link`, `orgBoard.chips.unavailable`, `orgBoard.band.pending`, `orgBoard.repair.billing`) all exist after Task 7. Testids `org-board-badge-<org>-<system>`, `org-board-card-badge-…`, `org-board-nothing-linked-<org>`, `org-board-badges-pending/unavailable`, `org-board-col-integrations`, `org-board-band-unlinked(-count)`, `org-board-filter-unlinked`, `org-board-repair-<system>`, `org-board-repairs` are spelled identically in Tasks 9, 10, 11.

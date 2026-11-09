---
tracking_issue: LanternOps/breeze#11500
---

# Match outside customers to organizations by name: implementation plan (UniFi sites, Pax8 companies)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suggest a Breeze org (and, for UniFi, a site) for every unmapped Pax8 company and UniFi site using one deterministic name matcher. A full-partner user confirms each suggestion one at a time or in a bulk review, and every mapping change is audited. Separately, a self-hosted controller's unmapped sites stop writing their devices into the collector agent's org.

**Architecture:** A pure corporate-name normalizer in `packages/shared`, and a pure matcher in `apps/api/src/services/externalTenantMapping.ts` with `exact` and `normalized` tiers, `ambiguous` and `contested` results, and a `cardinality` policy. Backup and EDR keep calling `resolveAutoMapNameSuggestions`, which now runs on the matcher. Pax8 (`one_to_one`) and UniFi (`many_to_one`) compute suggestions on read, with no new table. Each gets an additive bulk-accept route that refuses a stale review with 409 and writes nothing unless the whole batch can be written. Wave 4 makes reconcile mapped-only for self-hosted collectors, removes rows that the controller reports under an unmapped site, and widens the `unifi_clients` identity to `(collector_id, local_site_id, mac)`.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only), hand-written SQL migrations, Zod, Vitest (shared, API, web), React islands, i18next (8 locales), Starlight docs.

**Spec:** `docs/superpowers/specs/integrations/2026-11-06-external-customer-org-matching-spec.md`, approved 2026-11-08 with every Open Decision at its recommendation:
- OD1 A: no auto-apply.
- OD2 A: dual-owner `unifi_collectors`. This applies only to the Wave 5 spec.
- OD3 A: no fuzzy tier.
- OD4 A: no persisted dismissals.
- OD5 A: record `sites_unmapped`.
- OD6 A: trusted certificates only.
- OD7 B: direct connection becomes a linked spec.
- OD8 A: unmapped self-hosted sites are discovery-only.

Read the spec before any task. It argues the "why". This plan pins the "what".

**Issues:** anchor #10358 (UniFi), folded-in #11245 (Pax8). Wave PRs say `Refs #10358` (and `Refs #11245` for W01) plus `Closes #<wave sub-issue>`. Never write a closing keyword for #10358 or #11245. A negated keyword still closes the issue. #10358 stays open until Wave 5 ships or the owner declines it. The owner closes #11245 after W01 ships.

## Global Constraints

- **Matching never writes.** No sync, worker or read path writes a name match. Only `POST /pax8/companies/map`, `POST /pax8/companies/map-bulk`, `PUT /unifi/mappings` and `POST /unifi/mappings/accept` write mappings, and only on a request from a user who passes `canManagePartnerWidePolicies` (both route files already enforce this with a blanket `use('*')` guard). The rename-capture rule is in spec §3.2.
- **Normalizer, exactly as spec §3.1:**
  1. NFKC.
  2. Strip diacritics (NFD, then remove `\p{M}`).
  3. `toLocaleLowerCase('en-US')`.
  4. `&` and `+` become ` and `. Apostrophes (`'`, `’`, `ʼ`) are dropped. Other non-letter, non-digit characters become a space. Whitespace collapses.
  5. Strip one leading `the`.
  6. Repeatedly strip a trailing suffix from `inc incorporated llc "l l c" lc ltd limited corp corporation co company plc pllc pc lp llp gmbh ag kg ug sa sas sarl srl spa bv nv pty pte oy ab as aps kk "pty ltd"`. Never strip to empty.
  7. Return `null` for empty input.
- **Exact tier key** = `value.trim().toLowerCase()`, which is today's key (`externalTenantMapping.ts:35-39`). **Site-name key** (UniFi org→site step) = NFKC, trim, collapse whitespace, `toLocaleLowerCase('en-US')`. It never strips suffixes.
- **No fuzzy tier and no dismissal table.** No setting is added: Rule 9 counts name-matching configuration at 0 places before and 0 after. No AI tool is added, and no tool-index bytes or `WISP_TOOL_SUBJECTS` change.
- **Generic UniFi site names** `''`, `default` and `site` (compared by site-name key) never match on their own.
- **Bulk routes:**
  - At most 200 items, and the ids in one batch must be distinct.
  - Every item carries the state the reviewer saw (`expectedOrgId` or `expectedSiteId`, which is `null` for an unmapped row). Any mismatch returns 409 `code: 'STALE_REVIEW'` and writes nothing.
  - Authorization runs for every item before any write. The writes run in one `withDbTransaction`, and the `catch` sits outside it (CLAUDE.md, tenancy rule).
- **Audit:** one `writeRouteAudit` row per changed mapping, with `orgId` set to the target org (the previous org for an unmap). An audit row never contains an API key.
  - The `source` value is a client claim, and the server records it only when the matcher agrees at write time. Otherwise it records `manual`.
  - UniFi cloud names come only from the client, so cloud rows also record `sourceVerified: false`.
- **Web:**
  - Every mutation goes through `runAction` and follows the `ActionError` catch rule.
  - Modal open state is local, not in the URL hash.
  - Tests query by `data-testid` only.
  - Every new key goes in all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`) with the same `{{vars}}`. Keys are short semantic names, never sentence-humanized (`humanizedKeyRegression.test.ts`).
- **Migrations:**
  - Hand-written, idempotent, with no inner `BEGIN`/`COMMIT`.
  - Named to sort after the newest committed migration on `origin/main` at build time. Today that is `2027-01-22-211200-invoice-payments-idempotency-key.sql`. Check it, don't assume it.
  - Run `pnpm db:check-drift` afterwards.
- **CPU budget (shared 18-core host):**
  - Vitest with `--pool=forks --poolOptions.forks.maxForks=4`, on the touched files or `vitest --changed origin/main`. Never a whole package locally.
  - One `tsc` at a time, with `NODE_OPTIONS=--max-old-space-size=20480`. Check the exit code and never pipe it to `tail`.
  - Integration files run one at a time against `pnpm test-stack up`, followed by `pnpm test-stack down`.

## Review Focus

1. **Pax8 single-row map leaves the dropdown on the old org.** The handler merges `{pax8CompanyId, orgId, ignored}` into a row whose field is `mappedOrgId` (`Pax8Integration.tsx:332-336`). This is inferred from code and has not been run. Once suggestions exist, a map must also clear other rows' contests. **Task 7** pins "after mapping, the select shows the new org and the chip is gone" and re-fetches after every map.
2. **A retried or double-clicked bulk accept** must not map twice or overwrite a newer choice. Replaying a batch that already succeeded returns 409 and writes zero rows. **Task 5** and **Task 15**.
3. **An org renamed between opening the review and confirming it.** The write still succeeds, because the user confirmed that pairing, but the audit row records `source: 'manual'`. **Task 5**.
4. **A self-hosted agent that sends no `unifiSiteId`.** Its rows are skipped, never deleted, and the skip counter is logged, so an older agent cannot silently erase inventory. **Task 18**.
5. **The same MAC at two sites, plus the legacy row.** After the first poll on the widened key there is exactly one row per `(site, mac)`, in each site's own org. The legacy `local_site_id = ''` row for that MAC is gone, not stale. **Task 18** (integration).

## Plan decisions (reversible; made here, not in the spec)

- **PD1: where the unmapped count shows.** "A count badge on the integration's tab" (spec §3.2.4) is implemented as a summary pill in each integration's own mapping card header (`pax8-mapping-summary`, `unifi-mapping-summary`, `unifi-controller-mapping-summary`). The `IntegrationsPage` nav badge stays connection-health-only, because a mapping count there would need a cross-integration fetch on every page load.
- **PD2: "N new companies since last sync"** needs no schema.
  - After a manual sync completes, the web compares the company ids from before and after the sync and shows the count.
  - `GET /pax8/companies` also returns `summary.newUnmapped`, which counts unmapped, non-ignored companies with `created_at` in the last 7 days. The spec's "`created_at` is enough" does not hold on its own, because `lastSyncAt` is stamped at the end of a sync (`pax8SyncService.ts:399`).
- **PD3:** The spec's "Wave 2" is split into W02 (audit, registration copy, sync counter: no matcher, no gate) and W03 (suggestions, gated on the captured `/v1/sites` payload). The gate then holds back only the part that depends on it.
- **PD4:** The spec's Wave 2 discovery-only rule becomes **W04**, which runs in parallel with W01. It fixes cross-tenant attribution that exists on main today and does not depend on matching (advisor answer 5).
- **PD5:** New logic goes into new files, because `routes/unifi/index.ts` is at 500 lines and `Pax8Integration.tsx` at 954. Handlers stay registered in their route files.

## Tenancy and registration summary

| Wave | Table | RLS shape | Change | Cascade (`CORE_ORG_CASCADE_DELETE_ORDER`) | Merge (`orgMergeRegistry.ts`) | Export (`CORE_TENANT_EXPORT_POLICY`) | Device/ticket lists |
|---|---|---|---|---|---|---|---|
| W01 | `pax8_company_mappings` | 3, partner-axis with a nullable `org_id` | none (reads + existing writer) | already registered | already registered | already registered | n/a |
| W02 | `unifi_sync_runs` | 3, partner-axis, no `org_id` | `+ sites_unmapped integer` | n/a (no `org_id`) | n/a | n/a | n/a |
| W02/W03 | `unifi_site_mappings` | 1, org-axis | none (audit only) | already registered | already registered | already registered | n/a |
| W04 | `unifi_clients` | 1, org-axis | `+ local_site_id text NOT NULL DEFAULT ''`, unique key swap | already registered (`:1181`) | already registered (`:1401`) | **add `local_site_id` → `included`** | n/a (no `device_id` naming a Breeze device) |

No new table, so the partner-wide-first rule (`org_id` XOR `partner_id`) has nothing new to apply to. The one table the spec would add a partner owner to is `unifi_collectors` (W05), which carries it in its own spec. No RLS policy changes in W01–W04.

## Open Decisions (raised by this plan; the owner decides at plan approval)

**OD-P1: should cloud-host collectors also be mapped-only?** This amends the approved OD8 text.
- The approved spec keeps today's fallback for cloud collectors, because they are "bound to one console".
- The advisor (Codex `gpt-6-astra`, xhigh, read-only) disagreed. A cloud collector polls every site of its console (`agent/internal/unifi/client.go:438`), and since #10570 a cloud host can be a multi-site Network Application. An unmapped customer-B site on that console therefore writes into collector-org A today.
- I agree on the merits.
- Not checked: whether a Site Manager `siteId` equals the local Integration API site `id`. Reconcile assumes they are equal without translating. If they differ, today every cloud collector's telemetry already falls back to the collector's org, and making it mapped-only would empty it.
- **Recommend: adopt, behind the read-only LAB gate in Task 20.** W04 ships self-hosted-only (Task 18) either way.

**OD-P2: rows already written into the wrong org.**
- The draft let them converge to `is_stale`. The advisor disagreed: stale rows are still served and only dimmed (`routes/unifi/index.ts:461`, `TelemetryViewerCard.tsx:265`), and partial polls never stale anything (`jobs/unifiTelemetryWorker.ts:53`).
- **Adopted:** Task 18 deletes a device or client row on any poll, partial or full, where the controller reports it under a non-empty site id that has no mapping. That proves the row is wrongly attributed. The same rule revokes rows after a later unmap. No telemetry is deleted at migration time, because legacy rows carry no site provenance.
- **Not adopted, owner's call:** quarantine or review of `discovered_assets` rows created in the collector's org. They may be approved, linked or manual, and they have `NO ACTION` topology FKs. Task 18 logs their ids when it removes the telemetry row that linked them.
- **Recommend:** a follow-up issue for a review list, with no automatic asset deletion.

**OD-P3: deploy overlap in W04.**
- Dropping `unifi_clients_collector_mac_idx` makes an old API process's `ON CONFLICT (collector_id, mac)` fail until the new process replaces it. The advisor flagged this.
- Recommend accepting it. The cost is at most one lost telemetry poll per collector, and BullMQ retries the job on the new worker. The PR body says so.

---

## W01: shared matcher + Pax8 (closes the #11245 ask)

No migration. No new table. No registration-list change. API and web in one PR.

**Execution split and parallelism:**
- Task 1 must land first.
- Task 2 depends on 1.
- Tasks 3 and 4 depend on 2 and can run in parallel; they touch disjoint files.
- Task 5 depends on 4.
- Task 6 can start right after Task 1, because it depends only on the response types written in Task 4's Interfaces block.
- Task 7 depends on 5 and 6.
- Model routing:
  - Opus implements Tasks 2 and 5 (matcher semantics, stale-safe bulk transaction).
  - Sonnet implements Tasks 1, 3, 4, 6 and 7. The tables in Task 1 are mechanical, and the locale fill in Task 6 is mechanical.
- One reviewer pass on the whole branch.

**CI traps:**
- A new `apps/api/src/services/*.ts` file must be classified in `apps/api/src/__tests__/parkedFanout.contract.test.ts`. This applies to Task 3 and Task 4.
- New web keys in all 8 locales (`apps/web/src/lib/i18n/localeParity.test.ts`; `vitest run src/locales` does **not** include it).
- `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`.
- The `test-shared` job runs `packages/shared`.
- Before enqueueing, run `git merge origin/main` and re-run `tsc`. A semantic conflict in a shared import has dequeued a PR before.

### Task 1: Corporate-name normalizer in `packages/shared`

**Files:**
- Create: `packages/shared/src/utils/orgNameMatch.ts`
- Create: `packages/shared/src/utils/orgNameMatch.test.ts`
- Modify: `packages/shared/src/utils/index.ts` (add `export * from './orgNameMatch';`)

**Interfaces:**
- Produces:
  - `ORG_NAME_LEGAL_SUFFIXES: readonly string[]`. These are space-separated token sequences, for example `'l l c'` and `'pty ltd'`.
  - `exactOrgMatchKey(value: string | null | undefined): string | null`
  - `normalizeOrgMatchName(value: string | null | undefined): string | null`
  - `siteNameMatchKey(value: string | null | undefined): string | null`
- All three are exported from `@breeze/shared`.

- [ ] **Step 1: Write the failing table test** `orgNameMatch.test.ts`:

```ts
it.each([
  ['Acme, Inc.', 'acme'], ['ACME LLC', 'acme'], ['Acme L.L.C.', 'acme'], ['Acme Pty. Ltd.', 'acme'],
  ['The Acme Company', 'acme'], ['Company Inc', 'company'], ['Inc.', 'inc'],
  ['Smith & Jones LLP', 'smith and jones'], ['Smith + Jones', 'smith and jones'],
  ["O'Brien Plumbing Ltd", 'obrien plumbing'], ['O’Brien Plumbing', 'obrien plumbing'],
  ['Société Générale SA', 'societe generale'], ['Müller GmbH', 'muller'], ['İnci Ltd', 'inci'],
  ['Ａｃｍｅ Inc', 'acme'], ['  Acme   Dental  ', 'acme dental'], ['Acme Holdings Co Ltd', 'acme holdings'],
])('normalizeOrgMatchName(%j) === %j', (input, expected) => expect(normalizeOrgMatchName(input)).toBe(expected));
it.each(['', '   ', '---', null, undefined])('normalizeOrgMatchName(%j) is null', (v) => expect(normalizeOrgMatchName(v)).toBeNull());
it.each(ORG_NAME_LEGAL_SUFFIXES.map((s) => [s]))('strips suffix %j', (s) => expect(normalizeOrgMatchName(`Acme ${s}`)).toBe('acme'));
it('keeps distinct customers distinct', () => expect(normalizeOrgMatchName('Acme Dental')).not.toBe(normalizeOrgMatchName('Acme Dentistry')));
it('exactOrgMatchKey is trim + lowercase only', () => { expect(exactOrgMatchKey(' Acme Inc ')).toBe('acme inc'); expect(exactOrgMatchKey('  ')).toBeNull(); });
it('siteNameMatchKey never strips suffixes', () => expect(siteNameMatchKey(' Main  Office LLC ')).toBe('main office llc'));
```

- [ ] **Step 2: Run it to verify it fails.** `cd packages/shared && npx vitest run src/utils/orgNameMatch.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement the three functions** per Global Constraints.
  - Tokenize after step 4.
  - Suffix stripping compares the token-array tail against each entry's token sequence, longest first, and loops until nothing strips or one token is left.
- [ ] **Step 4: Run the test.** Expected: PASS. Then run `npx tsc --noEmit -p packages/shared` (exit 0).
- [ ] **Step 5: Commit** `feat(shared): corporate-name normalizer for external customer matching (#10358)`.

### Task 2: Order-independent matcher with tiers, contest and cardinality

**Files:**
- Modify: `apps/api/src/services/externalTenantMapping.ts` (add the matcher; re-implement `resolveAutoMapNameSuggestions` on it; delete the local `normalizeName`)
- Test: `apps/api/src/services/externalTenantMapping.test.ts`
- Test: `apps/api/src/services/backupProviders/mapping.test.ts`

**Interfaces:**
- Consumes: Task 1 `exactOrgMatchKey`, `normalizeOrgMatchName` from `@breeze/shared`.
- Produces:

```ts
export type OrgMatchTier = 'exact' | 'normalized';
export type MatchCardinality = 'one_to_one' | 'many_to_one';
export interface ExternalNameRecord { id: string; name: string | null }
export type OrgNameMatch =
  | { status: 'match'; orgId: string; tier: OrgMatchTier; matchKey: string }
  | { status: 'ambiguous'; candidateOrgIds: string[]; tier: OrgMatchTier; matchKey: string } // ids sorted ascending
  | { status: 'contested'; orgId: string; tier: OrgMatchTier; matchKey: string; contestedWith: string[] } // other record ids, sorted
  | { status: 'none' };
export function matchExternalRecordsToOrgs(
  records: readonly ExternalNameRecord[], orgs: readonly AutoMapOrgRow[],
  opts: { cardinality: MatchCardinality; excludedOrgIds?: ReadonlySet<string> },
): Map<string, OrgNameMatch>; // one entry per record id
```

Per record, the matcher works in this order:
1. Remove `excludedOrgIds` from the org pool.
2. Exact tier: if exactly one org has the record's exact key, the record is a `match`. If two or more orgs have it, the record is `ambiguous`.
3. Normalized tier, only when the exact tier found zero orgs: one org gives a `match`, two or more give `ambiguous`, and none gives `none`.

Then, in `one_to_one` only, every `match` group that shares an `orgId` and has two or more records becomes `contested`. `resolveAutoMapNameSuggestions` keeps its signature. It calls the matcher with `one_to_one` and `excludedOrgIds = alreadyClaimedOrgIds`, and returns only the `match` entries, in input order.

- [ ] **Step 1: Write the failing tests** in `externalTenantMapping.test.ts`, as a new `describe('matchExternalRecordsToOrgs')`:
  - `exact beats a normalized tie`: record `Acme Inc` against orgs `Acme Inc` (A) and `Acme LLC` (B) gives `{status:'match', orgId:A, tier:'exact', matchKey:'acme inc'}`.
  - `normalized tie is ambiguous`: record `Acme` against `Acme LLC` (A) and `Acme Inc` (B) gives `{status:'ambiguous', candidateOrgIds:[A,B] sorted, tier:'normalized', matchKey:'acme'}`.
  - `one_to_one contest`: records `r1 'Acme Ltd'` and `r2 'ACME LTD.'` against org A `Acme Ltd`. r1 gives `{status:'contested', tier:'exact', contestedWith:['r2']}` and r2 gives `{status:'contested', tier:'normalized', contestedWith:['r1']}`.
  - `many_to_one has no contest`: the same input gives two `match` entries.
  - `excluded org is not a candidate`: A is excluded, so the result is `none`.
  - `order independent`: run the contest input and an ambiguous input under all permutations of records and orgs. The result must be deep-equal after sorting entries by id.
  - Change the existing `never suggests the same org for two different customers` expectation (`:105-115`) to `[]`.
  - Add `strips corporate suffixes`: `Acme Corp` against org `Acme Corporation` gives `[{tenantId, orgId}]`.
  - Mirror both edits in `backupProviders/mapping.test.ts` (`describe('resolveCustomerAutoMapNameSuggestions')`).
- [ ] **Step 2: Run to verify it fails.** `cd apps/api && npx vitest run src/services/externalTenantMapping.test.ts src/services/backupProviders/mapping.test.ts src/services/edrProviders/mapping.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement** per Interfaces.
- [ ] **Step 4: Run the same command.** Expected: PASS, with `edrProviders/mapping.test.ts` unchanged and green.
- [ ] **Step 5: Commit** `feat(api): shared org-name matcher with exact/normalized tiers and order-independent contest (#10358)`.

### Task 3: One mappable-orgs loader

**Files:**
- Create: `apps/api/src/services/mappableOrgs.ts`
- Modify:
  - `apps/api/src/services/edrProviders/mapping.ts:27-41` (delete the local loader; import the shared one)
  - `apps/api/src/services/backupProviders/mapping.ts:301-311` (replace the inline query)
  - `apps/api/src/__tests__/parkedFanout.contract.test.ts` (classify `services/mappableOrgs.ts` as read-only)
- Test: `apps/api/src/services/mappableOrgs.test.ts`

**Interfaces:**
- Produces: `loadMappableOrgs(executor: DbExecutor, partnerId: string): Promise<AutoMapOrgRow[]>`, with a local `type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]` (repo pattern, e.g. `services/catalogService.ts:73`).
- The predicate is EDR's, verbatim:
  - partner
  - `deletedAt` and `archivedAt` null
  - status not in `archived`, `purging`, `merging`
  - `notHiddenOrgType()`
  - `type <> 'unassigned_pool'`
- Backup therefore gains the `unassigned_pool` exclusion. That is intended (spec §3.1).

- [ ] **Step 1: Failing test.** `mappableOrgs.test.ts` uses the Drizzle-mock pattern (`breeze-testing` skill). It asserts that the `where` clause carries all six conditions, and that `backupProviders/mapping.ts` and `edrProviders/mapping.ts` call `loadMappableOrgs` (spy on the module).
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement and swap both callers.**
- [ ] **Step 4: Run the tests.** Run the Task 2 command plus `src/services/mappableOrgs.test.ts`, `src/jobs/edrProviderSync.test.ts`, `src/jobs/backupProviderSync.test.ts`, `src/services/backupProviders/persist.test.ts` and `src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(api): one mappable-orgs loader for external customer mapping (#10358)`.

### Task 4: Pax8 suggestions on `GET /pax8/companies`, plus a richer single-map audit

**Files:**
- Create: `apps/api/src/services/pax8CompanyMapping.ts` (pure builder + summary; Task 5 adds the bulk writer here)
- Modify:
  - `apps/api/src/routes/pax8.ts:328-359` (GET) and `:85-90`, `:361-393` (single map)
  - `apps/api/src/__tests__/parkedFanout.contract.test.ts` (classify the new file)
- Test: `apps/api/src/services/pax8CompanyMapping.test.ts`, `apps/api/src/routes/pax8.test.ts`

**Interfaces:**
- Consumes:
  - Task 2 `matchExternalRecordsToOrgs`
  - Task 3 `loadMappableOrgs`
- Produces:

```ts
export interface Pax8CompanyRowForMatch { pax8CompanyId: string; pax8CompanyName: string | null; mappedOrgId: string | null; ignored: boolean; createdAt: Date }
export type Pax8CompanySuggestion =
  | { status: 'match'; orgId: string; orgName: string; tier: OrgMatchTier; matchKey: string }
  | { status: 'ambiguous'; candidates: Array<{ orgId: string; orgName: string }>; tier: OrgMatchTier; matchKey: string }
  | { status: 'contested'; orgId: string; orgName: string; tier: OrgMatchTier; matchKey: string;
      contestedWith: Array<{ pax8CompanyId: string; pax8CompanyName: string | null }> };
export function buildPax8CompanySuggestions(rows: Pax8CompanyRowForMatch[], orgs: AutoMapOrgRow[]): Map<string, Pax8CompanySuggestion>;
export function summarizePax8Companies(rows: Pax8CompanyRowForMatch[], suggestions: Map<string, Pax8CompanySuggestion>, now: Date):
  { unmapped: number; suggested: number; newUnmapped: number };
```

- Only rows with `!ignored && mappedOrgId === null` are matched.
- Run the matcher with `cardinality: 'one_to_one'` and `excludedOrgIds` = the set of `mappedOrgId` over rows where `!ignored`.
- A `none` result has no map entry.
- `suggested` counts `match` entries only. `newUnmapped` counts unmapped, non-ignored rows with `createdAt >= now - 7 days`.

`GET /pax8/companies` response becomes:

```ts
{ data: Array<existingRow & { firstSeenAt: string; suggestion: Pax8CompanySuggestion | null }>, integrationId, summary: { unmapped, suggested, newUnmapped } }
```

- Add `createdAt` to the select and expose it as `firstSeenAt`.
- `companyMapSchema` gains `source: z.enum(['manual', 'suggestion']).optional()`.
- Before calling `mapPax8Company`, the route reads the row's current `orgId` as `previousOrgId`.
- When the source is `suggestion`, it recomputes `buildPax8CompanySuggestions` for the integration and keeps `suggestion` only if that row's entry is `{status:'match', orgId: body.orgId}`.
- Audit `details` gains `previousOrgId`, `source` (the verified value), `matchTier` and `matchKey`. The last two are `null` when the source is `manual`.
- The audit `orgId` becomes `body.orgId ?? previousOrgId`, so an unmap is filed under the org that lost the company.

- [ ] **Step 1: Failing tests.**
  - `pax8CompanyMapping.test.ts`:
    - `ignored and mapped rows get no suggestion`
    - `an org already mapped by another company is not suggested` (one_to_one exclusion)
    - `two unmapped companies matching one org are both contested and not counted as suggested`
    - `newUnmapped counts only unmapped non-ignored rows first seen within 7 days` (fixed `now`)
  - `pax8.test.ts`:
    - `GET /companies returns suggestion and summary`
    - `hidden, archived, merging, quick_support and holding orgs are never candidates` (assert `loadMappableOrgs` is the org source)
    - `map with source=suggestion that no longer matches is audited as manual`
    - `map audit carries previousOrgId`
    - **`rename-capture: renaming an org to match an unmapped company writes nothing until a map request`**: issue `GET /companies` after the rename and assert no `update(pax8CompanyMappings)` call.
- [ ] **Step 2: Run them.** `cd apps/api && npx vitest run src/services/pax8CompanyMapping.test.ts src/routes/pax8.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run, plus `src/__tests__/parkedFanout.contract.test.ts` and `src/__tests__/partner-wide-write-coverage.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): Pax8 company org suggestions and audited match source (#11245)`.

### Task 5: `POST /pax8/companies/map-bulk`, all-or-nothing and stale-safe

**Files:**
- Modify:
  - `apps/api/src/services/pax8CompanyMapping.ts` (bulk writer)
  - `apps/api/src/routes/pax8.ts` (schema + route next to `/companies/map`)
- Test: `apps/api/src/services/pax8CompanyMapping.test.ts`, `apps/api/src/routes/pax8.test.ts`

**Interfaces:**
- Consumes:
  - `mapPax8Company` (`pax8SyncService.ts:446`)
  - Task 4 `buildPax8CompanySuggestions`
- Produces:

```ts
export class Pax8BulkMapError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: 'STALE_REVIEW' | 'NOT_FOUND' | 'INVALID_TARGET',
              message: string, readonly pax8CompanyIds: string[]) { super(message); }
}
export async function mapPax8CompaniesBulk(input: { integrationId: string; partnerId: string;
  items: Array<{ pax8CompanyId: string; orgId: string; expectedOrgId: string | null }> }):
  Promise<Array<{ pax8CompanyId: string; orgId: string; previousOrgId: string | null; source: 'bulk_suggestion' | 'manual'; matchTier: OrgMatchTier | null; matchKey: string | null }>>;
```

The route schema:

```ts
z.object({ integrationId: z.string().guid(),
  items: z.array(z.object({ pax8CompanyId: z.string().min(1).max(64), orgId: z.string().guid(), expectedOrgId: z.string().guid().nullable() }))
    .min(1).max(200).refine((a) => new Set(a.map((i) => i.pax8CompanyId)).size === a.length, 'Duplicate company') })
```

- Middleware is `partnerScopes, writePerm, requireMfa(), zValidator`.
- Before any write:
  - Look up the integration through `integrationScopeConditions`, and return 404 when it is missing.
  - For every item, `!auth.canAccessOrg(item.orgId)` returns 403 `'Access to target organization denied'`.
- `mapPax8CompaniesBulk` runs inside one `withDbTransaction`:
  1. `SELECT … FOR UPDATE` every item's row by `(integration_id, partner_id, pax8_company_id)`.
  2. A missing row throws `NOT_FOUND` (404).
  3. A row whose `orgId !== expectedOrgId`, or whose `ignored` is true, throws `STALE_REVIEW` (409) listing every stale id.
  4. Recompute the suggestions to set `source` per item.
  5. Call `mapPax8Company` per item. Its plain `Error` becomes `INVALID_TARGET` (400).
- The route catches `Pax8BulkMapError` outside the transaction and returns `{ error, code, pax8CompanyIds }` with its status.
- On success it writes one `pax8.company.map` audit per item (Task 4 detail shape, with `source`) and returns `{ data: { mapped: n } }`.

- [ ] **Step 1: Failing tests** in `pax8.test.ts`:
  - `one foreign org → 403 and zero mapPax8Company calls`
  - `holding org → 400 INVALID_TARGET and the transaction rolls back` (assert `mapPax8Company` for an earlier item ran inside the same `withDbTransaction` callback that threw)
  - `an item whose row changed since review → 409 STALE_REVIEW listing it, zero writes`
  - **`replaying a batch that already succeeded → 409, zero writes`** (Review Focus 2)
  - **`org renamed between review and confirm → mapped, audited source 'manual'`** (Review Focus 3)
  - `201 items → 400`
  - `duplicate pax8CompanyId → 400`
  - `MFA required`
- [ ] **Step 2: Run them.** Use the Task 4 command. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): Pax8 bulk map with stale-review refusal (#11245)`.

### Task 6: Shared suggestion chip and bulk review modal (web)

**Files:**
- Create:
  - `apps/web/src/components/integrations/matching/SuggestionChip.tsx`
  - `apps/web/src/components/integrations/matching/SuggestedMatchReviewModal.tsx`
  - `apps/web/src/components/integrations/matching/SuggestedMatchReviewModal.test.tsx`
- Modify: `apps/web/src/locales/<all 8>/integrations.json` (new `externalMatch` block)

**Interfaces:**
- Produces:

```ts
export interface MatchReviewItem { key: string; externalName: string; targetLabel: string; tier: 'exact' | 'normalized'; matchKey: string }
export interface MatchReviewBlockedItem { key: string; externalName: string; reason: 'ambiguous' | 'contested' | 'pick_site' }
export function SuggestedMatchReviewModal(p: { open: boolean; items: MatchReviewItem[]; blocked: MatchReviewBlockedItem[];
  onConfirm: (keys: string[]) => Promise<void>; onClose: () => void; testIdPrefix: string }): JSX.Element | null;
export function SuggestionChip(p: { label: string; detail?: string; onAccept?: () => void; disabled?: boolean; testId: string }): JSX.Element;
```

- Test ids:
  - `${prefix}-review-modal`
  - `${prefix}-review-item-${key}` (a checkbox, checked by default)
  - `${prefix}-review-blocked-${key}` (not selectable)
  - `${prefix}-review-confirm` (disabled when nothing is checked)
  - `${prefix}-review-cancel`
- The chip uses `${testId}` and `${testId}-accept`.
- Modal open state belongs to the caller. The modal only calls `onConfirm`.
- Keys (`integrations` namespace), English:
  - `externalMatch.suggested` "Suggested: {{target}}"
  - `externalMatch.matchedOn` "matched on “{{key}}”"
  - `externalMatch.accept` "Accept"
  - `externalMatch.possibleMatches` "{{count}} possible matches"
  - `externalMatch.alsoMatches` "Also matches {{names}}"
  - `externalMatch.pickSite` "Pick a site in {{org}}"
  - `externalMatch.reviewButton` "Review {{count}} suggested matches"
  - `externalMatch.reviewTitle` "Review suggested matches"
  - `externalMatch.confirm` "Map {{count}} selected"
  - `externalMatch.resolveInTable` "Resolve these in the table"
  - `externalMatch.tierExact` "Same name"
  - `externalMatch.tierNormalized` "Same name, ignoring suffixes"
  - `externalMatch.summary` "{{unmapped}} unmapped · {{suggested}} suggested"
  - `externalMatch.staleReview` "Some rows changed since you opened this review. The list has been reloaded."
  - `externalMatch.newSinceSync` "{{count}} new since last sync"
- Use the plural form `common.json` already uses for `{{count}}` keys, if it uses one.

- [ ] **Step 1: Failing test.** The modal renders checked items, blocked rows are not selectable, unchecking one changes the confirm count, and confirm calls `onConfirm` with only the checked keys.
- [ ] **Step 2: Run it.** `cd apps/web && npx vitest run src/components/integrations/matching src/lib/i18n/localeParity.test.ts src/locales --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL.
- [ ] **Step 3: Implement and add all 8 locales.** Sonnet may translate. The `{{vars}}` must be identical in every locale.
- [ ] **Step 4: Re-run.** Expected: PASS, including `localeParity` and `humanizedKeyRegression`.
- [ ] **Step 5: Commit** `feat(web): shared suggestion chip and bulk match review (#10358)`.

### Task 7: Pax8 panel: chips, bulk review, summary, refresh after sync

**Files:**
- Modify: `apps/web/src/components/integrations/Pax8Integration.tsx` (`Pax8Company` at `:44-53`, `handleSync` at `:286-309`, `mapCompany` at `:311-345`, table at `:730-808`)
- Modify: `apps/docs/src/content/docs/features/distributor-integrations.mdx` (Pax8 mapping section)
- Test: `apps/web/src/components/integrations/Pax8Integration.test.tsx`

**Interfaces:**
- Consumes: Task 4 response shape, Task 5 route, Task 6 components.

The panel changes:
- `Pax8Company` gains `firstSeenAt` and `suggestion`.
- Row chip test ids are `pax8-company-suggestion-${id}` and `-accept`.
  - Accept posts `/pax8/companies/map` with `source: 'suggestion'`.
  - An `ambiguous` row narrows its `<select>` to the candidates.
  - A `contested` row shows `alsoMatches`.
- The review button `pax8-review-suggestions` opens the modal with prefix `pax8` and posts `/pax8/companies/map-bulk` with `expectedOrgId: null`.
  - A 409 `STALE_REVIEW` shows `externalMatch.staleReview`, re-fetches, and keeps the modal open with the new rows.
- The summary pill is `pax8-mapping-summary`.
- Every successful map, single or bulk, `await`s `fetchCompaniesAndSubs()`, replacing the `{...c, ...mapped}` merge.
- `handleSync` polls after the enqueue:
  1. Record `lastSyncAt`, `updatedAt` and the set of company ids first.
  2. Poll `GET /pax8/integration` every 3000 ms, at most 40 times. Stop when `lastSyncAt` changes, or when `lastSyncStatus === 'failed'` and `updatedAt` changes.
  3. Then re-fetch, and render `pax8-sync-new-companies` with the count of new ids.
  4. Cancel on unmount.

- [ ] **Step 1: Failing tests:**
  - **`after mapping, the select shows the new org and the chip is gone`** (Review Focus 1)
  - `accept posts source=suggestion`
  - `bulk confirm posts only checked items with expectedOrgId null`
  - `409 STALE_REVIEW reloads companies and shows the stale notice`
  - `ambiguous row narrows the dropdown`
  - `sync polls integration until lastSyncAt changes then shows "2 new since last sync"` (fake timers)
- [ ] **Step 2: Run them.** `cd apps/web && npx vitest run src/components/integrations/Pax8Integration.test.tsx src/lib/__tests__/no-silent-mutations.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL.
- [ ] **Step 3: Implement and update the docs page.** The docs explain the two tiers, what is ignored, and that nothing maps itself.
- [ ] **Step 4: Re-run, plus the Task 6 command, plus `NODE_OPTIONS=--max-old-space-size=20480 pnpm --filter @breeze/web exec tsc --noEmit`.** Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(web): Pax8 suggested matches, bulk review and post-sync refresh (#11245)`.

---

## W02: UniFi audit, registration copy, unmapped-site counter

Depends on W01 only for the locale-file merge order, not for code. **One migration**, on `unifi_sync_runs`. That table is partner-axis and has no `org_id`, so no cascade, merge or export-policy entry is needed (verified: no `unifi_sync_runs` key in `tenantExportPolicyRegistry.ts`).

**Execution split and parallelism:**
- Tasks 8 and 9 both edit `routes/unifi/index.ts`, so they run in sequence. Task 8 first, because it extracts the shared helper.
- Task 10 (migration + sync service + `SyncHistoryCard`) and Task 11 (web copy) can run in parallel with 8 and 9.
- Model routing: Sonnet for all four. Opus reviews Task 8's extraction, which moves an authorization check.

**CI traps:**
- New `services/unifi/*.ts` files go in `parkedFanout.contract.test.ts`.
- **Migration naming:** W04 also adds a migration. Whichever PR merges second renames its file to sort after the first before enqueueing, or the merge queue's Check Migrations step fails every group.
- The 8 locales and `localeParity`.

### Task 8: Extract mapping-target validation; audit every `PUT /unifi/mappings` change

**Files:**
- Create: `apps/api/src/services/unifi/unifiMappingWrites.ts`
- Modify:
  - `apps/api/src/routes/unifi/index.ts:214-317`
  - `parkedFanout.contract.test.ts`
- Test: `apps/api/src/services/unifi/unifiMappingWrites.test.ts`, `apps/api/src/routes/unifi/index.test.ts`

**Interfaces:**
- Consumes:
  - `snapshotUnifiMappings`, `UnifiMappingSnapshot` (`services/topology/unifiAuthority.ts:214`)
  - `writeRouteAudit` (`services/auditEvents.ts:236`)
- Produces:

```ts
import type { AuthContext as RouteAuditCtx } from '../auditEvents';     // writeRouteAudit's first parameter (auditEvents.ts:232)
import type { AuthContext as RequestAuth } from '../../middleware/auth'; // c.get('auth'), carries canAccessOrg (middleware/auth.ts:129)
export type UnifiMappingTargetError = { status: 400 | 403 | 409; message: string; code?: string };
export async function resolveUnifiMappingTargets(auth: RequestAuth, partnerId: string, items: ReadonlyArray<{ siteId: string }>):
  Promise<{ ok: true; targets: Array<{ orgId: string; siteId: string }> } | { ok: false; error: UnifiMappingTargetError }>; // same order as items
export interface UnifiMappingChange { action: 'unifi.site.map' | 'unifi.site.unmap'; unifiHostId: string; unifiSiteId: string;
  orgId: string; siteId: string | null; previousOrgId: string | null; previousSiteId: string | null }
export function diffUnifiMappings(before: UnifiMappingSnapshot[], after: UnifiMappingSnapshot[]): UnifiMappingChange[];
export function writeUnifiMappingAudits(c: RouteAuditCtx, integrationId: string, changes: UnifiMappingChange[],
  meta: (change: UnifiMappingChange) => { source: 'manual' | 'suggestion' | 'bulk_suggestion'; sourceVerified: boolean; matchTier: OrgMatchTier | null; matchKey: string | null }): void;
```

- `resolveUnifiMappingTargets` is the loop at `:222-248`, moved without change. The messages and statuses stay byte-identical.
- The diff is keyed by `host::site`:
  - A new row, or a row whose org or site changed, gives `map`, with `orgId` set to the new org.
  - A removed row gives `unmap`, with `orgId` set to the previous org and `siteId` set to `null`.
- Audit `resourceType` is `'unifi_site_mapping'` and `resourceName` is `${unifiHostId}/${unifiSiteId}`. `details` carries every `UnifiMappingChange` field plus `integrationId` and `meta`.
- After its writes, `PUT /unifi/mappings` takes a second snapshot and audits the diff with `{source:'manual', sourceVerified:true, matchTier:null, matchKey:null}`.

- [ ] **Step 1: Failing tests.**
  - `diffUnifiMappings`: new, changed site, changed org, removed, unchanged → no entry.
  - Route tests (mock `services/auditEvents`):
    - `PUT /mappings writes unifi.site.map per changed row`
    - `replace-all delete writes unifi.site.unmap with the previous org`
    - `an unchanged resubmit writes no audit`
  - The existing 403/400/409 route tests stay as they are.
- [ ] **Step 2: Run them.** `cd apps/api && npx vitest run src/services/unifi/unifiMappingWrites.test.ts src/routes/unifi/index.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run, plus `src/__tests__/parkedFanout.contract.test.ts`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): audit UniFi site mapping changes (#10358)`.

### Task 9: Audit controller register and remove

**Files:**
- Modify:
  - `apps/api/src/routes/unifi/index.ts` (`PUT /collectors` at `:357`, `PUT /controllers` at `:396`, `DELETE /collectors/:hostId` at `:428`)
  - `apps/api/src/services/unifi/unifiMappingWrites.ts`
- Test: `apps/api/src/routes/unifi/index.test.ts`

**Interfaces:**
- Consumes: `snapshotUnifiCollectors` (`unifiAuthority.ts:231`; the columns include `id, orgId, siteId, unifiHostId, collectorDeviceId, controllerUrl`).
- Produces: `writeUnifiControllerAudits(c: RouteAuditCtx, integrationId: string, before: UnifiCollectorAuthority[], after: UnifiCollectorAuthority[]): void`.
  - A new or changed collector gives `unifi.controller.register`. A removed one gives `unifi.controller.remove`.
  - `orgId` is the collector's org. `resourceType` is `'unifi_collector'`.
  - `details` is `{ integrationId, collectorId, transport: 'agent', controllerHost: new URL(controllerUrl).host, siteId, collectorDeviceId }`.
- The two PUT routes take before and after snapshots. `DELETE` already takes the before snapshot (`:437`). An idempotent delete that matched nothing writes no audit.

- [ ] **Step 1: Failing tests:**
  - `PUT /controllers audits register with the host only`
  - **`no audit details contain the api key`**: assert `JSON.stringify(auditCalls)` excludes the submitted `apiKey`.
  - `DELETE /collectors/:hostId audits remove once; a second delete audits nothing`
- [ ] **Step 2: Run them.** Use the Task 8 command. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): audit UniFi controller register and remove (#10358)`.

### Task 10: `sites_unmapped` on cloud sync runs

**Files:**
- Create: `apps/api/migrations/<sorts-after-newest>-unifi-sync-runs-sites-unmapped.sql`
- Modify:
  - `apps/api/src/db/schema/unifi.ts:94-111`
  - `apps/api/src/services/unifi/unifiMappingHosts.ts`
  - `apps/api/src/services/unifi/unifiSyncService.ts` (the run update at `:540-552`)
  - `apps/web/src/components/integrations/unifi/SyncHistoryCard.tsx`
  - `apps/web/src/components/integrations/unifi/unifiTypes.ts`
  - 8 locales
- Test:
  - `apps/api/src/services/unifi/unifiMappingHosts.test.ts` (create if absent)
  - `apps/api/src/services/unifi/unifiSyncService.test.ts`
  - `apps/web/src/components/integrations/UnifiIntegration.test.tsx`

**Interfaces:**
- Produces: `countUnmappedSites(sites: ReadonlyArray<{ hostId: string; id: string }>, mappings: ReadonlyArray<{ unifiHostId: string; unifiSiteId: string }>): number`.
- The migration: `ALTER TABLE unifi_sync_runs ADD COLUMN IF NOT EXISTS sites_unmapped integer;`. It is nullable, where NULL means "not recorded" (older runs, failed runs). It has no row writes, so it needs no system-scope `set_config`.
- Drizzle: `sitesUnmapped: integer('sites_unmapped')`.
- A successful or partial run writes the count of `listSitesForSync()` sites with no mapping row. A failed run leaves it NULL.
- Web: a `unifi-sync-run-unmapped` cell, showing "—" for null. Key `unifiIntegration.sitesUnmapped` is "Unmapped sites".

- [ ] **Step 1: Failing tests.**
  - `countUnmappedSites`: a host-scoped key, so the same site id under two hosts counts twice.
  - `syncIntegration records sitesUnmapped`
  - `failed run leaves it null`
  - Web: the cell renders.
- [ ] **Step 2: Run them.** `cd apps/api && npx vitest run src/services/unifi/unifiMappingHosts.test.ts src/services/unifi/unifiSyncService.test.ts --pool=forks --poolOptions.forks.maxForks=4`, plus the web file. Expected: FAIL.
- [ ] **Step 3: Implement.** Then run `pnpm db:migrate` against `pnpm test-stack up` and `pnpm db:check-drift` (expected: no drift), and `cd apps/api && npx vitest run src/__tests__/migrationRlsScope.test.ts`.
- [ ] **Step 4: Re-run the tests.** Expected: PASS. Run `pnpm test-stack down`.
- [ ] **Step 5: Commit** `feat(unifi): record unmapped-site count per cloud sync run (#10358)`.

### Task 11: Self-hosted registration copy (spec §3.5)

**Files:**
- Modify:
  - `apps/web/src/components/integrations/unifi/ControllersCard.tsx:104-131`
  - `unifiTypes.ts` (`OrgOption` gains `type?: string`; `SiteGroup` gains `isInternal: boolean`)
  - `useUnifiIntegration.ts:157-172` (set `isInternal` from `org.type === 'internal'`; `/orgs/organizations` returns full rows, `routes/orgs.listQuery.ts:137`)
  - 8 locales
- Test: `apps/web/src/components/integrations/unifi/ControllersCard.test.tsx` (new)

**Interfaces:**
- The label key becomes `unifiIntegration.collectorAgentLocation`, "Collector agent location".
- The help key is `unifiIntegration.collectorAgentLocationHelp`: "Where the agent that polls this controller lives, often your own internal organization. You match the controller's sites to customers after you register it."
- Remove `siteThisControllerServes` from all 8 locales if grep finds no other use.
- Internal groups sort first.
- When exactly one internal org exists and it has exactly one site, and `controllerDraft.siteId` is empty, that site is preselected.

- [ ] **Step 1: Failing tests:**
  - `shows "Collector agent location" with help`
  - `internal org group is listed first`
  - `single internal site is preselected`
  - `two internal orgs → nothing preselected`
- [ ] **Step 2: Run them.** `cd apps/web && npx vitest run src/components/integrations/unifi/ControllersCard.test.tsx src/lib/i18n/localeParity.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): clearer UniFi collector agent location copy (#10358)`.

---

## W03: UniFi suggestions and accept (GATED on a captured `/v1/sites` payload)

Depends on W01 (matcher, review modal) and W02 (`resolveUnifiMappingTargets`, mapping audit). No migration.

**Execution split and parallelism:**
- **Task 12 is an owner gate.** It needs a UniFi Site Manager API key with at least one multi-site console, and Todd supplies the capture.
- Tasks 13, 14 (self-hosted half) and 15 do not depend on Task 12 and can start immediately. Task 13 (pure) comes first; Tasks 14 and 15 then run in sequence, because they share `routes/unifi/index.ts`.
- The cloud half of Task 14 and all of Task 16's cloud rendering wait for Task 12.
- Model routing:
  - Opus for Tasks 13 and 15 (resolution rules, stale-safe accept).
  - Sonnet for Tasks 14 and 16.

**CI traps:**
- New `services/unifi/unifiSiteSuggestions.ts` goes in `parkedFanout`.
- Fixtures must be scrubbed: no real ids, MACs, customer names or hostnames (CLAUDE.md, no infrastructure details).

### Task 12 (GATE): Captured Site Manager payload; `parseSites` carries `desc`

**Files:**
- Create: `apps/api/src/services/unifi/__fixtures__/siteManager-sites-single.json`, `siteManager-sites-multi.json` (scrubbed; one `network-server` host in the multi file)
- Modify:
  - `apps/api/src/services/unifi/unifiClient.ts:15` (`UnifiSite` gains `desc: string | null`) and `:117-148` (`desc = str(obj(s.meta).desc) ?? null`)
  - `apps/api/src/services/unifi/unifiMappingHosts.ts` (`MappingHostRow.sites` gains `desc`)
  - `apps/web/src/components/integrations/unifi/unifiTypes.ts:21-26`
- Test: `apps/api/src/services/unifi/unifiClient.test.ts`

- [ ] **Step 1: Owner capture.** Todd runs `GET https://api.ui.com/v1/sites` (and `/v1/hosts`) with his key and saves the raw JSON outside the repo. A subagent then scrubs it into the two fixtures.
  - **Stop condition:** if `meta.desc` is absent, or `meta.name` turns out to be the human label, record that on the W03 sub-issue and change `cloudSiteMatchName` (Task 13) to the field the capture shows. Do not guess.
- [ ] **Step 2: Failing test.** `parses meta.desc from the captured single and multi-site payloads` asserts the fixture's `desc` values and keeps `name` unchanged.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** `cd apps/api && npx vitest run src/services/unifi/unifiClient.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(unifi): carry Site Manager site description from a captured payload (#10358)`.

### Task 13: UniFi suggestion resolver (pure)

**Files:**
- Create: `apps/api/src/services/unifi/unifiSiteSuggestions.ts`, `unifiSiteSuggestions.test.ts`
- Modify: `parkedFanout.contract.test.ts`

**Interfaces:**
- Consumes:
  - Task 2 `matchExternalRecordsToOrgs` (cardinality `many_to_one`)
  - Task 1 `siteNameMatchKey`
- Produces:

```ts
export function isGenericUnifiSiteName(v: string | null | undefined): boolean;   // siteNameMatchKey(v) in {null, 'default', 'site'}
export function selfHostedSiteMatchName(name: string | null): string | null;      // null when generic
export function cloudSiteMatchName(site: { name: string; desc: string | null },
  host: { name: string; unknownConsole?: true; siteCount: number }): string | null;
  // desc when non-generic; else host.name only if siteCount === 1, site is generic, !unknownConsole, host.name non-generic; else null
export interface BreezeSiteCandidate { id: string; orgId: string; name: string }
export type UnifiSiteSuggestion =
  | { status: 'match'; orgId: string; orgName: string; tier: OrgMatchTier; matchKey: string;
      siteId: string | null; siteName: string | null; siteResolution: 'only_site' | 'name_match' | 'pick_site' }
  | { status: 'ambiguous'; candidates: Array<{ orgId: string; orgName: string }>; tier: OrgMatchTier; matchKey: string };
export function buildUnifiSiteSuggestions(records: ReadonlyArray<{ key: string; matchName: string | null; mapped: boolean }>,
  orgs: AutoMapOrgRow[], sites: BreezeSiteCandidate[]): Map<string, UnifiSiteSuggestion>; // unmapped records only
```

The site-resolution order (spec §3.3):
1. If the org has one site, use it (`only_site`).
2. Otherwise, if exactly one site's `siteNameMatchKey` equals the UniFi name's, use it (`name_match`).
3. Otherwise set `siteId: null` (`pick_site`).

Only a `match` with a non-null `siteId` is bulk-eligible.

- [ ] **Step 1: Failing tests:**
  - the three resolution cases
  - `two Breeze sites with the same name → pick_site`
  - `site names are not suffix-stripped` (`Main LLC` ≠ `Main`)
  - `generic self-hosted name gets no suggestion`
  - The cloud fallback is tested in four cases:
    - `desc wins`
    - `generic single-site console falls back to host name`
    - `generic site on a two-site console → null`
    - `Unknown console → null`
  - `many sites map to one org with no contest`
  - `mapped records get nothing`
- [ ] **Step 2: Run them.** `cd apps/api && npx vitest run src/services/unifi/unifiSiteSuggestions.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): UniFi org-then-site suggestion resolver (#10358)`.

### Task 14: Suggestions on `GET /unifi/hosts` and `GET /unifi/controller-sites`

**Files:**
- Modify:
  - `apps/api/src/routes/unifi/index.ts:191-211`, `:492-500`
  - `apps/api/src/services/unifi/unifiSiteSuggestions.ts` (add a loader)
- Test: `apps/api/src/routes/unifi/index.test.ts`

**Interfaces:**
- Produces:
  - `loadUnifiSuggestionCandidates(executor, partnerId): Promise<{ orgs: AutoMapOrgRow[]; sites: BreezeSiteCandidate[] }>`. It uses `loadMappableOrgs` plus `sites` filtered `inArray(sites.orgId, orgIds)`. It loads nothing more when `orgIds` is empty.
  - `GET /hosts`: each `hosts[].sites[]` gains `suggestion: UnifiSiteSuggestion | null`, and the response gains `summary: { unmapped: number; suggested: number }`.
    - "Mapped" means a `unifi_site_mappings` row exists for `(integrationId, host.id, site.id)`.
    - `suggested` counts bulk-eligible matches.
  - `GET /controller-sites`: each site gains `suggestion`, and the response gains the same `summary`. Mapped state comes from the existing `mapped` flag. The match name is `selfHostedSiteMatchName(name)`.
- The suggestion loader runs inside the request context and never inside `runOutsideDbContext`. The upstream fetch stays outside.

- [ ] **Step 1: Failing tests:**
  - `GET /controller-sites returns suggestion + summary`
  - `GET /hosts returns per-site suggestion using desc`. This one runs on the Task 12 fixture, so it waits for the gate.
  - `mapped sites get no suggestion`
  - `holding and quick_support orgs never suggested`
- [ ] **Step 2: Run them.** `cd apps/api && npx vitest run src/routes/unifi/index.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): UniFi site suggestions on the mapping reads (#10358)`.

### Task 15: `POST /unifi/mappings/accept`: additive, stale-safe, audited

**Files:**
- Create: `apps/api/src/routes/unifi/mappingAccept.ts` (handler + schema)
- Modify: `apps/api/src/routes/unifi/index.ts`. Register `unifiRoutes.post('/mappings/accept', partnerScopes, writePerm, requireMfa(), zValidator('json', acceptMappingsSchema), acceptUnifiMappingsHandler)` after the blanket guards.
- Test: `apps/api/src/routes/unifi/mappingAccept.test.ts`

**Interfaces:**
- Consumes:
  - W02 `resolveUnifiMappingTargets`, `diffUnifiMappings`, `writeUnifiMappingAudits`
  - Task 13 resolver (for source verification)
  - `snapshotUnifiMappings`, `revokeUnifiMappingDrift`
- Schema:

```ts
export const acceptMappingsSchema = z.object({
  source: z.enum(['suggestion', 'bulk_suggestion']),
  items: z.array(z.object({ unifiHostId: unifiId, unifiSiteId: unifiId, unifiHostName: z.string().max(200).optional(),
    unifiSiteName: z.string().max(200).optional(), siteId: z.string().guid(), expectedSiteId: z.string().guid().nullable() }))
    .min(1).max(200).refine((a) => new Set(a.map((i) => `${i.unifiHostId}::${i.unifiSiteId}`)).size === a.length, 'Duplicate site'),
});
```

The handler:
1. Resolve the partner and the connection.
2. Call `resolveUnifiMappingTargets` for every item and return its error as-is.
3. Inside `withDbTransaction`:
   1. `SELECT … FOR UPDATE` the existing rows for the item keys.
   2. Any `(row?.siteId ?? null) !== expectedSiteId` throws a stale error.
   3. Take the before snapshot.
   4. Upsert with the same `onConflictDoUpdate` as `PUT /mappings` (`:254-274`).
   5. There is **no delete path**.
4. Catch outside the transaction. A stale error returns 409 `{ success:false, code:'STALE_REVIEW', message, keys }`.
5. Then call `revokeUnifiMappingDrift` and audit the diff.
   - Self-hosted items (`unifiHostId` equals a collector id of this integration) verify `source` against the name stored in `unifi_controller_sites` (`sourceVerified: true`).
   - Cloud items verify against the submitted `unifiSiteName`/`unifiHostName` and record `sourceVerified: false`.

- [ ] **Step 1: Failing tests:**
  - **`an existing mapping outside the batch survives`** (the spec's no-delete proof)
  - `stale expectedSiteId → 409, zero upserts`
  - **`replay of a successful batch → 409`** (Review Focus 2)
  - `foreign-partner site → 403, zero writes`
  - `holding org → 409 PROTECTED_ORG`
  - `self-hosted source verified; mismatch audited manual`
  - `cloud items audited sourceVerified:false`
  - `MFA required`
  - `201 items → 400`
- [ ] **Step 2: Run them.** `cd apps/api && npx vitest run src/routes/unifi/mappingAccept.test.ts src/routes/unifi/index.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): additive stale-safe UniFi mapping accept route (#10358)`.

### Task 16: UniFi mapping cards: chips, review, summary, docs

**Files:**
- Modify:
  - `apps/web/src/components/integrations/unifi/SiteMappingCard.tsx`
  - `useUnifiIntegration.ts` (new `handleAcceptSuggestions(items, source)`, which posts `/unifi/mappings/accept` through `runAction`, then `loadDetails()`)
  - `unifiTypes.ts` (suggestion + summary types)
  - `apps/docs/src/content/docs/features/unifi-integration.mdx`
  - 8 locales (only if a UniFi-specific string is needed beyond `externalMatch.*`)
- Test: `apps/web/src/components/integrations/unifi/SiteMappingCard.test.tsx` (new)

**Interfaces:**
- Consumes: Task 6 components, Task 14 shapes, Task 15 route.

The card:
- Chip test ids are `unifi-mapping-suggestion-${key}` and `unifi-controller-mapping-suggestion-${key}`, each with `-accept`.
  - Accept is available only when `siteId` is non-null.
  - A `pick_site` row narrows the `<select>` to that org's `<optgroup>` and shows `externalMatch.pickSite`.
- The review modal prefixes are `unifi-mapping` and `unifi-controller-mapping`. Items are bulk-eligible matches, with `targetLabel` set to `${orgName} › ${siteName}`. Blocked rows are `ambiguous` and `pick_site` rows.
- The summary pills are `unifi-mapping-summary` and `unifi-controller-mapping-summary`.
- Cloud rows display `desc ?? name`.
- A 409 reloads and shows `externalMatch.staleReview`.

- [ ] **Step 1: Failing tests:**
  - `accept posts /unifi/mappings/accept with expectedSiteId null and source suggestion`
  - `pick_site row has no accept and narrows the dropdown`
  - `bulk confirm posts checked items only`
  - `409 reloads`
  - `the existing Save still posts PUT /unifi/mappings unchanged`
- [ ] **Step 2: Run them.** `cd apps/web && npx vitest run src/components/integrations/unifi src/components/integrations/UnifiIntegration.test.tsx src/lib/__tests__/no-silent-mutations.test.ts --pool=forks --poolOptions.forks.maxForks=4`. Expected: FAIL.
- [ ] **Step 3: Implement and update the docs.** The docs cover connect, see every site, accept the suggestions, and the generic-name caveat.
- [ ] **Step 4: Re-run, then run the web `tsc` (Task 7 command).** Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(web): UniFi suggested site matches and bulk review (#10358)`.

---

## W04: unmapped self-hosted sites are discovery-only, plus the client identity fix

Independent of W01–W03, and runs in parallel with W01. **One migration** on `unifi_clients`, an org-cascade table:
- The new column is classified in `CORE_TENANT_EXPORT_POLICY`.
- The cascade, merge and device lists need no change, because the table is already registered (`tenantCascade.ts:1181`, `orgMergeRegistry.ts:1401`).
- RLS needs no change, because the table's policies are org-axis and the shape is the same.
- **Behavior change for self-hosters.** The PR body carries a release note:

> Self-hosted UniFi controllers: devices and clients on a controller site that is not mapped to a Breeze site are no longer filed under the collector agent's organization, and rows already filed there are removed the next time the controller reports them. Map the controller's sites (Integrations → UniFi) to keep their inventory.

**Execution split and parallelism:**
- Task 17 first: migration, schema and export policy.
- Then Task 18 (Opus; this is the reconcile hot path).
- Task 19 (Sonnet) after 18.
- **Task 20 is a LAB/owner gate** (OD-P1). It ships as a follow-up PR on the same wave issue only if the owner adopts OD-P1 and the check passes.

**CI traps:**
- The export-policy and cascade suites fail **only under Integration Tests**. Run them locally one file at a time (see Task 17).
- `agentHotPathQueryBudget.integration.test.ts` covers agent ingest. Task 18 adds at most three set-based statements per reconcile, never one per row. Re-run that file.
- **Migration naming:** see W02. The second PR to merge renames.
- **AI tools:** Task 19 touches `aiToolsUnifi.ts`, and the AI-tool contract tests key some entries by line number. Run `apps/api/src/__tests__/aiTools*` after it.

### Task 17: `unifi_clients.local_site_id` and the widened unique key

**Files:**
- Create: `apps/api/migrations/<sorts-after-newest>-unifi-clients-site-identity.sql`
- Modify:
  - `apps/api/src/db/schema/unifi.ts:186-213`
  - `apps/api/src/services/tenantExportPolicyRegistry.ts:1121` (add `"local_site_id"` to `included`)

The migration:

```sql
ALTER TABLE unifi_clients ADD COLUMN IF NOT EXISTS local_site_id text NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS unifi_clients_collector_site_mac_idx ON unifi_clients (collector_id, local_site_id, mac);
DROP INDEX IF EXISTS unifi_clients_collector_mac_idx;
```

- `''` means "site unknown or not recorded" (legacy rows, or an agent that sent none). It does not mean "the agent reported no site". The advisor amended this, and the schema comment says it.
- `raw` cannot backfill the column, because the agent assigns the site id outside the raw element (`client.go:452`, `:478`).
- The migration has no row writes, so it needs no `set_config`.
- Drizzle: `localSiteId: text('local_site_id').notNull().default('')`. The unique index becomes `unifi_clients_collector_site_mac_idx` on `(collectorId, localSiteId, mac)`, and the old one is removed.

- [ ] **Step 1: Red.** Run `pnpm test-stack up`, then `pnpm db:migrate`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts`. Do this after adding the schema column but before the registry edit. Expected: FAIL, with `unifi_clients.local_site_id` unclassified.
- [ ] **Step 2: Add the registry classification and re-run.** Expected: PASS. Also run:
  - `pnpm db:check-drift` (no drift)
  - `src/__tests__/migrationRlsScope.test.ts`
  - `tenantExportErasureRoundtrip.integration.test.ts`
  - `tenantCascade.integration.test.ts` (one at a time)
- [ ] **Step 3: Commit** `feat(unifi): widen unifi_clients identity to collector + local site + mac (#10358)`. Leave the test stack up for Task 18.

### Task 18: Mapped-only reconcile for self-hosted collectors, removal of wrongly attributed rows, widened client key

**Files:**
- Modify:
  - `apps/api/src/services/unifi/unifiTelemetryService.ts:116-285`
  - `apps/api/src/jobs/unifiTelemetryWorker.ts:53-57` (log the result)
- Test:
  - `apps/api/src/services/unifi/unifiTelemetryService.test.ts`
  - `apps/api/src/__tests__/integration/unifiDiscoveryOnly.integration.test.ts` (new)

**Interfaces:**
- Produces:

```ts
export function requiresMappedSite(collector: { unifiHostId: string | null }): boolean; // W04: unifiHostId === null (Task 20 may widen)
export type TelemetrySiteResolution =
  | { kind: 'mapped' | 'fallback'; orgId: string; siteId: string }
  | { kind: 'skip'; reason: 'no_site_id' | 'unmapped_site'; unifiSiteId: string | null };
export function resolveTelemetrySite(unifiSiteId: string | null | undefined, siteByUnifi: ReadonlyMap<string, { orgId: string; siteId: string }>,
  collector: { orgId: string; siteId: string }, mappedOnly: boolean): TelemetrySiteResolution;
// ReconcileResult gains: devicesSkippedUnmapped, clientsSkippedUnmapped, devicesRemovedUnmapped, clientsRemovedUnmapped: number;
//                        removedDiscoveredAssetIds: string[]
```

Reconcile rules:
- **Skipped records.** When `mappedOnly` is set, a device or client that resolves to `skip` gets no telemetry or `unifi_clients` row and no `linkTelemetryDeviceToAsset` call. It is not added to any seen set.
- **Removal, on every poll** (partial included), only for `reason: 'unmapped_site'`:
  - One `DELETE … FROM unifi_device_telemetry WHERE collector_id = $c AND unifi_device_id = ANY($ids) RETURNING discovered_asset_id`.
  - One `DELETE FROM unifi_clients WHERE collector_id = $c AND mac = ANY($macs) AND local_site_id = ANY($unmappedSiteIds || '')`.
  - `no_site_id` never deletes (Review Focus 4).
- **Client upsert.** The client row carries `localSiteId = cl.unifiSiteId ?? ''`. The conflict target becomes `[collectorId, localSiteId, mac]`, and `orgId` and `siteId` stay in the `SET`.
  - After the loop, one `DELETE FROM unifi_clients WHERE collector_id = $c AND local_site_id = '' AND mac = ANY($macsUpsertedWithSite)` removes the legacy rows.
- **Stale pass.** The client seen-set and the stale pass key on `` `${localSiteId}\u0000${mac}` ``.
- **Cloud collectors** (`mappedOnly` false) keep today's fallback exactly. Both fallback paths resolve to `kind: 'fallback'`.
- **Logging.** The worker logs one structured line, `unifi.reconcile.unmapped`, with the four counters and at most 50 `removedDiscoveredAssetIds`, when any counter is non-zero. It deletes no `discovered_assets` row (OD-P2).

- [ ] **Step 1: Failing unit tests** (`resolveTelemetrySite` table + reconcile mocks):
  - `self-hosted: unmapped site → skip, no asset link`
  - `self-hosted: no site id → skip, no delete, counted` (Review Focus 4)
  - `cloud: unmapped site → collector fallback (unchanged)`
  - `partial poll still removes rows reported under an unmapped site`
  - `client conflict target is collector+local site+mac`
- [ ] **Step 2: Failing integration test** `unifiDiscoveryOnly.integration.test.ts` (real Postgres, system context):
  - Self-hosted collector in org A with sites `s1` (mapped to org B) and `s2` (unmapped). After one reconcile:
    - no `unifi_device_telemetry` or `unifi_clients` row for `s2` in any org
    - `s1` rows are in org B
    - `unifi_controller_sites` lists both sites
  - A pre-existing org-A row for an `s2` device is removed on the next reconcile, and its `discovered_assets` row still exists.
  - **The same MAC on `s1` and `s3`** (both mapped, to B and C) gives two rows in two orgs. A legacy `local_site_id = ''` row for that MAC is deleted, not left stale (Review Focus 5).
  - Unmapping `s1` and reconciling removes `s1`'s rows.
- [ ] **Step 3: Run them.** `cd apps/api && npx vitest run src/services/unifi/unifiTelemetryService.test.ts --pool=forks --poolOptions.forks.maxForks=4`, then `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/unifiDiscoveryOnly.integration.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement, then re-run both commands.** Also run:
  - `src/__tests__/integration/agentHotPathQueryBudget.integration.test.ts`
  - `src/__tests__/integration/unifiCollectorUpsert.integration.test.ts`
  - `src/__tests__/integration/unifiAssetTypeSource.integration.test.ts`
  - `src/__tests__/integration/topologyUnifiScope.integration.test.ts`
  Expected: PASS. Then run `pnpm test-stack down`.
- [ ] **Step 5: Update the docs.** In `apps/docs/src/content/docs/features/unifi-integration.mdx`, under the self-hosted section, add the release-note paragraph above: an unmapped site appears for mapping but files no inventory.
- [ ] **Step 6: Commit** `fix(unifi): unmapped self-hosted controller sites no longer write into the collector's org (#10358)`.

### Task 19: Read surfaces carry the client's site identity

**Files:**
- Modify: `apps/api/src/services/aiToolsUnifi.ts:167-171` (select `collectorId`, `localSiteId`)
- Test: the existing `aiToolsUnifi` test file (find it with `rg -l aiToolsUnifi apps/api/src --glob '*.test.ts'`)
- No change in `GET /unifi/telemetry`: it returns `select()` rows (`routes/unifi/index.ts:462`), so `localSiteId` appears automatically. The web keys rows by UUID.

- [ ] **Step 1: Failing test.** `client rows include collectorId and localSiteId`.
- [ ] **Step 2: Run, implement, re-run.** Run the test plus `apps/api/src/__tests__/aiTools*` contract tests (substring filter `src/__tests__/aiTools`; check the file count). Expected: PASS.
- [ ] **Step 3: Commit** `feat(ai): UniFi client rows carry collector and local site (#10358)`.

### Task 20 (LAB/owner gate, OD-P1): Cloud collectors become mapped-only

- [ ] **Step 1: Read-only check (owner approves the query and its target).** Find a cloud collector and its console's site mappings. Compare `unifi_controller_sites.local_site_id` (collector-reported) with `unifi_site_mappings.unifi_site_id` for `unifi_host_id = <that console>`.
  - **Pass:** the reported ids are a subset of the Site Manager ids, or at least intersect them.
  - **Fail:** they are disjoint. Stop, and file an issue: cloud-collector telemetry never matched a mapping, so it needs a site-id translation first.
- [ ] **Step 2: Failing test.** `cloud: unmapped site → skip`, replacing Task 18's cloud fallback case.
- [ ] **Step 3: Implement.** `requiresMappedSite` returns `true`. Add a second release-note line covering cloud consoles that have a collector.
- [ ] **Step 4: Run the Task 18 commands.** Expected: PASS.
- [ ] **Step 5: Commit** `fix(unifi): cloud-console collectors file only mapped sites (#10358)`.

---

## W05: direct server-to-controller connection, as a linked spec (OD7 B; no code in this plan)

Keeps #10358 open as an explicit deliverable.

- [ ] **Task 21: Requester check (owner).** The requester came from Discord and never sees GitHub, so Todd asks there. The question: is your controller linked to your UI account, so that it appears in the cloud Site Manager path since #10570? Or would an agent at your office reach it? Record the answer on the W05 sub-issue.
- [ ] **Task 22: Linked spec (feature pipeline, Stage 2).** Do this only if Task 21 says the direct connection is still needed.
  - Write `docs/superpowers/specs/integrations/<date>-unifi-server-polled-controller-spec.md` from spec §3.6, carrying the approved decisions OD2 A (dual-owner `unifi_collectors` + `unifi_controller_sites`) and OD6 A (trusted certificates only; pinning is a separate security-reviewed follow-up).
  - It needs its own tenancy acceptance (dual-axis RLS, composite ownership FKs, `DUAL_AXIS_TENANT_TABLES`, `<table>PartnerRls.integration.test.ts`), lifecycle acceptance (generation fence, scheduler split, connection-health arm) and transport acceptance (`safeFetch` GET-only, no redirects, poll deadline and request budget, HTTPS-only on hosted).
  - It goes through its own Gate A and Gate B, and is registered as its own feature.
  - #10358 closes when that feature ships, or when the owner declines it after Task 21.

---

## Wave order

| Wave | Depends on | Migration | Gate | Ships |
|---|---|---|---|---|
| W01 shared matcher + Pax8 | none | none | none | the #11245 ask |
| W04 discovery-only + client identity | none (parallel with W01) | `unifi_clients.local_site_id` (org-cascade; export policy) | Task 20 only (LAB, optional) | tenant-boundary fix on main |
| W02 UniFi audit + copy + counter | W01 (locale merge order) | `unifi_sync_runs.sites_unmapped` (partner-axis) | none | audit trail, §3.5 |
| W03 UniFi suggestions + accept | W01, W02 | none | Task 12 (owner payload capture; cloud half only) | the #10358 matching ask |
| W05 direct connection | none | (in its own spec) | Task 21 (requester) | linked spec |

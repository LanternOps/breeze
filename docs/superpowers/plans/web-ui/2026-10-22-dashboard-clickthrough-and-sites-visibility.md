---
tracking_issue: LanternOps/breeze#9791
spec_issue: LanternOps/breeze#6721
co_issue: LanternOps/breeze#6720
spec: docs/superpowers/specs/web-ui/2026-10-18-dashboard-clickthrough-and-sites-visibility-spec.md
status: approved (Gate B) — waves tracked on LanternOps/breeze#9791
---

# Dashboard Click-Through + Sites Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every dashboard number is a link to the list it counts (or is registered as not clickable, with a reason), Sites is reachable from the nav by anyone with `sites:read`, and devices can be moved to a site in bulk.

**Architecture:** One producer module (`dashboardLinks.ts`) builds every dashboard href from each destination's own hash encoder; a `DASHBOARD_METRICS` registry plus a `DashboardMetric` helper make an unregistered number a type error and a test failure. Destinations learn one hash grammar (`#<tab>[/<sel>][&k=v,v]…`). Sites revives `/settings/sites` as a site-centric page on the existing `useSiteCrud` (given a fleet mode). Bulk move is one new MFA-gated route sharing PATCH's move logic, one transaction per device.

**Tech Stack:** Astro + React islands, Vitest + Testing Library, Playwright (`data-testid` only), Hono + Drizzle (API, one route), i18next (8 locales).

**Spec:** `docs/superpowers/specs/web-ui/2026-10-18-dashboard-clickthrough-and-sites-visibility-spec.md` (approved 2026-10-22; §7 decisions 1–6 are final and are not re-opened here). Executors read both.

**Schema impact:** none. No migration, RLS, cascade or export-policy registration. (If a task ever seems to need one, stop: the plan is wrong.)

## Global Constraints

Copied from the spec / repo rules; every task inherits them.

- **R1** every dashboard number is a `count` link, an `affected` link (number stays text + a separate named link), or `exempt` with a written reason. **R2** a link never claims a count its destination won't show. **R3** links carry filters in the hash and never an org (ambient scope). **R4** a link renders only when the viewer can open the destination; otherwise plain text (no disabled styling, no tooltip).
- Every devices link carries `deviceClass=agent` (`/devices/stats` counts agents only).
- Hash grammar: `#<tab>[/<selection>][&<key>=<value>[,<value>…]]…`; booleans `1`; writers preserve keys they don't own; parsers ignore unknown keys/invalid values; existing bookmarks (`#patches`, `#cves/<id>`) keep resolving.
- Critical/Warnings tiles are **active-only**; links carry `status=active` (Decision 6). Patch compliance % is the **device** percentage everywhere, with a release-note line (Decision 4). Sites sits in **Fleet Management next to Device Groups**, `/settings/sites` revived, shown to every `sites:read` viewer incl. single-site orgs (Decisions 1–2). **No telemetry** (Decision 3). Bulk move = `POST /devices/bulk/site` (Decision 5).
- Mutations use `runAction` (`no-silent-mutations.test.ts`); transient UI state uses `useHashState` (`no-hash-in-usestate` lint). New en key → all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`, `apps/web/src/locales/<lang>/*.json`, `localeParity.test.ts`).
- Red first on every task: write the assertion, watch it fail, then implement. Scoped runs: `cd apps/<pkg> && npx vitest run <path>` (never `pnpm --filter … test -- --run`; paths are substring matches). Typecheck: `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` per touched package — read the exit code, never pipe to `tail`.
- Portal is out of scope. Subnet/WAN site identity and automation targeting are out of scope (topology; suggest-only, never auto-move).

## Review Focus

Failure modes the spec implies but no obvious task covers; each has a pinned test in the owning task (marked **RF#**).

1. **RF1 — Site-scoped viewer (`allowedSiteIds`) clicks a tile**: destination must narrow by the same allowlist; a link must not promise rows the viewer can't see. Test: Task A5 arrival test with a site-scoped fixture.
2. **RF2 — Fleet view (no org selected) arrival**: every destination fetch is verified to work org-less and not 400. Test: A5/C2/D-series arrival tests run with `currentOrgId = null`.
3. **RF3 — Tile count raced against list** (counts differ by seconds): parity tests compare predicate+scope via mocked fetch URLs, never live counts. Test: A5.
4. **RF4 — Legacy bookmarks and the old `?severity=` writer**: `#patches`, `#cves/<id>`, `/alerts?severity=high` must still land somewhere sane. Test: A6, C2.
5. **RF5 — Bulk move with duplicate ids, empty list, over-cap, the target site in another org, and a device already at the target**: each has a defined outcome. Test: D2.

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/components/dashboard/dashboardLinks.ts` (new) | `DASHBOARD_METRICS` registry + href builders (calls destination encoders) |
| `apps/web/src/components/dashboard/DashboardMetric.tsx` (new) | The only way a number renders on a card; link vs text per registry + viewer gate |
| `apps/web/src/components/dashboard/*.tsx` (modify) | Cards render numbers through `DashboardMetric` |
| `apps/web/src/components/devices/filterUrl.ts`, `deviceClassFilter.ts` (reuse) | Encoders for `#filtersV2=` and `deviceClass` |
| `apps/web/src/lib/hashParams.ts` (new) | Shared `parseHashGrammar` / `writeHashKeys` implementing §3.2.1 |
| `apps/web/src/components/patches/PatchesPage.tsx`, `PatchComplianceView.tsx` (modify) | Tab+filter grammar, server-side compliance split |
| `apps/web/src/components/alerts/AlertsPage.tsx` (modify) | `#status=&severity=` multi-value, merged writers |
| `apps/web/src/components/vulnerabilities/VulnerabilityFleetPage.tsx` (modify) | `#cves&status=&severity=&kev=&patchAvailable=` |
| `apps/web/src/pages/settings/sites/index.astro` (modify) | Replaces the 301 with the Sites page |
| `apps/web/src/components/settings/SitesPage.tsx` (new) | Site-centric list (fleet + org), reuses `SiteList`/`SiteModals` |
| `apps/web/src/components/settings/useSiteCrud.ts` (modify) | Fleet mode, org per write |
| `apps/web/src/components/layout/Sidebar.tsx`, `lib/routeScope.ts`, `settingsCatalog.ts` (modify) | Nav item, `org-or-all` classification |
| `apps/api/src/services/deviceSiteMove.ts` (new) | `moveDeviceToSite(...)` extracted from PATCH |
| `apps/api/src/routes/devices/bulkSite.ts` (new) | `POST /bulk/site` |
| `apps/api/src/routes/devices/index.ts`, `core.ts`, `middleware/selfManagedDbContextRoutes.ts`, `services/mcpCoverage.ts` (modify) | Mount order, shared logic, registrations |
| `e2e-tests/tests/dashboard-clickthrough.spec.ts`, `sites-reachability.spec.ts` (new) | Journeys |

## Waves (PR strategy)

| Wave | Content | PR | Rigor | Depends on |
|---|---|---|---|---|
| **A** Filter URL contract + click-through | A1–A8 | 2 PRs: **A-1** (A1–A4: producer, helper, devices/fleet links, site detail) fast-track web-only + one additive API field; **A-2** (A5–A8: alert/vuln/threat/security destinations + links) | Medium | — |
| **B** Sites nav + page | B1–B5 | 1 PR | Medium | A4 (`siteDevicesHref`); otherwise parallel with A |
| **C** Patch % unification + patch links | C1–C3 | 1 PR | Medium | A-1 and A-2 (A5 harness) |
| **D** Bulk move (`POST /devices/bulk/site`) | D1–D4 | 1 PR, API+UI together | **High** (auth, multi-tenant write) | — |
| **E** E2E reachability | E1–E2 | 1 PR | Low | A, B, C, D |
| **F** Score factors → event log (optional, #6721 ask 2) | F1–F2 | 1 PR | Medium | — (Gate B item 8) |

D and F are independent of everything; B needs A4; A-2 needs A-1's registry; C needs A-1 + A-2. Wave tracking: sub-issues of #6721 (A, C, F) and #6720 (B, D), `Closes #<sub>` in PR bodies; register via `feature-lifecycle` after Gate B.

**CI traps:** a PR with base ≠ main gets no CI → `gh workflow run CI --ref <branch>`. Contract suites (`mcp-coverage`, selfManagedDbContextRoutes, org-cascade) only fail under *Integration Tests*; run them on a `pnpm wt-stack` before opening Wave D. New files under `apps/api/src/services` must be classified in `parkedFanout.contract.test.ts`; `PaymentMethodsPage` portal test is a known 5 s flake; locale fixers miss `localeParity` — run it explicitly.

---

## Wave A — Filter URL contract + click-through

### Task A1: Hash grammar helper

**Files:** Create `apps/web/src/lib/hashParams.ts`; Test `apps/web/src/lib/__tests__/hashParams.test.ts`.

**Interfaces — Produces:**
```ts
export interface ParsedHash { tab: string | null; selection: string | null; params: Record<string, string[]> }
export function parseHashGrammar(hash: string, knownTabs: readonly string[]): ParsedHash;
export function writeHashKeys(currentHash: string, owned: Record<string, string[] | null>, knownTabs: readonly string[]): string; // null deletes; other keys preserved
```

- [ ] **Step 1: Failing tests** — `parses tab, selection, params`: `parseHashGrammar('#cves/abc&status=open&severity=critical,high', ['cves','software'])` → `{tab:'cves', selection:'abc', params:{status:['open'], severity:['critical','high']}}`; `bare filter hash with no tab`: `'#status=active'` → `tab:null`; `unknown keys and empty values are kept/ignored without throwing` (`'#&=&&x'`); `writeHashKeys preserves keys it does not own`: `writeHashKeys('#hideAiNoise=1&severity=low', {severity:['high']}, [])` → contains `hideAiNoise=1` and `severity=high`; `null deletes`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/lib/__tests__/hashParams.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** both functions; tab = first segment iff in `knownTabs`; split selection on first `/` of the tab segment; values split on `,` and URL-decoded.
- [ ] **Step 4:** rerun → PASS. **Step 5:** commit `feat(web): shared hash grammar helper (#6721)`.

### Task A2: Registry, producer and `DashboardMetric`

**Files:** Create `components/dashboard/dashboardLinks.ts`, `DashboardMetric.tsx`; Test `dashboardLinks.test.ts`, `DashboardMetric.test.tsx`.

**Interfaces — Produces:**
```ts
export type MetricKind = 'count' | 'affected' | 'section' | 'exempt';
export interface MetricDef { kind: MetricKind; href?: (d: DashboardData) => string; visible?: (v: Viewer) => boolean; reason?: string }
export const DASHBOARD_METRICS = { /* every key from spec §3.2 */ } as const satisfies Record<string, MetricDef>;
export type MetricKey = keyof typeof DASHBOARD_METRICS;
// <DashboardMetric metric="fleet.legend.offline" label="Offline">{12}</DashboardMetric>
export function DashboardMetric(props: { metric: MetricKey; label?: string; children: React.ReactNode }): JSX.Element;
```
`visible` reuses the Sidebar's own predicate for that destination (`requiredPermission` + module gates e.g. service-management `off` hides Tickets) — extract that predicate from `Sidebar.tsx` into `lib/navVisibility.ts` rather than duplicating it. Sidebar has only per-item flags today (`requiredPermission`, `partnerScopeOnly`, `requiresFlows`, …), so this is a real refactor: do it as its own sub-step with its own red test (`navVisibility.test.ts`: one case per flag, parity with the Sidebar's rendered items for a fixture viewer) before the registry uses it.

- [ ] **Step 1: Failing tests** — registry: `every entry has a kind; every exempt entry has a non-empty reason; every count/affected entry has href`; helper: `renders <a> with label+number as accessible name ("Critical open 12") when visible`; `renders plain text with no <a> when viewer fails the predicate (R4)`; `exempt renders text`; `an unregistered key fails typecheck` (a `// @ts-expect-error` line, enforced by a named step: run `NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"` with the registry entry temporarily removed and confirm a nonzero exit before restoring).
- [ ] **Step 2:** run both files → FAIL. **Step 3:** implement; all links get `focus-visible` ring + resting underline (#9033) and `data-testid` from §9.3 of the spec (`dashboard-<card>-<thing>-link`). At this task every not-yet-linked number is registered `section`/`exempt` with a reason; A-2/C flip them.
- [ ] **Step 4:** PASS; **Step 5:** extract-and-reuse check — `cd apps/web && npx vitest run src/components/layout` (Sidebar tests stay green). Commit.

### Task A3: Devices links (fix the two broken hrefs) + inventory test

**Files:** Modify `KpiStrip.tsx`, `FleetStatusCard.tsx`, `SecurityPostureCard.tsx`, `PatchComplianceCard.tsx`, `VulnerabilitiesCard.tsx`, `AlertsFeed.tsx` (the last four only to route their numbers through `DashboardMetric` as `section`/`exempt`; A6–A8/C3 flip them), `DashboardPage.tsx` (the offline fetch `?status=offline&limit=25` is a data fetch, untouched); Test `KpiStrip.test.tsx`, `FleetStatusCard.links.test.tsx`, new `dashboardInventory.test.tsx`.

- [ ] **Step 0:** `deviceClassFilter.ts`'s writer returns `void` and mutates the current URL, so add a pure `encodeDeviceClassToHash(cls): string` beside it (test: round-trips through its parser); build `dashboardLinks.ts` from that plus `encodeFilterToHash`.
- [ ] **Step 1: Failing tests** — regression: Online tile and "View N offline" hrefs **decode** (via the devices `decodeFilterFromHash`) to a `FilterConditionGroup` `status equals online|offline` plus `deviceClass=agent`, and contain no `?status=`; Total devices → `/devices#deviceClass=agent`; legend Online/Offline/Other links (Other = `status in` remaining `byStatus` keys); a viewer lacking `devices:read` gets no `<a>`; KPI tiles have a `focus-visible` class. **Inventory test (R1):** render every card with fixture data; every digit run in card text must sit inside `[data-metric]` (emitted by `DashboardMetric`) or an allowlisted element (dates, "updated Xs ago"). It fails now for numbers that bypass the helper — convert those cards (Fleet/Security/Patch/Vulns/AlertsFeed header counts) to `DashboardMetric` in this task.
- [ ] **Step 2:** run → FAIL. **Step 3:** build hrefs in `dashboardLinks.ts` with `encodeFilterToHash` + the `deviceClass` writer; **never** hand-concatenate hash strings.
- [ ] **Step 4:** PASS + typecheck (`apps/web`). **Step 5:** commit.

### Task A4: Site detail count + site-filtered "View all"; `OrgDevicesTab` paging

**Files:** Modify `apps/api/src/routes/orgs.ts` (extract `deviceCountBySite` ~L3082 into `getDeviceCountsBySite(orgId, siteIds)`; call from list route and `GET /orgs/sites/:id`), `SiteDetailPage.tsx`, `OrgDevicesTab.tsx` (use `fetchAllSites`); Tests: `orgs.sites.test.ts`, `SiteDetailPage.test.tsx`, `OrgDevicesTab.test.tsx`.

- [ ] **Step 1: Failing tests** — API: `GET /orgs/sites/:id returns deviceCount equal to the list route's value for the same site (excludes ephemeral, parked, decommissioned)`; web: `site-detail-device-count` renders the API count; `site-detail-devices-view-all-link` href decodes to `#orgId=<org>&deviceClass=agent` + `filtersV2` `siteId equals <id>`; `OrgDevicesTab` with 150 sites resolves names past 100 (no "Unknown Site").
- [ ] **Step 2–4:** run (`cd apps/api && npx vitest run src/routes/orgs` ; `cd apps/web && npx vitest run src/components/...`) → FAIL → implement → PASS. Build the devices href through `components/contracts/deviceCoverageLinks.ts` (extend it with `siteDevicesHref(orgId, siteId)`). **Step 5:** commit. **PR A-1 opens here**; typecheck both packages.

### Task A5: Count-parity (arrival) test harness

**Files:** Create `apps/web/src/components/dashboard/__tests__/countParity.test.tsx` (+ shared fixture `parityFixtures.ts`). Pattern: `DevicesPage.deepLink.test.tsx`.

- [ ] **Step 1: Failing tests, table-driven over every `count` entry in `DASHBOARD_METRICS`:** mount the destination with the link's hash; assert (a) the filter control shows the filter, (b) the destination's population request carries the **same filter predicate and the same org param** — for devices the predicate travels in the `POST /filters/preview` JSON body (see `DevicesPage.deepLink.test.tsx`), for alerts the predicate is the visible chips plus the client-filtered row set (the page fetches all statuses and filters in the browser) with the org param on the `/alerts` fetch, for vulns/patches in the list query string; assert each in its real transport, against (`orgId` from `useOrgStore`) as the tile's source endpoint (`/devices/stats`, `/alerts/summary`, …), (c) **RF1** repeat with an `allowedSiteIds` session: both fetches narrow identically, (d) **RF2** repeat with `currentOrgId = null`: no destination fetch 400s/blocks on a missing org (verify each endpoint in fleet view and note any exception in the registry as `exempt` with reason).
- [ ] **Step 2:** the harness ships with the devices cases only; first run it with one deliberately wrong fixture href (`?status=online`) and confirm it fails, to prove the red. Alerts/vulns/patches cases are added, red-first, by A6/A7/C2. Commit the harness. Parked devices absent from the agent+site list (spec §4.5) is asserted here.

### Task A6: Alerts destination (`#status=&severity=`) + KPI links

**Files:** Modify `AlertList.tsx` (it owns the **client-side** status/severity filter state, `string` today → make severity a multi-value set; `AlertsPage` fetches all statuses once and never sends these filters to the API, so **no API change**; `AlertList` accepts `initialStatus`/`initialSeverity` seeded from the hash), `AlertsPage.tsx`, `KpiStrip.tsx`, `AlertsFeed.tsx` (header counts); Tests: `AlertList.severity.test.tsx` (multi-value severity filters the row set; chips show both), `AlertsPage.hash.test.tsx`, parity cases.

**Interfaces — Produces:** `encodeAlertsHash({status?: AlertStatus[]; severity?: AlertSeverity[]}): string` and `parseAlertsHash(hash)`; `severityFilter` becomes `AlertSeverity[]`.

- [ ] **Step 1: Failing tests** — round-trip encode→parse; `#status=active&severity=critical,high` filters list and chips; Critical tile href = `/alerts#status=active&severity=critical,high`, Warnings = `…severity=medium`; header counts in `AlertsFeed` use the same hrefs; `#hideAiNoise` writer **merges** (does not clear `severity`); **RF4:** `handleFilterBySeverity` no longer navigates to `?severity=`; a legacy `/alerts?severity=high` URL is read once, converted to hash, and stripped.
- [ ] **Step 2–4:** FAIL → implement via `hashParams.ts` → PASS (`cd apps/web && npx vitest run src/components/alerts src/components/dashboard`). **Step 5:** commit.

### Task A7: Vulnerabilities + threats destinations; open-findings fix

**Files:** Modify `VulnerabilityFleetPage.tsx`, `VulnFleetFilters`, `VulnerabilitiesCard.tsx`, the threats list `components/security/VulnerabilitiesPage.tsx` (parses `#severity=` with a regex today → migrate to `parseHashGrammar`, add `#status=`), `apps/api/src/services/vulnerabilityFleetSql.ts` (`aggregateFleetStats` gains `openFindings`), route `/vulnerabilities/stats`; Tests: `vulnerabilityFleetSql.test.ts` (API), `VulnerabilityFleetPage.hash.test.tsx`, card tests.

- [ ] **Step 1: Failing tests** — API: `aggregateFleetStats` returns `openFindings` excluding accepted/other statuses (the header previously counted every status); web: `#cves&status=open&severity=critical&kev=1&patchAvailable=1` seeds `VulnFleetFilters`; legacy `#cves/<groupKey>` and `#software` still resolve (**RF4**); card: header shows `openFindings`; "Critical open"/"Patch ready" stay text + affected links "View critical CVEs"/"View patch-ready CVEs"; KEV "N CVEs" is a **count** link (distinct CVEs), device count stays text; threats "N active threats" → `/security/vulnerabilities#status=active`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`cd apps/api && npx vitest run src/services/vulnerabilityFleetSql`; web scoped). **Step 5:** commit.

### Task A8: Security scope parity, then security links

**Files:** Modify `apps/api/src/routes/security/compliance.ts` (`/trends`) and the score-breakdown route to honor `query.orgId` exactly like `/security/dashboard`; `SecurityPostureCard.tsx`; Tests: `compliance.trends.scope.test.ts`, card tests.

- [ ] **Step 1: Failing tests** — API: partner session with `?orgId=A` gets A-only trend and breakdown (today: all accessible orgs); site-scoped caller still narrowed. Web: score → `/security/score`, trend caption → `/security/trends` (sparkline stays non-interactive/exempt). **At-risk decision:** write a test that asserts the `/security/dashboard` at-risk computation (posture `riskLevel` medium|high; falls back to agent `at_risk` only when the population has no posture rows) equals the candidate list's (`/devices/posture` `FleetPostureReport`) count for a mixed fixture; if it cannot be made equal, the test instead pins the registry entry as `exempt` with reason (Gate B item 6).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** commit. Typecheck `apps/api` and `apps/web` (read exit codes). - [ ] **Locale fill:** add all new `en` `common.json` `dashboard.*` keys (A2/A3/A6/A7/A8) to the other 7 locales; `npx vitest run src/lib/i18n/localeParity.test.ts` red → green. **PR A-2 opens here.** (Wave C repeats this for its keys.)

---

## Wave B — Sites nav + page

### Task B1: `useSiteCrud` fleet mode

**Files:** Modify `components/settings/useSiteCrud.ts`; Modify `apps/api/src/routes/orgs.ts` list handler (~L3067–3118) so a no-`organizationId` listing also returns `orgName` per site (none today; one RLS-scoped lookup over the distinct org ids); Test `useSiteCrud.test.ts`, API `orgs.sites.test.ts` (`orgName` present; `allowedSiteIds` respected).

**Interfaces — Produces:** `useSiteCrud(orgId: string | null, opts?: { fleet?: boolean })`; in fleet mode `refresh()` lists via `fetchAllSites` with no `organizationId` (rows carry `orgId`, `orgName`), and `submitSite(values, targetOrgId)` / edit / delete take each row's own org. Org is captured when the modal opens (`openAdd(orgId)`), never read at submit time.

- [ ] **Step 1: Failing tests** — fleet `refresh` issues no `organizationId` and returns rows from two orgs; add in fleet mode without an org pick is blocked; **org switch mid-edit does not retarget the write** (switch `useOrgStore` after `openAdd('A')`, submit → POST body `orgId: 'A'`); edit/delete use the row's org; MFA-required 403 surfaces the existing MFA flow (same as `OrgSitesTab`). Existing org-mode tests stay green (no second hook).
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run src/components/settings/useSiteCrud src/components/organizations/record/OrgSitesTab`). **Step 5:** commit.

### Task B2: `SitesPage` + route

**Files:** Create `components/settings/SitesPage.tsx`; Modify `pages/settings/sites/index.astro` (drop the 301, mount `SitesPage client:load`); Test `SitesPage.test.tsx`.

- [ ] **Step 1: Failing tests** — fleet view lists cross-org sites with an **Organization** column; org selected → that org only; org-scoped session → own sites; site-scoped session → only allowlisted sites (**RF1**); `sites-add-button` hidden without `sites:write`; fleet-view add requires `sites-org-picker` choice, pre-filled when an org is selected; device-count link href = `deviceCoverageLinks.siteDevicesHref` (A4); `sites-page`, `sites-row-<id>` ids; search appears at ≥6 rows (reused `SiteList`).
- [ ] **Step 2–4:** FAIL → implement reusing `SiteList` + `SiteModals`; mutations through `runAction` (already inside `useSiteCrud`). **Step 5:** commit.

### Task B3: Nav item, route scope, catalog, breadcrumbs

**Files:** Modify `Sidebar.tsx` (Fleet Management, after Device Groups: `{ name: 'Sites', labelKey: 'nav.sites', href: '/settings/sites', icon: MapPin, requiredPermission: { resource: 'sites', action: 'read' } }` — **no** `partnerScopeOnly`), `lib/routeScope.ts` (insert `{ pattern: /^\/settings\/sites(\/[^/]+)?$/, kind: 'org-or-all' }` **above** the `/settings/*` catch-all), `settingsCatalog.ts` only if `settingsPageRegistry.test.ts` demands it, `SiteDetailPage.tsx` breadcrumbs/Back → `/settings/sites`; Tests: `Sidebar.test.tsx`, `routeScope.test.ts`, `settingsPageRegistry.test.ts`, `SiteDetailPage.test.tsx`.

- [ ] **Step 1: Failing tests** — org-scoped user with `sites:read` sees `nav-sites`; user without it doesn't; single-site org still shows it (Decision 2); `getRouteScope('/settings/sites')` and `'/settings/sites/abc'` → `org-or-all`; `/settings/sites` is not in a redirect list; breadcrumb path is Settings → Sites → site; Back lands on `/settings/sites`. `systemPageRoutes.test.ts` and `settingsPageRegistry.test.ts` stay green (read `docs/agents/settings.md` rule 9: state home = Sites page, level = org records, resolver = n/a (records, not settings), places configured before=1 (org Sites tab) after=2 views of the same records — state this in the PR).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** commit.

### Task B4: Locale keys (8 locales)

B2/B3 add the `en` keys as they use them (red-first); B4 fills the other 7 locales. Namespace: `nav.sites` in the sidebar's namespace (`common.json`), `sites.page.*` in the namespace holding `SiteList` strings.

- [ ] **Step 1:** confirm `en` has: `nav.sites`, `sites.page.title`, `sites.page.organizationColumn`, `sites.page.pickOrg`, `sites.page.addSite`, `sites.page.empty`; **Step 2:** run `npx vitest run src/lib/i18n/localeParity.test.ts` → FAIL; **Step 3:** add real translations to the other 7 locale dirs; **Step 4:** PASS. Commit.

### Task B5: Wave B verification

- [ ] `npx vitest run src/components/settings src/components/layout src/lib/__tests__` in `apps/web`; typecheck `apps/web` (exit code). Open PR B.

---

## Wave C — Patch % unification + patch links (needs A-1)

### Task C1: Server-side compliance split exposes `failed`

**Files:** Modify `apps/api/src/routes/patches/compliance.ts` (today it returns only non-compliant device rows plus a scalar compliant count, so a compliant/all list has no source): add `devicePercent`, `failedDevices`, and a paginated `devices` list chosen by a `status=all|compliant|needs-patches|failed|critical` query param (+ `limit`/`offset`; each row carries `compliant`, `failedMissing`, `criticalMissing`); Test API `patches.compliance.test.ts`.

- [ ] **Step 1: Failing test** — response contains `compliantDevices`, `totalDevices`, `devicePercent = round(compliant/total*100)` (0 total → 0, not NaN), `failedDevices` = devices with `failedMissing > 0`; `status=compliant` returns only compliant rows and page totals add up to `totalDevices`; narrowing by `allowedSiteIds` and by `orgId` (fleet view works). **Step 2–4:** FAIL → implement → PASS. Commit.

### Task C2: `/patches` takes its list and split from the API; `#compliance&status=`

**Files:** Modify `PatchesPage.tsx` (tab parsing via `parseHashGrammar`; `#compliance` tab = empty hash retained, `#compliance&status=…` ≡ `#status=…`), `PatchComplianceView.tsx` (drop the `limit=200` device fetch and client predicate; headline = `devicePercent`; `statusFilter` gains `failed`); Tests: `PatchesPage.hash.test.tsx`, `PatchComplianceView.test.tsx`, parity cases.

- [ ] **Step 1: Failing tests** — `#compliance&status=needs-patches|compliant|failed|critical` sets the filter; legacy `#patches`/`#rings`/`#jobs` still select tabs (**RF4**); with >200 devices fixture the headline and list counts equal the API fields (cap removed); arrival fetch carries org scope, runs with `currentOrgId=null` (**RF2**).
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit.

### Task C3: Dashboard KPI + card use the device %, links, release note

**Files:** Modify `KpiStrip.tsx`, `PatchComplianceCard.tsx`, `dashboardLinks.ts`; add the release-note line to the next unreleased entry via the `update-breeze-release-notes` convention (apps/docs or website release page — follow that skill; note "Patch compliance on the dashboard now shows the percentage of devices that are fully patched, matching the Patches page"); Tests: `KpiStrip.test.tsx`, `PatchComplianceCard.test.tsx`.

- [ ] **Step 1: Failing tests** — KPI + headline both render `devicePercent` (assert a fixture where item% ≠ device%); "X of Y devices compliant": two links → `#compliance&status=compliant` / `#compliance&status=needs-patches`; Pending → text + `View devices` affected link; Failed → `#compliance&status=failed`; "critical pending" → `#compliance&status=critical`; Installed, unrated, "images not checked" stay text with registry reasons; KPI tile flips from `section` to `count`.
- [ ] **Step 2–4:** FAIL → implement → PASS; typecheck. Commit; open PR C.

---

## Wave D — Bulk site move (HIGH rigor)

Per CLAUDE.md this is auth + multi-tenant writes: run an **independent review round on the diff and the `codex exec` quorum before merge**; run the integration/contract suites on a wt-stack (below).

### Task D1: Extract `moveDeviceToSite` from PATCH

**Files:** Create `apps/api/src/services/deviceSiteMove.ts`; Modify `routes/devices/core.ts` (~L2139–2330, the `siteChanged` branch); Test `deviceSiteMove.test.ts`, existing `core.*patch*` tests stay green.

**Interfaces — Produces:**
```ts
export type SiteMoveOutcome = 'moved' | 'already_there' | 'conflict' | 'forbidden' | 'not_found' | 'not_agent' | 'error';
export async function moveDeviceToSite(args: {
  auth: AuthContext; deviceId: string; toSiteId: string; expectedSiteId: string | null | undefined;
  trigger: 'manual' | 'topology_suggestion'; evidence?: unknown;
  audit: SiteMoveAuditSink; // caller-supplied so both audit entries keep the request's IP/user-agent attribution
}): Promise<{ outcome: SiteMoveOutcome; fromSiteId?: string; message?: string }>;
```
`SiteMoveAuditSink = { route(entry): Promise<void>; semantic(entry): Promise<void> }` is built by each caller from its Hono context `c` (PATCH: its existing `writeRouteAudit(c, …)`; bulk: the same, per device) — the service never reaches for request context. Moves, unchanged: row `FOR UPDATE` lock + `expectedSiteId` check, target-site/org check, `canAccessSite` on **both** source and target, `rewriteDeviceSiteDenormalizedTables`, peripheral reconciliation, group re-evaluation, route audit **and** the post-commit semantic move audit (two entries per moved device).

- [ ] **Step 1: Failing tests** (characterization first — run against current PATCH to pin behavior, then against the service): moved; already_there; stale `expectedSiteId` → conflict; target site in another org → forbidden; site-scoped caller moving out of / into a non-allowlisted site → forbidden; both audit entries written. **Step 2:** FAIL (module missing). **Step 3:** extract; PATCH calls the service and maps outcomes to its existing HTTP codes/bodies (no response-shape change). **Step 4:** PASS + all existing PATCH tests (`npx vitest run src/routes/devices/core`). Commit.

### Task D2: `POST /devices/bulk/site`

**Files:** Create `routes/devices/bulkSite.ts` (+ `schemas.ts` addition `bulkSiteMoveSchema`); Modify `routes/devices/index.ts` (mount **before** core's `/:id`, beside `bulkLifecycleRoutes`; extend `bulkLifecycle.mountorder.test.ts` or add `bulkSite.mountorder.test.ts`), `middleware/selfManagedDbContextRoutes.ts` (`{ method: 'POST', pattern: /^\/api\/v1\/devices\/bulk\/site\/?$/ }` with a comment like the bulk-restore one), `services/mcpCoverage.ts` (`'devices/bulkSite.ts': { exempt: 'human_only_bulk_destructive', note: ... }` — Gate B item 4); Test `bulkSite.test.ts`.

**Interfaces — Produces:**
```ts
// body: { siteId: string(uuid), devices: { id: string(uuid), expectedSiteId: string(uuid)|null }[] }   // 1..BULK_SITE_MOVE_CAP
// 200: { results: { id: string; outcome: SiteMoveOutcome; message?: string }[]; summary: { moved: number; total: number } }
export const BULK_SITE_MOVE_CAP = 100; // Gate B item 2
```
Gates: `requireScope('organization','partner','system')`, `requirePermission(DEVICES_WRITE)`, `requireMfa()`. Per device: `runBulkIsolated(dbAccessContextFromAuth(auth), ids, id => moveDeviceToSite(...))` (one caller-scoped transaction each). Whole-batch rejections (400, before any write): over cap, empty list, duplicate ids (pick **reject whole**, Gate B item 3), target site missing/other-org for a mixed-org batch.

- [ ] **Step 1: Failing tests** — happy path (3 moved, 3 × 2 audit rows); **RF5:** empty → 400; cap+1 → 400 and zero writes; duplicate id → 400 and zero writes; target already the device's site → `already_there`; devices spanning two orgs → 400 `mixed_org`; stale `expectedSiteId` → that device `conflict`, others `moved` (partial success **stays committed**); site-scoped caller: out-of-allowlist source/target → `forbidden` per device; non-agent id → `not_agent`; unknown id → `not_found`; no MFA → 403 (same assertion helper as PATCH's); missing `devices:write` → 403; route mounted before `/:id` (literal `bulk` never reaches core).
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run src/routes/devices/bulkSite src/middleware src/services/mcp`). **Step 5:** commit.

### Task D3: Web — row action, bulk action, modal

**Files:** Modify `DeviceActions.tsx`/row actions in `DeviceList.tsx` (it only emits an action string via `handleBulkAction`), **`DevicesPage.tsx` (owns `handleBulkAction`'s dispatch switch and agent-only allowlist, and rejects unknown actions — add the `move-site` case that opens the modal)**, bulk bar (`bulkActionGating.ts`), `ChangeSiteModal.tsx` (bulk variant: `devices`, "N devices from K sites"); Tests: `bulkActionGating.moveSite.test.ts`, `ChangeSiteModal.bulk.test.tsx`, `DeviceList.moveSite.test.tsx`.

- [ ] **Step 1: Failing tests** — `device-row-move-site` only on agent rows (never network/manual); `DevicesPage` dispatches `move-site` to the modal (not the unknown-action toast); `devices-bulk-move-site` enabled when all selected agents share one org; mixed orgs → disabled with `devices-bulk-move-site-disabled-reason` = "Selected devices belong to more than one organization"; non-agent selections excluded/disabled; modal lists only that org's reachable sites (`allowedSiteIds` respected); submit calls `runAction` → `POST /devices/bulk/site`; partial result shows a **warning** toast "Moved N of M" naming failures; 401 `ActionError` swallowed per the catch pattern; MFA-required handled like `ChangeSiteModal` today. `no-silent-mutations.test.ts` stays green.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** commit.

### Task D4: Locale keys + contract/integration verification

- [ ] Add `devices.json` keys (`devices.moveToSite`, `devices.bulkMoveToSite`, `devices.bulkMoveMixedOrgs`, `devices.moveToSiteSummary`, `devices.movedNOfM`) to all 8 locales; `localeParity` PASS.
- [ ] Integration/contract runs use the **test-stack** (integration tests only accept `breeze_test…` databases): `pnpm test-stack up`; in `apps/api`: `npx vitest run --config vitest.integration.config.ts <bulk-site + PATCH integration files>` (real RLS: a site-scoped and an org-scoped session) plus the `selfManagedDbContextRoutes` / `mcp-coverage` contract tests; `pnpm test-stack down`. Use `pnpm wt-stack` (copied root `.env`, AI keys blanked, `BREEZE_WORKSPACE_ENABLED=false`, free `BREEZE_DOCKER_SUBNET=172.31.N.0/24` + `BREEZE_CADDY_IP`) only for Wave E's Playwright runs; tear both down. Typecheck `apps/api`, `apps/web` (exit codes). Open PR D.

---

## Wave E — E2E reachability

### Task E1: Dashboard → filtered list (one per destination family)

**Files:** Create `e2e-tests/tests/dashboard-clickthrough.spec.ts` (`data-testid` only; follow `e2e-tests/README.md` and existing `dashboard.spec.ts`).

- [ ] Journeys: Online tile → devices list shows only online agents and count == tile; Critical tile → alerts list active critical/high; Patch non-compliant link → patches compliance filtered; vuln open-CVEs link → CVE list filtered; assert count parity on the first page header total. Run against the wt-stack. These specs can only pass after A–D, so prove the red by temporarily breaking one link's `href` and confirming the matching journey fails, then restore it.

### Task E2: Sites reachability

- [ ] `sites-reachability.spec.ts`: org-scoped user opens `nav-sites` → `sites-page` → `sites-add-button` → creates a site → on the devices list selects a device in its source site → `devices-bulk-move-site` into the new site → back on `/settings/sites` the new site's count is 1 and `sites-device-count-link-<id>` lands on a devices list showing that device. Mixed-org fixture asserts the disabled reason. Open PR E.

---

## Wave F — Score factors → event log (optional; Gate B item 8)

### Task F1: Event log sub-hash

**Files:** Modify `DeviceDetails.tsx` event-log tab (precedents `#anomalies/<id>`, `#scripts/<id>`) to parse `#eventlog/<filter>&from=&to=` (source/event filter + scoring window); Test `DeviceEventLog.hash.test.tsx`. If the log cannot filter by source, the link opens the unfiltered tab labelled "Open event log" (never claims "View N events", R2).

- [ ] Failing test → implement → pass → commit.

### Task F2: Links in `DeviceReliabilityPanel`

**Files:** Modify `DeviceReliabilityPanel.tsx`; Test `DeviceReliabilityPanel.links.test.tsx`; ids `reliability-factor-link-<factor>`, `reliability-offender-link-<key>`; locale keys in `devices.json` (`deviceReliabilityPanel.*`) × 8.

- [ ] Failing tests: `serviceFailures`/`hardwareErrors`/`hangs`/`crashes` rows each get one link with source filter + scoring window; each offender row links one-per-offender; `uptime` is exempt (text, no link). Implement → pass → commit; open PR F.

---

## Self-Review

- **Spec coverage:** §3.2 widget map → A3/A6/A7/A8/C3; §3.2.1 grammar → A1/A6/A7/C2; §3.3 anatomy/a11y → A2/A3; §3.5 gating → A2; §3.6 producer/registry → A2; §3.7 → F; §4.1–4.2 → B1–B3; §4.3 → A4; §4.4 → D1–D4; §4.5 → A4; §8 tests → A2/A5/D2/E; i18n → B4/D4/F2; Decisions 1–6 → Global Constraints. Open gap: a Sentry check (spec: no telemetry) — nothing to add.
- **Types:** `SiteMoveOutcome` (D1) is reused verbatim in D2/D3; `parseHashGrammar` signature (A1) is what A6/A7/C2 consume; `siteDevicesHref` defined in A4, consumed in B2.
- **Proportion:** code appears only as signatures/assertions; bodies are the implementer's.

## Gate B — decisions for Todd (default in brackets; reply only to override)

1. **Wave/PR split** — A as two PRs (A-1 fast-track, A-2), others one each. [Yes]
2. **Bulk cap** `BULK_SITE_MOVE_CAP`. [100 per request, matching the 50-per-batch bulk-restore precedent doubled; lower to 50 if per-device lock time is high in the integration run]
3. **Duplicate ids in one batch.** [Reject whole batch (400) rather than dedupe]
4. **MCP classification of `bulkSite.ts`.** [`human_only_bulk_destructive` (matches `bulkLifecycle.ts`); revisit if AI-driven site moves are wanted]
5. **Legacy `/alerts?severity=` URL.** [Read once → convert to hash → strip, instead of dropping support]
6. **"N at risk" Security link.** [Exempt unless A8's equality test proves a matching list]
7. **Partial bulk-move HTTP status.** [200 with per-device outcomes (a 207 adds nothing for the UI); whole-batch validation failures are 400]
8. **Wave F (score factors).** [Include as optional last wave, independent; skip it without affecting A–E]
9. **Sites icon / label.** [`MapPin`, "Sites"]
10. **Release-note line for the patch % change** — where it lands. [Next unreleased entry via `update-breeze-release-notes`, in Wave C's PR]

## Execution handoff

Recommend **subagent-driven** for Wave D (high rigor, interface-coupled tasks D1→D2→D3) and **native** execution for A–C, E, F (mechanical, web-only). Register the feature (`register_feature`) after Gate B, then one wave per branch `feature/6721-dashboard-clickthrough/wave-<subissue#>`.

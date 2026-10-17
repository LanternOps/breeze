---
tracking_issue: LanternOps/breeze#8985
wave: W02
---

# UI Flow W02: org switcher Customer › Page columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the header org switcher, pick a customer and a destination in two clicks: rows lose the status badge and gain a status dot, a right-hand pane shows the highlighted org's badge, billing address, primary contact and six destinations with live counts, and a Recent group lists the last three switched-to orgs.

**Architecture:** `OrgSwitcher.tsx` keeps the trigger, panel shell, left column, highlight state and keyboard wiring; a new pure `OrgSwitcherPane.tsx` renders the right pane from props; `useOrgSummaryCache.ts` owns the lazy, intent-delayed summary fetch and its per-open cache; `orgSwitcherDestinations.ts` derives destination visibility from the org record's `visibleTabs` gating. `applyContext` in `OrgSwitcher.tsx` stays the single caller of `applyOrgSwitch`, now with an optional destination; `orgStore` gains persisted `recentOrgIds`.

**Tech Stack:** React islands (Astro), zustand `persist`, react-i18next, lucide-react, Tailwind; Vitest + React Testing Library (`renderHook`, fake timers).

**Spec:** `docs/superpowers/specs/web-ui/2026-10-16-ui-flow-improvements-design.md` — section "Wave B: org switcher, Customer › Page columns" (also "Constraints", "Anti-goals", decisions 4 and 8).

## Global Constraints

- Branch `feature/8985-ui-flow/wave-<sub#>` off `main` **after W01 merges** (this wave imports `formatAddress` from W01); PR body carries `Closes #<sub-issue>`.
- Every new `en` locale key is added to all 7 other locales under `apps/web/src/locales/<lang>/` (`localeParity`). **Translate them** — `translationCoverage.test.ts` caps exact-English duplicates per namespace (`common.json` pt-BR cap 103), so English placeholders can fail CI.
- Interactive elements get `data-testid`; Playwright selects by testid only.
- Files under ~500 lines: the pane, the hook and the destinations table are their own files; `OrgSwitcher.tsx` (330 lines today) keeps only shell, left column and keyboard.
- No mutations: `runAction` is not involved; the one read goes through the org-pinned `makeOrgFetch` (`orgRecordFetch.ts:78-83`). No new API routes.
- Transient UI state in `window.location.hash` (`#sites`, `#billing` on the org record), never query params.
- Navigation never silently changes the working org; only the switcher does — and here **every** pane destination is an explicit switch (Todd, 2026-10-16).
- Keep every existing case in `OrgSwitcher.test.tsx` and `OrgSwitcher.statusBadge.test.tsx` green: list rows stay `<button>`s with nothing interactive nested, rows precede the pane in DOM order, the roving-focus query excludes the pane.
- Dynamic `t()` keys carry the `/* i18n-dynamic */` marker (`keyUsage.test.ts`); no new `en` value may equal the humanized form of a two-or-more-word key leaf (`humanizedKeyRegression.test.ts`).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A summary response for a previously highlighted org lands after the highlight moved on — the pane must show the current org's counts, never the stale org's. → Task 3, test `a late response for a previous org never surfaces under the current one`.
2. The highlighted org disappears from the visible list (search text excludes it) — the pane must follow the first visible row, not go blank or keep a hidden org. → Task 5, test `a search that hides the highlighted org moves the highlight to the first match`.
3. A primary contact whose `name` is `''` (the API sends `name ?? ''`, `routes/orgSummary.ts:256`) — the `tel:` link still renders with no empty name span. → Task 4, test `a contact with an empty name still renders the tel link`.
4. A tampered or legacy persisted `recentOrgIds` (non-array, non-string entries, more than three) — rehydrates to a clean array; the header must never crash on it. → Task 1, test `rehydrate merge sanitises a tampered recentOrgIds`.
5. A Sites/Billing destination for the org the user is already in, picked from that org's own record page — the target differs only by hash; it must navigate with the hash and never toast or re-select. → Task 5, test `a destination for the current org is a plain navigation (no switch, no toast)`; the router-side tab change is checked in the browser in Task 7.

## Verified facts (re-checked on `origin/main` 9a16b94e02, 2026-10-16)

| Fact | Where |
|---|---|
| Local `StatusBadge` (moves out), rows render it at the row's right edge | `components/layout/OrgSwitcher.tsx:23-35`, `:320`; trigger badge `:227` |
| `SEARCH_THRESHOLD = 6`; panel `w-80`; roving focus `panelRef.querySelectorAll('button')` | `OrgSwitcher.tsx:39`, `:243`, `:117-134` |
| `applyContext(orgId)` closes, computes `changed`, toasts, calls `applyOrgSwitch(orgId, message)` | `OrgSwitcher.tsx:173-188` |
| Open effect resets query and focuses search | `OrgSwitcher.tsx:142-147` |
| `applyOrgSwitch(orgId, toastMessage, destination?)`; `destination` bypasses the redirect table and navigates with `replace: false` | `lib/orgSwitch.ts:87-106` (`:97-100`) |
| `Organization` type has no address fields; `ServiceManagementMode`; persist `partialize`/`merge`; `clearOrgContext`; `setPartner` | `stores/orgStore.ts:17-37`, `:56`, `:404-410`, `:416-426`, `:370-391`, `:157-173` |
| API org row carries `billingAddressLine1/Line2/City/Region/PostalCode/Country` | `apps/api/src/db/schema/orgs.ts:226-231` |
| `OrgSummary` (`devices?`, `alerts?`, `tickets?`, `sites`, `contacts?.primary {name,email,phone}`); `makeOrgFetch` (the brief's `orgFetch`) | `components/organizations/record/orgRecordFetch.ts:50-71`, `:78-83` |
| Summary route `requireScope('partner','system')`; record reads it as `res.ok ? await res.json() : null` | `apps/api/src/routes/orgSummary.ts:102-103`; `OrganizationRecordPage.tsx:152-160` |
| `ORG_RECORD_TABS` has no `alerts` tab; `TAB_PERMISSION`; `MODE_HIDDEN_TABS`; `visibleTabs(permissions, mode)` | `components/organizations/record/orgRecordTabs.ts:13-24`, `:51-80`, `:89-97`, `:122-133` |
| `hasPermission(permissions, resource, action)`; `usePermissions()` reads `useAuthStore((s) => s.user?.permissions)` | `lib/permissions.ts:13-24`, `:34-44` |
| `alerts:read` is a real grant | `packages/shared/src/constants/permissions.ts:56` |
| `useJwtClaims(): { status:'unresolved' } \| { status:'resolved'; claims }`, `claims.scope: 'system'\|'partner'\|'organization'\|null` | `lib/authScope.ts:39-41`, `:7-8`, `:92-98` |
| Status labels for all eight statuses live in the `settings` namespace (`statusLabelKeys`) | `lib/orgStatus.ts:14-23`; `locales/en/settings.json` `organizationsPage.status` |
| `layout.org.*` keys (`status` has only active/trial/suspended/inactive) | `locales/en/common.json:670-693` |
| Tests running the **real** `applyOrgSwitch` against a mocked store (must learn `recordRecentOrg`) | `lib/orgSwitch.test.ts:5-16`, `OrgSwitcher.test.tsx:42-55`, `OrgSwitcher.statusBadge.test.tsx:13-25` — every other `applyOrgSwitch` test mocks `@/lib/orgSwitch` |
| `OrgSwitcher` tests mock `@/stores/auth` with only `waitForPendingRefresh` | `OrgSwitcher.test.tsx:26-28`, `OrgSwitcher.statusBadge.test.tsx:10` |
| Test helper takes the first `button` whose `textContent` includes the org name | `OrgSwitcher.test.tsx:145-154` |
| No `matchMedia` stub in test setup; Sidebar reads `window.matchMedia('(max-width: 767px)')` inline | `src/__tests__/setup.ts`; `Sidebar.tsx:772-773` |
| Rehydrate test pattern (`localStorage.setItem('breeze-org', …)` + `useOrgStore.persist.rehydrate()`) | `stores/orgStore.test.ts:340-351` |
| `formatAddress(parts: AddressParts \| null \| undefined): string` | W01 interface, `apps/web/src/lib/formatAddress.ts` (brief) |

## Decisions made in this plan

- **The pane emits, `applyContext` switches.** `OrgSwitcherPane` calls `onDestination(orgId, target)`; `OrgSwitcher.applyContext(orgId, destination?)` stays the one caller of `applyOrgSwitch` so the close, spinner and toast ritual is not duplicated. The spec's "Billing calls `applyOrgSwitch` with `/organizations/:id#billing` and the store ends up on that org" is therefore asserted in `OrgSwitcher.test.tsx` (real `applyOrgSwitch`, mocked store), and the pane test asserts the emitted target.
- **"Matches the current org" is the plain-navigation rule.** Same org → `navigateTo(target)`, no toast, no store call (a toast "Switched to X" when nothing switched would lie). Different org → `applyOrgSwitch(org.id, toast, target)`.
- **Alerts has no record tab**, so it is gated on `alerts:read` alone; the other five reuse `visibleTabs` verbatim.
- **Narrow = JS, not CSS.** The pane is not rendered below 768px (`useMediaQuery('(min-width: 768px)')`), so `→`/Tab cannot land on an invisible button and the hint disappears with the pane. Width stays CSS (`w-80 md:w-[36rem]`).
- **Status dot colours follow the spec** (amber trial, red suspended, muted rest) even though `statusColors.trial` is neutral; dot labels reuse `statusLabelKeys` (no new status keys).
- `en` keys land in the task whose tests need them (Tasks 4 and 5); Task 6 mirrors them into the seven other catalogs.

---

### Task 1: `orgStore` recents + `applyOrgSwitch` records them

**Files:**
- Modify: `apps/web/src/stores/orgStore.ts:61-139` (state), `:157-173`, `:370-391`, `:404-410`, `:416-426`
- Modify: `apps/web/src/lib/orgSwitch.ts:92-94`
- Test: `apps/web/src/stores/orgStore.test.ts` (beforeEach `:29-42`), `apps/web/src/lib/orgSwitch.test.ts` (mocks `:5-16`, fixture `:85-100`)
- Mocks to extend: `apps/web/src/components/layout/OrgSwitcher.test.tsx:42-55,101-107`, `apps/web/src/components/layout/OrgSwitcher.statusBadge.test.tsx:13-34`

**Interfaces:**
- Produces: `export const MAX_RECENT_ORGS = 3`; `OrgState.recentOrgIds: string[]` (newest first); `OrgState.recordRecentOrg: (orgId: string) => void`.

- [ ] **Step 1: Write the failing store tests** in `orgStore.test.ts` (add `recentOrgIds: []` to the beforeEach `setState`):
  - `recordRecentOrg keeps newest first, de-duplicates and caps at MAX_RECENT_ORGS`: record `a, b, c, d` → `['d','c','b']`; then `c` → `['c','d','b']`.
  - `recentOrgIds persist under breeze-org`: after recording `a`, `JSON.parse(localStorage.getItem('breeze-org')!).state.recentOrgIds` → `['a']`.
  - `rehydrate merge sanitises a tampered recentOrgIds` (pattern `:340-351`): persisted `'nope'` → `[]`; persisted `['a', 7, 'b', 'c', 'd']` → `['a','b','c']`.
  - `clearOrgContext and setPartner reset recentOrgIds`: both leave `[]` (for `setPartner`, `fetchWithAuth` mock resolves `{ data: [] }`).
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/stores/orgStore.test.ts` — expected: the four new cases FAIL (`recordRecentOrg is not a function`).
- [ ] **Step 3: Implement** in `orgStore.ts`: the two fields on `OrgState` (doc comment: last switched-to orgs, written only by `applyOrgSwitch`), initial `recentOrgIds: []`, `recordRecentOrg` = `[orgId, ...recentOrgIds.filter((id) => id !== orgId)].slice(0, MAX_RECENT_ORGS)`, add to `partialize`, reset to `[]` in `clearOrgContext` and `setPartner`, and in `merge` coerce to `Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, MAX_RECENT_ORGS) : []`.
- [ ] **Step 4: Run** the same command — expected: PASS.
- [ ] **Step 5: Write the failing switch tests** in `orgSwitch.test.ts`: add `recordRecentOrgMock` to the hoisted mocks and to the `getState()` object (`:14-16`); cases `applyOrgSwitch records a real org as recent` (`recordRecentOrgMock` called with `'org-b'`, and its `mock.invocationCallOrder[0]` is greater than `selectOrganizationMock`'s) and `fleet view is never recorded` (`applyOrgSwitch(null, 'x')` → not called).
- [ ] **Step 6: Run** `cd apps/web && npx vitest run src/lib/orgSwitch.test.ts` — expected: the two new cases FAIL.
- [ ] **Step 7: Implement** in `orgSwitch.ts:93`: `if (orgId) { store.selectOrganization(orgId); store.recordRecentOrg(orgId); } else store.selectAllOrgs();`.
- [ ] **Step 8: Extend the switcher mocks**: `OrgSwitcher.test.tsx` — hoist `recordRecentOrgMock: vi.fn()`, add `recordRecentOrg: recordRecentOrgMock` to `buildStoreSnapshot` (`:43-48`), add `recentOrgIds: string[]` to the `mockStoreState` type and `recentOrgIds: []` to the beforeEach state; `OrgSwitcher.statusBadge.test.tsx` — add `recordRecentOrg: vi.fn()` to `snapshot()` and `recentOrgIds: []` to `seed()`.
- [ ] **Step 9: Run** `cd apps/web && npx vitest run src/lib/orgSwitch.test.ts src/stores/orgStore.test.ts src/components/layout/OrgSwitcher.test.tsx src/components/layout/OrgSwitcher.statusBadge.test.tsx` — expected: 4 files, all PASS.
- [ ] **Step 10: Commit** `feat(web/orgStore): persist the last three switched-to orgs (recentOrgIds)` + Co-Authored-By line.

### Task 2: `Organization` address fields + status glyphs (dot on rows)

**Files:**
- Modify: `apps/web/src/stores/orgStore.ts:17-37`
- Create: `apps/web/src/components/layout/OrgStatusGlyphs.tsx`
- Modify: `apps/web/src/components/layout/OrgSwitcher.tsx:23-35` (delete), `:13`, `:227`, `:315-320`
- Test: `apps/web/src/components/layout/OrgStatusGlyphs.test.tsx`, `OrgSwitcher.test.tsx` (one new case)

**Interfaces:**
- Produces: `Organization.billingAddressLine1?/billingAddressLine2?/billingAddressCity?/billingAddressRegion?/billingAddressPostalCode?/billingAddressCountry?: string | null` (doc: present on the partner/system-scope list only, like `currencyCode`); `export function OrgStatusBadge({ status }: { status: string })` (body = today's `StatusBadge`, `OrgSwitcher.tsx:23-35`); `export function OrgStatusDot({ status }: { status: string })` — renders `null` for `'active'`, else `<span role="img" data-testid="org-status-dot" data-status={status} title={label} aria-label={label} className="inline-block h-[7px] w-[7px] shrink-0 rounded-full …">`; `export const STATUS_DOT_CLASS = { trial: 'bg-warning', suspended: 'bg-destructive' } as const` with `'bg-muted-foreground'` for every other status. `label` = `t(statusLabelKeys[status])` via `useTranslation('settings')`, or the raw `status` when the map has no entry.

- [ ] **Step 1: Write the failing tests** `OrgStatusGlyphs.test.tsx` (import `'../../lib/i18n'`): `the dot is absent for active`; `trial is amber, suspended red, churned muted, each titled with the status label` (`bg-warning`/`bg-destructive`/`bg-muted-foreground`, titles `Trial`/`Suspended`/`Churned`); `an unknown status gets the muted dot and its raw value as label` (`'inactive'`); `the badge keeps the shared status colours` (`statusColors.trial` classes, `FALLBACK_STATUS_CLASS` for `'inactive'`).
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/layout/OrgStatusGlyphs.test.tsx` — expected: FAIL (module not found).
- [ ] **Step 3: Implement** `OrgStatusGlyphs.tsx` and the six optional fields on `Organization`.
- [ ] **Step 4: Run** — expected: PASS.
- [ ] **Step 5: Write the failing switcher test** in `OrgSwitcher.test.tsx`: `rows carry a status dot, not the badge` — org-b status `'trial'`; `within(getByTestId('org-option-org-b')).getByTestId('org-status-dot')` has `data-status="trial"`; `within(row).queryByText('Trial')` is null; the org-a (active) row has no dot.
- [ ] **Step 6: Run** `cd apps/web && npx vitest run src/components/layout/OrgSwitcher.test.tsx` — expected: that case FAILS.
- [ ] **Step 7: Implement** in `OrgSwitcher.tsx`: delete the local `StatusBadge` and the now-unused `lib/orgStatus` import (`:13`), import `{ OrgStatusBadge, OrgStatusDot }`, trigger uses `OrgStatusBadge` (`:227`), row renders `Building2`, `<OrgStatusDot status={org.status} />`, name, check (`:315-320`; the right-edge badge is gone).
- [ ] **Step 8: Run** `cd apps/web && npx vitest run src/components/layout/OrgSwitcher.test.tsx src/components/layout/OrgSwitcher.statusBadge.test.tsx src/components/layout/OrgStatusGlyphs.test.tsx` — expected: 3 files PASS (the trigger badge test is untouched).
- [ ] **Step 9: Commit** `feat(web/org-switcher): status dot on rows, badge and address fields ready for the pane` + Co-Authored-By line.

### Task 3: `useOrgSummaryCache` — lazy, intent-delayed, per-open cache

**Files:**
- Create: `apps/web/src/components/layout/useOrgSummaryCache.ts`
- Test: `apps/web/src/components/layout/useOrgSummaryCache.test.ts`

**Interfaces:**
- Consumes: `makeOrgFetch(orgId)` and `OrgSummary` (`orgRecordFetch.ts:78-83`, `:50-71`); `useJwtClaims()` (`lib/authScope.ts:92-98`).
- Produces: `export const SUMMARY_INTENT_DELAY_MS = 120`; `export type OrgSummaryStatus = 'idle' | 'loading' | 'ready' | 'error'`; `export interface OrgSummaryLookup { summary: OrgSummary | undefined; status: OrgSummaryStatus }`; `export function useOrgSummaryCache(orgId: string | null, active: boolean): OrgSummaryLookup`.

Algorithm (not determined by the signature): a `useRef<Map<string, OrgSummary | 'error'>>` cache and a `forbiddenRef` boolean. Allowed = `active && claims.status === 'resolved' && claims.claims.scope !== 'organization' && !forbiddenRef.current`. On every `orgId`/allowed change: clear any pending timer; if not allowed or `orgId` null → `idle`; cache hit → `ready`/`error` synchronously; else `loading` and a `setTimeout(SUMMARY_INTENT_DELAY_MS)` that calls `makeOrgFetch(orgId)(\`/orgs/organizations/${orgId}/summary\`)`, stores `await res.json()` on `ok`, stores `'error'` otherwise (and sets `forbiddenRef` on `403`), then bumps a `useState` counter so the hook re-reads the cache for the **current** `orgId` (a response for another org only fills the cache). `active` false → `cache.clear()` (the `forbiddenRef` survives: it is a session fact). Errors never toast.

- [ ] **Step 1: Write the failing tests** (`vi.useFakeTimers()`, `renderHook` from `@testing-library/react`; mock `@/lib/authScope` → `useJwtClaims: () => claimsRef.current` defaulting to `{ status:'resolved', claims:{ scope:'partner', orgId:null, partnerId:'p1' } }`; mock `@/components/organizations/record/orgRecordFetch` → `makeOrgFetch: vi.fn(() => fetchMock)` where `fetchMock` resolves `{ ok:true, status:200, json: async () => SUMMARY }`):
  - `fetches once per org after the intent delay and serves repeats from the cache`: `('org-a', true)` → after 100 ms `fetchMock` not called and `status === 'loading'`; after 20 ms more called once with `'/orgs/organizations/org-a/summary'`; after flushing, `status === 'ready'` and `summary === SUMMARY`; rerender `'org-b'` then `'org-a'` → two calls total, `'org-a'` is `ready` with no timer.
  - `a pass-through highlight shorter than the delay never fetches`: `'org-a'` → rerender `'org-b'` at 50 ms → advance 200 ms → one call, for `org-b`.
  - `a late response for a previous org never surfaces under the current one`: org-a's fetch is a deferred promise; rerender to `'org-b'` (its fetch resolves); resolve org-a afterwards → `summary.orgId === 'org-b'`.
  - `a 403 marks the session forbidden: no later org fetches, even after close and reopen`: first response `{ ok:false, status:403 }` → `status === 'error'`; rerender `'org-b'`, then `active` false → true → advance 500 ms → still one call.
  - `closing the panel clears the cache; reopening refetches`: ready for org-a → `active` false → true, advance 120 ms → two calls.
  - `an org-scoped session never fetches`: `claimsRef` scope `'organization'` → advance 500 ms → no call, `status === 'idle'`.
  - `a 500 reports error without throwing`: `{ ok:false, status:500 }` → `status === 'error'`, `summary === undefined`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/layout/useOrgSummaryCache.test.ts` — expected: FAIL (module not found).
- [ ] **Step 3: Implement** `useOrgSummaryCache.ts` per the algorithm above.
- [ ] **Step 4: Run** — expected: 7 PASS.
- [ ] **Step 5: Commit** `feat(web/org-switcher): lazy org summary cache with hover-intent delay` + Co-Authored-By line.

### Task 4: destinations table + `OrgSwitcherPane`

**Files:**
- Create: `apps/web/src/components/layout/orgSwitcherDestinations.ts`, `apps/web/src/components/layout/OrgSwitcherPane.tsx`
- Modify: `apps/web/src/locales/en/common.json:670-693` (`layout.org` block gains `pane`)
- Test: `apps/web/src/components/layout/orgSwitcherDestinations.test.ts`, `apps/web/src/components/layout/OrgSwitcherPane.test.tsx`

**Interfaces:**
- Consumes: `formatAddress` (W01); `visibleTabs`, `OrgRecordTab` (`orgRecordTabs.ts:122-133`, `:26`); `hasPermission` (`lib/permissions.ts:13-24`); `Permission` (`stores/auth.ts:48-51`); `ServiceManagementMode` (`orgStore.ts:56`); `OrgStatusBadge` (Task 2); `OrgSummary`; `OrgSummaryStatus` (Task 3).
- Produces (`orgSwitcherDestinations.ts`): `export const ORG_SWITCHER_DESTINATIONS = ['overview','devices','tickets','alerts','sites','billing'] as const`; `export type OrgSwitcherDestination = (typeof ORG_SWITCHER_DESTINATIONS)[number]`; `export function destinationTarget(dest: OrgSwitcherDestination, orgId: string): string` (spec table: overview `/organizations/:id`, devices `/devices`, tickets `/tickets`, alerts `/alerts`, sites `/organizations/:id#sites`, billing `/organizations/:id#billing`); `export function visibleDestinations(permissions: Permission[] | undefined, mode: ServiceManagementMode): OrgSwitcherDestination[]` — `alerts` iff `hasPermission(permissions, 'alerts', 'read')`, every other destination iff `visibleTabs(permissions, mode)` contains the same-named tab; declaration order.
- Produces (`OrgSwitcherPane.tsx`): `export interface OrgSwitcherPaneProps { org: Organization; summary: OrgSummary | undefined; summaryStatus: OrgSummaryStatus; destinations: OrgSwitcherDestination[]; onDestination: (orgId: string, target: string) => void }`; `export default function OrgSwitcherPane(props: OrgSwitcherPaneProps)`.
- Markup decisions: root `data-testid="org-switcher-pane"`; header = name, `<OrgStatusBadge status={org.status} />`, address `data-testid="org-switcher-pane-address"` only when `formatAddress({ line1: org.billingAddressLine1, line2: org.billingAddressLine2, city: org.billingAddressCity, region: org.billingAddressRegion, postalCode: org.billingAddressPostalCode, country: org.billingAddressCountry }) !== ''`, contact `data-testid="org-switcher-pane-contact"` only when `summary?.contacts?.primary` exists (name span only when non-empty; `<a href={`tel:${phone}`}>` only when `phone`); each destination is `<button type="button" data-testid={`org-switcher-dest-${dest}`} aria-label={[label, org.name, countText].filter(Boolean).join(', ')}>` with icon (`LayoutDashboard`, `Monitor`, `Ticket`, `Bell`, `MapPin`, `CreditCard`), label `t(/* i18n-dynamic */ \`layout.org.pane.destinations.${dest}\`)`, and a count span `data-testid={`org-switcher-count-${dest}`}`; hint `<p data-testid="org-switcher-hint">{t('layout.org.pane.hint')}</p>` at the bottom.
- Count text (`summaryStatus === 'ready'` and the section present): devices `${total} · ${t('layout.org.pane.offlineCount', { count: offline })}` with `text-warning-strong` on the offline part when `offline > 0`; tickets `t('layout.org.pane.openCount', { count: open })`; alerts `critical > 0 ? t('layout.org.pane.criticalCount', { count: critical })` in `text-destructive` : `t('layout.org.pane.noCritical')`; sites `${count}`; overview/billing never. `loading` → `<span data-testid="org-switcher-count-skeleton" aria-hidden="true" className="h-3 w-10 animate-pulse rounded bg-muted" />` on devices/tickets/alerts/sites; `idle`/`error` or an absent section → no count element.
- `en` keys (`layout.org.pane`): `destinations.{overview:"Overview",devices:"Devices",tickets:"Tickets",alerts:"Alerts",sites:"Sites",billing:"Billing"}`, `offlineCount:"{{count}} offline"`, `openCount:"{{count}} open"`, `criticalCount:"{{count}} critical"`, `noCritical:"none"`, `hint:"Click a name to switch · click a page to switch and go there"`.

- [ ] **Step 1: Write the failing destination tests** (`orgSwitcherDestinations.test.ts`, no mocks): targets for all six with `orgId 'org-1'`; wildcard grant + `'native'` → all six in order; wildcard + `'off'` → no `tickets`, no `billing`; wildcard + `'external'` → `tickets` kept, `billing` hidden; `[{resource:'organizations',action:'read'}]` → `['overview','sites']`; `undefined` permissions → `['overview','sites']`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/layout/orgSwitcherDestinations.test.ts` — expected: FAIL (module not found).
- [ ] **Step 3: Implement** `orgSwitcherDestinations.ts`.
- [ ] **Step 4: Run** — expected: PASS.
- [ ] **Step 5: Add the `en` keys** listed above to `locales/en/common.json` inside `layout.org` (after `legacyFilterNotice`, `:692`).
- [ ] **Step 6: Write the failing pane tests** (`OrgSwitcherPane.test.tsx`, import `'../../lib/i18n'`; fixtures: `ORG = { id:'org-b', partnerId:'p1', name:'Acme Dental', status:'trial', createdAt:'2024-01-01', billingAddressLine1:'1 Main St', billingAddressCity:'Springfield', billingAddressRegion:'IL', billingAddressPostalCode:'62701', billingAddressCountry:'US' }`, `SUMMARY = { orgId:'org-b', devices:{total:42,online:39,offline:3}, alerts:{open:4,critical:1,high:2}, tickets:{open:2,awaitingCustomer:0}, sites:{count:3}, contacts:{count:1, primary:{id:'c1',name:'Dana Reyes',email:null,phone:'+1 555 0100'}} }`, all six destinations):
  - `header shows name, the shared status badge, the formatted address and a tel link`: text `Acme Dental`; `getByText('Trial')` carries every `statusColors.trial` class; address text is `formatAddress(...)` of the fixture (`'1 Main St · Springfield, IL 62701 · US'`); `getByRole('link')` href `tel:+1 555 0100`.
  - `renders the counts the spec fixes`: `org-switcher-count-devices` text `42 · 3 offline` (offline part has `text-warning-strong`); tickets `2 open`; alerts `1 critical` with `text-destructive`; sites `3`; no `org-switcher-count-overview` / `-billing`.
  - `zero offline and zero critical lose their tones`: offline 0 → `42 · 0 offline` without `text-warning-strong`; critical 0 → `none`.
  - `loading shows skeletons and never a number`: status `'loading'`, summary `undefined` → 4 `org-switcher-count-skeleton`, no count testids.
  - `error and idle render destinations without counts or skeletons`.
  - `only the given destinations render, in order`: `['overview','sites']` → two buttons, overview first.
  - `a destination click hands the org id and target to onDestination`: billing → `('org-b', '/organizations/org-b#billing')`; devices → `('org-b', '/devices')`.
  - `accessible names read "Devices, Acme Dental, 42 · 3 offline"`: `getByRole('button', { name: 'Devices, Acme Dental, 42 · 3 offline' })`; `getByRole('button', { name: 'Billing, Acme Dental' })`.
  - `summary sections the caller cannot read leave their count off`: summary without `devices`/`tickets`/`alerts` → those counts absent, sites `3` present.
  - `a contact with an empty name still renders the tel link`: `primary.name === ''` → link present, no empty name span (contact text equals the phone).
  - `no address and no contact render neither line`: org without address fields, summary without `contacts` → both testids absent; name still shown.
- [ ] **Step 7: Run** `cd apps/web && npx vitest run src/components/layout/OrgSwitcherPane.test.tsx` — expected: FAIL (module not found).
- [ ] **Step 8: Implement** `OrgSwitcherPane.tsx` per the markup decisions.
- [ ] **Step 9: Run** `cd apps/web && npx vitest run src/components/layout/OrgSwitcherPane.test.tsx src/components/layout/orgSwitcherDestinations.test.ts` — expected: 2 files PASS.
- [ ] **Step 10: Commit** `feat(web/org-switcher): destination pane with counts, address and contact` + Co-Authored-By line.

### Task 5: `OrgSwitcher` two columns, Recent group, highlight, keyboard

**Files:**
- Create: `apps/web/src/hooks/useMediaQuery.ts`, `apps/web/src/hooks/useMediaQuery.test.tsx`
- Modify: `apps/web/src/components/layout/OrgSwitcher.tsx` — imports `:1-15`, state `:52-62`, store destructure `:64-70`, keyboard `:103-138`, open effect `:142-147`, list derivation `:159-166`, `applyContext` `:173-188`, panel `:239-327`
- Modify: `apps/web/src/locales/en/common.json` (`layout.org.recent`)
- Test: `apps/web/src/components/layout/OrgSwitcher.test.tsx` (mocks `:26-32`, `:42-55`; beforeEach `:101-107`), `apps/web/src/components/layout/OrgSwitcher.statusBadge.test.tsx:10-25`

**Interfaces:**
- Consumes: `recentOrgIds` (Task 1); `OrgStatusDot` (Task 2); `useOrgSummaryCache(orgId, active)` (Task 3); `OrgSwitcherPane`, `visibleDestinations` (Task 4); `usePermissions()` (`lib/permissions.ts:34-44`); `navigateTo` (`lib/navigation.ts:49`).
- Produces: `export function useMediaQuery(query: string): boolean` — `false` when `window.matchMedia` is not a function, else `matches`, subscribed to `change`.
- `OrgSwitcher.tsx` decisions:
  - `const isWide = useMediaQuery('(min-width: 768px)')`; `const [highlightedOrgId, setHighlightedOrgId] = useState<string | null>(null)`; `paneRef = useRef<HTMLDivElement>(null)`.
  - Store destructure adds `recentOrgIds`, `serviceManagementMode`; `const { permissions } = usePermissions()`; `destinations = useMemo(() => visibleDestinations(permissions, serviceManagementMode), …)`.
  - Open effect (`:142-147`) also sets the highlight to `currentOrgId ?? visibleOrgs[0]?.id ?? null`; a second effect re-targets `visibleOrgs[0]?.id ?? null` whenever `highlightedOrgId` is not in `visibleOrgs`.
  - `const lookup = useOrgSummaryCache(isOpen && isWide ? highlightedOrgId : null, isOpen)`. Arrow-key travel changes the highlight through the same `onFocus` path as hover, so the hook's 120 ms intent delay covers holding `↓` as well (spec "Data"; pinned by Task 3's pass-through test).
  - Rows (one internal `OrgRow` renderer used by both groups): `data-org-id={org.id}`, `data-highlighted={highlighted ? 'true' : undefined}`, `tabIndex={highlighted ? 0 : -1}`, `onMouseEnter` and `onFocus` → `setHighlightedOrgId(org.id)`, `ChevronRight` at the right edge when highlighted and `isWide`. Fleet row hover/focus leaves the highlight alone. Recent rows use `data-testid={`org-recent-${org.id}`}`; org rows keep `org-option-${org.id}`.
  - Recent group: `recentOrgs = recentOrgIds.filter((id) => id !== currentOrgId).map((id) => organizations.find((o) => o.id === id)).filter(Boolean)`; rendered as heading `t('layout.org.recent')` + rows inside `data-testid="org-switcher-recent"` only when `recentOrgs.length > 0 && !normalizedQuery`; placed between the search and the "Organizations" heading.
  - Panel: `w-80 md:w-[36rem]`; fleet row + separator unchanged above; then `<div className={cn(isWide && 'grid grid-cols-[250px_1fr] gap-2')}>` → left column (search, Recent, Organizations list) then, when `isWide && highlightedOrg`, `<div ref={paneRef} className="min-w-0 border-l pl-2"><OrgSwitcherPane org summary={lookup.summary} summaryStatus={lookup.status} destinations onDestination={(id, target) => void applyContext(id, target)} /></div>`. List before pane in DOM order.
  - `applyContext(orgId: string | null, destination?: string)`: after `if (!changed)` → `{ if (destination) await navigateTo(destination); return; }`; otherwise `await applyOrgSwitch(orgId, message, destination)`.
  - Keyboard (replaces `:117-134`): `items` = `panelRef` buttons **not inside `paneRef`**; `paneItems` = buttons inside `paneRef`. `ArrowDown/Up`: active in `paneItems` → wrap within `paneItems`; else today's rule over `items`. `ArrowRight`: active in `items` and `paneItems.length > 0` → `preventDefault`, focus `paneItems[0]`. `ArrowLeft`: active in `paneItems` → focus the button with `data-org-id === highlightedOrgId` (fallback `items[0]`). `Enter` is the native click. Tab/Shift+Tab are native: the roving `tabIndex` makes the list one tab stop, so Tab leaves the list into the pane and Shift+Tab returns to the highlighted row. `Escape`, Cmd+O, click-outside unchanged.
- `en` key: `layout.org.recent: "Recent"`.

- [ ] **Step 1: Write the failing hook tests** (`useMediaQuery.test.tsx`, `renderHook`): `returns false when matchMedia is unavailable`; `reflects matches and follows change events` (stub `window.matchMedia` returning `{ matches:false, addEventListener, removeEventListener }`, capture the listener, call it with `{ matches:true }` in `act` → `true`; unmount removes it).
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/hooks/useMediaQuery.test.tsx` — expected: FAIL.
- [ ] **Step 3: Implement** `useMediaQuery.ts`. **Run** — expected: PASS.
- [ ] **Step 4: Prepare the switcher test harness** (`OrgSwitcher.test.tsx`): add `vi.mock('@/lib/permissions', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/permissions')>()), usePermissions: () => ({ permissions: [{ resource: '*', action: '*' }], can: () => true }) }))`; hoist `summaryLookupMock` and `vi.mock('./useOrgSummaryCache', () => ({ useOrgSummaryCache: summaryLookupMock }))`, reset in beforeEach to return `{ summary: undefined, status: 'idle' }`; add `serviceManagementMode: 'native'` to the state; add `stubMatchMedia(matches: boolean)` (assigns `window.matchMedia = vi.fn().mockReturnValue({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })`), called with `true` in beforeEach and restored in afterEach; import `showToast` from `'@/components/shared/Toast'` (the module mock). Add the same two `vi.mock`s to `OrgSwitcher.statusBadge.test.tsx`.
- [ ] **Step 5: Write the failing switcher tests** (`OrgSwitcher.test.tsx`; add `'layout.org.recent'` to `en` first so text assertions can pass):
  - `opens with the current org highlighted and the pane showing it`: `org-option-org-a` has `data-highlighted="true"`; `org-switcher-pane` contains `Org A`; `org-switcher-hint` present; `summaryLookupMock` last called with `('org-a', true)`.
  - `hovering a row moves the highlight and the pane follows`: `mouseEnter` org-b → pane shows `Org B`; `summaryLookupMock` last called with `('org-b', true)`.
  - `Billing destination switches to the highlighted org and lands on its billing tab (no redirect bounce)`: `stubLocation('/devices/abc123')`, hover org-b, click `org-switcher-dest-billing` → `selectOrganizationMock` with `'org-b'`, `recordRecentOrgMock` with `'org-b'`, `navigateToMock` with `('/organizations/org-b#billing', { replace: false })`; the panel closes.
  - `Devices destination calls applyOrgSwitch with '/devices'`: → `selectOrganizationMock('org-b')`, `navigateToMock('/devices', { replace: false })`.
  - `a destination for the current org is a plain navigation (no switch, no toast)`: highlight org-a, click `org-switcher-dest-sites` → `selectOrganizationMock` not called, `recordRecentOrgMock` not called, `showToast` not called, `navigateToMock` called with `'/organizations/org-a#sites'` (first argument).
  - `keyboard: ArrowDown moves the highlight, ArrowRight enters the pane, ArrowLeft returns, activation navigates`: focus `org-option-org-a`; `keyDown(document, ArrowDown)` → `document.activeElement` is `org-option-org-b` and the pane shows `Org B`; `ArrowRight` → active is `org-switcher-dest-overview`; `ArrowDown` → `org-switcher-dest-devices`; `ArrowLeft` → `org-option-org-b`; `ArrowRight` then `fireEvent.click(document.activeElement!)` (Enter's native effect) → `navigateToMock('/organizations/org-b', { replace: false })`.
  - `the list is one tab stop: only the highlighted row has tabIndex 0`: org-a row `tabIndex === 0`, org-b `-1`; after hovering org-b the values swap.
  - `Recent lists the last switched-to orgs newest first, without the current org`: `makeOrgs(5)`, `recentOrgIds: ['org-a','org-c','org-b']` → `within(getByTestId('org-switcher-recent')).getAllByRole('button')` texts `['Org C','Org B']`; `queryByTestId('org-recent-org-a')` null.
  - `Recent skips ids no longer in the list and hides while searching or empty`: `recentOrgIds: ['org-zzz','org-b']` → only `org-recent-org-b`; with 8 orgs type `Org H` → `org-switcher-recent` absent; `recentOrgIds: []` → absent.
  - `a search that hides the highlighted org moves the highlight to the first match`: 8 orgs, current org-a; type `Org H` → `org-option-org-h` has `data-highlighted="true"` and the pane shows `Org H`.
  - `narrow viewport renders a single column: no pane, no hint, rows still switch`: `stubMatchMedia(false)` → `org-switcher-pane` and `org-switcher-hint` absent; `summaryLookupMock` last called with `(null, true)`; `openDropdownAndClickOrg('Org B')` still calls `selectOrganizationMock('org-b')`.
- [ ] **Step 6: Run** `cd apps/web && npx vitest run src/components/layout/OrgSwitcher.test.tsx` — expected: the new cases FAIL, the existing ones still PASS.
- [ ] **Step 7: Implement** the `OrgSwitcher.tsx` changes per the decisions above.
- [ ] **Step 8: Run** `cd apps/web && npx vitest run src/components/layout/OrgSwitcher.test.tsx src/components/layout/OrgSwitcher.statusBadge.test.tsx src/components/layout/OrgStatusGlyphs.test.tsx src/components/layout/OrgSwitcherPane.test.tsx src/hooks/useMediaQuery.test.tsx` — expected: 5 files PASS, every pre-existing case included.
- [ ] **Step 9: Check the line count** `wc -l apps/web/src/components/layout/OrgSwitcher.tsx` — if above ~500, move `OrgRow` into `OrgSwitcherRow.tsx` (same props, same testids) before committing.
- [ ] **Step 10: Commit** `feat(web/org-switcher): Customer › Page columns — pane, Recent group, highlight and keyboard model` + Co-Authored-By line.

### Task 6: the seven other locales + i18n suites

**Files:**
- Modify: `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json` — `layout.org.recent` and the `layout.org.pane` block from Tasks 4–5.

- [ ] **Step 1: Run** `cd apps/web && npx vitest run src/lib/i18n` — expected: `localeParity.test.ts` FAILS naming the missing keys in each of the 7 catalogs (this is the red).
- [ ] **Step 2: Add the keys** to each catalog, translated: reuse each catalog's own wording for `nav.tickets`, `nav.alerts`, `nav.billing`, `layout.search.sections.recent` and `layout.search.sections.devices` (e.g. pt-BR `nav.tickets` is "Chamados"); translate `Overview`, `Sites`, the three count strings, `none` and the hint in the same register.
- [ ] **Step 3: Run** `cd apps/web && npx vitest run src/lib/i18n src/locales` — expected: PASS; the reported file list includes `localeParity.test.ts`, `translationCoverage.test.ts`, `keyUsage.test.ts` and `humanizedKeyRegression.test.ts`. A `translationCoverage` failure means a value was left in English — translate it, never bump the baseline.
- [ ] **Step 4: Commit** `i18n(web): org switcher pane and Recent keys in all locales` + Co-Authored-By line.

### Task 7: typecheck, full suite, browser check, PR

- [ ] **Step 1: Typecheck** `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo exit=$?` — expected: `exit=0`.
- [ ] **Step 2: Full web suite** `cd apps/web && npx vitest run` — expected: all files PASS.
- [ ] **Step 3: Browser check** (`worktree-stack` skill, partner login, ≥6 orgs seeded): open the switcher with Cmd+O; hover a row and confirm counts appear after a beat and the second hover of the same row is instant; pick Billing on another org → that org's record on the Billing tab with the "Switched to" toast; from `/organizations/<current>` pick Sites → the Sites tab opens with **no** toast (Review Focus 5); narrow the window below 768px → one column; log in as an org-scoped user → no `/summary` request in the network tab.
- [ ] **Step 4: Open the PR** titled `feat(web): org switcher Customer › Page columns (UI flow W02)`; body: `Closes #<sub-issue>`, `Part of #8985`, the Decisions list above, the browser-check results, and the attribution line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Non-goals (this wave)

- Search grammar (`harbor tick`), a hover card on the trigger, two columns on narrow viewports, any API change, frequency-weighted recents (spec "Non-goals"). `EntityLink` conversions (W03) and the sidebar/dashboard Recent list (W04) are separate waves; this wave's `recentOrgIds` is switcher-only state.

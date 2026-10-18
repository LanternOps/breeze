---
tracking_issue: LanternOps/breeze#8985
wave: W04
---

# UI Flow W04: Recent mixed list in sidebar and dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One recency-ordered list of recently opened *things* (devices and
named records) replaces the sidebar's nested "recent devices" rows and gains a
"Pick up where you left off" card on the dashboard.

**Architecture:** `stores/recentsStore.ts` keeps recording exactly as today
(`recordDevice`; `recordPage` + `namePage`); a new pure selector
`selectRecentEntries()` beside the store filters, merges, de-dups and caps.
Both surfaces are presentational over it: the Sidebar renders a top-level
collapsible **Recent** group directly under Dashboard; the dashboard renders a
card in the same row as the audit "Recent activity" feed. No API, no migration,
no command-palette change.

**Tech Stack:** React islands (Astro), zustand, lucide-react 1.21,
react-i18next, Vitest + React Testing Library, Tailwind.

**Spec:** `docs/superpowers/specs/web-ui/2026-10-16-ui-flow-improvements-design.md`
— "Wave C: Recent (mixed list)", decisions 5 and 9. Branch
`feature/8985-ui-flow/wave-<sub#>` off `main`; PR body `Closes #<sub>`.

## Global Constraints

- Every new `en` locale key is added to all 8 locale directories under
  `apps/web/src/locales/` (`en` + `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`,
  `pt-BR`, `tr-TR`; `localeParity.test.ts:416-456` enumerates them). Use real
  translations: `translationCoverage.test.ts` caps exact-English duplicates per
  namespace per locale (baselines at `:15`; precedent for a justified +1 at `:831`).
- Interactive elements get `data-testid`.
- Files under ~500 lines by judgment; `Sidebar.tsx` (1297) is edited in place,
  not split. `DeviceList.tsx` untouched.
- No mutations and no fetches in this wave; `runAction` is not involved.
- Transient UI state lives in `window.location.hash`, never query params (none
  added here; recorded page paths carry `pathname + search`, no hash).
- Navigation never silently changes the working org: every Recent link is a
  plain `<a href>`; only the switcher moves the org.
- `MAX_RECENT_DEVICES` and `MAX_RECENT_PAGES` both become `10`.
- Command palette unchanged: `CommandPalette.tsx:118-119` keeps
  `PALETTE_RECENT_DEVICES = 5` / `PALETTE_RECENT_PAGES = 5`; `:229-230` keeps
  reading `s.devices` / `s.pages`.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Commands (exact): one file `cd apps/web && npx vitest run <path>`; parity
  `cd apps/web && npx vitest run src/lib/i18n` (confirm the reported file count
  includes `localeParity.test.ts`); typecheck
  `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo exit=$?`;
  full suite `cd apps/web && npx vitest run`.

## Review Focus

1. **Store already populated when the island hydrates.** `GlobalShortcuts`
   fills the store in an effect (`useRecentsRecorder.ts:27-29`); islands hydrate
   independently, so Sidebar or dashboard can first-render *after* the store is
   full while the server HTML had nothing. Expected: identical first render
   (group/card hidden until mounted), no hydration error. → Task 2 "renders no
   Recent group on the server pass"; Task 3 "renders no card on the server pass".
2. **The open page's recorded path carries a query string.** Pages are keyed by
   `pathname + search` (`useRecentsRecorder.ts:9-14`); the Sidebar's
   `resolvedPath` is a bare pathname (`Sidebar.tsx:130-144`, `:808`). Expected:
   the page you are on never appears; other hrefs keep their query. → Task 1
   "excludes the open page by pathname".
3. **Nested paths under a record prefix** (`/alerts/monitors/:id`,
   `/organizations/:id/...`). Expected: "Page" with FileText, not "Alert". →
   Task 1 "only a single id segment makes a record kind".
4. **A persisted page entry with a blank `name`** (`readPersisted` keeps any
   string). Expected: treated as a hub page, hidden, never a blank row. → Task 1
   "treats a blank name as unnamed".
5. **A 200-character item name.** Expected: truncated row, full name in
   `title`, sidebar width unchanged. → Task 2 and Task 3 "truncates long labels".

---

## Verified facts (origin/main 5fbf5f9220, 2026-10-16 — re-check lines)

| Fact | Where |
|---|---|
| `MAX_RECENT_DEVICES = 5`, `MAX_RECENT_PAGES = 8`; `RecentDevice`/`RecentPage` types; `interface RecentsState` **not exported** | `apps/web/src/stores/recentsStore.ts:16-17`, `:19-35`, `:37-49` |
| Device detail paths never recorded as pages; cap test reads the constants | `recentsStore.ts:57-67`; `recentsStore.test.ts:36-45` |
| Device entries written with `displayName \|\| hostname`; pages named by `usePageItemName` (org record, ticket, alert, site among 26 detail pages) | `components/devices/DeviceDetailPage.tsx:325-331`; `components/layout/usePageItemName.ts:20-38` |
| Sidebar recents consts + `readRecentDevicesExpanded` (keep `TICKETS_PATH` `:517`) | `components/layout/Sidebar.tsx:511-525` |
| Sidebar recents state/toggle; `hydrated` flag (#7498); `resolvedPath` | `Sidebar.tsx:636-644`; `:659-660`; `:808` |
| `renderNavItem` (`withRecents` `:939`, key `:943`, class `:950`, early return + recents branch `:976-1031`, mobile `onClick` pattern `:1019`) | `Sidebar.tsx:926-1032` |
| Section-header button classes; nav renders `topLevelNav` (desktop/mobile); Dashboard item; stale comment | `Sidebar.tsx:1063`; `:1174`, `:1236`; `:243`; `:248-250` |
| `Clock` stays imported (Timesheets) | `Sidebar.tsx:55`, `:388` |
| Only `Sidebar.recents.test.tsx` references the recents block; no other `Sidebar.*.test.tsx` and nothing in `e2e-tests/` does | grep `sidebar-recent`, `RECENT_DEVICES` |
| Dashboard island is SSR'd; alerts grid-row pattern; `RecentActivity` full-width last; card chrome | `pages/index.astro:8`; `components/dashboard/DashboardPage.tsx:165-176`, `:186`; `FleetStatusCard.tsx:65` |
| Relative time, locale-aware, accepts `number`, `numeric:'auto'` (chosen over `lib/formatTime.ts:4` `formatTimeAgo(string)`) | `lib/dateTimeFormat.ts:5`, `:158-175` |
| Dashboard test mock pattern | `DashboardPage.alertAuthorization.test.tsx:5-18` |
| Lucide SVGs carry `lucide-<kebab-name>` classes | `node_modules/lucide-react/dist/esm/createLucideIcon.mjs:20-21` |
| `layout.sidebar.{recentDevices,hideRecentDevices,showRecentDevices}` in every locale; `dashboard` block / `dashboard.activity` | `locales/<each>/common.json:808-810` (block `:803`); `locales/en/common.json:265`, `:309-317` |
| Humanized-key baseline lists the three old keys; stale entries fail; dynamic `t()` needs `/* i18n-dynamic */` | `locales/humanizedKeyBaseline.json:955-957`; `locales/humanizedKeyRegression.test.ts:105-141`; `lib/i18n/keyUsage.test.ts:186-200` |

## Tasks

### Task 1 — `selectRecentEntries` + caps to 10

**Files:** Modify `apps/web/src/stores/recentsStore.ts:16-17`, `:37`, append selector. Test `apps/web/src/stores/recentsStore.test.ts`.

**Produces:**
```ts
export const MAX_RECENT_DEVICES = 10;
export const MAX_RECENT_PAGES = 10;
export interface RecentsState { /* unchanged body, now exported */ }
export type RecentEntryKind = 'device' | 'org' | 'ticket' | 'alert' | 'site' | 'page';
export interface RecentEntry { kind: RecentEntryKind; href: string; label: string; at: number }
export const DEFAULT_RECENT_ENTRY_LIMIT = 10;
export function selectRecentEntries(
  state: Pick<RecentsState, 'devices' | 'pages'>, currentPath: string,
  limit: number = DEFAULT_RECENT_ENTRY_LIMIT,
): RecentEntry[];
```
Order of operations (the tests fix the rules): devices → `{kind:'device', href:'/devices/'+id, label:name, at:openedAt}`;
pages with non-blank `name` → `{kind: kindFromPath(path), href:path, label:name.trim(), at:visitedAt}`;
drop entries whose pathname (href before `?`) equals `currentPath`'s pathname; stable sort by `at`
desc; de-dup by `href` keeping the first; `slice(0, limit)`. `kindFromPath` matches the pathname
against `^/organizations/[^/]+$` → org, `^/tickets/[^/]+$` → ticket, `^/alerts/[^/]+$` → alert,
`^/settings/sites/[^/]+$` → site, else page.

- [ ] **Step 1: Failing tests** in `recentsStore.test.ts`. Fixtures `page = (path, name, visitedAt) => ({ path, title: 'T', name, visitedAt })`, `dev = (id, name, openedAt) => ({ id, name, openedAt })`.

```ts
it('raises both caps to 10', () => { expect(MAX_RECENT_DEVICES).toBe(10); expect(MAX_RECENT_PAGES).toBe(10); });
describe('selectRecentEntries', () => {
  it('merges devices and named pages newest first with a kind per path', () => {
    const r = selectRecentEntries({ devices: [dev('d1', 'LAPTOP-01', 3000)], pages: [
      page('/organizations/o1', 'Acme Dental', 4000), page('/tickets/t1', 'T-0042 Printer', 2000),
      page('/alerts/a1', 'CPU high', 1000), page('/settings/sites/s1', 'Main office', 500), page('/scripts/x1', 'Reboot', 400)] }, '/');
    expect(r.map((e) => e.href)).toEqual(['/organizations/o1', '/devices/d1', '/tickets/t1', '/alerts/a1', '/settings/sites/s1', '/scripts/x1']);
    expect(r.map((e) => e.kind)).toEqual(['org', 'device', 'ticket', 'alert', 'site', 'page']);
    expect(r[0]).toEqual({ kind: 'org', href: '/organizations/o1', label: 'Acme Dental', at: 4000 });
  });
  it('never lists a page without an item name (hub and list pages)', () =>   // pages: {path:'/devices', title:'Devices', visitedAt:9000} + page('/tickets/t1','T-1',1) → hrefs ['/tickets/t1']
  it('treats a blank name as unnamed', () =>                                 // page('/tickets/t1', '   ', 1) → []
  it('excludes the open page by pathname and keeps the query on other hrefs', () =>
    // pages page('/tickets/t1?tab=notes','T-1',2), page('/tickets/t2?tab=notes','T-2',1); currentPath '/tickets/t1' → hrefs ['/tickets/t2?tab=notes']
  it('only a single id segment makes a record kind', () =>                  // '/alerts/monitors/m1', '/organizations/o1/x' → kinds ['page','page']
  it('de-duplicates by href, keeping the newest', () =>                      // '/tickets/t1' ×2 (at 1 'old', at 2 'new') → length 1, label 'new'
  it('caps at 10 by default and honours limit', () =>                        // 12 devices → 10 (first href '/devices/d11'); limit 8 → 8
  it('returns [] for an empty store', () =>
});
```

- [ ] **Step 2: Red** — `cd apps/web && npx vitest run src/stores/recentsStore.test.ts`. Expected: FAIL (`selectRecentEntries` not exported; caps 5/8).
- [ ] **Step 3: Implement** the interfaces above; update the doc comment at `recentsStore.ts:12-13` to name the dashboard card as a reader.
- [ ] **Step 4: Green** — same command. Expected: PASS, including the existing cap test.
- [ ] **Step 5: Commit** — `feat(web/recents): selectRecentEntries merges devices and named records; caps to 10`.

### Task 2 — Sidebar: top-level Recent group under Dashboard

**Files:** Create `apps/web/src/components/layout/recentEntryIcons.ts`. Modify `Sidebar.tsx:1` (import `Fragment`), `:248-250` (comment), `:511-525`, `:636-644`, after `:808`, `:926-1032`, `:1174`, `:1236`; `locales/<all 8>/common.json` `layout.sidebar` (block `:803`). Rewrite `Sidebar.recents.test.tsx`.

**Consumes:** `selectRecentEntries`, `RecentEntry`, `RecentEntryKind` (Task 1).
**Produces:**
```ts
// recentEntryIcons.ts — { device: Monitor, org: Building2, ticket: Ticket, alert: Bell, site: MapPin, page: FileText }
export const RECENT_ENTRY_ICONS: Record<RecentEntryKind, LucideIcon>;
// Sidebar.tsx — replaces RECENT_DEVICES_EXPANDED_KEY; the old 'sidebar-recent-devices' value is not migrated
export const RECENT_EXPANDED_KEY = 'sidebar-recent';
```
Locale keys (en exact; translate the other 7): `layout.sidebar.recent` "Recent",
`layout.sidebar.hideRecent` "Hide recent", `layout.sidebar.showRecent` "Show recent".
The three old `*RecentDevices` keys stay until Task 4.

Decisions the tests pin:
- Group renders only when `hydrated && labels && recentEntries.length > 0` (Review Focus 1;
  `hydrated` exists at `:659`). Icon rail: nothing, as today.
- Markup: `<div data-testid="sidebar-recent-group">` → `<button type="button" data-testid="sidebar-recent-toggle" aria-expanded aria-label={hide/show} title={same}>`
  showing `t('layout.sidebar.recent')` + `ChevronDown` (reuse the `:1063` classes, no `my-2 border-t` divider) →
  when expanded `<ul data-testid="sidebar-recent" aria-label={t('layout.sidebar.recent')}>` of
  `<li data-kind={kind}><a href={href} title={label}>` with `RECENT_ENTRY_ICONS[kind]` (`aria-hidden`) and a
  `truncate` label span. No `aria-current` — the open page is never listed. Mobile rows close the menu like `:1019`.
- Placement: `renderTopLevelNav(forMobileOverlay)` maps `topLevelNav` in a keyed `Fragment`, emitting
  `renderRecentGroup(forMobileOverlay)` after the item whose `href === '/'`; replaces `:1174` and `:1236`.
- Two store selectors (`s.devices`, `s.pages`; one object selector would re-render on every write) merged by
  `useMemo(() => selectRecentEntries({ devices, pages }, resolvedPath), [...])` placed after `:808`.
- `renderNavItem` returns `anchor` unconditionally: delete `:939`, `:950`, `:976-1031`; `key={item.name}` at `:943`.
  Devices & Assets loses its chevron and sub-list.

- [ ] **Step 1: Rewrite `Sidebar.recents.test.tsx`.** Keep the "Devices & Assets label" and "keyboard mode cycling" describes verbatim; import `RECENT_EXPANDED_KEY` and `renderToString` (`react-dom/server`). `beforeEach` adds `vi.useFakeTimers({ toFake: ['Date'] })`, `afterEach` `vi.useRealTimers()`; helpers `seedDevices(names)` and `seedPage(path, title, name?)` (`recordPage`, then `namePage` when named) each advance `vi.setSystemTime` by 1 s per record so timestamps never tie. `describe('Sidebar — Recent group')`:

```ts
it('shows nothing when nothing has been opened', ...)   // no 'sidebar-recent-group', no 'sidebar-recent-devices'
it('lists devices and named records newest first, directly under Dashboard', () => {
  seedDevices(['alpha']); seedPage('/organizations/o1', 'Organization', 'Acme Dental'); seedPage('/devices', 'Devices');
  render(<Sidebar currentPath="/" />);
  const links = within(screen.getByTestId('sidebar-recent')).getAllByRole('link');
  expect(links.map((l) => l.textContent)).toEqual(['Acme Dental', 'alpha']);
  expect(links[0]).toHaveAttribute('href', '/organizations/o1');
  const group = screen.getByTestId('sidebar-recent-group');
  expect(screen.getByRole('link', { name: 'Dashboard' }).compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(group.compareDocumentPosition(screen.getByRole('link', { name: 'Organizations' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('shows an icon per kind', ...)          // li[data-kind="org"] svg.lucide-building-2; li[data-kind="device"] svg.lucide-monitor
it('excludes the page currently open', ...)  // seedPage('/organizations/o1',…,'Acme Dental'); currentPath="/organizations/o1" → no 'Acme Dental' link
it('shows at most 10 entries', ...)         // 7 devices + 5 named pages → 10 links
it('updates live when a device is opened', ...)  // as today, against 'sidebar-recent'
it('truncates long labels and keeps the full name in title', ...)   // 200-char name: link title === name; label span className contains 'truncate'
it('collapses and expands from the header, remembering under sidebar-recent', ...)  // 'Hide recent' → list gone, 'Show recent', localStorage[RECENT_EXPANDED_KEY]==='false' → click → 'true'
it('starts collapsed when the user collapsed it last time', ...)   // RECENT_EXPANDED_KEY 'false' → no list, 'Show recent' present
it('ignores the old sidebar-recent-devices preference', ...)        // localStorage 'sidebar-recent-devices'='false' → list visible
it('hides the group in the icon rail', ...)                          // sidebar-mode 'collapsed' → no 'sidebar-recent-group'
it("does not show another user's entries", ...)                      // as today
it('no longer nests a list under Devices & Assets', ...)             // no 'sidebar-recent-devices', no button /recent devices/i
it('renders no Recent group on the server pass even when the store is populated', () => {
  seedDevices(['alpha']);
  expect(renderToString(<Sidebar currentPath="/" />)).not.toContain('sidebar-recent');
});
```

- [ ] **Step 2: Red** — `cd apps/web && npx vitest run src/components/layout/Sidebar.recents.test.tsx`. Expected: FAIL (`RECENT_EXPANDED_KEY` undefined).
- [ ] **Step 3: Implement** `recentEntryIcons.ts`, the Sidebar changes, the three keys in all 8 `common.json`.
- [ ] **Step 4: Green** — the file above, then
  `cd apps/web && npx vitest run src/components/layout/Sidebar.collapsedrail.test.tsx src/components/layout/Sidebar.hydration.test.tsx src/components/layout/Sidebar.nav.test.tsx src/components/layout/Sidebar.rbac.test.tsx src/components/layout/Sidebar.scrollpersist.test.tsx`
  (they render the nav and must stay green), then `cd apps/web && npx vitest run src/lib/i18n`. Expected: all PASS.
- [ ] **Step 5: Commit** — `feat(web/sidebar): top-level Recent group under Dashboard replaces recent-devices rows`.

### Task 3 — Dashboard "Pick up where you left off" card

**Files:** Create `apps/web/src/components/dashboard/RecentlyViewedCard.tsx`, `RecentlyViewedCard.test.tsx`, `DashboardPage.recentlyViewed.test.tsx`. Modify `DashboardPage.tsx:1`, `:20` (imports), `:50-57` (state), `:186` (row); `locales/<all 8>/common.json` `dashboard` block after `activity` (`:309-317`).

**Consumes:** `selectRecentEntries`, `RecentEntry` (Task 1); `RECENT_ENTRY_ICONS` (Task 2); `formatRelativeTime` (`@/lib/dateTimeFormat`).
**Produces:**
```ts
export const RECENTLY_VIEWED_LIMIT = 8;
export const RECENT_ENTRY_KIND_LABEL_KEYS: Record<RecentEntryKind, string>; // 'dashboard.recentlyViewed.kind.<kind>'
export default function RecentlyViewedCard({ entries }: { entries: RecentEntry[] }): JSX.Element | null; // null when empty
```
Locale keys (en exact): `dashboard.recentlyViewed.title` "Pick up where you left off";
`dashboard.recentlyViewed.kind.{device,org,ticket,alert,site,page}` = "Device", "Organization",
"Ticket", "Alert", "Site", "Page"; read with `t(/* i18n-dynamic */ RECENT_ENTRY_KIND_LABEL_KEYS[kind])`.

Decisions the tests pin:
- Presentational like `RecentActivity` (`:20-24`): `<section data-testid="dashboard-recently-viewed" className="rounded-lg border bg-card p-5 shadow-xs">`,
  `<h3 data-testid="dashboard-recently-viewed-heading">`, `<ul>` of `<li data-kind>` →
  `<a data-testid="dashboard-recently-viewed-link" href title={label}>`: icon (`aria-hidden`), `truncate` label,
  muted kind label, `tabular-nums` `formatRelativeTime(entry.at)`. Times refresh on the page's 60 s `tick`.
- `DashboardPage` owns the data: two store selectors, `mounted` (`useState(false)` + `useEffect`), and
  `recentEntries = useMemo(() => mounted ? selectRecentEntries({ devices, pages }, window.location.pathname, RECENTLY_VIEWED_LIMIT) : [], [mounted, devices, pages])`.
- Row replacing `:186` (Recent activity keeps full width when the card is hidden):
```tsx
<div className={cn('grid items-start gap-6', showRecentlyViewed && 'lg:grid-cols-3')}>
  <div className={cn(showRecentlyViewed && 'lg:col-span-2')}><RecentActivity activity={activity} onRetry={refresh} /></div>
  {showRecentlyViewed && <RecentlyViewedCard entries={recentEntries} />}
</div>
```

- [ ] **Step 1: Failing card test** `RecentlyViewedCard.test.tsx` (`beforeEach`: `await i18n.changeLanguage('en')`, `vi.useFakeTimers({ toFake: ['Date'] })`, `vi.setSystemTime(NOW)`; `afterEach`: `vi.useRealTimers()`; `NOW = new Date('2026-10-16T12:00:00Z').getTime()`, `entry = (kind, href, label, agoMs) => ({ kind, href, label, at: NOW - agoMs })`):

```ts
it('renders nothing when there are no entries', () => { expect(render(<RecentlyViewedCard entries={[]} />).container.firstChild).toBeNull(); });
it('lists each entry as a link with icon, kind label and relative time', () => {
  render(<RecentlyViewedCard entries={[entry('org', '/organizations/o1', 'Acme Dental', 2 * 3_600_000), entry('device', '/devices/d1', 'LAPTOP-01', 30_000), entry('ticket', '/tickets/t1', 'T-0042', 86_400_000)]} />);
  expect(screen.getByTestId('dashboard-recently-viewed-heading')).toHaveTextContent('Pick up where you left off');
  const links = screen.getAllByTestId('dashboard-recently-viewed-link');
  expect(links.map((l) => l.getAttribute('href'))).toEqual(['/organizations/o1', '/devices/d1', '/tickets/t1']);
  expect(links[0]).toHaveTextContent('Acme Dental'); expect(links[0]).toHaveTextContent('Organization'); expect(links[0]).toHaveTextContent('2 hours ago');
  expect(links[1]).toHaveTextContent('Device'); expect(links[2]).toHaveTextContent('Ticket'); expect(links[2]).toHaveTextContent('yesterday');
  expect(links[0].querySelector('svg.lucide-building-2')).not.toBeNull(); expect(links[1].querySelector('svg.lucide-monitor')).not.toBeNull();
});
it('does not throw for an entry stamped in the future', ...)       // at NOW + 3_600_000 → one link rendered
it('truncates long labels and keeps the full name in title', ...)  // 200-char label: link title === label; label span className contains 'truncate'
```

- [ ] **Step 2: Failing page test** `DashboardPage.recentlyViewed.test.tsx` — copy the mocks from `DashboardPage.alertAuthorization.test.tsx:5-18`, but mock `./RecentActivity` as `() => <div data-testid="recent-activity-stub" />` and do **not** mock `./RecentlyViewedCard` or the recents store. `seedDevices(n)` = `hydrate('u1')` + `recordDevice` ×n with `vi.setSystemTime` advancing 1 s per record.

```ts
it('hides the card and keeps Recent activity full width when nothing was opened', async () => {
  render(<DashboardPage />);
  const stub = await screen.findByTestId('recent-activity-stub');
  expect(screen.queryByTestId('dashboard-recently-viewed')).toBeNull();
  expect(stub.parentElement!.className).not.toContain('lg:col-span-2');
});
it('shows the top 8 entries beside Recent activity', async () => {
  seedDevices(9); render(<DashboardPage />);
  const card = await screen.findByTestId('dashboard-recently-viewed');
  expect(screen.getAllByTestId('dashboard-recently-viewed-link')).toHaveLength(8);
  const row = screen.getByTestId('recent-activity-stub').parentElement!.parentElement!;
  expect(row).toBe(card.parentElement); expect(row.className).toContain('lg:grid-cols-3');
});
it('renders no card on the server pass even with a populated store', () => {
  seedDevices(2); expect(renderToString(<DashboardPage />)).not.toContain('dashboard-recently-viewed');
});
```

- [ ] **Step 3: Red** — `cd apps/web && npx vitest run src/components/dashboard/RecentlyViewedCard.test.tsx src/components/dashboard/DashboardPage.recentlyViewed.test.tsx`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement** the card, the `DashboardPage` wiring, the seven keys in all 8 `common.json`.
- [ ] **Step 5: Green** — the two files plus `src/components/dashboard/DashboardPage.alertAuthorization.test.tsx` (now imports the real card with an empty store) and `src/lib/i18n`. Expected: all PASS.
- [ ] **Step 6: Commit** — `feat(web/dashboard): "Pick up where you left off" card beside Recent activity`.

### Task 4 — Retire the recent-devices locale keys; i18n contract sweep

**Files:** Modify `locales/<all 8>/common.json:808-810` (delete `recentDevices`, `hideRecentDevices`, `showRecentDevices`); `locales/humanizedKeyBaseline.json:955-957` (delete the three entries — the stale check at `humanizedKeyRegression.test.ts:105-141` fails otherwise); possibly `lib/i18n/translationCoverage.test.ts` baselines (Step 3).

- [ ] **Step 1: Red** — delete the three keys from `en/common.json` only; `cd apps/web && npx vitest run src/locales/humanizedKeyRegression.test.ts src/lib/i18n/localeParity.test.ts`. Expected: FAIL (stale baseline entries; parity mismatch ×7).
- [ ] **Step 2: Green** — delete the keys from the other 7 locales and the three baseline lines; re-run. Expected: PASS.
- [ ] **Step 3: Whole contract** — `cd apps/web && npx vitest run src/lib/i18n src/locales`. Expected: PASS. If `translationCoverage` reports `common.json: N exact-English duplicates exceeds baseline` for a locale whose natural word equals English (e.g. "Site"), prefer another natural rendering; only if none exists, raise that locale's `'common.json'` baseline by exactly the count with a comment naming the key (precedent `:831`).
- [ ] **Step 4: Commit** — `chore(web/i18n): drop recent-devices sidebar keys and their humanized-key baseline entries`.

### Task 5 — Typecheck, full suite, PR

- [ ] `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo exit=$?` → `exit=0`.
- [ ] `cd apps/web && npx vitest run` → green; the run lists `recentsStore.test.ts`, `Sidebar.recents.test.tsx`, `RecentlyViewedCard.test.tsx`, `DashboardPage.recentlyViewed.test.tsx`.
- [ ] Guard: `grep -rn "sidebar-recent-devices\|RECENT_DEVICES\|RecentDevices" apps/web/src e2e-tests` → only `CommandPalette.tsx` (`PALETTE_RECENT_DEVICES` is expected).
- [ ] PR with `Closes #<sub>`, `Part of #8985`: the two surfaces, caps 5/8 → 10/10, the un-migrated `sidebar-recent-devices` preference, palette untouched. Ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Non-goals (from the spec)
- Recency only — no frequency weighting, no server-side tracking, no palette change.
- No dashboard empty-state card; no Recent group in the icon rail.
- The org switcher's own Recent group (last 3 orgs) is Wave B, not this list.

---
tracking_issue: LanternOps/breeze#8985
wave: W03
---

# UI Flow W03: EntityLink and cross-link sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared `EntityLink` component renders every org / site / device / ticket / alert name as a quiet link, and the lists and headers that print those names as plain text (or as hand-rolled `<a>`s) use it.

**Architecture:** `components/shared/EntityLink.tsx` owns the href map and the `stopPropagation` contract, so a link is safe inside any clickable row. Call sites change only the text node they print; two rows that are themselves interactive elements (`TicketQueueList` `<button>`, `AlertsFeed` `<a>`) are restructured so no anchor is nested in another interactive element. No API changes, no new locale keys, no mutations.

**Tech Stack:** React 19 islands, Vitest + React Testing Library (`apps/web`), Tailwind via `cn` (`@/lib/utils`), Astro `<ClientRouter />` (test stand-in `src/__tests__/astroClientRouterStandIn.ts`).

**Spec:** `docs/superpowers/specs/web-ui/2026-10-16-ui-flow-improvements-design.md` — section "Wave D: `EntityLink` and the cross-link sweep" (lines 292–327) and decisions 7 and 10.

**Branch:** `feature/8985-ui-flow/wave-<sub#>` off `main` (numbers filled in at `register_feature`); PR body carries `Closes #<sub>`. Independent of W02/W04. W01 merges first and edits `DeviceList.tsx` above line 1500 (`metricBar`) and `OrgDevicesTab.tsx`; re-grep the `DeviceList` line numbers below after branching.

## Global Constraints

- Every new `en` locale key is added to all 7 locales under `apps/web/src/locales/<lang>/` (the `localeParity` test enforces it). **This wave adds none** — `EntityLink` prints the `name` it is given; `AlertsFeed` keeps `t('states.unknown')`.
- Interactive elements get `data-testid`. `EntityLink` renders `data-testid="<kind>-record-link"`; the org kind keeps the existing `org-record-link`. Every testid that exists today is preserved.
- Aim for files under ~500 lines; `DeviceList.tsx` (3730 lines) must NOT be split in this work — edit only the inside of three cells.
- No mutations in this work, so `runAction` is not involved; reads go through `fetchWithAuth` / the org-pinned `orgFetch`. This wave adds no fetches.
- Transient UI state in `window.location.hash` (`#billing`, `#contacts` on the org record), never query params — `EntityLink.hash` exists for exactly these two deep links.
- Navigation never silently changes the working org; only the switcher does. `EntityLink` is a same-origin `<a>` with no store writes; a primary unmodified click soft-navigates through `navigateTo` (`@/lib/navigation`), and modified clicks are left to the browser so cmd/ctrl-click opens a tab.
- Spec: "No behaviour change beyond links; existing testids preserved."

## Review Focus

Inputs the spec implies but no spec bullet tests; each is pinned to a task below.

1. A device whose `siteId` / `orgId` is `''` (the sentinel `DevicesPage.tsx:749-751` and `DeviceDetailPage.tsx:143-146` write) must print the name as text, never a link to `/settings/sites/` — Task 1 (`renders plain text when id is empty`), Task 3, Task 4.
2. A `DeviceList` row of class `network` or `manual` must not link its hostname to `/devices/:id`: `DevicesPage.handleSelectDevice` (`:1161-1176`) sends those to `/devices/network/:id` or an edit modal — Task 3.
3. Cmd/ctrl-click on an `EntityLink` inside a clickable row must open a new tab (browser default, no `navigateTo`) and must not fire the row's handler — Task 1 (`hands a modified click to the browser and still stops propagation`).
4. A dashboard alert with `deviceHostname` but no `deviceId` (detached device / older payload) must render an inert row: text hostname, no `navigateTo`, no chevron — Task 5.
5. After the `TicketQueueList` row stops being a `<button>`, Enter and Space on a focused row must still select it, and a ticket with `orgName: null` renders no org link — Task 6.

## Verified facts (re-checked on `main` 9a16b94e02, 2026-10-16)

| Fact | Where |
|---|---|
| Only shared link component; `cn` util; `JSX` type import convention | `components/shared/HashLink.tsx` (91 lines); `lib/utils.ts:5`; `components/shared/PageHeader.tsx:1` (`import type { JSX } from 'react'`) |
| Astro `<ClientRouter />` claims same-origin anchor clicks at `document`; React's `stopPropagation()` halts the native event below it, so a link that stops propagation hard-navigates unless it navigates itself | `layouts/AuthLayout.astro:31`; `HashLink.tsx:29-36,48-55` |
| `navigateTo(path)` soft-navigates via `astro:transitions/client` with `window.location.assign` fallback; `getSafeNext` returns a safe path unchanged (hash kept); Vitest aliases `astro:transitions/client` to `src/__mocks__/astro-transitions-client.ts` | `lib/navigation.ts:49-84`; `lib/authNext.ts:9-15`; `vitest.config.ts` `resolve.alias` |
| Hand-rolled org `<a>`s with `data-testid="org-record-link"`, style `hover:underline` (`hover:text-foreground hover:underline` in TicketWorkbench) | `TicketWorkbench.tsx:1149-1151`, `ContractEditor.tsx:962-964`, `InvoiceEditor.tsx:932-934`, `QuoteDetail.tsx:276` |
| Org link with `#billing`, testid `autopay-client-<orgId>` (row and card variants via `id(variant, …)`), style `font-medium text-primary hover:underline` | `AutopayListPage.tsx:36-37`; no test references the testid |
| Tests that pin `org-record-link` (`tagName A`, href, text) | `TicketWorkbench.test.tsx:132-135`, `ContractEditor.autosave.test.tsx:215-218`, `InvoiceEditor.test.tsx:195-198`, `QuoteDetail.customer.test.tsx:103-106` |
| Device link with `/devices?device=` vs `/devices/:id` | `TicketWorkbench.tsx:1155` vs `:1847-1853` (`ticket-workbench-device-link`) |
| `DeviceList` row: `<tr onClick={() => onSelect?.(device)} tabIndex={0} onKeyDown…>`; `Device.orgId/orgName/siteId/siteName: string` | `DeviceList.tsx:3147-3156`; `:199-202` |
| Hostname cell (outer `<span className="block truncate font-medium" title>` + secondary hostname span); Organization cell; Site cell | `DeviceList.tsx:1590-1611`; `:1717-1729`; `:1730-1741` |
| `rowOrder` test helper reads `tbody tr td:nth-child(2) span` text | `DeviceList.test.tsx:388-389` — the hostname cell must keep its outer `<span>` |
| `DeviceDetails` header sub-line: OS, agent version, `<span>{device.siteName}</span>`; `Device` imported from `DeviceList` | `DeviceDetails.tsx:822-831`; `:41` |
| `DeviceCard` root `<div onClick={() => onClick?.(device)}>`; footer `<span>{device.siteName}</span>` | `DeviceCard.tsx:319-320`; `:650-651` |
| `AlertList` row `<tr onClick={() => onSelect?.(alert)}>`; org cell; `Alert.orgId?: string \| null` | `AlertList.tsx:511-513`; `:541-547`; `:73` |
| `AlertsFeed` row is `<a href=/devices/:id>` wrapping `hostname · orgName`; `AlertRow` has `orgName` but no `orgId`; API list row does return `orgId` | `AlertsFeed.tsx:193-221`; `dashboard/types.ts:24-35`; `apps/api/src/routes/alerts/alerts.ts:356,375` |
| `OrgOverviewTab` critical-alert sub-line joins `[deviceHostname, time]`; rows are `AlertRow` from `/alerts?status=active&severity=critical&limit=10` | `OrgOverviewTab.tsx:296-300`; `:8,56,131` |
| `TicketQueueList` row is `<button type="button" role="option" aria-selected … data-testid="ticket-row-<id>">`; org name `<span className="truncate">` | `TicketQueueList.tsx:108-149`; `:143` |
| `TicketsPage.test.tsx` asserts `ticket-row-*` `aria-selected`; consumers `TicketsPage.tsx:745`, `OrgTicketsTab.tsx:162` | `TicketsPage.test.tsx:260-262,274` |
| `DevicesPage.handleSelectDevice`: manual → modal, network → `/devices/network/:id`, else `/devices/:id` | `DevicesPage.tsx:1161-1176` |
| Playwright specs (`e2e-tests/tests/*.spec.ts`) reference none of the touched testids | grep 2026-10-16 |

**Not migrated, and why** (the spec's "seven" counted these): `DeviceDetailPage.tsx:749` and `SiteDetailPage.tsx:408` are `Breadcrumbs` items (`{label, href}`; `layout/Breadcrumbs.tsx:34-40` renders the `<a>` itself — changing a layout component used app-wide is out of scope); `SiteDetailPage.tsx:417` is an icon-only back arrow (`aria-label`, no name); `SiteDetailPage.tsx:602` and `OrgBillingSettings.tsx:556` link to the settings editor / a "Manage contacts" CTA, not an entity name; `AccountBoardTable.tsx:99-112` carries a roving-focus `ref`, `tabIndex`, `onKeyDown` and a soft-nav `onClick` the fixed props cannot express. `TicketWorkbench.tsx:1847` already uses `/devices/:id` with its own testid; the spec names only `:1155`.

---

### Task 1: `EntityLink` + `entityHref`

**Files:**
- Create: `apps/web/src/components/shared/EntityLink.tsx`
- Test: `apps/web/src/components/shared/EntityLink.test.tsx`

**Interfaces:**
- Produces (fixed cross-wave names, verbatim):
  ```ts
  export type EntityKind = 'org' | 'site' | 'device' | 'ticket' | 'alert';
  export function entityHref(kind: EntityKind, id: string, hash?: string): string;
  export function EntityLink(props: { kind: EntityKind; id: string; name: string; hash?: string; className?: string }): JSX.Element;
  ```
  Href map: org `/organizations/:id`, site `/settings/sites/:id`, device `/devices/:id`, ticket `/tickets/:id`, alert `/alerts/:id`; `:id` is `encodeURIComponent(id)` (keeps the CodeQL note at `ContractEditor.tsx:959-961` true); `hash` appended as `#<hash without leading #>`.
  Renders `<a href={href} data-testid={`${kind}-record-link`} className={cn('hover:underline', className)} onClick={handleClick}>{name}</a>`. `handleClick`: always `e.stopPropagation()`; then, if `e.button === 0` and no `metaKey/ctrlKey/shiftKey/altKey` (the `HashLink.tsx:73-81` test), `e.preventDefault()` and `void navigateTo(href)` (`@/lib/navigation`); a modified click returns after the `stopPropagation` so the browser opens a tab. **Why it navigates itself:** React's `stopPropagation()` also halts the native event, so Astro's `document`-level `<ClientRouter />` never sees the click and the four links migrated in Task 2 would silently downgrade from soft to hard navigation. `navigateTo` keeps the `#hash` (`getSafeNext` returns a safe path unchanged). **Decision:** when `id === ''` it renders `<span className={className}>{name}</span>` (no href, no testid) — the `''` sentinel of Review Focus 1 is handled once here, not at every call site.

- [ ] **Step 1: Write the failing tests** in `EntityLink.test.tsx`. Mock navigation as `TicketWorkbench.test.tsx:60-61` does: `const navigateTo = vi.fn(); vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }))`.
  - `describe('entityHref')`: `it.each` over the five kinds with id `'x-1'` → exact hrefs above; `it('appends a hash with or without its leading #')` → `entityHref('org','o1','billing') === '/organizations/o1#billing'` and `entityHref('org','o1','#contacts') === '/organizations/o1#contacts'`; `it('encodes the id as one path segment')` → `entityHref('device','a b/c') === '/devices/a%20b%2Fc'`.
  - `describe('EntityLink')`: `it('renders an anchor with the kind testid, href and name')` → `getByTestId('site-record-link')` has `tagName 'A'`, href `/settings/sites/s-1`, text `'HQ'`; `it('keeps the legacy org-record-link testid')`; `it('stops propagation and soft-navigates on a plain click')` → `<div onClick={row}><EntityLink kind="org" id="o1" name="Acme" hash="billing" /></div>`, `expect(fireEvent.click(link)).toBe(false)` (default prevented), `expect(row).not.toHaveBeenCalled()`, `expect(navigateTo).toHaveBeenCalledWith('/organizations/o1#billing')`; `it('hands a modified click to the browser and still stops propagation')` → `expect(fireEvent.click(link, { metaKey: true })).toBe(true)`, `row` not called, `navigateTo` not called; `it('renders plain text when id is empty')` → `queryByRole('link')` null, `queryByTestId('site-record-link')` null, `getByText('Unknown Site')`; `it('merges className')` → `toHaveClass('hover:underline', 'block', 'truncate')`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/shared/EntityLink.test.tsx` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `EntityLink.tsx` per Interfaces (a `const ENTITY_PATHS: Record<EntityKind, string>`, the two exports, `handleClick` as specified; `import type { JSX, MouseEvent } from 'react'`).
- [ ] **Step 4: Run** the same command — Expected: PASS, 1 file.
- [ ] **Step 5: Commit** `git add apps/web/src/components/shared/EntityLink.tsx apps/web/src/components/shared/EntityLink.test.tsx && git commit -m "feat(web): EntityLink shared record link with per-kind hrefs and stopPropagation" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 2: Migrate the hand-rolled org links

**Files:**
- Modify: `TicketWorkbench.tsx:1149-1151`, `ContractEditor.tsx:962-964`, `InvoiceEditor.tsx:932-934`, `QuoteDetail.tsx:276`, `AutopayListPage.tsx:36-37`
- Test: `apps/web/src/components/billing/AutopayListPage.test.tsx` (new case); the four existing `org-record-link` tests are the guard for the rest.

**Interfaces:** Consumes `EntityLink` (Task 1).

- [ ] **Step 1: Write the failing test** in `AutopayListPage.test.tsx`: `it('links the client name to the org record billing tab (ui-flow W03)')` → `render(<AutopayListPage />)`, `const row = await screen.findByTestId(`autopay-row-${id}`)`, `const link = within(row).getByTestId('org-record-link')`, `expect(link).toHaveAttribute('href', `/organizations/${id}#billing`)`, `toHaveTextContent('Example client')`, and `within(row).getByTestId(`autopay-client-${id}`)` still exists.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/billing/AutopayListPage.test.tsx` — Expected: FAIL (`org-record-link` not found).
- [ ] **Step 3: Replace** each `<a href={`/organizations/…`} data-testid="org-record-link" …>{name}</a>` with `<EntityLink kind="org" id={…} name={…} />`: TicketWorkbench passes `className="hover:text-foreground"`; ContractEditor, InvoiceEditor, QuoteDetail pass no className; `AutopayListPage.renderClient` returns `<span data-testid={id(variant, `autopay-client-${row.orgId}`)}><EntityLink kind="org" id={row.orgId} name={row.orgName} hash="billing" className="font-medium text-primary" /></span>` (wrapper keeps the existing testid).
- [ ] **Step 4: Run** `cd apps/web && npx vitest run src/components/billing/AutopayListPage.test.tsx src/components/tickets/TicketWorkbench.test.tsx src/components/contracts/ContractEditor.autosave.test.tsx src/components/billing/InvoiceEditor.test.tsx src/components/billing/quotes/QuoteDetail.customer.test.tsx` — Expected: PASS, 5 files.
- [ ] **Step 5: Commit** `git commit -am "refactor(web): hand-rolled org record links use EntityLink" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 3: `DeviceList` Organization, Site and hostname cells

**Files:**
- Modify: `apps/web/src/components/devices/DeviceList.tsx:1590-1611` (hostname), `:1717-1729` (organization), `:1730-1741` (site) — re-grep after W01
- Test: `DeviceList.test.tsx` (new describe), `DeviceList.unified.test.tsx` (network row case)

**Interfaces:** Consumes `EntityLink`. Produces nothing new; `onSelect` semantics unchanged.

- [ ] **Step 1: Write the failing tests.** Add `vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))` to both test files' mock blocks (a link click now calls it). In `DeviceList.test.tsx`, `describe('DeviceList — entity links (ui-flow W03)')`:
  - `it('links the organization and site cells to their records')` → `render(<DeviceList devices={[baseDevice]} />)`; `getByTestId('org-record-link')` href `/organizations/org-1`; `getByTestId('site-record-link')` href `/settings/sites/site-1`.
  - `it('links the hostname to the device and keeps row click working')` → `onSelect = vi.fn()`; `getByTestId('device-record-link')` href `/devices/11111111-1111-1111-1111-111111111111`; `fireEvent.click(link)` → `onSelect` not called; `fireEvent.click(link.closest('tr')!)` → `onSelect` called with `baseDevice`.
  - `it('prints a manual asset hostname as text (no detail page)')` → `manualDevice()` fixture (`:1686`), `queryByTestId('device-record-link')` null, `getByText(hostname)` present.
  - `it('prints the site name as text when the device has no site')` → `{ ...baseDevice, siteId: '', siteName: 'Unknown Site' }`, `queryByTestId('site-record-link')` null, `getByText('Unknown Site')`.
  In `DeviceList.unified.test.tsx`: `it('prints a network row hostname as text (its page is /devices/network/:id)')` → `networkPrinter` with `networkDevicesEnabled`, `queryByTestId('device-record-link')` null.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/devices/DeviceList.test.tsx src/components/devices/DeviceList.unified.test.tsx` — Expected: the five new cases FAIL.
- [ ] **Step 3: Implement.** Organization cell: inside the existing `<span className="block truncate" title>` replace `{device.orgName}` with `<EntityLink kind="org" id={device.orgId} name={device.orgName} />`; Site cell likewise with `kind="site"`. Hostname cell: keep the outer `<span className="block truncate font-medium" title={primaryName}>` and replace its text with `(device.deviceClass ?? 'agent') === 'agent' ? <EntityLink kind="device" id={device.id} name={primaryName} /> : primaryName`. The secondary hostname span is untouched.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run src/components/devices/DeviceList` — Expected: PASS; the count includes all 13 `DeviceList*.test.tsx` files (sort tests via `rowOrder` stay green).
- [ ] **Step 5: Commit** `git commit -am "feat(web): DeviceList org, site and hostname cells are EntityLinks" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 4: `DeviceDetails` header org + site links; `DeviceCard` site link

**Files:**
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx:822-831`, `apps/web/src/components/devices/DeviceCard.tsx:650-651`
- Test: create `apps/web/src/components/devices/DeviceDetails.headerLinks.test.tsx` (mock block copied from `DeviceDetails.pageTitle.test.tsx:7-23`, fixture `:25-43`); extend `DeviceCard.test.tsx`

- [ ] **Step 1: Write the failing tests.** `DeviceDetails.headerLinks.test.tsx`, `describe('DeviceDetails header links (ui-flow W03)')`: `it('links the org name before the site name')` → `org-record-link` href `/organizations/org-1` text `'Org One'`; `site-record-link` href `/settings/sites/site-1` text `'HQ'`; `expect(org.compareDocumentPosition(site) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()`. `it('prints an unassigned site as text')` → `siteId: ''`, `siteName: 'Unknown Site'` → no `site-record-link`, `getByText('Unknown Site')`.
  `DeviceCard.test.tsx` (add `vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))`), `describe('DeviceCard site link (ui-flow W03)')`: `fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ metrics: [] }))`; `it('links the site name and does not trigger the card click')` → `onClick = vi.fn()`, `render(<DeviceCard device={baseDevice} onClick={onClick} />)`, `site-record-link` href `/settings/sites/site-1`, `fireEvent.click(link)` → `onClick` not called.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/devices/DeviceDetails.headerLinks.test.tsx src/components/devices/DeviceCard.test.tsx` — Expected: FAIL (testids missing).
- [ ] **Step 3: Implement.** `DeviceDetails.tsx:830` `<span>{device.siteName}</span>` → `<EntityLink kind="org" id={device.orgId} name={device.orgName} />` followed by `<EntityLink kind="site" id={device.siteId} name={device.siteName} />` (same flex container; order org, site). `DeviceCard.tsx:651` → `<EntityLink kind="site" id={device.siteId} name={device.siteName} />`.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run src/components/devices/DeviceDetails src/components/devices/DeviceCard` — Expected: PASS, 17 files.
- [ ] **Step 5: Commit** `git commit -am "feat(web): device header links org and site; DeviceCard site link" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 5: `AlertList` org cell, `OrgOverviewTab` hostname, `AlertsFeed` row restructure

**Files:**
- Modify: `apps/web/src/components/alerts/AlertList.tsx:541-547`; `apps/web/src/components/organizations/record/OrgOverviewTab.tsx:296-300`; `apps/web/src/components/dashboard/types.ts:24-35` (add `orgId?: string | null` to `AlertRow`, documented as mirrored from `routes/alerts/alerts.ts:356`); `apps/web/src/components/dashboard/AlertsFeed.tsx:193-221`
- Test: `AlertList.test.tsx`, `OrgOverviewTab.test.tsx`, create `AlertsFeed.links.test.tsx` (leave `AlertsFeed.title.test.tsx` untouched; it must stay green)

**Interfaces:** Consumes `EntityLink`; `navigateTo(path)` from `@/lib/navigation` (mock as `vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))`).

- [ ] **Step 1: Write the failing tests.**
  - `AlertList.test.tsx` (add `vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))`): `it('links the org cell to the org record and keeps row selection separate')` → `onSelect = vi.fn()`, `render(<AlertList alerts={[baseAlert]} showOrgColumn onSelect={onSelect} />)`, `org-record-link` href `/organizations/org-1`, `fireEvent.click(link)` → `onSelect` not called.
  - `OrgOverviewTab.test.tsx`: `it('links a critical alert hostname to the device')` → alerts feed returns `{ data: [{ id: 'al-1', title: 'Disk full', severity: 'critical', status: 'active', deviceId: 'dev-1', deviceHostname: 'edge-01', createdAt: '2026-09-05T10:00:00.000Z' }] }` → `await screen.findByTestId('device-record-link')` href `/devices/dev-1` text `'edge-01'`; `it('prints the hostname as text when the alert has no deviceId')` → same row without `deviceId` → no `device-record-link`, `getByText(/edge-01/)`.
  - `AlertsFeed.links.test.tsx` (fixtures as `AlertsFeed.title.test.tsx:10-27`, plus `orgId: 'org-1'`): `it('navigates to the device on row click and renders hostname and org as sibling links')` → `fireEvent.click(screen.getByText('DESKTOP-8UG65K6 offline'))` → `navigateTo` called with `/devices/d1`; `device-record-link` href `/devices/d1`; `org-record-link` href `/organizations/org-1`; `expect(link.parentElement?.closest('a')).toBeNull()` for both (no nested anchors); `it('an org link click goes to the org, not the device')` → click `org-record-link`, `navigateTo` called once, with `/organizations/org-1`; `it('a row without deviceId is inert')` → `deviceId: null`, click title → `navigateTo` not called, no `device-record-link`, hostname text present; `it('prints the org as text when the payload has no orgId')` → `orgId` omitted → no `org-record-link`, `getByText(/A1 Quality Transmission/)`.
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/alerts/AlertList.test.tsx src/components/organizations/record/OrgOverviewTab.test.tsx src/components/dashboard/AlertsFeed.links.test.tsx` — Expected: FAIL (new cases).
- [ ] **Step 3: Implement.** `AlertList.tsx:543-545`: inside the truncate span, `alert.orgName ? <EntityLink kind="org" id={alert.orgId ?? ''} name={alert.orgName} /> : '—'`. `OrgOverviewTab.tsx:296-300`: replace the `.join(' · ')` with `{alert.deviceHostname && <><EntityLink kind="device" id={alert.deviceId ?? ''} name={alert.deviceHostname} />{' · '}</>}{formatDateTime(alert.triggeredAt ?? alert.createdAt)}`. `AlertsFeed.tsx:210-221`: one `<div key className={cn(rowClass, alert.deviceId && 'group cursor-pointer hover:bg-muted/40')} onClick={alert.deviceId ? () => void navigateTo(`/devices/${alert.deviceId}`) : undefined}>` with the chevron only when `alert.deviceId`; in `inner` (`:200-203`) the sub-line becomes `{alert.deviceHostname ? <EntityLink kind="device" id={alert.deviceId ?? ''} name={alert.deviceHostname} /> : t('states.unknown')}{showOrg && alert.orgName && <> · <EntityLink kind="org" id={alert.orgId ?? ''} name={alert.orgName} /></>}`. Keyboard reach to the device is the hostname link (the old `<a>` row is gone); no `role` on the div.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run src/components/alerts/AlertList src/components/organizations/record/OrgOverviewTab.test.tsx src/components/dashboard/AlertsFeed` — Expected: PASS; count includes `AlertsFeed.title.test.tsx` and `AlertList.permissions.test.tsx`.
- [ ] **Step 5: Commit** `git commit -am "feat(web): alert lists and dashboard feed link org and device names" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 6: `TicketQueueList` row restructure; `TicketWorkbench` device href

**Files:**
- Modify: `apps/web/src/components/tickets/TicketQueueList.tsx:108-149`, `apps/web/src/components/tickets/TicketWorkbench.tsx:1152-1157`
- Test: `TicketQueueList.test.tsx`, `TicketWorkbench.test.tsx` (next to the org link case at `:128-136`)

**Structure decision:** the `<button type="button" role="option" …>` becomes `<div role="option" tabIndex={0} aria-selected={…} onClick={() => onSelect(ticket)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(ticket); } }} data-testid={`ticket-row-${ticket.id}`} className={cn('cursor-pointer', …same classes…)}>`. The accessibility tree is unchanged (the `button` was already overridden to `option`, `aria-selected` stays, so `TicketsPage.test.tsx:260-274` stays green); `tabIndex={0}` keeps the row in the tab order and `onKeyDown` reproduces the button's Enter/Space activation; the checkbox sibling pattern (`:90-107`) is untouched. The alternative — an absolutely positioned link outside the button like the checkbox — would detach the org name from its flex line, so it is rejected.

- [ ] **Step 1: Write the failing tests.** `TicketQueueList.test.tsx` (add `vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }))`), `describe('TicketQueueList org link and row activation (ui-flow W03)')`: `it('links the org name to the org record without selecting the row')` → `org-record-link` href `/organizations/org-1` text `'Acme'`, `fireEvent.click(link)` → `onSelect` not called; `it('selects on row click, Enter and Space')` → `row = getByTestId('ticket-row-tk-1')`, `expect(row).toHaveAttribute('role', 'option')`, `fireEvent.click(row)`, `row.focus(); fireEvent.keyDown(row, { key: 'Enter' })`, `fireEvent.keyDown(row, { key: ' ' })` → `onSelect` called 3 times with the ticket; `it('renders no org link when hideOrg or orgName is null')` → two renders, `queryByTestId('org-record-link')` null in both.
  `TicketWorkbench.test.tsx`: `it('links the header device hostname to /devices/:id (ui-flow W03)')` → `makeTicket({ deviceId: 'dev-1', deviceHostname: 'DESKTOP-123' })`, `getByTestId('device-record-link')` href `/devices/dev-1` (the rail's `ticket-workbench-device-link` is a different testid).
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/tickets/TicketQueueList.test.tsx src/components/tickets/TicketWorkbench.test.tsx` — Expected: FAIL (new cases).
- [ ] **Step 3: Implement** the structure above; `:143` becomes `{!hideOrg && ticket.orgName && <EntityLink kind="org" id={ticket.orgId} name={ticket.orgName} className="truncate" />}`. `TicketWorkbench.tsx:1155` `<a … href={`/devices?device=${ticket.deviceId}`}>` → `<EntityLink kind="device" id={ticket.deviceId ?? ''} name={ticket.deviceHostname} className="hover:text-foreground" />`.
- [ ] **Step 4: Run** `cd apps/web && npx vitest run src/components/tickets/TicketQueueList.test.tsx src/components/tickets/TicketsPage.test.tsx src/components/tickets/TicketWorkbench.test.tsx src/components/organizations/record/OrgTicketsTab` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(web): ticket queue rows link the org; workbench device link uses /devices/:id" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 7: Typecheck, full suite, PR

- [ ] `cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo exit=$?` — Expected: `exit=0` (check the echoed code, never pipe to `tail`).
- [ ] `cd apps/web && npx vitest run` — Expected: all green, including `no-silent-mutations.test.ts` (no handlers added that mutate) and `localeParity` (no keys added).
- [ ] Grep guard: `grep -rn --include='*.tsx' -F 'href={`/organizations/${' apps/web/src | grep -v test` lists only `AccountBoardTable.tsx` and `OrgBillingSettings.tsx` (the other excluded sites use `Breadcrumbs` items or a ternary href and never matched this pattern).
- [ ] Open the PR: title `feat(web): EntityLink and cross-link sweep (ui-flow W03)`, body `Closes #<sub>`, `Part of #8985`, the structure decision from Task 6, the "not migrated" list, and the attribution line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

### Task 8: Post-merge `/impeccable` critiques (findings become issues, nothing fixed here)

Run after the PR merges, against a stack on `main` (`worktree-stack` skill), signed in with a partner-scope user. Each finding is filed as its own GitHub issue (label `enhancement` — the repo has no UI/UX label — with a `Part of #8985` line); none are fixed in this wave.

- [ ] `/impeccable critique` → org record page `/organizations/:id` (Overview, Devices `#devices`, Sites `#sites` tabs) — issues filed: `#____`
- [ ] `/impeccable critique` → device detail page `/devices/:id` (header links from Task 4, tab strip) — issues filed: `#____`
- [ ] `/impeccable critique` → `/devices` list in fleet view (linked cells from Task 3, column chooser) — issues filed: `#____`
- [ ] Post the three issue lists as a comment on the wave sub-issue, then `complete_wave`.

## Non-goals
- No `Breadcrumbs` change; no `AccountBoardTable` change; no new locale keys; no column-preset or `onSelect` changes in `DeviceList` (W01 owns those).

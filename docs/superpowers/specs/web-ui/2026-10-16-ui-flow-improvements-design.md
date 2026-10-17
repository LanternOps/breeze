# UI flow improvements: org switcher, org record, recents, entity links

**Date:** 2026-10-16
**Status:** Approved 2026-10-16 (Todd)
**Scope:** `apps/web` only. No API changes, no migrations.

## Intent

Techs bounce between customers all day. Today that costs more clicks and more
reading than it should: a company's address is buried under Settings → Billing,
the org switcher row spends its only badge slot on "Active" (which nearly every
row says), the org record's Devices tab is broken in three small ways, the
device page's "Devices" crumb goes to whatever org happens to be selected, and
org/site/device names are plain text in most lists. This design fixes those and
makes "Customer › Page" a two-click move from anywhere.

Four independent pieces, each its own PR and wave sub-issue:

| Wave | Piece | Size |
|---|---|---|
| A | Fixes + address + site columns + crumb | small |
| B | Org switcher: Customer › Page columns | medium |
| C | Recent: mixed sidebar list + dashboard card | small |
| D | `EntityLink` + cross-link sweep + `/impeccable` critique | small, mechanical |

Suggested order: A, B, D, C. None blocks another.

## Goals

- Billing address visible on the org record without opening settings.
- Sites tab shows what a site is (address, contact), not just its timezone.
- Org record Devices tab renders the same data as `/devices` and rows navigate.
- No raw floats anywhere a CPU/RAM percent is printed.
- From the header switcher: pick a customer and a destination in two clicks,
  with live counts and the address in view.
- "Devices" crumb on a device page lands on that device's org, never a
  different one.
- One list of recently opened things (devices, orgs, tickets, pages) in the
  sidebar and on the dashboard.
- Org, site, device, ticket names are links wherever they appear in a list or
  header.

## Non-goals

- Frequency-weighted or "learning" recents. Recency only, using the existing
  local store. (Todd, 2026-10-16.)
- Search grammar in the switcher (`harbor tick`), and a hover card on the header
  trigger. Both are plausible follow-ups, not in scope.
- Changing what the org list API returns. Counts come from the existing
  per-org summary endpoint, fetched lazily.
- A two-column switcher on narrow viewports.
- New tables, migrations, or server-side tracking of any kind.

## Anti-goals

- **Navigation must never silently change the working org.** Only an explicit
  pick in the switcher (a row, or any destination in its pane) moves it.
  Breadcrumbs, entity links and record pages never do.
- Regressing the existing switcher behaviours pinned by `OrgSwitcher.test.tsx`
  (redirect rules, soft navigation, fleet row, search, Escape/Cmd+O/outside
  click).
- Making the `/devices` column preset worse for the sake of the embedded tab.

## Constraints (repo rules that apply)

- Every new `en` locale key is added to all 7 locales (`localeParity`).
- Interactive elements carry `data-testid`; Playwright selects by testid only.
- Aim for files under ~500 lines. `OrgSwitcher.tsx` is 330 lines; the pane goes
  in its own file. `DeviceList.tsx` is already >3000 lines; do not split it in
  this work.
- No mutations here, so `runAction` is not involved. All fetches go through
  `fetchWithAuth` / `orgFetch`.
- Hash for transient UI state (`#tab=…`), not query params.
- Multi-wave tracking: parent issue labeled `feature`, one `wave` sub-issue per
  piece, branch `feature/<parent#>-ui-flow/wave-<sub#>`, PR body `Closes #<sub>`.

## Wave A: fixes, address, site columns, crumb

### A1. Billing address on the org record header

- `OrgRecordOrg` (`components/organizations/record/orgRecordFetch.ts`) gains the
  six optional billing address fields the API already returns
  (`billingAddressLine1/2`, `billingAddressCity`, `billingAddressRegion`,
  `billingAddressPostalCode`, `billingAddressCountry`).
- `OrgRecordHeader.tsx` renders the address on its own line directly under the
  primary-contact line, formatted as `line1, line2 · city, region postal ·
  country`, empty parts skipped. Add `lib/formatAddress.ts` (none exists in
  `apps/web`); wave B reuses it.
- When all six are empty: "No billing address" with a link to the existing
  billing settings tab for this org (`/settings/organizations/:id`, billing
  tab). Same muted style as "No primary contact".
- Test: `OrgRecordHeader.test.tsx` gets a case for the formatted address and
  one for the empty state.

### A2. Sites tab shows full site info

- `settings/SiteList.tsx` `Site` type gains `address?` (`{line1,line2,city,
  state,postalCode,country}`) and `contact?` (`{name,email,phone}`), matching the
  `sites` jsonb shapes in `useSiteCrud.ts`.
- Columns become: **Name** (navigates to `/settings/sites/:id`, as today),
  **Address** (`line1 · city, state`, or "—"), **Contact** (name, phone as a
  `tel:` link, or "—"), **Timezone**, **Devices**, Actions. `OrgSitesTab` is
  the only consumer of `SiteList`.
- No API change: `GET /orgs/sites` spreads the full row
  (`routes/orgs.ts` ~3103), so `address` and `contact` already ship.
- Test: `SiteList` test for address/contact rendering and the "—" fallbacks.

### A3. Org record Devices tab

Three defects, one cause: `OrgDevicesTab.tsx` passes raw API rows to the shared
`DeviceList`, skipping the transform `DevicesPage.tsx:740-790` applies.

- Extract that transform into
  `components/devices/deviceRowTransform.ts` (export one function that maps an
  API device row to the `DeviceList` row shape: `os`, `lastSeen`, `siteName`,
  rounded `cpuPercent`/`ramPercent`, etc.). `DevicesPage` and `OrgDevicesTab`
  both call it. Unit-test it directly with a raw API row fixture, including a
  CPU value like `37.456789012` → `37.5` (`toPercent` rounds to one decimal,
  matching `/devices` today).
- `DeviceList`'s `metricBar` rounds through `toPercent` itself, so no future
  caller can leak a raw float. `DeviceCard` does the same for its two percents.
- `OrgDevicesTab` passes `onSelect` → navigate to `/devices/:id`. The hostname
  cell becomes an `EntityLink` in wave D; here, row click is enough. Note
  `onSelect` also backs the row's Edit action in `DeviceList`, so Edit
  navigates too; that is acceptable.
- Embedded default columns: `hostname, site, os, status, cpu, ram, lastSeen`
  (no `class`, `role`, `organization`), persisted under their own localStorage
  key (`breeze.devices.columns.orgTab`) so a tech's `/devices` preset does not
  cramp the tab and vice versa. The column chooser still works in the tab.
  `columnVisibility.ts` hard-codes its storage key; parameterise its
  read/write helpers rather than forking them.
- The 200-row cap stays; it is documented in the file and out of scope here.
- Fix `OrgDevicesTab.test.tsx`'s fixture to use a **raw** API row so the test
  would have caught this.

### A4. Device page "Devices" crumb

`DeviceDetailPage.tsx:742-754` builds `[org] › Devices › hostname`.

- Rule for the Devices crumb href and for the page's back button:
  - working org is fleet view (`null`) or equals `device.orgId` → `/devices`
    (the list the tech came from, filters intact);
  - otherwise → `/organizations/${device.orgId}#devices` (that org's devices,
    no context switch; the record's tab hash is a bare `#<tab>`, see
    `tabFromHash` in `orgRecordTabs.ts`).
- Put the rule in a small pure helper next to the page (e.g.
  `deviceListCrumbHref(currentOrgId, deviceOrgId)`) and unit-test the three
  cases. Extend `DeviceDetailPage.orgBreadcrumb.test.tsx` for the mismatch case.

## Wave B: org switcher, Customer › Page columns

Chosen from three mockups (`.superpowers/brainstorm/…/org-switcher.html`,
option B). The status badge leaves the rows; the panel becomes two columns at
`md` and up.

### Layout

- Panel: `w-80` below `md` (single column, today's behaviour minus the badge),
  `w-[36rem]` at `md+` with a 250px left column and a right pane.
- **Above the columns, unchanged:** the "All organizations" fleet row and
  separator.
- **Left column, top to bottom:** search (same ≥6-orgs threshold), a **Recent**
  group (≤3 orgs, see below), then **Organizations** (full list, as today).
- **Row:** Building2 icon, a 7px status dot for any non-`active` status (amber
  for `trial`, red for `suspended`, muted for the rest; `title` = status
  label), name, check mark when current, chevron when highlighted. Row click =
  `applyContext(org.id)` exactly as today.
- **Right pane** reflects the highlighted org. Initial highlight: the current
  org, or the first row in fleet view.
  - Header: name + `StatusBadge` (moves here from the row), then the billing
    address (same `formatAddress` as A1, from the org row; the `Organization`
    type in `orgStore.ts` gains the six optional fields), then primary contact
    name with a `tel:` link (from summary, see Data).
  - Destinations, each a full-width row with icon, label, count on the right:

    | Destination | Target |
    |---|---|
    | Overview | `/organizations/:id` |
    | Devices | `/devices` |
    | Tickets | `/tickets` |
    | Alerts | `/alerts` |
    | Sites | `/organizations/:id#sites` |
    | Billing | `/organizations/:id#billing` |

    **Every destination switches the working org** (Todd, 2026-10-16: "we are
    in the context switcher as a whole, so selecting any sub item should be
    expected to switch the working org"). Each one calls
    `applyOrgSwitch(org.id, toast, target)`; the `destination` argument
    bypasses the redirect table, so an org-record target is not bounced to
    `/organizations`. A destination that matches the current org and page is
    a plain navigation (no toast). Destination visibility mirrors the org
    record's `visibleTabs` gating exactly: permission **and**
    `serviceManagementMode` (Tickets hidden when the module is `off`, Billing
    hidden when `off` or `external`), so the pane never offers a door the
    sidebar hides. Hidden, not disabled.
  - Counts: Devices `42 · 3 offline` (offline in warning colour when >0),
    Tickets `2 open`, Alerts `1 critical` (error colour when >0, else `none`),
    Sites `3`. Billing and Overview carry no count.
  - One-line hint at the bottom: "Click a name to switch · click a page to
    switch and go there". Hidden on narrow.

### Recent group

- `orgStore` gains `recentOrgIds: string[]` (max 3, most recent first),
  persisted with the rest of `breeze-org`, updated inside `applyOrgSwitch` on
  every successful switch to a real org (not fleet view). The current org is
  excluded from the rendered group; ids no longer in `allOrgs` are skipped.
- Group hidden when empty or when the search box has text.

### Data

- Address: from the org row already in the store (partner-scope list returns
  the full row). Org-scope projections omit it; the pane simply shows nothing.
- Counts and contact: `GET /orgs/organizations/:id/summary` (exists,
  `routes/orgSummary.ts`; partner/system scope, permission-gated sections
  absent rather than zero). Fetched lazily when a row becomes highlighted, after
  a ~120ms hover-intent delay, through `orgFetch(id)`. In-memory `Map` cache
  per panel open, cleared when the panel closes. Skeleton placeholders for the
  counts while loading; on error, destinations render without counts and no
  toast (it is a convenience surface).
- The summary route is `requireScope('partner','system')` and runs ~8 queries
  per call. Do not fetch at all for org-scoped sessions (the store's rows lack
  the partner-only fields, or the first call 403s: remember and stop). Apply
  the same intent delay to keyboard `↑`/`↓` as to hover, so holding an arrow
  key does not fan out one request per row.
- No new API routes.

### Keyboard and a11y

- `↑`/`↓` move the org highlight (pane follows); `Enter` switches; `→` or `Tab`
  moves focus into the pane; `↑`/`↓` inside the pane; `Enter` activates;
  `←` or `Shift+Tab` returns to the list; `Esc` closes. Cmd+O toggle and
  click-outside unchanged.
- Pane destinations are `<button>`s (they all switch, then navigate) with
  accessible names like "Devices, Acme Dental, 42".
- Rows stay `<button>`; nothing interactive is nested inside them.

### Files

- `OrgSwitcher.tsx` keeps the trigger, panel shell, left column, keyboard
  wiring. New `OrgSwitcherPane.tsx` renders the right pane. New
  `useOrgSummaryCache.ts` (or similar) owns the lazy fetch + cache.
- Locale keys for destination labels, counts, hint, "Recent", status dot
  titles.

### Tests

- Keep every existing `OrgSwitcher.test.tsx` and `OrgSwitcher.statusBadge`
  case green (the badge test moves to the pane). Two traps: the test helper
  `openDropdownAndClickOrg` takes the first `button` whose text includes the
  org name, and the roving-focus code uses `panelRef.querySelectorAll('button')`;
  pane buttons named "Devices, Acme Dental, 42" would match both. Scope the
  roving query to the left column and keep list rows before the pane in DOM
  order.
- New: highlight fetches summary once and reuses it; Devices destination calls
  `applyOrgSwitch` with `'/devices'`; Billing calls it with
  `'/organizations/:id#billing'` and the store ends up on that org; keyboard
  path list → pane → activate; Recent group order and exclusion of the
  current org; narrow viewport renders one column.

## Wave C: Recent (mixed list)

Uses `stores/recentsStore.ts` as is, except `MAX_RECENT_DEVICES` and
`MAX_RECENT_PAGES` both become 10 so either kind can fill the merged list.

- **What counts as an entry (my call):** recent *things*, not navigation.
  Devices (`recordDevice`) plus pages that carry an item `name` (every detail
  record wired through `usePageItemName`: orgs, tickets, alerts, sites,
  invoices, scripts, policies, monitors, and so on). List and hub pages
  (`/`, `/devices`, `/settings/users`) are recorded as today but never shown
  here. The page currently open is excluded. Pure recency, no reserved share
  for devices.
- **Merge:** by timestamp descending, de-duplicated by href, top 10. Icon by
  kind: Monitor for devices, Building2 for `/organizations/:id`, Ticket for
  `/tickets/:id`, Bell for `/alerts/:id`, MapPin for `/settings/sites/:id`,
  FileText otherwise. Label = item name. Put filter + merge in a pure
  `selectRecentEntries()` next to the store and unit-test it (including the
  "hub page excluded" and "current page excluded" cases).
- **Sidebar:** the "recent devices" sub-list nested under Devices & Assets is
  replaced by a top-level collapsible **Recent** group placed directly under
  the Dashboard item, listing the merged entries (labels mode only; the icon
  rail hides it as today). Collapse state persisted under `sidebar-recent`
  (replacing `sidebar-recent-devices`). Hidden when empty.
- **Dashboard:** a "Pick up where you left off" card showing the top 8 merged
  entries with icon, name, kind label, relative time. Placed in the same grid
  row as the audit "Recent activity" feed; hidden entirely when empty (no
  empty-state card). Builder picks the exact slot.
- Command palette unchanged.
- Tests: `Sidebar.recents.test.tsx` updated for the new group; dashboard card
  test; `selectRecentEntries` unit test.

## Wave D: `EntityLink` and the cross-link sweep

- New `components/shared/EntityLink.tsx`:
  `{ kind: 'org'|'site'|'device'|'ticket'|'alert'; id: string; name: string;
  hash?: string; className?: string }` (`hash` because two existing org links
  deep-link to `#billing` / `#contacts`). Href map: org `/organizations/:id`, site
  `/settings/sites/:id`, device `/devices/:id`, ticket `/tickets/:id`, alert
  `/alerts/:id`. Renders `<a data-testid="<kind>-record-link">`; the org kind
  keeps the existing `org-record-link` testid. Always calls
  `stopPropagation()` on click so it is safe inside clickable rows. Quiet link
  style (`hover:underline`, inherits colour), matching the existing hand-rolled
  org links.
- Convert plain-text names to `EntityLink`:
  - `DeviceList.tsx` Organization and Site cells; hostname cell becomes a
    device link (row click still works).
  - `DeviceDetails.tsx` header sub-line: add the org name (link) before the
    site name (link).
  - `DeviceCard.tsx` site name.
  - `AlertList.tsx` org cell.
  - `TicketQueueList.tsx` org name. The row is a `<button>`; an `<a>` inside
    it is invalid HTML, so restructure the row (a `div` with `role="button"`
    and keyboard handling, or move the link out of the button) rather than
    nesting.
  - `dashboard/AlertsFeed.tsx`: the row is already an `<a>` to the device
    wrapping `hostname · orgName`. Restructure to a `div` row whose click still
    goes to the device, with the hostname and org name as sibling
    `EntityLink`s inside it (no nested anchors). Keep
    `AlertsFeed.title.test.tsx` green.
  - `OrgOverviewTab.tsx` critical-alert device hostname.
  - Migrate the seven existing hand-rolled org links to `EntityLink`.
  - `TicketWorkbench.tsx:1155` device link uses `/devices?device=…`; make it
    `/devices/:id` like line 1848.
- No behaviour change beyond links; existing testids preserved.
- After merge: run `/impeccable` critique on the org record page, device
  detail page, and `/devices`. File each finding as its own issue; none are
  fixed in this wave.

## Left to the builder

- Exact Tailwind classes, spacing, hover-intent timing, skeleton shapes.
- Test file layout and fixture names.
- Dashboard grid slot for the Recent card.
- Name and shape of the summary cache hook and the row-transform module.
- Whether `formatAddress` lives in `lib/` or `packages/shared` (prefer `lib/`
  unless the portal needs it).

## Decisions made in this document (not Todd's)

1. ~~Record-tab destinations do not switch~~ Superseded: Todd ruled that every
   pane destination switches the working org (see Wave B).
2. Devices crumb goes to `/devices` when the working org already matches (or
   fleet view), else to the org's Devices tab.
3. Embedded devices table gets its own column preset and storage key.
4. Recent group in the switcher = last 3 switched-to orgs, current excluded.
5. Sidebar Recent becomes a top-level group under Dashboard, replacing the
   nested recent-devices list.
6. Search grammar and trigger hover card are deferred.
7. `EntityLink` always stops propagation.
8. Pane destinations are gated like the org record's tabs (permission and
   service-management mode), not permission alone.
9. Recent shows only items with a name (records) plus devices; hub pages are
   never listed; the current page is excluded.
10. `AlertsFeed` rows keep row-level device navigation with the two names as
    sibling links.

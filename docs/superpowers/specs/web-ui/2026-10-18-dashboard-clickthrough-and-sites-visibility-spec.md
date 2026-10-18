# Dashboard click-through contract and Sites visibility

**Date:** 2026-10-18
**Status:** Draft. Awaiting Todd's decisions (§8).
**Issues:** #6721 (anchor), #6720 (co-anchor). Both were filed by Discord triage, and the reporters do not read GitHub.
This spec does not depend on asking them anything. Every ambiguity is settled in the text or listed as an Open
Decision.
**Scope:** the dashboard (`apps/web/src/components/dashboard/**`), the list pages those widgets link to, the device
Overview "Score factors" panel, and how users find and use Sites. This document decides intent. It contains no plans
and no code. Each wave in §9 gets its own plan or a fast-track PR.

Evidence labels: **verified** means the author re-read the code on `origin/main` at `d49876c54d`. **reported** means
an exploration pass cited file:line and the author did not re-read it. **inferred** means a conclusion drawn from
verified facts that was not observed running.

**Design quorum (CLAUDE.md):** the author's positions went to an independent `codex exec` review (read-only,
`xhigh`). It agreed with the direction of every decision and required changes. Each change was checked against the
code before it was folded in. §10 lists them. No disagreement was left open.

---

## 1. Problem

### 1.1 #6721: dashboard numbers are not a way in

The reporter wants every widget to click through to "review actions required". For Patch Compliance they want to see
the non-compliant machines and the compliant ones, and the same for Security Posture and Vulnerabilities. They also
propose a design principle: "Any time data is presented it should be filterable and actionable." A second user (+1)
wants the device Overview "Score factors" rows to go "right to the offending failure".

What the dashboard does today:

- **Most cards link only their title**, to an unfiltered page. `PatchComplianceCard`, `SecurityPostureCard` and
  `VulnerabilitiesCard` link the title to `/patches`, `/security` and `/vulnerabilities`. None of their numbers,
  bar segments or rows is a link. *verified*
- **The KPI tiles are whole-tile links** (`KpiStrip.tsx`, the `<a>` in the final `tiles.map`). The Critical and
  Warnings tiles both go to plain `/alerts`, so the page they open does not show the number on the tile. The tiles
  have hover styles but no explicit `focus-visible` ring. *verified*
- **Two dashboard links are broken.** The Online tile links `/devices?status=online` and the fleet card's "View N
  offline" links `/devices?status=offline`. The devices list never reads `location.search`. It reads only hash state
  (`#filtersV2=`, `#orgId=`, `#deviceClass=`, `#sort=`). Both links open an unfiltered list. *verified*
  (`components/devices/filterUrl.ts`, `components/devices/orgHash.ts`; no `URLSearchParams`/`location.search` read in
  `DevicesPage.tsx` or `DeviceList.tsx`.)
- **Two numbers are wrong as labelled.**
  - The Vulnerabilities header renders `totalFindings` as "N open findings". `/vulnerabilities/stats` computes
    `total` as `count(*)` over every finding status, including accepted ones (`services/vulnerabilityFleetSql.ts`,
    `aggregateFleetStats`). *verified*
  - The KPI "Patch compliance %" is `/patches/compliance`'s `compliancePercent`: installed items over installed plus
    pending, with container-image terms. The `/patches` page's headline is compliant devices over total devices,
    computed in `PatchComplianceView` from a device fetch capped at `limit=200`. The same label shows two different
    metrics. *verified*
- **The site page shows a device count it never receives.** `SiteDetailPage.tsx` renders `site.deviceCount ?? 0`, but
  `GET /orgs/sites/:id` returns the site row without a count, so every site reads 0 devices. Its "View all" link goes
  to plain `/devices`, not filtered to the site. *verified*
- **One dead writer.** `AlertsPage.tsx` `handleFilterBySeverity` navigates to `/alerts?severity=<s>`, but nothing
  reads that param. It only works because the in-memory `setSeverityFilter` runs first. A reload or a shared URL
  loses it. *verified*

Most destination pages already have the filters. They just cannot be set from a link:

| Destination | Filters a link can set today | Filters that exist in-page only |
|---|---|---|
| `/devices` (`DevicesPage` → `DeviceList`) | `#filtersV2=<base64url group>` (any chip field, including `status`, `osType`, `orgId`, `siteId`), `#orgId=`, `#deviceClass=`, `#sort=` | search text, VPN facet, show-removed |
| `/patches` (`PatchesPage` → `PatchComplianceView`) | tab only (`#rings`, `#patches`, `#compliance`, `#jobs`) | `statusFilter`: all, needs-patches, critical, reboot, 3rd-party, compliant |
| `/vulnerabilities` (`VulnerabilityFleetPage`) | `#software`/`#cves` and a group selection | `VulnFleetFilters`: severity, status, kevOnly, patchAvailable, expiringWithinDays |
| `/security/vulnerabilities` (threats list) | `#severity=critical\|high\|medium\|low` | status, category, search |
| `/alerts` (`AlertsPage`) | `?orgId=` (one-shot org switch, #9108), `#hideAiNoise` | status, severity, device, date range, search |
| `/tickets` (`TicketsPage`) | `#<ticket selection>&sort=&type=`. The queue tab is component state and defaults to `open` | tab (mine, unassigned, open, breaching, closed) |

*reported*, with spot checks for `/devices`, `/patches`, `/security/vulnerabilities`, `/tickets` and
`VulnFleetFilters`.

### 1.2 #6721: "Score factors" stop at a summary

`DeviceReliabilityPanel.tsx` renders one row per reliability factor (`uptime`, `crashes`, `hangs`, `serviceFailures`,
`hardwareErrors`). Rows are plain `div`s. For three factors (`OFFENDER_FACTORS`) a "details" button opens an in-panel
offenders list. The offender rows themselves link nowhere, and `crashes` has no drill-down at all. *verified*

### 1.3 #6720: Sites are hard to find and use

The report bundles four asks. This spec scopes each one explicitly:

| # | Ask (paraphrased) | In scope? |
|---|---|---|
| A | Finding and adding sites takes Organizations → org → Sites, even with the org already selected | **In** (§4) |
| B | The Devices list reached from there has an empty Sites column, and there is no way to move one device or a batch to a site | **In.** The empty column is already fixed (§4.3). Moving devices from the list and in bulk is in scope (§4.4) |
| C | Site identity by WAN IP or subnet, a "master site", and "last seen site" | **Out** (§6). This belongs to topology |
| D | Automations that target a site filter, a device filter, or OS type | **Out** (§6). Separate feature |

What the code shows for A and B:

- **No nav entry reaches a sites list.** `Sidebar.tsx` and `lib/settingsCatalog.ts` have no Sites item.
  `pages/settings/sites/index.astro` is a 301 to `/organizations` (since #5737). The only list of sites is the org
  record's Sites tab (`OrgSitesTab.tsx`). *verified*
- **Org-scoped users cannot reach any sites list.** `Organizations` is `partnerScopeOnly`, and
  `OrganizationRecordPage` renders `org-record-unavailable` for an org-scoped session. The API serves them
  (`GET /orgs/sites` and `POST /orgs/sites` accept `requireScope('organization', 'partner', 'system')`, gated on the
  `sites:read`/`sites:write` permissions). So the web UI hides a capability the API grants. *verified*
- **There is no global site selection, by design.** `orgStore.ts` removed `currentSiteId`. The comment there says
  "site handling moved into the pages that support it". `OrgSwitcher` no longer has a site submenu. *verified*
- **The device list can already filter by site**, but only through the generic chip picker (`siteId` field,
  `filter-site-picker`). Nothing links into it. *reported*
- **Moving a device to a site works for one device at a time**, from the device page's actions menu
  (`DeviceActions` "change-site" → `ChangeSiteModal` → `PATCH /devices/:id { siteId, expectedSiteId }`). The list
  has no row action and no bulk action, and the API has no bulk site-move route. *reported*, with the PATCH route
  spot-checked (it requires MFA).

## 2. Users and scope

| Viewer | Dashboard scope | What links may carry | Sites surface |
|---|---|---|---|
| **Partner admin, fleet view** (`allOrgs`) | All orgs the partner can reach | Filters only. The org is ambient (§3.4) | Cross-org sites list with an Organization column |
| **Partner user, one org selected** | That org | Filters only. The destination must honor the same `currentOrgId` (§3.4 parity) | That org's sites |
| **Org-scoped user** | Their org | Filters only | Their org's sites (new: today they have none) |
| **Site-scoped user** (`allowedSiteIds` set) | Only their sites. Every dashboard summary endpoint narrows by `allowedSiteIds` | Filters only. The destination lists narrow by the same allowlist | Only sites in their allowlist |

Site narrowing on the summary endpoints is *reported* for `/devices/stats` (`buildDeviceScope`), `/alerts/summary`
(`alertSiteScopeCondition`), `/patches/compliance` (`perms.allowedSiteIds`, spot-checked), `/security/dashboard`
(`siteAllowlistOf`) and `/vulnerabilities/stats` (`perms.allowedSiteIds`). For the last one, the author verified that
`requirePermission` populates `permissions` (`middleware/auth.ts`), so the allowlist is not silently empty.

The **portal** (`apps/portal`) is out of scope.

## 3. Proposed design: the click-through contract

### 3.1 The rule (checkable)

The reporter's principle, restated so a test can enforce it:

> **R1.** Every number the dashboard renders is one of three things:
> - a **count link**: its destination's initial view lists exactly the entities the number counts;
> - an **affected link**: the number counts sub-items (findings, device×patch rows, events), so the number stays plain
>   text and a separate text link names what it opens ("View critical CVEs");
> - **exempt**: registered as not clickable, with a written reason.
>
> Section links (a card title, or a KPI tile whose number has no matching list) open the page that owns the topic and
> claim no count.
>
> **R2.** A link never claims a count its destination will not show.
>
> **R3.** A link carries the filter by hash state on the destination page. It never carries the org. The org scope is
> ambient (§3.4).
>
> **R4.** A link renders only when the viewer can open its destination. Otherwise the number renders as plain text
> (§3.5).

**Enforcement.** Every number on a dashboard card renders through one helper, `<DashboardMetric metric="<key">`. The
helper takes its href, kind and gate from the `DASHBOARD_METRICS` registry (§3.6), so an unregistered key fails to
typecheck. Two tests close the gaps:

1. **Registry test.** Every entry is `count`, `affected`, `section` or `exempt`, and every `exempt` entry has a reason.
2. **Inventory test.** Render each card with fixture data. Assert that every digit run in the card's text sits inside
   a `DashboardMetric`, or inside an element on a short allowlist (dates, "updated Xs ago"). This catches a number
   added without the helper, which an opt-in `data-metric` attribute could not.

**Count parity is "same predicate, same scope", not "same instant".** Summary and list fetch at different times, so
a number may differ from the list by whatever changed in between. Parity means the two count the same predicate under
the same org and site scope, at the same grain. Where they cannot (different status sets, different grains, a capped
list), the entry is `affected`, `section` or `exempt`.

### 3.2 Widget map

Hash shapes in **bold** do not exist yet. Their destination pages must learn them (W2, §9). Every devices link adds
`#deviceClass=agent`. `/devices/stats` counts only agent devices, and without it the list opens on the viewer's
remembered class (`resolveDeviceClass`), which may be "all" or "network".

| Widget → element | Today | Target | Kind | Wave |
|---|---|---|---|---|
| KPI **Total devices** | `/devices` | `/devices#deviceClass=agent` | count | W1 |
| KPI **Online** | `/devices?status=online` (broken) | `/devices#deviceClass=agent&filtersV2=<status equals online>` | count | W1 |
| KPI **Critical** (`bySeverity.critical + high`, active only) | `/alerts` | `/alerts`**`#status=active&severity=critical,high`** | count | W2 |
| KPI **Warnings** (`bySeverity.medium`, active only) | `/alerts` | `/alerts`**`#status=active&severity=medium`** | count | W2 |
| KPI **Open tickets** | `/tickets` | unchanged. The queue already opens on the `open` tab | count | — |
| KPI tickets sub-line "N unassigned" | text | stays text. The tile is already one link (§3.3) | exempt | — |
| KPI **Patch compliance %** | `/patches` | unchanged, as a section link until Open Decision 5 aligns the metric | section | — |
| Alerts feed "View all", rows, hostname/org links | links | unchanged (#8985 W03) | — | — |
| Alerts feed header counts | text | follow the KPI Critical/Warnings links when the count and status set match. Otherwise exempt | count / exempt | W2 |
| Fleet card title | `/devices` | `/devices#deviceClass=agent` | section | W1 |
| Fleet header "N of M online" | text | stays text. The legend carries the same numbers as links | exempt | — |
| Fleet bar legend: Online / Offline / Other | text | `#deviceClass=agent&filtersV2=` status equals online / offline / **in** the remaining `byStatus` keys | count | W1 |
| Fleet card offline rows | `/devices/:id` | unchanged | — | — |
| Fleet card "View N offline" | `/devices?status=offline` (broken) | `/devices#deviceClass=agent&filtersV2=<status equals offline>` | count | W1 |
| Security card title | `/security` | unchanged | section | — |
| Security score `/100` | text | `/security/score`, after scope parity is fixed (below) | count | W2 |
| Security 30-day sparkline | tooltip only | stays non-link. Its caption becomes a link to `/security/trends`, after scope parity is fixed | exempt (chart) + section | W2 |
| Security "N at risk" | text | a device list with the same at-risk computation (note below), or exempt | count / exempt | W2 |
| Security "N active threats" | text | `/security/vulnerabilities`**`#status=active`** | count | W2 |
| Patch card "%" headline | text | same as the KPI tile | section | — |
| Patch card "X of Y devices compliant" | text | two links: compliant → `/patches`**`#status=compliant`**, not compliant → **`#status=needs-patches`**. Needs the page's 200-device cap removed (W2) | count | W2 |
| Patch bar Installed / Pending / Failed | text | stays text. These count device×patch rows, and no list shows that grain | exempt | — |
| Patch "N critical patches pending" | text | text plus an affected link "View devices" → `/patches`**`#status=critical`** | affected | W2 |
| Patch "N unrated pending" | text | stays text. No list filters on unrated severity | exempt | — |
| Patch "N images not checked" | text | stays text | exempt | — |
| Vulns title | `/vulnerabilities` | unchanged | section | — |
| Vulns header "N open findings" | text, counts every status (bug) | fix the number to open findings, then affected link "View open CVEs" → **`#cves&status=open`** | affected | W2 |
| Vulns "Critical open" (findings) | text | affected link "View critical CVEs" → **`#cves&status=open&severity=critical`** | affected | W2 |
| Vulns "KEV: N CVEs · M devices" | text | CVE count → **`#cves&status=open&kev=1`** (count, distinct CVEs). Device count stays text | count + exempt | W2 |
| Vulns "Patch ready" (findings) | text | affected link → **`#cves&status=open&patchAvailable=1`** | affected | W2 |
| Recent activity "View all" | `/audit` | unchanged | — | — |
| Recently viewed | links | unchanged | — | — |

**Security scope parity (prerequisite for every security link).** `/security/dashboard` honors the selected org
(`query.orgId`). The trends route (`routes/security/compliance.ts`, `/trends`) derives scope only from the session:
`auth.orgId`, else every accessible org. So a partner with one org selected sees that org's score on the dashboard and
the fleet's trend on `/security/trends`. Codex also reports that the score breakdown ignores `orgId`. W2 fixes
destination scope first and adds the links after. *verified* for trends, *reported* for the score breakdown.

**Note on "at risk".** `/security/dashboard` counts devices whose posture `riskLevel` is `medium` or `high`. Only when
the queried population has **no posture rows at all** does it fall back to counting agent status `at_risk`.
*verified* The W2 plan must pick a list that uses the same computation (candidates: `/security/score`, or
`/devices/posture` → `FleetPostureReport`). If neither does, the entry is exempt.

### 3.3 Link anatomy and accessibility

- **One target per tile → whole-tile link.** The KPI tiles keep their whole-tile `<a>`. A tile never contains a
  second interactive element. That is why the tickets "N unassigned" sub-line stays text.
- **More than one target per card → explicit links, no card link.** Cards get no wrapping `<a>` and no click handler
  on the card body. The title stays a link. A count link makes its **label plus number** the link text, so the
  accessible name reads "Critical open 12", never "click here" or a bare number. An affected link's text names the
  destination ("View critical CVEs").
- **No nested anchors.** A row that is itself clickable may contain links only through the #8985 W03 pattern
  (`AlertsFeed`: the row is a `div` with a click handler, and its links are siblings that stop propagation). New card
  content does not add clickable rows.
- **Focus order is DOM order**: title, then metrics top to bottom, then the footer link. W1 adds a `focus-visible`
  ring to the KPI tiles and every new link, since the tiles have none today. Hover and resting affordance follow
  #9033 (links must look like links at rest, not only on hover).
- **Color is never the only signal.** Existing legend dots stay `aria-hidden`, and the label carries meaning.
- **Charts.** The `SegmentedBar` bar stays `role="img"`. Its legend entries become the links. The `Sparkline` stays
  non-interactive, because its points are samples, not entities. Neither chart becomes a click target itself (no
  hit-testing segments).
- **Test ids.** Every new link gets a `data-testid` (§9.3).

### 3.4 Org and filter transport: hash, and why `?orgId=` stays an exception

CLAUDE.md puts transient UI state in `window.location.hash`. The devices list (`#filtersV2=`) and the threats list
(`#severity=`) already follow it. New filter params follow it too.

The dashboard always shows the **global working scope** (`useOrgStore.currentOrgId`, or fleet view). `fetchWithAuth`
injects that org into API calls. So a dashboard link has **no org to carry**. Leaving it out also respects the UI-flow
rule that "navigation must never silently change the working org" (2026-10-16 UI-flow spec, anti-goals).

**Ambient scope is not automatic parity.** An API route can ignore the injected `orgId` (the security trends route
above does). Every count link's arrival test (§7) must assert that the destination's fetch is scoped to the same org
as the dashboard's.

Two existing deep links do carry an org, and they stay as they are:

- `/alerts?orgId=` (`useOrgIdParamSwitch`, #9108/#9167) is an **explicit, toasted org switch** from an org record.
  It is a navigation side effect, not UI state. It changes the global scope and strips itself.
- `/devices#orgId=` (`orgHash.ts`, #3205) pins the list to an org from a coverage notice. It is consumed one-shot.

These are two transports for the same intent. Unifying them is outside this spec (§6). The rule here: **dashboard
links never add either one.** A link from an org-scoped page to a filtered list (the Sites page in §4) uses whatever
transport that destination already honors (`#orgId=` for devices).

### 3.5 Gating: plain text, not a disabled link

Each `DASHBOARD_METRICS` entry names its destination's **nav visibility predicate**: the same check the sidebar uses
for that page. That is the `requiredPermission` **plus** module gates, such as the service-management mode that hides
Tickets when a partner runs `off`. When the viewer fails the predicate, the number renders as plain text, with no
disabled-link styling and no tooltip. The number still informs. A disabled link adds noise and invites a click that
does nothing.

Disabled-with-reason is right for an **action** the viewer could take with a different selection (§4.4's mixed-org
bulk move). It is wrong for a read link the viewer can never use.

**Fleet view.** A destination that cannot render fleet view must not be linked in fleet view. The W1 and W2 plans
verify each destination's endpoint in fleet view before linking. The patch compliance *export* needs an org, but the
view does not.

### 3.6 One producer for every link

`components/contracts/deviceCoverageLinks.ts` is the precedent: the one producer of device-list deep links, built
from the list's own hash encoders so producer and consumer cannot drift. Follow it. A new
`components/dashboard/dashboardLinks.ts` builds every dashboard href from each destination's own encoder
(`encodeFilterToHash` and the device-class writer for devices, and new exported encoders for patches, alerts,
vulnerabilities and threats in W2). It also holds the `DASHBOARD_METRICS` registry:
`key → { kind: 'count' | 'affected' | 'section' | 'exempt', href?(data), visible(viewer), reason? }`.

Each destination's parser and the producer's encoder get a round-trip test: encode, then parse, and get back the same
filter.

### 3.7 Score factors (#6721 second ask)

The reliability score counts events over windows of up to 90 days (uptime). The device tabs show narrower windows
(Performance charts reach at most 30 days, per codex). So a factor link must open **the evidence**, not a nearby
chart.

- **Offender factors** (`serviceFailures`, `hardwareErrors`, `hangs`) and **`crashes`**: each problem row gets one
  explicit text link to the event log tab, carrying a **source/event filter and the scoring window in the hash**
  (`#eventlog/<filter>`, following the `#anomalies/<id>` and `#scripts/<id>` sub-selection precedents in
  `DeviceDetails.tsx`). Offender rows in the drill-down link the same way, one offender per link. The event log tab
  must learn that sub-hash. That is W4.
- **`uptime`**: exempt. No device tab shows 90-day availability. The row's evidence text already states the number.
  Revisit if an availability history view is built.
- If the event log cannot filter to an offender's source, the link opens the unfiltered tab and is labelled "Open
  event log", not "View N events". It never claims a filtered view it does not deliver (R2).

## 4. Proposed design: Sites visibility

### 4.1 A Sites list everyone with `sites:read` can reach

Add a **Sites** nav item gated on `{ resource: 'sites', action: 'read' }`, **not** `partnerScopeOnly`, in the Fleet
Management section next to Device Groups. Placement is Open Decision 1.

It opens a **Sites list page** that:

- in fleet view lists every site the viewer can reach, with an **Organization** column, from `GET /orgs/sites` with no
  `organizationId` (it returns all accessible sites; *reported*);
- with an org selected (or for an org-scoped user) lists that org's sites;
- reuses `SiteList` (search at 6 or more, overflow menu from #9022) and `SiteModals`;
- has **Add site**, gated on `sites:write`. In fleet view the modal requires an org pick first. With an org selected
  it is pre-filled. The org is captured when the modal opens, so an org switch mid-edit cannot retarget the write;
- links each site's device count to `/devices#orgId=<org>&deviceClass=agent&filtersV2=<siteId equals id>`, through a
  `deviceCoverageLinks.ts`-style producer.

**`useSiteCrud` needs a fleet mode.** Today `useSiteCrud(orgId)` returns nothing and cannot submit when `orgId` is
null (*reported*). W3 extends it to list across orgs and to take the org per write. It does not fork a second CRUD
hook. Edit and delete in fleet view use each row's own org.

**Route.** Revive **`/settings/sites`** as this page, instead of its 301. Site detail already lives at
`/settings/sites/[id]`, and `EntityLink` maps `site` there. A new `/sites` root would move every site URL for no user
gain. Two consequences the plan must handle:

- `lib/routeScope.ts` classifies every `/settings/*` path as `partner-settings`, which hides the fleet scope line. Add
  explicit `org-or-all` entries for `/settings/sites` and `/settings/sites/[id]` ahead of the catch-all.
- `SiteDetailPage`'s breadcrumbs (Settings → Organizations → site) and Back return to the Sites page, not to
  Organizations.

The org record's Sites tab stays. It is the org-centric view, and the new page is the site-centric one. Both use the
same `useSiteCrud`. This is not two homes for one setting (`docs/agents/settings.md`): sites are records, not
settings.

### 4.2 Single-site orgs: always show

Show the Sites item to every viewer with `sites:read`, including partners whose orgs all have one site. The reporter's
first need was **adding** a site. Hiding the entry until a second site exists hides the one control that creates it.
This adds no setting and no persisted state. Open Decision 2 records the alternatives.

### 4.3 The empty Sites column: already fixed

The reporter's path (Organizations → org → Devices tab) rendered `OrgDevicesTab` rows with no `siteName` before
#8994 (UI-flow W01, merged 2026-10-17). The pre-#8994 file fetched sites only to fill the site filter dropdown.
*verified* via `git show cd19d23239^`. #8994 moved both lists onto `deviceRowTransform.toDeviceListRow`.
`OrgDevicesTab` now resolves site names and falls back to "Unknown Site". `OrgDevicesTab.test.tsx` asserts resolved
names.

One residual limit: `OrgDevicesTab` fetches `/orgs/sites?…&limit=100`, so an org with more than 100 sites shows
"Unknown Site" for the rest. *verified* W1 switches it to `fetchAllSites`, the paged helper `DevicesPage` uses.

### 4.4 Moving devices to a site

**Eligibility.** Site moves apply to **agent devices** only. Network and manual assets have their own site field and
edit paths (`networkDevice/settings/IdentitySection.tsx` uses `ChangeSiteModal`'s `subject`/`submit` variant). The
list's existing mutation funnels already reject non-agent ids (*reported*). The row and bulk actions show only for
agent rows.

**Web.**

- **Row action on `/devices`.** Add "Move to site" to the agent row's actions, reusing `ChangeSiteModal`.
- **Bulk action.** With N selected agent devices, offer "Move to site" when **all of them are in one org**. With mixed
  orgs it is disabled, with the reason "Selected devices belong to more than one organization". Cross-org moves stay
  on `MoveDeviceOrgDialog`. The modal lists only that org's sites the viewer can reach. When the selection spans
  several source sites, the modal says "N devices from K sites" rather than naming one current site.
- The mutation goes through `runAction`. The toast reports "Moved N of M" and names the failures. A partial result
  is a warning, not a success.

**API: `POST /devices/bulk/site`** taking `{ siteId, devices: [{ id, expectedSiteId }] }`. The plan sets the batch
cap.

- **Shared move logic.** Extract the body of `PATCH /devices/:id`'s site move into one service function, and call it
  from both routes. The bulk route must not re-implement it. That function keeps PATCH's row locking, its
  transactional rewrite of denormalized tables, peripheral reconciliation, group re-evaluation, and its audit entries
  (PATCH writes two today: the route audit and the post-commit semantic move audit).
- **Isolation.** Each device moves in its own caller-scoped transaction, so one failure cannot roll back the others,
  and the outcome per device is durable. Follow the bulk-restore precedent (`lib/bulkOps.ts`) and register the route
  in `selfManagedDbContextRoutes.ts`.
- **Checks per device**: same org as the target site, `allowedSiteIds` covering both the source and the target site,
  and the `expectedSiteId` conflict check.
- **Outcomes**: `moved | already_there | conflict | forbidden | not_found | not_agent | error`, one per device.
- **Gates**: `requireScope('organization', 'partner', 'system')`, `devices:write`, and **`requireMfa()`**, matching
  PATCH.
- **MCP**: classify it in `services/mcpCoverage.ts` (the metadata lives there; `mcp-coverage.test.ts` enforces it).

Open Decision 4 weighs this against a client-side loop.

### 4.5 Getting from a site to its devices

- `SiteDetailPage` shows a real device count, and "View all" goes to
  `/devices#orgId=<org>&deviceClass=agent&filtersV2=<siteId equals id>` (W1). The count comes from adding
  `deviceCount` to `GET /orgs/sites/:id`, the same count `GET /orgs/sites` rows carry (the plan confirms the list
  query), or from a scoped device count call. Either way it is site-scoped.
- The device list's Site cell already links to the site (`EntityLink kind="site"`).
- No site switcher and no site breadcrumb segment in device views. The global site selection was removed on purpose
  (§1.3), and nothing here argues for bringing it back.

## 5. Tenancy and data model impact

**Schema: none.** No table, column, migration or RLS policy, and no cascade or export-policy registration.

- Click-through is links plus hash parsing on existing pages, plus two read fixes (the vulnerability open count and
  the site device count).
- The Sites page reads `GET /orgs/sites`, which already exists and is site-scoped.
- Partner-Wide First does not apply: no config or policy table is proposed, and no recommended option persists
  state. If Todd picks Open Decision 2's "per-user hide" option, it needs a `user_id`-scoped preference with RLS and
  the four registrations (`CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, device cascade lists if it
  has `device_id`, and the `rls-coverage.integration.test.ts` allowlist). That is one reason it is not recommended.

**Authorization and transactions: substantial, for one route.** `POST /devices/bulk/site` (§4.4) writes tenant data
across many devices at once. Its obligations are MFA, per-device site-allowlist checks on both sides, isolated
transactions, the `selfManagedDbContextRoutes` registration, the `mcpCoverage.ts` entry, and route tests:

- mixed-org rejection;
- a stale `expectedSiteId` conflict;
- a site-scoped caller moving a device out of, or into, a site outside their allowlist;
- partial success that stays committed;
- non-agent ids;
- both audit entries per moved device.

This route makes W5 a high-rigor wave (CLAUDE.md: auth and multi-tenant changes get full ceremony).

## 6. Out of scope

- **Site identity by WAN IP or subnet, "master site", "last seen site"** (#6720 ask C). This is topology work. The
  standing rule is to *suggest* a site move from network evidence and never auto-move one (the topology
  `SiteMoveSuggestion` component). Recommend a separate topology issue.
- **Automation targeting by site, device filter or OS** (#6720 ask D). Jobs and automations need their own target
  model. Filing it separately is the orchestrator's call.
- **Unifying `?orgId=` and `#orgId=`** into one org-deep-link transport. A real inconsistency (§3.4), but it is not
  needed here.
- **Making the sparkline or bar segments directly clickable.**
- **Saved dashboard filters, dashboard customization, and per-site dashboards.**
- **Product analytics instrumentation**, unless Open Decision 3 says otherwise.
- **The portal.**

## 7. Test and rollout notes

- **Registry and inventory tests (R1).** As in §3.1. They are the guard against the next card shipping dead numbers.
- **Round-trip tests.** One per new hash param: producer encode → destination parse.
- **Arrival tests.** For each count link's destination, mount with the hash set and assert two things: the filter
  control shows the filter, and the fetch carries both the filter and the dashboard's org scope.
  `DevicesPage.deepLink.test.tsx` is the pattern.
- **Regression tests for the broken links.** Assert the Online tile and "View N offline" hrefs decode to the expected
  `FilterConditionGroup` plus `deviceClass=agent`, not a `?status=` string.
- **Gating test.** A metric whose destination predicate fails renders without an `<a>`. `KpiStrip.test.tsx` already
  asserts an inert tile has no `href`.
- **Bulk move.** The route tests in §5. Web test: a mixed-org selection disables the action and shows the reason, and
  non-agent rows never offer it.
- **Sites page.** Fleet view lists across orgs with the Organization column. Add site in fleet view requires an org
  pick. An org-scoped session sees its own sites. A site-scoped session sees only its allowlist. `routeScope`
  classifies the route `org-or-all`.
- **i18n.** Every new string goes in all 8 locale folders (`en` plus 7). `localeParity.test.ts` enforces it.
- **E2E.** `data-testid` selectors only (`e2e-tests/README.md`). One dashboard → filtered list journey per
  destination family, and one Sites nav → add site → move a device journey.
- **Rollout.** No flag, because each piece is additive and individually reversible. The bulk route ships with its UI
  in one wave.

### 7.1 How success is judged without telemetry

The repo has no product analytics. `apps/web` has Sentry: error capture, 10% performance tracing, replays on 50% of
error sessions and none otherwise, and Sentry's automatic breadcrumbs (`sentry.client.config.ts`). It records no
product events and gives no click-through counts. The API has no usage counters. The UI-flow spec made "server-side
tracking of any kind" a non-goal.

So success is judged on correctness, not adoption:

1. **Coverage:** every rendered number is registered. The inventory test enforces it.
2. **Parity:** each count link's arrival test proves the destination applies the same predicate under the same scope.
3. **Reachability:** an org-scoped user can open, add and edit a site from the nav. An E2E test proves it.
4. **Recurrence:** no new Discord or GitHub report of "can't click through" or "can't find sites" in the 60 days after
   release. This is weak evidence and is labelled that way.

## 8. Open Decisions

Todd-gated product and UX calls come first.

**1. Where Sites lives in the nav (Todd).**
- (a) **Fleet Management section, next to Device Groups**, with `/settings/sites` revived. Pros: it sits with the
  device-organizing tools, no URL churn, and the top level stays at 11 items. Cons: one click deeper than top level.
- (b) A top-level item. Pros: the most visible, which is the literal ask. Cons: the top level is already long, and
  Sites is a setup-time object, not a daily one.
- (c) A Settings catalog entry only. Pros: it matches the URL. Cons: it reproduces the "hard to find" complaint.
- (d) No nav entry; promote the org record's Sites tab instead. Cons: it does nothing for org-scoped users, who cannot
  open org records.
- **Recommend (a).** It fixes both the partner discoverability gap and the org-scoped dead end without growing the top
  level.

**2. The Sites entry for partners whose orgs all have one site (Todd).**
- (a) **Always show**, gated only on `sites:read`.
- (b) Hide until any reachable org has 2 or more sites. This hides the add-site path, which is the reporter's first
  need.
- (c) A per-user hide preference. This adds persisted, tenancy-bearing state for a nav item.
- **Recommend (a).**

**3. Product analytics for click-through (Todd).**
- (a) **No telemetry. Judge by §7.1.** Pros: no privacy surface, nothing new for self-hosters to disclose, no CSP or
  vendor changes. Cons: no usage numbers.
- (b) Adopt a product-analytics SDK in `apps/web` (for example PostHog), off by default for self-hosted, with an
  opt-in env var. Pros: real usage data. Cons: a new vendor and data flow, consent and CSP work, and a public-repo
  policy question bigger than this feature.
- (c) Server-side counters: hrefs carry `#from=dashboard`, and the destination posts a fire-and-forget count. Pros:
  first-party data. Cons: a new endpoint and table (tenancy shape, cascade and export registrations) for a vanity
  metric. The UI-flow spec already ruled it out.
- **Recommend (a)** for this feature, and decide (b) as a separate, product-wide question.

**4. Bulk site move: new endpoint or client loop.**
- (a) **`POST /devices/bulk/site`** sharing PATCH's move logic, with per-device outcomes. Pros: one round trip, one
  place for checks, the cap and the audit, and usable by MCP and AI tools. Cons: a new route and its contract tests,
  and a high-rigor wave.
- (b) The web loops `PATCH /devices/:id`. Pros: no API work. Cons: N MFA-gated requests, partial failure assembled in
  the browser, and not reusable by agents.
- **Recommend (a).**

**5. What "Patch compliance %" means (Todd).**
The dashboard shows an **item** percentage: installed over installed plus pending, with image terms. The `/patches`
page headline shows a **device** percentage: compliant devices over devices, from a 200-device fetch. One label, two
metrics.
- (a) **The dashboard KPI and card headline switch to the device percentage** (`compliantDevices / totalDevices`,
  already returned by `/patches/compliance`). The page drops its 200-device cap and uses the same API fields. Pros:
  it matches the reporter's mental model ("machines not compliant") and makes the KPI a count link. Cons: the
  dashboard number changes for every user on release, so it needs a release-note line.
- (b) Keep both metrics and label them differently ("Patches installed %" vs "Devices compliant %"). Pros: no
  number changes meaning. Cons: two percentages for one concept.
- (c) Keep everything as is. The KPI stays a section link.
- **Recommend (a).**

**6. Whether the Critical and Warnings tiles keep the active-only count.**
`/alerts/summary` counts `bySeverity` over **active** alerts only. The dashboard's alert feed shows active plus
acknowledged. The links in §3.2 match the tile (`status=active`).
- (a) **Keep the tile active-only and link `status=active`.**
- (b) Change the summary to active plus acknowledged. That changes a long-standing number for every user.
- **Recommend (a).**

## 9. Wave sketch (no plans here)

### 9.1 Waves

| Wave | Content | Path | Depends on |
|---|---|---|---|
| **W1** | `dashboardLinks.ts` producer, `DashboardMetric` helper, `DASHBOARD_METRICS` registry, and the registry and inventory tests. Fix the two broken `?status=` links and add `deviceClass=agent` to every devices link. Fleet legend links. Focus rings on tiles and links. Every not-yet-linked number registered as `section` or `exempt` with a reason (W2 flips them). SiteDetailPage real device count and site-filtered "View all". `OrgDevicesTab` paged site lookup | **Fast-track PR**, web only except the additive `deviceCount` on `GET /orgs/sites/:id` | — |
| **W2** | Destinations learn hash filters: `/patches` `#status=` (and the 200-device cap removed), `/alerts` `#status=&severity=` (the dead `?severity=` writer removed), `/vulnerabilities` `#cves&status=&severity=&kev=&patchAvailable=`, `/security/vulnerabilities` `#status=`. Security destination scope parity (trends and score honor the selected org). The at-risk destination. The vulnerability open-findings count. Open Decision 5's metric change. Exported encoders, arrival tests, dashboard links | **Plan.** Several pages and metric definitions, not just parsers | W1, Open Decision 5 |
| **W3** | Sites nav item and the `/settings/sites` list page: fleet view, Organization column, `useSiteCrud` fleet mode, add-site with org capture, `routeScope` entries, site detail breadcrumbs | **Plan**, after Open Decisions 1 and 2 | — |
| **W4** | Score factors: per-factor event log links, the event log tab's `#eventlog/<filter>` sub-hash, offender links | **Plan.** The event log filter is a new surface | — |
| **W5** | Move to site: agent row action, bulk action, `POST /devices/bulk/site` with shared move logic | **Plan, high rigor** (auth, multi-tenant writes), after Open Decision 4 | — |

W1, W3, W4 and W5 are independent. W2 needs W1's registry.

### 9.2 Wave labels

The waves can be registered as sub-issues of #6721 (W1, W2, W4) and #6720 (W3, W5), or under one parent. That is the
orchestrator's call. W1's site-detail fixes serve #6720 but ride in W1 because they are the same link class.

### 9.3 `data-testid` coverage

Every new link or control gets an id. Proposed names follow `e2e-tests/README.md` (`<page>-<section>-<thing>`):

- **KPI:** the existing `dashboard-{total-devices,online,critical,warnings,tickets,patch}-card` (unchanged).
- **Fleet:** `dashboard-fleet-legend-{online,offline,other}-link`, `dashboard-fleet-view-offline-link`.
- **Security:** `dashboard-security-score-link`, `dashboard-security-trend-link`, `dashboard-security-at-risk-link`,
  `dashboard-security-threats-link`.
- **Patch:** `dashboard-patch-compliant-link`, `dashboard-patch-noncompliant-link`,
  `dashboard-patch-critical-devices-link`.
- **Vulns:** `dashboard-vuln-open-link`, `dashboard-vuln-critical-link`, `dashboard-vuln-kev-link`,
  `dashboard-vuln-patch-ready-link`.
- **Score factors:** `reliability-factor-link-<factor>`, `reliability-offender-link-<key>`.
- **Sites:** `nav-sites` (sidebar), `sites-page`, `sites-add-button`, `sites-org-picker`, `sites-row-<id>`,
  `sites-device-count-link-<id>`, `site-detail-device-count`, `site-detail-devices-view-all-link`.
- **Move:** `device-row-move-site`, `devices-bulk-move-site`, `devices-bulk-move-site-disabled-reason`.

## 10. Design quorum record

The independent review (`codex exec`, read-only, `xhigh`) agreed with the direction of every decision: the
count/affected/exempt contract, hash transport with an ambient org, plain-text gating, Fleet Management placement
with `/settings/sites` revived, always-show, no site switcher, a bulk endpoint over a client loop, no telemetry, and
the wave independence. Its required changes, each re-checked against the code and folded in:

- **Count grains.** The vulnerability "critical open" and "patch ready" numbers count findings while the destination
  lists CVEs, so they became affected links. `totalFindings` counts every status, so it became a bug to fix (§1.1,
  §3.2).
- **Patch metric.** The dashboard % and the `/patches` % are different metrics, and the page caps its device fetch at
  200. This became Open Decision 5 and a W2 item.
- **Enforcement.** An opt-in `data-metric` attribute cannot catch an unmarked number. Replaced with a
  `DashboardMetric` helper and an inventory test (§3.1). Alert-feed and fleet-header counts were added to the map.
- **As-built corrections.** The KPI tiles have no focus ring. `AlertsFeed` rows keep a click handler (the anatomy
  rule now names the W03 pattern). The at-risk fallback applies to the whole population, not per device. Sentry has
  tracing, error replays and breadcrumbs.
- **Scope parity.** The security trends route ignores the selected org, so security links moved from W1 to W2 behind a
  parity fix. Devices links carry `deviceClass=agent`.
- **Gating.** The visibility predicate includes module gates (Tickets under service-management mode `off`).
- **Sites.** The `routeScope` classification, a fleet mode for `useSiteCrud` with the org captured per write, the
  site-detail breadcrumbs, the site-detail device count (always 0 today), and the 100-site lookup cap in
  `OrgDevicesTab`.
- **Bulk move.** MFA, logic shared with PATCH (locking, rewrites, peripheral reconciliation, both audits), isolated
  per-device transactions with a `selfManagedDbContextRoutes` registration, an `mcpCoverage.ts` entry, agent-only
  eligibility, and multi-source-site copy. The tenancy section now says "schema: none" and states the authorization
  obligations separately.
- **Score factors.** Performance charts do not cover the 90-day uptime window, so `uptime` is exempt rather than
  linked to a chart that does not explain it.
- **Factual fixes from the path verification pass.** `/tickets#open` is not a hash format (the queue tab is component
  state, and it already defaults to `open`). The topology `SiteMoveSuggestion` does not reuse `ChangeSiteModal`.

# Organization record page and PSA module navigation

Status: draft for Todd's review (2026-09-06). Advisor quorum complete: Fable,
codex gpt-5.6-sol xhigh and codex gpt-6-astra xhigh agree on D1, D2, D3 and D5;
D4 (column vs table) split 2:1 for the column, GPT-6 casting the tie-break. See
"Quorum record".
Tracking: to be registered via feature-lifecycle after approval (multi-wave).

## Problem

`/settings/organizations` is the only list of an MSP's customers. It is a
master-detail admin surface: the row shows name, a status pill and a device
count; the detail pane shows the header and Sites. The only way "into" an
organization is a hover-only pencil icon that lands on the per-org **settings**
page (`/settings/organizations/[id]`, 15 configuration sections). Breeze has no
PSA-style *company record*: one page that answers "what is going on at this
customer" (contacts, sites, devices, tickets, contracts, invoices, activity).

Two further observations drive this design:

- The status pill reads "Active" on nearly every row, so it carries no
  information in the list. The field itself is load-bearing (org-token auth
  admits only `active`/`trial`; the alert worker skips non-active orgs; the
  stale-command reaper keys on `offboarding`), so the fix is presentational.
- Every operational page filters by the global OrgSwitcher scope, which is
  applied by a full page reload. Opening a customer must not require switching
  the technician's working scope.

Todd's second question, answered in Part 2: should PSA features be hideable for
RMM-only partners, and should the sidebar be regrouped into workflow trees.

## Goals

1. A URL-addressable organization record at `/organizations/[id]` with an
   overview and tabs, pinned to that org regardless of global scope.
2. An always-visible way to open it from the organizations list, plus
   exception-only status badges in the list.
3. A partner-level switch that hides the PSA module for RMM-only partners, and a
   sidebar grouped by workflow (RMM, PSA, AI) without a two-level tree rewrite.

## Non-goals

- Replacing `/settings/organizations` (add, bulk import, reorder, archive,
  merge, sites CRUD stay there).
- Moving billing configuration, Pax8 or any settings editor onto the record.
- New tenant tables. Part 1 needs none; Part 2 needs one boolean column.
- Custom fields on organizations (#3843), org document templates (#3844),
  cross-org reporting (#3858). The record links out where those land later.
- An onboarding "RMM only" preset. Follow-up once the toggle exists.

## Current state (verified 2026-09-06 on origin/main 2602e045e)

| Fact | Where |
|---|---|
| Org list = master-detail, hover pencil → settings page | `apps/web/src/components/settings/OrganizationsPage.tsx` (`handleEdit`) |
| Per-org settings page, 15 hash sections incl. Contacts, Contracts | `apps/web/src/components/settings/OrgSettingsPage.tsx` |
| Nothing in the sidebar links to the per-org page; deep links from quotes/invoices use `#billing`, `#pax8/<id>` | `InvoiceSendComposer.tsx`, `QuoteActions.tsx`, `QuoteDetail.tsx` |
| Device breadcrumb already wants an org destination, points at settings | `components/devices/DeviceDetailPage.tsx` (org crumb) |
| Global scope: zustand `useOrgStore`, `applyOrgSwitch` reloads the page | `stores/orgStore.ts`, `lib/orgSwitch.ts` |
| `fetchWithAuth` injects `?orgId=<global>` unless the URL already has `orgId=` or `skipOrgIdInjection` is set | `stores/auth.ts` (~1251-1278) |
| Explicit-org precedent: `ContactsCard({orgId})`, `ContractsList({lockedOrgId})`, `AlertList({orgId?})`; sites API lets `organizationId` outrank ambient `orgId` | `settings/ContactsCard.tsx`, `contracts/ContractsList.tsx`, `alerts/AlertList.tsx`, `routes/orgs.ts` (~2383) |
| Global-scope-only pages: `DevicesPage`, `TicketsPage`, `AlertsPage`, `InvoicesPage`, `QuotesPage`, `DashboardPage` | respective components |
| Route-scope registry; `/settings/organizations/[id]` is `org-required` | `lib/routeScope.ts` |
| No per-org summary endpoint; `GET /orgs/organizations/:id` returns the raw row | `routes/orgs.ts` (~1802) |
| Every list route accepts an org filter: tickets/invoices/quotes/contracts/alerts `orgId`, devices `orgId`/`orgIds[]`, sites `organizationId`, contacts by path | validators + routes |
| Sidebar gates: `requiredPermission`, `partnerScopeOnly`, `platformAdminOnly`, `requiresAiForOffice` (partner boolean from `GET /orgs/partners/me`), extension registry | `components/layout/Sidebar.tsx` |
| Partner-level feature precedent: `partners.ai_for_office_enabled` boolean column, platform-admin-only write | `db/schema/orgs.ts` (~143), `routes/orgs.ts` (~173, ~455) |
| `organizations.type` enum: `customer`, `internal`, `quick_support` (hidden from lists) | `db/schema/orgs.ts` |
| Web `Organization.status` union drifted: has `inactive`, lacks `churned`/`offboarding` | `stores/orgStore.ts:15` |
| Tab patterns: `useHashState` + `OverflowTabs` (DeviceDetails), `SettingsSectionNav` (settings pages), `HashLink` | `lib/useHashState.ts`, `shared/OverflowTabs.tsx`, `shared/HashLink.tsx` |
| 8 locales must stay in parity | `apps/web/src/locales/*/common.json` |

## Decisions (quorum)

| # | Decision | Rejected |
|---|---|---|
| D1 | New record page at `/organizations/[id]`; settings page stays and becomes the record's Settings tab target | Growing the settings page with operational tabs (mixes dirty-state forms with live lists); "open = switch scope + dashboard" (reload, no record) |
| D2 | Record is URL-pinned. Opening it never changes the global OrgSwitcher scope. A secondary "Work in this org" button does | Auto-switching scope on open |
| D3 | Both: regroup the sidebar by workflow *and* add a partner-level PSA toggle | Toggle only (nav still cluttered for PSA users); regroup only (RMM-only shops still see PSA) |
| D4 | Toggle storage: dedicated boolean column on `partners` (see Part 2 and quorum record for the table alternative) | `partner_modules` table (a new partner-axis RLS table with allowlist + `*PartnerRls` suite for one presentation preference; no org cascade/export burden since it has no `org_id`, but still a tenant table to own) |
| D5 | Status pill in lists shown only for non-`active` statuses; record header always shows status, subdued when active | Removing status from the list entirely |

---

## Part 1: Organization record page

### 1.1 Route and entry points

- Astro page `apps/web/src/pages/organizations/[id].astro` → `<OrganizationRecordPage orgId={id} client:load />`.
- Register `/^\/organizations\/[^/]+(\/.*)?$/` in `lib/routeScope.ts` as a new
  kind `org-record`: it neither requires nor follows the global scope.
  `getOrgSwitchRedirect` sends it to `/settings/organizations` on a scope switch
  (same treatment as other detail routes). `ContextScopeLine` renders
  "Viewing <org name>" and, when the global scope is a *different* org, appends
  "· workspace scope: <other org>" so the two contexts are never confused.
- Entry points added in this feature:
  - Organizations list row: the org name becomes a link to the record and a
    persistent chevron sits at the row end (the hover pencil and archive icons
    stay). Detail-pane header gains a primary **Open record** button; the
    existing Edit button is relabelled **Settings**.
  - Device detail breadcrumb org crumb → `/organizations/<id>`.
  - Ticket, invoice, quote, contract detail pages: org name → record.
  - Not in scope: the command palette (it does not list organizations today).
- Permission: `organizations:read` for the page. Each tab is additionally gated
  by its own resource (`tickets:read`, `invoices:read`, `contracts:read`,
  `devices:read`, `alerts:read`, `audit:read`); a tab the user cannot read is
  not rendered. Sidebar visibility for Part 1 is unchanged (Organizations stays
  under Settings until Part 2).
- Org-scoped tokens: the API already 404s `GET /orgs/organizations/:id` for a
  foreign org, so an org user can open only their own record. No new checks.

### 1.2 URL-pinned fetching

Add an `orgIdOverride?: string | null` option to `fetchWithAuth`
(`stores/auth.ts`):

- `undefined` (default): current behaviour, inject the global scope.
- `string`: set `orgId=<override>` on the URL, replacing any existing value.
- `null`: suppress injection (equivalent to `skipOrgIdInjection`, which becomes
  an alias and is left in place).

Implementation notes: parse with `URL`/`URLSearchParams` instead of the current
substring test; strip the custom options before spreading into native `fetch`;
if the URL already carries a *different* `orgId=` than the override, throw (a
conflicting explicit target is a bug, not a preference). Path-scoped endpoints
with strict query schemas (the `OrgBillingSettings` precedent) pass `null`.
The record page wraps this once as `orgFetch(path, init)` and passes it, or the
`orgId` itself, down as props. No React context carries the org id into shared
list components: explicit props are what `ContractsList`/`ContactsCard` already
do, and they are greppable. Responses are keyed by org id and a response for a
previous org id is discarded (navigating record to record must not paint stale
data).

Mutations, creation forms, exports and outbound links from inside the record
(create ticket, add contact, add site, export devices) must carry the pinned org
the same way; the global scope must never leak into a default. A code-review
checklist item for each tab: every request, form default and link in the tab
either uses `orgFetch`/the pinned `orgId` or a path that embeds it.

### 1.3 Header

Identity only, so it stays readable on narrow widths: name; type badge
(`customer`/`internal`); status (always shown, `active` rendered subdued, other
statuses use the existing `statusColors`); primary contact (name, email, phone;
the contact flagged primary, else none); site count. All metrics (devices,
alerts, tickets, contracts, invoices) live in the Overview tab tiles (1.4, 1.5).

Actions: **Work in this org** (calls `applyOrgSwitch` to this org, lands on the
dashboard), **Settings** (→ `/settings/organizations/<id>`), overflow with
Archive and Merge (reuse `ArchiveOrgModal`/`MergeOrgModal`; Merge only when
`canMergeOrgs`).

Lifecycle:

- `archived` / `offboarding` (`isArchiveLifecycleOrg`): same read-only banner
  and drain/purge countdown as the settings page, every mutation hidden,
  Restore offered. Tabs remain readable through the existing archived read path.
- `suspended` / `churned`: **not in the partner token's accessible-org set**
  (`middleware/auth.ts` admits only `active`/`trial`), so the record GET and
  every tab fetch will 404/deny under RLS. The record renders a lifecycle card
  from the list's cached row (name, status, created) with copy explaining that
  the organization's data is not accessible while in that status, and a link to
  the settings list. Same limitation the settings page has today; widening
  partner access to suspended orgs is a follow-up, not this feature.

### 1.4 Summary endpoint

`GET /orgs/organizations/:id/summary` in a new file
`apps/api/src/routes/orgs/summary.ts` (mounted from `routes/orgs.ts`), guarded
like `GET /orgs/organizations/:id` (`requireOrgRead` + accessible-org check).
Returns:

```
{
  devices:   { total, online, offline, stale },
  alerts:    { open, critical, high },
  tickets:   { open, awaitingCustomer, overdue },
  contracts: { active, nextRenewalAt },
  invoices:  { outstandingCents, currencyCode, nextDueAt, overdueCount },
  sites:     { count },
  contacts:  { count, primary: { id, name, email } | null },
  portalUsers: { count },
  lastActivityAt
}
```

Sections the caller lacks permission for are omitted (not zeroed) so the Overview
can hide the tile. All queries run inside the request's `withDbAccessContext`;
no system context, no new tables. Counts are cheap `COUNT` per table keyed on
`org_id` indexes that already exist; if any proves slow at 10k devices, cache
per org for 60s in Redis (follow-up, not in wave 1).

### 1.5 Tabs

Hash-keyed via `useHashState` + `OverflowTabs` (the DeviceDetails pattern).
Each tab lazy-loads on first activation.

| Tab | Renders | Change needed |
|---|---|---|
| Overview | Summary tiles (from 1.4), recent activity (last 20 audit events for the org), open critical alerts, upcoming renewals/invoices | New `OrgOverview` component; audit and alert lists via `orgFetch` |
| Contacts | `ContactsCard({orgId})` | None. Settings `#contacts` section becomes a link to the record tab (one owner) |
| Sites | `SiteList` fed by `GET /orgs/sites?organizationId=` plus add/edit/delete using the existing `SiteForm` modals | Extract the site-modal handlers from `OrganizationsPage` into a hook `useSiteCrud(orgId)` shared by both pages |
| Devices | `DeviceList` fed by `GET /devices?orgId=`; filters limited to site/status/search; row → device detail | Parent loader; `DeviceList` is data-driven but derives `isFleetView` (org column) from the global store, so add a `forceSingleOrg`/`lockedOrgId` prop that overrides it |
| Tickets | `TicketQueueList` fed by `GET /tickets?orgId=` + status filter; "New ticket" preselects the org | Parent loader only; `TicketQueueList` is presentational (`tickets[]`, `onSelect`) |
| Contracts & Billing | `ContractsList({lockedOrgId})`; invoices and quotes tables filtered by `orgId` (extract `InvoiceTable`/`QuoteTable` presentational pieces from the pages or add `lockedOrgId` to the pages) | `lockedOrgId` prop on `InvoicesPage`/`QuotesPage` following `ContractsList` |
| Activity | `AuditLogViewer` pinned to the org | Add an `orgId?: string` prop (today it takes only `timezone` and reads global scope) |
| Settings | Link-out to `/settings/organizations/<id>` (not embedded) | None |

Legacy hashes: `/settings/organizations/<id>#contacts` redirects to
`/organizations/<id>#contacts`; `#contracts` likewise. `#billing` and
`#pax8/<id>` are unchanged (billing config stays in settings).

### 1.6 Organizations list changes (`/settings/organizations`)

- Status pill rendered only when `status !== 'active'` (archived section
  unchanged). Detail header keeps the pill always.
- Row: name is a link to the record; persistent chevron; existing hover icons
  stay. `data-testid="org-open-record-<id>"`.
- Detail pane: **Open record** primary, **Settings** secondary, Archive/Merge
  unchanged.
- Fix `Organization.status` union in `stores/orgStore.ts` to match the API
  (`active | trial | suspended | churned | offboarding | merging | archived | purging`),
  and grep callers for `'inactive'`.

### 1.7 Testing

- `stores/auth.test.ts`: `orgIdOverride` string replaces an existing `orgId`,
  `null` suppresses, `undefined` keeps injection; custom option is not forwarded
  to `fetch`.
- `lib/routeScope.test.ts`: new kind, switch redirect, scope line copy.
- `routes/orgs/summary.test.ts` (Drizzle mock): shape, permission-omitted
  sections, 404 for inaccessible org.
- Integration: an org-scoped token gets 404 for another org's summary; a partner
  token gets counts that match seeded rows.
- Component tests for header lifecycle states, tab gating by permission, and
  that the list hides the Active pill but shows Trial/Suspended.
- E2E (`e2e-tests`): open record from list, switch tabs by hash, "Work in this
  org" changes scope.
- `no-silent-mutations`: any new mutation handler uses `runAction`.

---

## Part 2: Workflow navigation and the PSA module toggle

### 2.1 Recommendation

Do both (D3). The sidebar already has single-level collapsible sections that
are, in effect, workflow groups (Fleet Management, Security, Backup, Billing,
AI). A two-level tree (Module → Section → Item) is a nav rewrite for little
gain, since sections already collapse. Instead:

1. **Regroup and rename sections so the module is legible from the headers**:

   | Section (new) | Items |
   |---|---|
   | Dashboard, Organizations | top-level, module-neutral (Organizations moves out of Settings; partner scope only, `organizations:read`) |
   | RMM · Fleet | Devices, Discovery, Patches, Software, Scripts, Automations, Monitors, Remote, Peripherals, SNMP, Fleet Posture |
   | RMM · Security | current Security section unchanged |
   | RMM · Backup | current Backup section unchanged |
   | PSA · Service Desk | Tickets, Timesheet (Approvals stays module-neutral: it is AI/PAM approvals) |
   | PSA · Billing | Contracts, Quotes, Invoices, Product Catalog |
   | AI | current AI section unchanged (AI Agents, AI Impact, AI Usage, AI for Office, Workspace) |
   | Reporting | unchanged, cross-module |
   | Settings, Administration, Extensions | unchanged |

   Naming: Todd's term is PSA. Codex suggested "Service Management" because the
   repo uses "PSA" for external PSA *connectors* (`components/psa/*`,
   `psa_connections`). Decision for Todd; the module key in code is `psa`
   either way.

2. **Partner-level module toggle** hides the two PSA sections and the record's
   Tickets and Contracts & Billing tabs and Overview tiles, plus their creation
   affordances. It does **not** hide external PSA connectors on the Integrations
   page (ConnectWise/Autotask/Halo sync): an RMM-only shop is exactly the shop
   that pushes tickets to someone else's PSA.

### 2.2 Toggle semantics

- It is a **presentation preference, never authorization**. The API keeps
  enforcing RBAC only; every PSA route keeps working when the module is off, and
  deep links still open. No 403s are introduced by the toggle.
- Partner-wide, no org override. An MSP either runs a service desk or it does
  not.
- Default **on** for existing and new partners. The setting lives on the Partner
  settings page under a new **Modules** card in the `company` section: one
  switch, "Service desk & billing (PSA)", with the list of what it hides.
- Sidebar gate `requiresModule: 'psa'` evaluated in `isNavItemVisible`. Source:
  `psaEnabled` on `GET /orgs/partners/me`, persisted in the zustand store so the
  first paint uses the last known value (no flash, no over-hide during the
  cold-load window that already bites `requiredPermission`). Fails open when the
  fetch errors.
- Org-scoped users are **not** affected by the toggle. `GET /orgs/partners/me`
  is `requireScope('partner')`, so an org token cannot read the flag, and org
  navigation is already narrowed by `partnerScopeOnly` (Quotes, Invoices,
  Contracts, Catalog are partner-only) plus RBAC. The only PSA items an org
  user can see are Tickets and Timesheet, which their role grants or not.
  Alternative if this proves wrong in practice: expose `psaEnabled` on the
  org-readable branding/config endpoint. Not in W4.

### 2.3 Storage (D4)

`partners.psa_enabled boolean NOT NULL DEFAULT true`, migration named to sort
after the newest committed migration at implementation time (as of 2026-09-06
that is `2026-10-12-000100-device-manual-maintenance-lease.sql`, so e.g.
`2026-10-12-000200-partners-psa-enabled.sql`; re-check before committing, the
ceiling runs ahead of real time). `ADD COLUMN IF NOT EXISTS`. Exposed on `GET /orgs/partners/me` next to
`aiForOfficeEnabled`; writable on `PATCH /orgs/partners/me` by partner admins
(unlike `aiForOfficeEnabled`, which is platform-only). `partners` is not an
org-cascade table, so no cascade-list change; the column is a plain boolean, so
no export-policy bucket change beyond what the partner table already has (verify
with `tenant-export-policy.integration.test.ts`).

Why a column and not a `partner_modules` table: one toggle today, and the table
would be a new partner-axis RLS tenant table (policy, `PARTNER_TENANT_TABLES`
allowlist entry, its own `*PartnerRls.integration.test.ts`; no org cascade or
export-policy entries since it has no `org_id`). The typed column matches how
every other partner preference is stored. Revisit a table when modules need
metadata or an independent lifecycle; a third toggle is a prompt to review, not
an automatic migration. The read path (`partners/me`) keeps its shape either way.

### 2.4 Testing

- `Sidebar.module.test.tsx`: PSA sections hidden when `psaEnabled=false`,
  visible when true or when the fetch fails, Organizations visible in both.
- `routes/orgs.test.ts`: `psaEnabled` round-trips on `/partners/me` GET and
  PATCH; org-scope PATCH is rejected.
- Record page: PSA tabs and tiles hidden when the flag is off.
- Migration idempotency via `autoMigrate.test.ts`; naming guard.
- Locale parity: new `nav.*`, `orgRecord.*`, `partnerSettingsPage.modules.*`
  keys in all 8 locales (`keyUsage.test.ts`).

---

## Waves

| Wave | Scope | Depends on |
|---|---|---|
| W1 | `orgIdOverride`, route-scope kind, summary endpoint, record page shell with header + Overview, list affordances + status-pill rule, orgStore status fix, device breadcrumb retarget | — |
| W2 | Contacts, Sites (shared `useSiteCrud`), Devices, Activity tabs; settings `#contacts` redirect | W1 |
| W3 | Tickets and Contracts & Billing tabs (`lockedOrgId` on invoices/quotes pages), `#contracts` redirect, org links from ticket/invoice/quote/contract details | W1 |
| W4 | Sidebar regroup + Organizations top-level; `psa_enabled` column, `/partners/me` exposure, Modules card, `requiresModule` gate, record tab gating | W1 (for the record gating), otherwise independent |

W2 and W3 are file-disjoint and can run in parallel. W4 can start after W1 in
parallel with W2/W3.

## Open questions for Todd

1. Section naming: **PSA** (your term) or **Service Management** (codex's
   suggestion, avoids collision with PSA connectors)?
2. Should the top-level **Organizations** item point at a new operational list
   (`/organizations`, table with online/total devices, open tickets, alerts) or
   at the existing settings master-detail for now? Recommendation: existing
   page in W4, new list as a follow-up once the record has shipped and we know
   which columns techs actually use.
3. Default for the PSA toggle on **self-hosted** installs: same default-on, or
   off? Recommendation: same default-on; the switch is one click.

## Quorum record

- **codex gpt-5.6-sol xhigh (2026-09-06)**: agreed D1, D2, D3 and the
  status-pill rule. Added: lazy-load tabs; move Contacts/Contracts to the record
  and redirect legacy hashes; `orgIdOverride` on `fetchWithAuth` with URL
  parsing; show both contexts when pinned org ≠ global scope; new `org-record`
  route kind; "Service Management" naming; fail-open nav after a stable loading
  state. Disagreed on D4 (preferred a `partner_modules` table with partner RLS).
  Contradictions it surfaced and this spec absorbs: `quick_support` org type,
  Organizations nav is permission-gated not `partnerScopeOnly`, `orgStore`
  status union drift.
- **codex gpt-6-astra xhigh (2026-09-06)**: agreed D1, D2, D3, D5 and picked
  the column for D4 (tie-break), correcting the premise that a partner-axis
  table would carry org cascade/export registrations (it would not; it would
  still need partner RLS + allowlisting). Added: header too crowded, move
  metrics to Overview; partner tokens cannot access `suspended`/`churned` orgs
  so the record needs a lifecycle-only view for them; conflicting explicit
  `orgId` targets should throw; path-scoped strict-schema endpoints suppress
  injection; key caches by org and discard stale responses; `DeviceList`
  derives `isFleetView` from the store; keep external PSA connectors visible
  when the module is off; keep Organizations and Reporting outside the module
  groups. Suggested exposing the flag to org users via bootstrap (deferred, see
  2.2) and an onboarding "RMM only" choice (follow-up).

## Follow-ups (not in these waves)

- Onboarding "RMM only" preset that sets `psa_enabled=false` at partner signup.
- Partner access to `suspended`/`churned` organizations' records (today the
  partner token's org set excludes them, so their data is unreachable in both
  the record and the settings page).
- `psaEnabled` on an org-readable bootstrap endpoint if org users need the
  module preference.
- Operational `/organizations` list with online/total, open tickets, open
  alerts columns (see open question 2).
- Redis-cached summary if the counts prove slow at fleet scale.

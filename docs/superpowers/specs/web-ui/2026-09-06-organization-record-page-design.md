# Organization record page and Service Management navigation

Status: **approved by Todd 2026-09-06** (open questions resolved, see below).
Advisor quorum complete: Fable, codex gpt-5.6-sol xhigh and codex gpt-6-astra
xhigh agree on D1, D2, D3 and D5; D4 (column vs table) split 2:1 for the
column, GPT-6 casting the tie-break. See "Quorum record".
Tracking: LanternOps/breeze#5075 (waves #5076 W01, #5077 W02, #5078 W03, #5079 W04).
Plan: `docs/superpowers/plans/2026-09-06-organization-record-page.md`.

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

Todd's second question, answered in Part 2: should the service desk and billing module be hideable for
RMM-only partners, and should the sidebar be regrouped into workflow trees.

## Goals

1. A URL-addressable organization record at `/organizations/[id]` with an
   overview and tabs, pinned to that org regardless of global scope.
2. An always-visible way to open it from the organizations list, plus
   exception-only status badges in the list.
3. A partner-level Service Management mode (`native` / `off` / `external`) that
   hides the service desk and billing module for RMM-only partners and is
   already shaped for an external PSA as system of record, plus a sidebar
   grouped by workflow without a two-level tree rewrite.

## Non-goals

- Replacing `/settings/organizations` (add, bulk import, reorder, archive,
  merge, sites CRUD stay there).
- Moving billing configuration, Pax8 or any settings editor onto the record.
- New tenant tables. Part 1 needs none; Part 2 needs two scalar columns on
  `partners`.
- The external service desk itself (adapter wiring for `createTicket`, shadow
  ticket rows, inbound status sync, org → PSA company picker). Part 2 only
  reserves the `external` mode for it; it gets its own spec and feature after
  this one (see D6 and Follow-ups).
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
| D3 | Both: regroup the sidebar by workflow *and* add a partner-level Service Management mode | Mode only (nav still cluttered for service-desk users); regroup only (RMM-only shops still see the module) |
| D4 | Mode storage: two typed columns on `partners` (`service_management_mode`, `service_management_psa_connection_id`) | `partner_modules` table (a new partner-axis RLS table with allowlist + `*PartnerRls` suite for one preference; no org cascade/export burden since it has no `org_id`, but still a tenant table to own); a JSON blob in `partners.settings` |
| D5 | Status pill in lists shown only for non-`active` statuses; record header always shows status, subdued when active | Removing status from the list entirely |
| D6 | External PSA (ConnectWise, Autotask, …) as system of record = **direct create through `ticketService` via the existing adapters, a thin shadow `tickets` row with the external id/URL, and inbound sync limited to status/closure**. Approved by Todd 2026-09-06; specified in a follow-on feature | Two-way sync of the native ticketing module with the PSA (board/type/status mapping per vendor, comment and attachment mirroring, conflict resolution, two systems of record); "no local record at all" (breaks every surface that reads `tickets`: alert linked-tickets card, AI tool reads, portal, org record, reporting) |
| D7 | The module is named **Service Management** in UI, i18n keys and the column name; "PSA" stays reserved for external connectors | "PSA" (collides with `components/psa/*`, `psa_connections`) |

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
- Org-scoped tokens: `GET /orgs/organizations/:id` is `requireScope('partner',
  'system')`, so org users get 403. The record is a partner/system surface; an
  org-scoped JWT renders a "not available in this workspace" state linking to
  `/`. The API is not widened (plan note 2).

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

The shape above is illustrative; the binding shape is `OrgSummary` in the plan
(`docs/superpowers/plans/2026-09-06-organization-record-page.md`, Task 1.4),
which drops fields the schema cannot answer cheaply (`tickets.overdue`,
`devices.stale`). Sections the caller lacks permission for are omitted (not
zeroed) so the Overview can hide the tile. All queries run inside the request's `withDbAccessContext`;
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
| Settings | Not a tab: a header action linking to `/settings/organizations/<id>` (plan Task 1.5) | None |

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

## Part 2: Workflow navigation and the Service Management mode

### 2.1 Recommendation (approved 2026-09-06)

Do both (D3). The sidebar already has single-level collapsible sections that
are, in effect, workflow groups (Fleet Management, Security, Backup, Billing,
AI). A two-level tree (Module → Section → Item) is a nav rewrite for little
gain, since sections already collapse. Instead:

1. **Regroup sections so the module is legible from the headers.** The module
   is called **Service Management** (Todd, 2026-09-06; "PSA" in this repo means
   the external PSA *connectors*, `components/psa/*`, `psa_connections`).

   | Section | Items |
   |---|---|
   | Dashboard, Organizations | top-level, module-neutral. Organizations moves out of Settings and points at the existing `/settings/organizations` page for now (operational list is a follow-up); partner scope only, `organizations:read` |
   | Fleet Management, Security, Backup | unchanged (RMM; the product name, so no prefix) |
   | Service Desk | Tickets, Timesheet (Approvals stays module-neutral: it is AI/PAM approvals) |
   | Billing | Contracts, Quotes, Invoices, Product Catalog |
   | AI | unchanged (AI Agents, AI Impact, AI Usage, AI for Office, Workspace) |
   | Reporting | unchanged, cross-module |
   | Settings, Administration, Extensions | unchanged |

   Service Desk and Billing sit adjacent and are the two sections the mode
   below hides. Section i18n keys: `nav.sectionServiceDesk`, `nav.sectionBilling`.

2. **Partner-level Service Management mode** (replaces the earlier on/off
   boolean; shaped now so the external-PSA follow-on does not retrofit it).

### 2.2 Mode semantics

`service_management_mode` is one of:

| Mode | Meaning | Nav | Org record | Ticket creation surfaces |
|---|---|---|---|---|
| `native` (default, hosted and self-hosted alike) | Breeze is the service desk and billing system | Service Desk + Billing shown | Tickets and Contracts & Billing tabs + tiles shown | Unchanged |
| `off` | RMM-only partner | Both sections hidden | Both tabs and their tiles hidden | Hidden in the web (alert dialog, "New ticket"); `manage_tickets` create actions and the add-in `ticket-create` capability return a clear "service management is off" error; portal ticket submission forced off |
| `external` | The partner's system of record is an external PSA bound to `service_management_psa_connection_id` | Both sections hidden; a read-only Tickets list of shadow rows with external links replaces the workbench | Tickets tab shows shadow rows with "Open in <PSA>" links; Contracts & Billing hidden | Route through the connection's adapter (`createTicket`), write a shadow `tickets` row (`source='psa'`, `external_ticket_id/url`), narrow inbound status sync. **Specified and built by the follow-on "External service desk" feature**; W4 ships the value in the schema and validator but the settings UI offers only `native` and `off` until that feature lands |

Rules that hold in every mode:

- The mode never changes API authorization. RBAC keeps enforcing every route;
  deep links to existing tickets, invoices and contracts keep working; background
  billing jobs are unaffected (they act only on data the partner created).
  The single behavioural effect is that `off` refuses *new* ticket creation at
  the service layer, so nothing can create tickets nobody will see.
- Partner-wide, no org override. An MSP either runs a service desk or it does
  not.
- External PSA connectors on the Integrations page stay visible in every mode:
  an RMM-only shop is exactly the shop that pushes tickets to someone else's
  PSA.
- Sidebar gate `requiresModule: 'service_management'` evaluated in
  `isNavItemVisible`. Source: `serviceManagementMode` on
  `GET /orgs/partners/me`, persisted in the zustand store so the first paint uses
  the last known value (no flash, no over-hide during the cold-load window that
  already bites `requiredPermission`). Fails open (`native`) when the fetch
  errors.
- Org-scoped users are **not** affected by the mode. `GET /orgs/partners/me`
  is `requireScope('partner')`, so an org token cannot read it, and org
  navigation is already narrowed by `partnerScopeOnly` (Quotes, Invoices,
  Contracts, Catalog are partner-only) plus RBAC. The only Service Management
  items an org user can see are Tickets and Timesheet, which their role grants
  or not. Alternative if this proves wrong in practice: expose the mode on the
  org-readable branding/config endpoint. Not in W4.
- The setting lives on the Partner settings page under a new **Modules** card
  in the `company` section: a radio group (Breeze / Off; External appears when
  the follow-on ships) with the list of what each choice hides.

### 2.3 Storage (D4)

Two columns on `partners`, one migration named to sort after the newest
committed migration at implementation time (as of 2026-09-06 that is
`2026-10-12-000100-device-manual-maintenance-lease.sql`, so e.g.
`2026-10-12-000200-partners-service-management-mode.sql`; re-check before
committing, the ceiling runs ahead of real time):

```sql
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS service_management_mode text NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS service_management_psa_connection_id uuid
    REFERENCES psa_connections(id) ON DELETE RESTRICT;
-- CHECK service_management_mode IN ('native','external','off')
-- CHECK (service_management_mode <> 'external' OR service_management_psa_connection_id IS NOT NULL)
-- CHECK (service_management_mode = 'external' OR service_management_psa_connection_id IS NULL)
```

`ON DELETE RESTRICT` so a bound connection cannot be deleted without first
leaving external mode. The PATCH handler validates that the referenced
connection is partner-owned by the caller's partner (`psa_connections` is org
XOR partner owned; only partner-owned rows qualify). Exposed on
`GET /orgs/partners/me` next to `aiForOfficeEnabled`; writable on
`PATCH /orgs/partners/me` by partner admins (unlike `aiForOfficeEnabled`, which
is platform-only). `partners` is a partner-axis table with no `org_id`, so no
org cascade or export-policy registration applies; both columns are scalar.

Why columns and not a `partner_modules` table: one mode today, and the table
would be a new partner-axis RLS tenant table (policy, `PARTNER_TENANT_TABLES`
allowlist entry, its own `*PartnerRls.integration.test.ts`). The typed column
matches how every other partner preference is stored. Revisit a table when
modules need metadata or an independent lifecycle.

### 2.4 Testing

- `Sidebar.module.test.tsx`: Service Desk and Billing hidden for `off` and
  `external`, visible for `native` and when the fetch fails; Organizations
  visible in every mode.
- `routes/orgs.test.ts`: mode round-trips on `/partners/me` GET and PATCH;
  `external` without a connection is 400; a connection owned by another partner
  or by an org is 400; org-scope PATCH is rejected.
- `ticketService` / `aiToolsTicketing` / `officeAddin/tickets`: creation
  refused with the mode error when `off`; unchanged when `native`.
- Record page: Service Management tabs and tiles hidden when `off`.
- Migration idempotency via `autoMigrate.test.ts`; naming guard; CHECK
  constraints exercised in an integration test (23514 on an inconsistent pair).
- Locale parity: new `nav.*`, `orgRecord.*`, `partnerSettingsPage.modules.*`
  keys in all 8 locales (`keyUsage.test.ts`).

---

## Waves

| Wave | Scope | Depends on |
|---|---|---|
| W1 | `orgIdOverride`, route-scope kind, summary endpoint, record page shell with header + Overview, list affordances + status-pill rule, orgStore status fix, device breadcrumb retarget | — |
| W2 | Contacts, Sites (shared `useSiteCrud`), Devices, Activity tabs; settings `#contacts` redirect | W1 |
| W3 | Tickets and Contracts & Billing tabs (`lockedOrgId` on invoices/quotes pages), `#contracts` redirect, org links from ticket/invoice/quote/contract details | W1 |
| W4 | Sidebar regroup (Service Desk + Billing sections) + Organizations top-level → `/settings/organizations`; `service_management_mode` + connection columns and CHECKs, `/partners/me` exposure + PATCH validation, Modules card (Breeze / Off), `requiresModule` gate, `off` refusal in `ticketService` + AI tool + add-in + portal, record tab gating | W1 (for the record gating), otherwise independent |

W2 and W3 are file-disjoint and can run in parallel. W4 can start after W1 in
parallel with W2/W3.

## Open questions (resolved by Todd 2026-09-06)

1. Module naming → **Service Management** (D7).
2. Top-level **Organizations** item → the existing `/settings/organizations`
   page in W4; an operational list (`/organizations` with online/total devices,
   open tickets, alerts) is a follow-up once the record has shipped and we know
   which columns techs actually use.
3. Default mode on **self-hosted** installs → `native`, same as hosted.
4. (Raised during review) External PSA ticketing → D6: direct create + shadow
   row + narrow status sync, not two-way sync; amend this spec to the three-mode
   model now, build the external service desk as its own follow-on feature.

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
- **External PSA ticketing (D6), 2026-09-06**: Fable position, approved by Todd
  without a codex round (the follow-on spec gets its own quorum). Inventory
  that grounded it: real adapters for ConnectWise, Autotask, Jira, ServiceNow,
  Freshservice, Zendesk in `apps/api/src/services/psa/*` with
  `createTicket`/`updateTicket`/`getTicket`/`syncTickets` never called by any
  route or job; `POST /psa/connections/:id/sync` returns 501; `psa_ticket_mappings`
  has no writer; `tickets.external_ticket_id/url` dormant; `ticketSourceEnum`
  lacks `psa`; company import maps PSA company → org in
  `organization_external_links`; every native ticket-creating surface (alert
  dialog, `manage_tickets` AI tool, portal, Outlook add-in, email-to-ticket)
  already funnels through `ticketService`, which emits `ticket.created/updated`
  on the event bus; no device "create ticket" button and no automation
  `create_ticket` action exist today.
- **Todd's decisions, 2026-09-06**: Service Management naming; Organizations
  top-level → existing settings list first; `native` default on self-hosted;
  amend to the three-mode model now.

## Follow-ups (not in these waves)

- **External service desk** (own spec + feature, after this one): wire the
  existing `services/psa/*` adapters' `createTicket`/`updateTicket`/`getTicket`
  into `ticketService` behind `service_management_mode = 'external'`; shadow
  `tickets` rows (`source='psa'` enum value, activate the dormant
  `external_ticket_id`/`external_ticket_url` columns, fold or retire the
  never-written `psa_ticket_mappings`); outbound note append for alert updates
  and AI findings; inbound status/closure via PSA webhook where supported, else
  poll on the adapters' `syncTickets`; optional alert auto-resolve on close;
  org → PSA company picker on org settings General (company import already
  populates `organization_external_links`); per-connection board/type/priority
  defaults in the existing `syncSettings` JSON; unlock the External option in
  the Modules card. Inventory of what exists is in this spec's quorum record.
- Onboarding "RMM only" preset that sets `service_management_mode='off'` at
  partner signup.
- Partner access to `suspended`/`churned` organizations' records (today the
  partner token's org set excludes them, so their data is unreachable in both
  the record and the settings page).
- `serviceManagementMode` on an org-readable bootstrap endpoint if org users
  need the module preference.
- Operational `/organizations` list with online/total, open tickets, open
  alerts columns (see open question 2).
- Redis-cached summary if the counts prove slow at fleet scale.

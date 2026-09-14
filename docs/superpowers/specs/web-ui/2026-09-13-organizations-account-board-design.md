# Organizations Account Board — Design

**Date:** 2026-09-13
**Status:** Design — direction and first-cut scope approved by Todd in session; Codex xhigh quorum applied (section 13); ready for plans
**Issues addressed:** feature #5721 (waves W01 #5722, W02 #5723, W03 #5724); replaces the split-view Organizations page refined in #5708
**Branch:** `spec/organizations-account-board` (docs); implementation waves branch from the feature issue
**Mock:** [`assets/2026-09-13-organizations-account-board-mock.html`](assets/2026-09-13-organizations-account-board-mock.html) — static, example figures, table above 900px and cards below. The mock shows the W03 end state; W02 ships without the Integrations column.

## Problem

`/settings/organizations` is a master–detail split view: a 26% list of customers on the left, and a panel on the right that repeats what the organization record (`/organizations/:id`) already shows better (status, a facts strip, the Sites tab). Two surfaces for one org will drift, and the wider one is the shallower one. More importantly, the page answers no question an MSP actually brings to a list of its customers:

- A technician cannot tell **which accounts are not set up yet** — no site, no device enrolled, no agent checking in, no policy assigned — without opening each record.
- An owner cannot tell **which accounts are incomplete as accounts** — no primary contact, no reachable email or phone, no billing contact, no billing address, overdue invoices, an invitation nobody accepted.
- Nobody can see **which systems each customer is linked to** (accounting customer, PSA company, Pax8, Microsoft 365, DNS filter, Huntress, SentinelOne) or that a link is pending or broken; that state is scattered across each integration's own page.
- Open tickets per customer, with awaiting-customer and SLA-breached counts, are visible only one record at a time.

The manual drag ordering of the list (a partner-wide preference persisted in `partners.settings.organizationOrder`) is valued and must survive any redesign.

The impeccable critique of 2026-09-13 scored the incumbent 20/40 and the refinement in #5708 fixed its accessibility, action vocabulary, workspace-scope and layout defects. This spec replaces the concept, not the fixes: the keyboard row contract, `shared/ActionMenu`, the dialogs, the semantic status colours and the `:focus-visible` rule all carry over.

## Goals / Non-goals

**Goals**
- One full-width page, `/organizations`, that is the customer directory **and** the account-readiness board: every customer, what it still needs, what it is linked to, and what is open.
- Two lenses on the same rows: **Setup** (technician) and **Account** (owner), with **Both** as the default.
- Exception-only display: a row shows only what is missing or wrong, and every chip is a link to the place that fixes it. A row with no exceptions gets one quiet check.
- Every exception is **accurate and applicable**: a chip fires only for a condition the data actually establishes and only for accounts the condition applies to. A smaller, trustworthy board first; more checks as their applicability contracts become reliable.
- Manual order kept as the default sort, with the existing drag and arrow-key reorder.
- Row actions that do not require opening the record: contact the primary contact, open a new ticket, work in this org, settings, archive, merge, restore.
- One new bulk API read that computes every signal for a partner's orgs in one request, with explicit capability metadata and the same permission vocabulary as the per-org summary.
- Route consolidation: `/organizations` (directory) and `/organizations/:id` (record) under one home; `/settings/organizations` redirects.

**Non-goals**
- Fleet health (devices online, open alerts) — that is the record Overview's job and the Devices/Alerts pages'. The board shows device **count and whether any agent has checked in** as onboarding signals only.
- Inline site editing (the record's Sites tab keeps `SiteList` and `SiteModals`).
- Bulk selection and bulk actions.
- Saved views (the Devices saved-views store is device-filter specific).
- Persisting an onboarding checklist. Every signal is derived from data that already exists; no new tables, no new columns.
- A "Most to do" ranking. Raw chip counts would rank several optional gaps above one overdue invoice or one broken connector. A weighted ranking is a later decision once the checks have earned trust.
- A searchable merge-survivor picker, a Bulk import drawer, a Restore confirmation — unchanged from today.

## Users and jobs

| Who | Situation | Must be able to |
|---|---|---|
| Technician (primary) | Onboarding a new customer, or sweeping the book monthly | See which accounts are not fully set up and exactly which step is missing; jump to fix it |
| Owner / account manager | Quarterly clean-up, before invoicing, before a QBR | See which accounts have incomplete contact or billing data, overdue invoices, unlinked accounting, unaccepted portal invitations |
| Either | Phone rings | Find the customer by name, contact name or contact email; contact them or open a ticket from the row |

Mode: Operate. Scanability and consistency with the Devices list page outrank expression.

## Applicability

A check is evaluated only for accounts it applies to. Wrong chips destroy trust faster than missing ones.

| Rule | Effect |
|---|---|
| `organizations.type = 'internal'` | No Account-data chips, no ticket column contribution. Setup chips still apply. |
| `organizations.status IN ('trial','suspended','churned','offboarding','merging')` | No billing chips (billing contact, billing address, overdue invoices). Contact chips still apply. |
| Partner `service_management_mode <> 'native'` | Tickets column hidden; overdue invoices not evaluated (mirrors `OrgOverviewTab`'s rule for tickets, contracts and invoices). |
| Caller lacks the grant for a section | Section omitted from the API response and from `capabilities`; the column, its band cell and its filter chip do not render. An omitted check contributes neither a chip nor evidence of completeness. |
| Archived or archive-draining org (`archived: true`) | Listed only under the Archived filter; no readiness chips; Restore in the row menu. |

## Page anatomy

Top to bottom, at 1440px (see mock):

1. **Header** — `h1` "Organizations", one-line description, actions **Bulk import** (secondary) and **Add organization** (primary). Same anatomy as the Devices page header.
2. **Roll-up band** — one cell per filter, in the same order and wording as the filter chips: Accounts (with trial/suspended sub-counts) · Setup incomplete · Account data missing · Unlinked (W03) · Open tickets (with SLA breached in destructive). Counts are over the **live, unfiltered** list. Each cell is a button with `aria-pressed` that applies the matching filter; the band shows dashes until every readiness batch has landed and says "partial" if a batch failed.
3. **Toolbar** — search (matches org name, primary contact name and email), filter chips (All · Setup incomplete · Account data missing · Unlinked (W03) · Open tickets · Trial · Archived; a count renders only once it is known, and Archived is always shown, without a count, until its on-demand fetch has run), a **Lens** segmented control (Setup · Account · Both), a Sort select (Manual order · A to Z · Open tickets).
4. **Table** — columns in Both lens: grip · Organization · Setup · Account data · Integrations (W03) · Open tickets · row menu. Setup lens hides Account data; Account lens hides Setup. Applying a filter whose evidence lives in a hidden column switches the lens to Both. Footer line: active account count, device total, open ticket total, and the manual-order hint.
5. **Phone (< 900px)** — one card per org: name and meta, "Still needed" chips (setup and account together), Integrations badges (W03), Open tickets, row menu. The roll-up band stacks two per row with the last cell full width.

### Organization cell

Name (link to the record), then a meta line: exception-only status pill (nothing for `active`), the **Workspace** pill on the one org the OrgSwitcher currently points at (marker only; it does not pin to the top; it is text, not `aria-current`), device count, site count. Archived rows are muted and carry the archived pill with the purge countdown.

### Setup cell (W02)

Chips for what is missing, in this order, each a link to the repair surface; nothing else. When none apply, a single "Complete" check in success colour.

| Chip | Condition | Repair link |
|---|---|---|
| No site | `count(sites where org_id = org) = 0` | record → Sites tab |
| No devices enrolled | `count(devices where org_id = org and status <> 'decommissioned') = 0` | record → Devices tab |
| No agent has checked in | devices > 0 and `max(devices.last_seen_at) IS NULL` over the same non-decommissioned population | record → Devices tab |
| No agent check-in for N days | devices > 0 and `now() - max(last_seen_at) >= 7 days`; N = whole days. This means **no live agent** has reported recently; it says nothing about individual stale devices, which stay a fleet-operations concern | record → Devices tab |
| No policy assigned | no `config_policy_assignments` row with `level = 'organization' AND target_id = org` whose `config_policy_id` points at a `configuration_policies` row with `status = 'active'`, **and** no such row at `level = 'partner'` for the org's partner. Wording is deliberately "assigned", not "covered": site, device-group and device-level assignments are not counted, and assignment does not prove the policy's feature links apply to this org's devices | `/configuration-policies` |

Cut from the first cut, with the reason: **No alert rules** (partner-wide `alert_rules` rows are compiled from monitors and do not imply applicability to an org; a real coverage check goes through the configuration-policy resolver — W03 candidate), **No enrollment key** (a live key is not an obligation for an enrolled account), **No backup config** (backup is an entitlement, not a requirement; W03 with applicability = partner has backup enabled for the org).

### Account data cell (W02)

Chips in this order. Red (destructive) chips are things that are wrong, amber chips are things that are missing. Contact data comes from the canonical `contacts` table, never from the `organizations.billing_contact` compatibility JSON.

| Chip | Tone | Condition | Repair link |
|---|---|---|---|
| Primary contact | amber | no `contacts` row with `org_id = org AND is_primary AND site_id IS NULL` | record → Contacts |
| Contact email | amber | primary contact exists and `email IS NULL` | record → Contacts |
| Contact phone | amber | primary contact exists and `phone IS NULL AND mobile IS NULL` | record → Contacts |
| Billing contact | amber | no `contacts` row for the org whose `roles` array contains `'billing'` (applicability: active customer orgs) | record → Contacts |
| Billing address | amber | any of `billing_address_line1`, `billing_address_city`, `billing_address_country` is null (applicability: active customer orgs) | `/settings/organizations/:id` |
| N overdue invoices | red | `count(invoices where status IN ('sent','partially_paid','overdue') and due_date < current_date) > 0` (needs `invoices:read`, native mode, active customer org) | record → Billing tab |
| Invitation not accepted | amber | any `portal_users` row with `status <> 'disabled' AND invited_at < now() - 7 days AND last_login_at IS NULL` (needs `users:read`) | record → Contacts / portal users |

Cut from the first cut, with the reason: **Tax ID** (not universally required; applicability needs the partner's tax settings), **Contract dates / Contract expired** (the `organizations.contract_*` columns are metadata; the source of truth is the `contracts` table, which permits evergreen terms — W03 defines "No active contract" from `contracts` for active customer orgs in native mode).

### Integrations cell (W03)

Connector state and org mapping state are modelled separately and presented together.

**Partner-level connectors** (from the partner, once per response): accounting (`accounting_connections.provider`, `status ∈ connected | reauth_required | disconnected | error`), PSA (`psa_connections` where `partner_id = partner`, `provider`, `enabled`), Pax8 (`pax8_integrations.is_active`, `last_sync_status`, where the worker writes `'failed'` on failure), Huntress and SentinelOne (their partner-level integration rows: active flag and last sync status). A connector that is not `connected`/enabled renders **once** in the roll-up band as a partner-level repair ("QuickBooks needs reconnecting") and mutes every org's badge for that system; it never renders as N per-org problems.

**Org mapping state**, one badge per system, dot colour = state, label = system, `reason` code translated client-side. Aggregation when an org has several rows for one system (M365 profiles): the worst state wins (error > pending > linked).

| System | Source (all restricted to the accepted org ids) | linked | pending (reason) | error (reason) |
|---|---|---|---|---|
| QuickBooks / Xero | `accounting_entity_mappings` where `breeze_entity_type = 'org' AND breeze_entity_id = org`, joined to `accounting_connections` on `integration_id` with `partner_id = partner` (the mapping table is partner-axis RLS; the join is the tenancy predicate) | `link_status = 'confirmed'` and `sync_status IN ('synced','synced_with_tax_variance','pending')` and connector `connected` | `link_status IN ('suggested','create_new')` (`suggested_match`) | `sync_status = 'error'` or `last_error IS NOT NULL` (`sync_error`); `link_status = 'unlinked'` is not linked |
| PSA | `psa_connections` row with `org_id = org AND enabled`, or a partner-level enabled connection plus an `organization_external_links` row whose `system` equals the connection's `provider` | connected | — | connection `enabled = false` (`disabled`) |
| External identity (Datto RMM, CSV, other `organization_external_links.system`) | row exists | rendered as a **muted identity badge**, never green: provenance, not connectivity | — | — |
| Pax8 | `pax8_company_mappings` where `org_id = org AND NOT ignored AND integration_id` = the partner's **active** `pax8_integrations` row | row exists and connector last sync not `failed` | — | connector `last_sync_status = 'failed'` (`sync_failed`) |
| Microsoft 365 | `m365_connections` where `org_id = org AND revoked_at IS NULL AND status <> 'revoked'` | `status = 'active'` | `status IN ('pending-consent','verifying')` (`consent_pending`) or `expires_at < now()` (`expired`) | `status IN ('degraded','suspended')` (`degraded` / `suspended`) or `last_error_code IS NOT NULL` (`error`) |
| DNS filter | `dns_filter_integrations` where `org_id = org AND is_active` | `last_sync_status = 'ok'` (or the provider's success value) | `last_sync_status IS NULL` (`never_synced`) | `last_sync_status = 'error'` (`sync_error`) |
| Huntress / SentinelOne | `huntress_org_mappings` / `s1_org_mappings` where `org_id = org` joined to their partner-level integration on `integration_id` + `partner_id` | parent active and last sync ok | parent never synced (`never_synced`) | parent inactive or last sync error (`connector_error`) |

A dashed **"<System> not linked"** badge renders only for connectors the partner has and this org lacks, and only when the caller may see connectors (`connected_apps:read`; accounting additionally `accounting:read`; Pax8 additionally the grant the Pax8 routes require, `billing:manage`). Systems the partner has not connected are never mentioned. An org with nothing linked and no partner-level connectors shows "Nothing linked" muted.

### Open tickets cell (W02)

Open count (`status IN ('new','open','pending','on_hold')`, `deleted_at IS NULL`), then a small line: "N awaiting customer" (`status = 'pending'`) in muted, and "N SLA breached" (`sla_breached_at IS NOT NULL` among open) in destructive. Zero renders muted. Hidden entirely (column, band cell, filter) when the caller lacks `tickets:read` or the partner is not in native service-management mode.

### Row menu (`shared/ActionMenu`)

Open record · Contact <primary contact name, or their email when the contact has no name> (two-line item: email, phone or mobile; `mailto:`/`tel:`; hidden when there is no primary contact) · New ticket (opens the ticket composer with the org preselected; native mode and `tickets:write` only) · separator · Work in this org · Settings · separator · Archive organization · Merge into another organization (partner scope only, destructive tone). For archived rows: Open record · Restore.

Row click opens the record. The whole row is a hit area; the name is the keyboard target with the roving tabindex, Arrow/Home/End and one-tab-stop-per-row contract carried over from #5708. There is no selected row on this page, so `aria-current` is not used on rows.

### Filters, lens, sort, URL state

- Filter chips are mutually exclusive. "Setup incomplete" = at least one setup chip; "Account data missing" = at least one account chip; "Unlinked" (W03) = at least one "not linked" badge; "Open tickets" = open > 0; Trial and Archived are status filters.
- Lens is remembered per browser (`localStorage` `breeze.orgBoard.lens`); default Both. Applying a filter whose evidence is hidden by the current lens switches the lens to Both for that view.
- Sort: Manual order (default; the partner's `organizationOrder`), A to Z, Open tickets (desc, then name). Remembered per browser under `breeze.orgList.sort` (the key #5708 introduced). Drag and arrow-key reorder are offered only under Manual order with no search and the All filter, exactly as today, through the existing PATCH with `runAction`, the `reorderPending` serialisation and the authoritative refetch on failure. The PATCH remains gated server-side on `canManagePartnerWidePolicies`; a 403 surfaces as today's toast.
- URL hash carries navigable state, serialised as `#lens=setup&filter=unlinked` through `useHashState`; localStorage supplies the defaults when the hash is empty. A bare `#<uuid>` (the incumbent's selected-org deep link, still produced by `getOrgSwitchRedirect` bookmarks) scrolls to and briefly highlights that row.
- Search matches org name, primary contact name and email (client-side over the loaded list plus the readiness payload).
- Archived: fetched on demand with `includeArchived=true`, server-side search forwarded, and `archivedTruncated` surfaced as the note it is today.

### States

- **Cold load:** page frame renders immediately; the table shows skeleton rows; the roll-up band shows dashes. Rows paint from the org list first; readiness columns fill in per 200-id batch (skeleton chips meanwhile). The web issues at most two batches concurrently.
- **A readiness batch fails:** its rows show one muted "Unavailable" per readiness cell; the band says "partial" with **Try again**; other batches stay.
- **Permission-trimmed:** a section absent from `capabilities` hides its column, band cell and filter entirely; never zeros.
- **Empty:** no orgs → the existing empty state with Add organization; no matches → "No organizations match your search or filter." with a Clear filters action.
- **Long values:** names truncate with a title; chips wrap; the table scrolls horizontally inside its own container below 1040px of content width; the page never scrolls sideways.

### Accessibility

Everything #5708 established stays the contract. Column headers are sortable `th` with `aria-sort`. Chips are links (they repair), so they are real anchors with the org name in their accessible name. The row menu is `ActionMenu`. Dialogs are `Dialog`/`ConfirmDialog`. Band cells are buttons with `aria-pressed`.

### Routes

- New page `apps/web/src/pages/organizations/index.astro` mounting the board with `client:load`, title "Organizations".
- `apps/web/src/pages/settings/organizations/index.astro` becomes a frontmatter-only `return Astro.redirect('/organizations', 301);` (the repo's redirect idiom, e.g. `pages/settings/organization.astro`). The per-org settings pages under `/settings/organizations/:id` are unchanged.
- Sidebar entry href `/settings/organizations` → `/organizations` (`Sidebar.tsx:196`). The record page's back-links (`OrganizationRecordPage.tsx:238, :249, :323`) and the `organizations/[id].astro` and `settings/organizations/[id]/billing.astro` param guards point at `/organizations`. `DashboardLayout.astro` gains an accent-bar case for `/organizations`. `getOrgSwitchRedirect` sends `/organizations/:id` to `/organizations`.

## API: `GET /orgs/account-readiness`

New sibling router `apps/api/src/routes/orgAccountReadiness.ts`. The path is deliberately **not** under `/organizations/…`: `orgRoutes` is mounted first and its `/organizations/:id` would capture a literal `/organizations/account-readiness` and answer 404 from its UUID guard. Mounted in `apps/api/src/index.ts` with `api.route('/orgs', orgAccountReadinessRoutes)`; the composed app is tested, not only the router.

Scope `partner`/`system`, permission `PERMISSIONS.ORGS_READ`. Query:
- `orgIds` — comma-separated UUIDs, 1–200; 400 on malformed or more than 200.
- `partnerId` — required for **system** scope (the list endpoint uses the same rule); ignored for partner scope, whose partner is the token's.

Accepted ids are resolved **against organization rows** before any aggregate: `organizations.id = ANY(ids) AND partner_id = partner AND deleted_at IS NULL AND type <> 'quick_support'`, and for partner scope additionally `id = ANY(auth.accessibleOrgIds)`. Ids that do not survive are silently absent from `orgs` (never 403), matching `auth.canAccessOrg` semantics. Every aggregate is then keyed on the accepted id list; the accounting mapping join carries the partner relationship explicitly because that table is partner-axis RLS.

Response:

```ts
interface AccountReadinessResponse {
  partnerId: string;
  /** Which sections were computed for this caller. Absent sections were withheld by permission or mode; the web hides their columns even when `orgs` is empty. */
  capabilities: {
    sites: boolean;            // sites:read
    devices: boolean;          // devices:read
    policies: boolean;         // organizations:read (always true)
    contacts: boolean;         // organizations:read (always true)
    portalUsers: boolean;      // users:read
    invoices: boolean;         // invoices:read AND service_management_mode = 'native'
    tickets: boolean;          // tickets:read AND service_management_mode = 'native'
    integrations: boolean;     // W03: connected_apps:read
  };
  serviceManagementMode: 'native' | 'external' | 'off';
  /** W03. Present only with capabilities.integrations. */
  connectors?: Array<{
    system: 'quickbooks' | 'xero' | 'psa' | 'pax8' | 'huntress' | 'sentinelone';
    state: 'connected' | 'reauth_required' | 'disconnected' | 'error' | 'disabled';
    provider?: string;         // PSA provider name
  }>;
  orgs: Array<{
    orgId: string;
    type: 'customer' | 'internal' | 'quick_support';
    status: string;
    setup: {
      sites?: number;                    // capabilities.sites
      devices?: number;                  // capabilities.devices, non-decommissioned
      lastSeenAt?: string | null;        // capabilities.devices, max over the same population; null = never
      policyAssigned: boolean;           // org- or partner-level assignment of an active policy
    };
    account: {
      primaryContact: { name: string | null; email: string | null; phone: string | null; mobile: string | null } | null;
      billingRoleContact: boolean;       // any contact with roles ⊇ {'billing'}
      billingAddress: boolean;
      pendingInvitations?: number;       // capabilities.portalUsers; invited ≥ 7 days ago, never signed in
      overdueInvoices?: number;          // capabilities.invoices
    };
    /** W03. Present only with capabilities.integrations. */
    integrations?: Array<{
      system: 'quickbooks' | 'xero' | 'psa' | 'pax8' | 'm365' | 'dns_filter' | 'huntress' | 'sentinelone' | 'external';
      state: 'linked' | 'pending' | 'error' | 'identity';
      reason?: 'suggested_match' | 'sync_error' | 'consent_pending' | 'expired' | 'degraded' | 'suspended' | 'error' | 'never_synced' | 'sync_failed' | 'disabled' | 'connector_error';
      label?: string;                    // for 'external' rows: the system name from organization_external_links
    }>;
    tickets?: { open: number; awaitingCustomer: number; slaBreached: number }; // capabilities.tickets
  }>;
}
```

Implementation rules:
- `services/orgAccountReadiness.ts` owns the queries; the route validates, resolves accepted ids, gates and shapes. `reason` values are **codes**; the web translates them in all eight locales. No English sentence crosses the API.
- One aggregate per independent domain over `WHERE org_id = ANY($ids) GROUP BY org_id` (or an `EXISTS`/`bool_or` per org), with the parent joins each domain needs (accounting mapping → connection; Pax8 mapping → active integration; assignments → active policy). Never one giant join that multiplies counts. Issued under `Promise.all` for orchestration only: the request runs inside the single transaction `withDbAccessContext` opens, so there is no connection-level parallelism and the code must not escape the request context to get it.
- Device freshness reads `max(last_seen_at)` over the non-decommissioned population using the dedicated freshness index (`2026-05-17-a-devices-scale-indexes.sql:15`), not the `(org_id, status)` index.
- No `audit_logs` read.
- Runs under the request's `withDbAccessContext` (via `authMiddleware`); every table read is org- or partner-scoped and under forced RLS. No new tables, so no cascade or export-policy registration.
- **Measured, not promised:** W01 seeds a partner with 200 orgs and realistic fan-out (devices, invoices, contacts, mappings) and records `EXPLAIN ANALYZE` for every aggregate under the `breeze_app` role in the plan's verification step; any aggregate that walks a per-row history (invoices, devices) must show an index scan keyed on `org_id`.
- Route tests cover: malformed ids, cap, partner-scope intersection (a sibling org of the same partner that the token cannot access is dropped), system scope without `partnerId` → 400, system scope with mixed partners (only the named partner's orgs return), unknown and deleted ids, `quick_support` exclusion, every capability gate, the composed-app path.

## Web architecture

- `apps/web/src/components/organizations/board/OrganizationsBoardPage.tsx` — page island; owns the org list (via `fetchAllOrganizations`), the readiness batches, filters, lens, sort, hash state, manual reorder (existing PATCH via `runAction`), archived on-demand fetch, dialogs. Replaces `components/settings/OrganizationsPage.tsx`, which is deleted along with its split-view-only pieces (detail panel, facts strip, `SiteList` `section` variant). The `no-silent-mutations` adopted-path list is updated to the new file in the same change. `SiteList` (card variant), `SiteModals`, `useSiteCrud` remain for the record's Sites tab.
- `board/AccountBoardTable.tsx` — the `ResponsiveTable` with sortable headers (`SortableTh` lifted from `components/billing/shared` to `components/shared` with a namespace prop), the roving-tabindex rows, the drag handle, and the phone `DataCard`s.
- `board/ReadinessChips.tsx` — renders setup/account chips (anchors) from `deriveReadinessChips`.
- `board/IntegrationBadges.tsx` (W03) — badges from `integrations` plus the partner's connectors.
- `board/RollupBand.tsx` — the counts, each a filter button; partial/incomplete states.
- `board/useAccountReadiness.ts` — batching by 200 with concurrency 2, latest-wins per batch, per-batch failure state.
- `lib/orgReadiness.ts` — `deriveReadinessChips(org, readiness, capabilities, mode, now)`, filter predicates, sort comparators, repair-link map (pure, unit-tested; applicability rules live here and nowhere else).
- Reused unchanged: `shared/ActionMenu`, `shared/Dialog`, `shared/ConfirmDialog`, `ArchiveOrgModal`, `MergeOrgModal`, `OrganizationForm`, `BulkOrgImport`, `lib/orgStatus`, `lib/fetchAllOrganizations`, `lib/orgSwitch`, `lib/useHashState`.
- i18n: new `orgBoard.*` block in `apps/web/src/locales/*/organizations.json` (all eight locales, real translations, including every `reason` code, plural forms, accessible labels and the repair-link titles; the `localeParity`, `translationCoverage` and `keyUsage` contracts enforce parity, and the reason-code rule keeps English out of the API). Keys the old page no longer uses are removed from `settings.json` in the same wave.

## Testing

- **API unit** (route, `orgSummary.test.ts` style): every case in the route-tests list above.
- **API integration (real Postgres):** seed one partner with three orgs plus a second partner; assert each W02 signal, the partner-level policy assignment rule, the contact-role billing rule, the invitation aging rule, invoice statuses, system-scope `partnerId` handling, and that a restricted sibling org and a foreign-partner org are both dropped. W03 adds the mapping/connector matrix. W01 also records the `EXPLAIN ANALYZE` evidence.
- **Web unit:** `deriveReadinessChips` table-driven over every chip and every applicability rule; filters, sorts, hash serialisation; `OrganizationsBoardPage` rendering (skeleton → rows → per-batch fill-in), lens switch and the filter-forces-Both rule, chip repair links, roll-up counts and partial state, manual reorder preserved with the 403 toast path, row menu inventory incl. nameless-contact fallback, capability-trimmed columns hidden, batch failure state, phone cards.
- **Web contract tests** that already exist and must stay green: `no-silent-mutations` (adopted path updated), i18n parity/coverage/key-usage, `no-hash-in-usestate`.
- **E2E (Playwright, data-testid only, W02):** `org-board-row-<id>`, `org-board-chip-<key>`, `org-board-filter-<key>`, `org-board-lens-<key>`, `org-board-more-<id>`, `org-board-band-<key>`.

## Rollout / waves

| Wave | Scope | Ships |
|---|---|---|
| W01 | API: `services/orgAccountReadiness.ts`, `routes/orgAccountReadiness.ts` with capabilities, applicability, accepted-id resolution, system-scope `partnerId`, composed-app registration; route + integration tests; measured query plans on a seeded 200-org partner | Endpoint behind no flag; nothing consumes it yet |
| W02 | Web: the board with Setup, Account data and Open tickets columns; lens, filters, sort, hash state, manual order; Contact and New ticket row actions with their gates; archive behaviour; route move, redirect, sidebar and back-links; deletion of the split view; eight-locale i18n; E2E spec | Page replaces `/settings/organizations` |
| W03 | API + web: connectors and per-org integration mapping state with reason codes; the Integrations column, "not linked" badges and the partner-level repair line in the band; "No active contract" from `contracts`; backup applicability; roll-up expansion | Feature complete |

W02 starts when W01 has merged; W03 starts when W02 has merged.

## Decisions recorded

- Workspace org: marker only, never pinned (marker keeps sort order truthful).
- Archived orgs: a filter value, always discoverable, count shown once fetched.
- Sites: record only.
- Last activity (`audit_logs`) dropped: expensive and not an account-readiness signal.
- Alerts and device-online counts stay on the record Overview; the board shows device count and agent check-in only.
- "Most to do" sort cut; a weighted attention ranking is a later decision.
- Path `/orgs/account-readiness`, not `/orgs/organizations/account-readiness` (route shadowing).

## Codex quorum

Read-only review at `xhigh` (gpt-6-astra) on 2026-09-13 returned **agree with changes**: the account-readiness concept is the right one for this page (its unit of work is the customer relationship, not incident triage), the full-width directory, separate record, preserved manual order and two lenses are sound, and the objection was to the certainty of the checks. Applied: route shadowing (path moved off `/organizations/…`), explicit capabilities and per-section gates including connector visibility, relationship-specific tenancy predicates and a system-scope `partnerId` contract with accepted-id resolution against organization rows, ownership-is-not-coverage (alert rules cut, policy chip narrowed to "assigned"), corrected accounting/Pax8/M365/DNS state definitions with worst-state aggregation, connector state separated from mapping state with one partner-level repair line, billing contact from contact roles and phone-or-mobile reachability with a nameless-contact fallback, applicability rules before any "Complete", freshness narrowed to "no live agent", invitation aging, Archived always discoverable, band cells matching filters, chips as repair links, "Most to do" cut, `runAction`/reorder/hash rules made executable, reason codes instead of English, waves reordered around complete journeys, and the mock reconciled (no contract chips, no unsupported PSA provider names). Not applied: none.

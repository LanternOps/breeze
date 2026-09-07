---
tracking_issue: LanternOps/breeze#5075
---
# Organization Record Page + Service Management Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every organization a URL-pinned record page (`/organizations/<id>`: header with a Settings action, tabs Overview, Contacts, Sites, Devices, Tickets, Contracts & Billing, Activity) reachable from the organizations list, and add a partner-level Service Management mode (`native` / `off` / `external`) with a workflow-grouped sidebar.

**Architecture:** A new `org-record` route kind whose fetches carry an explicit `orgIdOverride` on `fetchWithAuth`, so the page never depends on the OrgSwitcher scope. One new read-only API route aggregates per-org counts. Tabs reuse the existing presentational list components behind thin org-pinned loaders. The mode is two typed columns on `partners`, exposed on `GET /orgs/partners/me`, gating navigation, the record's Service Management tabs, and (for `off`) new ticket creation inside `ticketService`.

**Tech Stack:** Astro + React islands, zustand, i18next (auto-registered namespaces), Hono + Drizzle + Zod, hand-written SQL migration, Vitest (web jsdom + API unit + API integration), Playwright.

**Spec:** `docs/superpowers/specs/web-ui/2026-09-06-organization-record-page-design.md` (approved 2026-09-06). Where this plan is more specific than the spec (summary shape, i18n namespace, org-scope handling), the plan wins and the spec was amended to point here.

## Global Constraints

- Web URL state for tabs is `window.location.hash` via `useHashState` (`apps/web/src/lib/useHashState.ts`); never query params.
- Every new mutation handler in the web goes through `runAction` (`apps/web/src/lib/runAction.ts`); the `no-silent-mutations` test enforces it.
- Every request from inside the record page passes `orgIdOverride: <record org id>` (or embeds the org in the path). Never rely on ambient injection there.
- New i18n keys land in all 8 locales (`apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/<ns>.json`); `apps/web/src/lib/i18n/localeParity.test.ts` enforces parity. Namespaces auto-register from the folder (`apps/web/src/lib/i18n/index.ts`), so a new `organizations.json` needs no wiring.
- Migration filename must sort after the newest committed migration. As of 2026-09-06 that is `2026-10-12-000100-device-manual-maintenance-lease.sql`; use `2026-10-12-000200-partners-service-management-mode.sql` and re-check `ls apps/api/migrations | sort | tail -1` before committing. Idempotent, no inner `BEGIN`/`COMMIT`.
- `partners` has no `org_id`: no cascade or export-policy registration applies. No new tenant tables anywhere in this plan.
- The mode never changes API authorization. The single behavioural effect is `off` refusing *new* ticket creation in `ticketService.createTicket`.
- Branch per wave: `feature/<parent#>-organization-record-page/wave-<subissue#>`; PR body carries `Closes #<sub-issue>`.
- Model routing per CLAUDE.md: contracts here; implementation by cheap models; tsc + tests + grep before any model review.

---

## Critical implementation notes — read before starting

1. **`fetchWithAuth` spreads `options` straight into native `fetch`** (`apps/web/src/stores/auth.ts:1370` and the retry at `:1386`). Today `skipOrgIdInjection`/`skipUnauthorizedRetry` ride along harmlessly. Task 1.1 must destructure the custom keys out before the spread, at both call sites.
2. **`GET /orgs/organizations/:id` is `requireScope('partner','system')`** (`apps/api/src/routes/orgs.ts:1802`). Org-scoped tokens get 403, not 404. The record page is therefore a partner/system surface; for an org-scoped JWT (`getJwtClaims().scope === 'org'`, `apps/web/src/lib/authScope.ts`) the page renders the "not available in this workspace" state and links to `/`. Do not widen the API.
3. **Partner tokens can only access `active`/`trial` orgs** (`apps/api/src/middleware/auth.ts` ~378-393). A `suspended`/`churned` org 404s on the record GET. Task 1.5 renders a lifecycle card from the list's cached row for that case; do not try to fetch tabs.
4. **`OrganizationsPage.tsx` imports `Organization` from `./OrganizationList`**, whose status union is already correct. The drifted union is `apps/web/src/stores/orgStore.ts:19` (has `inactive`, lacks `churned`/`offboarding`). Fix only that one.
5. **`orgs.ts` is one flat file.** Sibling route files (`orgArchive.ts`, `orgMerge.ts`) are mounted in `apps/api/src/index.ts:833-834` with `api.route('/orgs', …)`. The summary route follows that pattern; do not add to `orgs.ts`.
6. **`aiForOfficeEnabled` is platform-only** (settable on `PATCH /partners/:id`, not `/partners/me`; `orgs.ts:171-173`). The mode is the opposite: partner-writable on `PATCH /partners/me` (`updatePartnerSettingsSchema`, `orgs.ts:811`), never on the platform route.
7. **Every native ticket-creating surface calls `ticketService.createTicket`** (alert dialog via `createTicketFromAlert`, `manage_tickets` AI tool, portal `POST /tickets`, Outlook add-in `from-email`, email-to-ticket). One guard inside `createTicket` covers all of them (Task 4.3).
8. **Timesheets already sits in the Billing section** (`Sidebar.tsx:284`); Tickets is a top-level item (`Sidebar.tsx:184`). The regroup moves both into a new Service Desk section.
9. **Sidebar permission gate hides items until `/users/me` resolves** (memory: `hasPermission(undefined, …)` is false). The mode gate must not add a second flash: persist the last known mode in `orgStore` and fail open to `native`.

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `apps/web/src/pages/organizations/[id].astro` | Astro page → `OrganizationRecordPage` |
| `apps/web/src/components/organizations/record/OrganizationRecordPage.tsx` | Shell: loads org + summary, lifecycle states, tab strip, renders active tab |
| `apps/web/src/components/organizations/record/orgRecordFetch.ts` | `makeOrgFetch(orgId)` → `fetchWithAuth` with `orgIdOverride`; stale-response guard |
| `apps/web/src/components/organizations/record/orgRecordTabs.ts` | Tab ids, permission per tab, mode gating, hash parse |
| `apps/web/src/components/organizations/record/OrgRecordHeader.tsx` | Identity header + actions |
| `apps/web/src/components/organizations/record/OrgOverviewTab.tsx` | Summary tiles + recent activity + open critical alerts |
| `apps/web/src/components/organizations/record/OrgSitesTab.tsx` | `SiteList` + site modals via `useSiteCrud` |
| `apps/web/src/components/organizations/record/OrgDevicesTab.tsx` | Loader → `DeviceList` (`forceSingleOrg`) |
| `apps/web/src/components/organizations/record/OrgTicketsTab.tsx` | Loader → `TicketQueueList` |
| `apps/web/src/components/organizations/record/OrgBillingTab.tsx` | `ContractsList({lockedOrgId})` + `InvoicesPage({lockedOrgId})` + `QuotesPage({lockedOrgId})` |
| `apps/web/src/components/organizations/record/OrgActivityTab.tsx` | `AuditLogViewer({orgId})` |
| `apps/web/src/components/settings/useSiteCrud.ts` | Site fetch/add/edit/delete state + handlers extracted from `OrganizationsPage` |
| `apps/web/src/components/settings/PartnerModulesCard.tsx` | Service Management mode radio card on the Partner → Company tab |
| `apps/web/src/locales/<8 locales>/organizations.json` | New namespace for the record page |
| `apps/api/src/routes/orgSummary.ts` | `GET /orgs/organizations/:id/summary` |
| `apps/api/src/services/serviceManagement.ts` | `getServiceManagementMode(partnerId)`, `assertTicketCreationAllowed(partnerId)`, mode types |
| `apps/api/migrations/2026-10-12-000200-partners-service-management-mode.sql` | Two columns + CHECKs |

### Modified files

| File | Change |
|---|---|
| `apps/web/src/stores/auth.ts` | `orgIdOverride` option; URL parsing; strip custom options before `fetch` |
| `apps/web/src/lib/routeScope.ts`, `apps/web/src/lib/orgSwitch.ts`, `apps/web/src/components/layout/ContextScopeLine.tsx` | `org-record` kind, switch redirect, no scope line on the record |
| `apps/web/src/stores/orgStore.ts` | Status union fix; `serviceManagementMode` persisted field |
| `apps/web/src/components/settings/OrganizationsPage.tsx` | Row link + chevron, exception-only pill, Open record button, Edit→Settings, site handlers → `useSiteCrud` |
| `apps/web/src/components/settings/OrgSettingsPage.tsx` | `#contacts` and `#contracts` redirect to the record |
| `apps/web/src/components/devices/DeviceDetailPage.tsx` | Org crumb → `/organizations/<id>` |
| `apps/web/src/components/devices/DeviceList.tsx` | `forceSingleOrg?: boolean` prop |
| `apps/web/src/components/audit/AuditLogViewer.tsx` | `orgId?: string` prop |
| `apps/web/src/components/billing/InvoicesPage.tsx`, `apps/web/src/components/billing/quotes/QuotesPage.tsx`, `apps/web/src/lib/api/quotes.ts` (`listQuotes`) | `lockedOrgId?: string` prop; org filter on fetch; new-item default org |
| Ticket, invoice, quote, contract detail components | Org name → record link |
| `apps/web/src/components/layout/Sidebar.tsx` | Service Desk section, Organizations top-level, `requiresModule` gate, mode from `/partners/me` |
| `apps/web/src/components/settings/PartnerSettingsPage.tsx` | Mount `PartnerModulesCard` in the `company` tab |
| `apps/web/src/locales/*/common.json`, `settings.json` | Nav + settings keys |
| `apps/api/src/index.ts` | Mount `orgSummaryRoutes` |
| `apps/api/src/db/schema/orgs.ts` | Two partner columns |
| `apps/api/src/routes/orgs.ts` | Projection + `updatePartnerSettingsSchema` + PATCH validation |
| `apps/api/src/services/ticketService.ts` | `assertTicketCreationAllowed` in `createTicket` |

---

## Wave W01 — Record page shell, pinned fetching, summary endpoint, list affordances

Deliverable: `/organizations/<id>` renders header + Overview for a partner user; the organizations list links to it; the Active pill is exception-only.

### Task 1.1: `orgIdOverride` on `fetchWithAuth`

**Files:** Modify `apps/web/src/stores/auth.ts:1251-1290, 1368-1390`. Test: create `apps/web/src/stores/auth.orgIdOverride.test.ts` (mock `global.fetch`, register a provider via `registerOrgIdProvider(() => 'ambient-org')`, follow the mocking style of `auth.test.ts`).

**Interfaces (produces):**
```ts
export interface FetchWithAuthOptions extends RequestInit {
  skipUnauthorizedRetry?: boolean;
  skipOrgIdInjection?: boolean;           // kept as an alias of orgIdOverride: null
  /** undefined = inject ambient scope; string = force this org; null = inject nothing. */
  orgIdOverride?: string | null;
}
```

**Implementation:**
```ts
export async function fetchWithAuth(rawUrl: string, options: FetchWithAuthOptions = {}): Promise<Response> {
  const { skipOrgIdInjection, skipUnauthorizedRetry, orgIdOverride, ...init } = options;
  const url = applyOrgId(rawUrl, { skipOrgIdInjection, orgIdOverride, ambient: _getOrgId?.() ?? null });
  // ... existing token/refresh logic unchanged, but every `fetch(...)` call spreads `init`, not `options`
}

/** Exported for tests. Relative URLs only (the API base is prepended later by buildApiUrl). */
export function applyOrgId(rawUrl: string, o: { skipOrgIdInjection?: boolean; orgIdOverride?: string | null; ambient: string | null }): string {
  const hashIdx = rawUrl.indexOf('#');
  const hash = hashIdx >= 0 ? rawUrl.slice(hashIdx) : '';
  const base = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;
  const qIdx = base.indexOf('?');
  const path = qIdx >= 0 ? base.slice(0, qIdx) : base;
  const params = new URLSearchParams(qIdx >= 0 ? base.slice(qIdx + 1) : '');
  const existing = params.get('orgId');
  if (o.orgIdOverride === null || o.skipOrgIdInjection) {
    // caller owns scoping entirely
  } else if (typeof o.orgIdOverride === 'string') {
    if (existing && existing !== o.orgIdOverride) {
      throw new Error(`fetchWithAuth: URL orgId=${existing} conflicts with orgIdOverride=${o.orgIdOverride}`);
    }
    params.set('orgId', o.orgIdOverride);
  } else if (!existing && o.ambient) {
    params.set('orgId', o.ambient);
  }
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ''}${hash}`;
}
```

**Tests (write first, watch them fail):**
- `applyOrgId('/tickets', { ambient: 'a' })` → `/tickets?orgId=a` (existing behaviour preserved).
- `applyOrgId('/tickets?orgId=x', { ambient: 'a' })` → unchanged.
- `applyOrgId('/tickets?status=open', { orgIdOverride: 'p', ambient: 'a' })` → `/tickets?status=open&orgId=p`.
- `applyOrgId('/tickets?orgId=p', { orgIdOverride: 'p', ambient: 'a' })` → unchanged, no throw.
- `applyOrgId('/tickets?orgId=x', { orgIdOverride: 'p', ambient: 'a' })` → throws with message containing both ids.
- `applyOrgId('/fleet/findings', { orgIdOverride: null, ambient: 'a' })` → unchanged; same with `skipOrgIdInjection: true`.
- `fetchWithAuth('/x', { orgIdOverride: 'p', skipUnauthorizedRetry: true })`: the `RequestInit` passed to `global.fetch` has no `orgIdOverride`, `skipOrgIdInjection` or `skipUnauthorizedRetry` keys.
- Run `apps/web/src/lib/api/catalog.test.ts` and `apps/web/src/stores/orgStore.scope.test.ts` afterwards; both must still pass.

Commit: `feat(web): fetchWithAuth orgIdOverride for org-pinned pages`.

### Task 1.2: `org-record` route kind

**Files:** Modify `apps/web/src/lib/routeScope.ts:29-53`, `apps/web/src/lib/orgSwitch.ts:38-49`, `apps/web/src/components/layout/ContextScopeLine.tsx`. Tests: `apps/web/src/lib/routeScope.test.ts`, `apps/web/src/lib/orgSwitch.test.ts` (create if absent), `apps/web/src/components/layout/ContextScopeLine.test.tsx`.

**Interfaces:** `RouteScopeKind` gains `'org-record'`. `ROUTE_SCOPES` gains, above the `/settings/organizations` entries:
```ts
// The organization RECORD pins its org from the URL (spec D2). It neither
// requires nor follows the OrgSwitcher; the page owns its own scoping.
{ pattern: /^\/organizations\/[^/]+(\/.*)?$/, kind: 'org-record' },
```
`getOrgSwitchRedirect`: `/^\/organizations\/[^/]+\/?$/` → `'/settings/organizations'`. `ContextScopeLine`: `if (kind === 'org-record') return null;` (the record header shows scope itself, Task 1.5). `isGlobalScopeRoute` is unchanged: `org-record` does **not** suppress injection globally; the page passes `orgIdOverride` per request.

**Tests:** `getRouteScope('/organizations/abc')` → `'org-record'`; `getRouteScope('/organizations')` → `null` (no list route yet); `getOrgSwitchRedirect('/organizations/abc')` → `/settings/organizations`; `getOrgSwitchRedirect('/organizations')` → `null`; `isGlobalScopeRoute('/organizations/abc')` → `false`; ContextScopeLine renders nothing at `/organizations/abc` in fleet scope.

Commit: `feat(web): org-record route scope kind`.

### Task 1.3: `Organization.status` union fix

**Files:** Modify `apps/web/src/stores/orgStore.ts:19` to
`status: 'active' | 'trial' | 'suspended' | 'churned' | 'offboarding' | 'merging' | 'archived' | 'purging';`
Run `pnpm --filter @breeze/web exec tsc --noEmit`; fix any caller that compared against `'inactive'` on an `Organization` (the known `'inactive'` hits are SSO providers, partner status and device tests, which are different types and stay). Leave `Partner.status` alone.

Commit: `fix(web): orgStore Organization.status matches the API enum`.

### Task 1.4: `GET /orgs/organizations/:id/summary`

**Files:** Create `apps/api/src/routes/orgSummary.ts`; modify `apps/api/src/index.ts` (import + `api.route('/orgs', orgSummaryRoutes)` beside line 834). Test: create `apps/api/src/routes/orgSummary.test.ts` (copy the `vi.mock('../db', …)` and `setAuthContext` scaffolding from `apps/api/src/routes/orgs.test.ts:132-160, 2752-2775`). Integration: `apps/api/src/__tests__/integration/orgSummary.integration.test.ts`.

**Interfaces (produces):**
```ts
export const orgSummaryRoutes = new Hono<AppEnv>();
// GET /organizations/:id/summary → 200 OrgSummary | 404 { error: 'Organization not found' }
export interface OrgSummary {
  orgId: string;
  devices?:     { total: number; online: number; offline: number };
  alerts?:      { open: number; critical: number; high: number };
  tickets?:     { open: number; awaitingCustomer: number };
  contracts?:   { active: number; nextRenewalAt: string | null };
  invoices?:    { outstanding: string; currencyCode: string | null; nextDueAt: string | null; overdueCount: number };
  sites:        { count: number };
  contacts?:    { count: number; primary: { id: string; name: string; email: string | null; phone: string | null } | null };
  portalUsers?: { count: number };
  lastActivityAt: string | null;
}
```
Each optional section is present only when the caller holds the matching read permission (`devices`, `alerts`, `tickets`, `contracts`, `invoices`, `contacts` (org read covers it), `portal` for portalUsers). Use the imperative check already used by `apps/api/src/routes/search.ts` (`c.get('permissions')` + `hasPermission`).

**Implementation contract:** middleware chain identical to `GET /organizations/:id` (`requireScope('partner','system')`, `requireOrgRead`); `PG_UUID_REGEX` pre-check → 404; partner scope must pass `auth.canAccessOrg(id)` → else 404 (no archived branch: the summary is meaningless for a drained org). Counts (all `and(eq(t.orgId, id), <deletedAt null where the table has it>)`):
- devices: `total`; `online` = `status = 'online'`; `offline` = `status <> 'online' AND status <> 'decommissioned'`.
- alerts: `open` = `status IN ('active','acknowledged')`; `critical`/`high` = open with that `severity`.
- tickets: `open` = `status IN ('new','open','pending','on_hold')` (mirror `OPEN_STATUSES`, `routes/tickets/tickets.ts:61`); `awaitingCustomer` = `status = 'pending'`; exclude soft-deleted rows the same way the list does.
- contracts: `active` = `status = 'active'`; `nextRenewalAt` = `MIN(end_date)` among active with `end_date >= CURRENT_DATE`.
- invoices: open set = every value of `INVOICE_STATUSES` (`packages/shared/src/validators/invoices.ts`) except `draft`, `paid`, `void` (reuse the same predicate the invoices list uses for `overdue`); `outstanding` = `SUM(total - amount_paid)` as a decimal string; `nextDueAt` = `MIN(due_date)` among open; `overdueCount` = open with `due_date < CURRENT_DATE`; `currencyCode` = the org's `currency_code`.
- sites: count. contacts: count + the row with `is_primary AND site_id IS NULL`. portalUsers: count where not disabled. `lastActivityAt` = `MAX(audit_logs.created_at)` for the org.
All queries run in the request's normal DB context (no system context).

**Tests:** 404 for `not-a-uuid`; 404 when `canAccessOrg` is false; 200 with every section for a wildcard-permission partner; `tickets`/`invoices` omitted when those permissions are absent; org-scoped token → 403 (from `requireScope`). Integration: seed one org with 2 devices (1 online), 1 active alert (critical), 1 open ticket, verify numbers; a second partner's token gets 404.

Commit: `feat(api): per-organization summary endpoint`.

### Task 1.5: Record page shell, header, Overview tab

**Files:** Create `apps/web/src/pages/organizations/[id].astro` (mirror `pages/settings/organizations/[id].astro`, title "Organization"), `components/organizations/record/{OrganizationRecordPage,OrgRecordHeader,OrgOverviewTab}.tsx`, `orgRecordFetch.ts`, `orgRecordTabs.ts`, `apps/web/src/locales/*/organizations.json` (8 files). Tests: `OrganizationRecordPage.test.tsx`, `OrgRecordHeader.test.tsx`, `orgRecordTabs.test.ts`.

**Interfaces (produces):**
```ts
// orgRecordFetch.ts
export type OrgFetch = (path: string, init?: FetchWithAuthOptions) => Promise<Response>;
export function makeOrgFetch(orgId: string): OrgFetch;            // adds orgIdOverride: orgId
export function useLatest<T>(): { run: (p: Promise<T>) => Promise<T | undefined> }; // drops responses from a superseded call

// orgRecordTabs.ts
export const ORG_RECORD_TABS = ['overview','contacts','sites','devices','tickets','billing','activity'] as const;
export type OrgRecordTab = typeof ORG_RECORD_TABS[number];
export const TAB_PERMISSION: Record<OrgRecordTab, { resource: string; action: 'read' } | null>; // overview/contacts/sites → null (org read), devices, tickets, billing → contracts/invoices (either), activity → audit
export const SERVICE_MANAGEMENT_TABS: ReadonlySet<OrgRecordTab> = new Set(['tickets','billing']);
export function tabFromHash(hash: string): OrgRecordTab | undefined;  // '#tickets' → 'tickets'; unknown → undefined
export function visibleTabs(perms: UserPermissions | undefined, mode: 'native'|'off'|'external'): OrgRecordTab[];

// OrganizationRecordPage.tsx
export default function OrganizationRecordPage({ orgId }: { orgId: string });
```
Tab strip: `useHashState<OrgRecordTab>('overview', tabFromHash)` + `OverflowTabs` (`apps/web/src/components/shared/OverflowTabs.tsx`). W01 renders only Overview; other tab ids show a "coming in the next wave" placeholder **only in W01** and are replaced in W02/W03. `visibleTabs` takes `mode` now (default `'native'` until W04 wires the store) so W04 does not touch the shell.

**Header (`OrgRecordHeader`):** name; type badge from `org.type` (`customer`/`internal`); status pill always (subdued class when `active`, else `statusColors[status]` imported from `settings/OrganizationsPage.tsx`); primary contact from `summary.contacts.primary`; `summary.sites.count`; when `useOrgScope()` is a different org than `orgId`, a chip "Workspace: <other org name>" (`data-testid="org-record-scope-chip"`). Actions: **Work in this org** → `applyOrgSwitch(orgId)` then `/`; **Settings** → `/settings/organizations/<id>`; overflow with Archive (`ArchiveOrgModal`) and Merge (`MergeOrgModal`, only when `getJwtClaims().scope === 'partner'`). `data-testid`s: `org-record-header`, `org-record-status`, `org-record-work-here`, `org-record-settings`.

**Lifecycle states in the shell:**
- org-scoped JWT → `org-record-unavailable` card, link to `/`.
- GET 404 → look the org up in `useOrgStore().organizations`; if found and `status` is `suspended`/`churned`, render `org-record-lifecycle` card (name, status pill, created, copy `orgRecord.lifecycle.inaccessible`, link to `/settings/organizations`); otherwise `org-record-not-found`.
- `archived: true` in the response (or `isArchiveLifecycleOrg`) → read-only banner (`org-record-archived-banner`), no Work/Archive/Merge actions, Restore via the same `POST` the settings page uses.
- Loading → skeleton; fetch error → inline error with retry (`runAction` not needed: reads).

**Overview tab:** tiles from `OrgSummary` (each tile hidden when its section is absent): Devices online/total, Open alerts (critical/high sub-line), Open tickets (awaiting customer sub-line), Active contracts (next renewal), Outstanding invoices (next due, overdue count), Contacts, Portal users. Below: "Recent activity" (last 20 rows from `GET /audit-logs?limit=20` through `orgFetch`) and "Open critical alerts" (`GET /alerts?status=active&severity=critical&limit=10` through `orgFetch`, rendered with `AlertList({ orgId })`). Tiles have `data-testid="org-overview-tile-<key>"`.

**i18n:** namespace `organizations`, keys under `orgRecord.*` (header.*, tabs.*, overview.*, lifecycle.*, actions.*, unavailable.*). English copy in the PR; other 7 locales get real translations (not English copies), same as prior waves.

**Tests:** shell renders header from a mocked `GET /orgs/organizations/:id` + `/summary`; `#tickets` in the URL selects that tab; 404 + store row `suspended` → lifecycle card; `archived: true` → banner and no `org-record-work-here`; org-scope claims → unavailable card; `visibleTabs` drops `devices` without `devices:read` and drops `tickets`/`billing` when `mode === 'off'`; every request URL in the test's fetch mock contains `orgId=<record id>` even with the store's `currentOrgId` set to another org.

Commit: `feat(web): organization record page shell with overview`.

### Task 1.6: Organizations list affordances + breadcrumb

**Files:** Modify `apps/web/src/components/settings/OrganizationsPage.tsx` (row block ~1085-1160, detail header ~1284-1330, `handleEdit`), `apps/web/src/components/devices/DeviceDetailPage.tsx:639`, `apps/web/src/locales/*/settings.json` (`organizationsPage.actions.openRecord`, `organizationsPage.actions.openSettings`). Tests: extend `OrganizationsPage.test.tsx`; `DeviceDetailPage` breadcrumb test if one exists.

**Changes:**
- Row: wrap `{org.name}` in `<a href={`/organizations/${org.id}`} data-testid={`org-open-record-${org.id}`} onClick={e => e.stopPropagation()}>`; add a persistent chevron link with the same href at the row end (visible without hover, `aria-label` = openRecord).
- Status pill: render only when `org.status !== 'active'`. The archived section is untouched.
- Detail-pane header: primary button **Open record** (`data-testid="org-open-record"`, `navigateTo('/organizations/<id>')`) before the existing buttons; the existing Edit button label → `organizationsPage.actions.openSettings` ("Settings"). The hover pencil keeps going to settings; its `title` becomes openSettings too.
- `DeviceDetailPage.tsx:639`: `href: `/organizations/${device.orgId}``.

**Tests:** an `active` org renders no status pill, a `trial` org renders "Trial"; `org-open-record-<id>` has the record href; clicking the name does not select the row; detail header shows Open record; device breadcrumb href points at `/organizations/<orgId>`.

Commit: `feat(web): organizations list opens the record; exception-only status pill`.

### W01 verification

- `pnpm --filter @breeze/web exec tsc --noEmit`; `cd apps/web && npx vitest run src/stores/auth.orgIdOverride src/lib/routeScope src/lib/orgSwitch src/components/organizations/record src/components/settings/OrganizationsPage src/lib/i18n/localeParity`.
- `cd apps/api && npx vitest run src/routes/orgSummary`; integration suite for `orgSummary` against a real DB.
- Browser: open an org from the list with the switcher on "All organizations", confirm the scope chip is absent; switch the switcher to another org, reload the record, confirm the chip names the other org and the tiles still show the record's org.

---

## Wave W02 — Contacts, Sites, Devices, Activity tabs

Deliverable: four data tabs, sites CRUD shared with the settings list, `#contacts` on the settings page redirects to the record.

### Task 2.1: `useSiteCrud(orgId)` hook

**Files:** Create `apps/web/src/components/settings/useSiteCrud.ts`; modify `OrganizationsPage.tsx:191-199, 392-415, 856-990` to consume it (state + handlers move; the modals' JSX stays in the page and reads from the hook). Test: `useSiteCrud.test.ts` (renderHook + mocked `fetchWithAuth`).

**Interfaces (produces):**
```ts
export type SiteModalMode = 'closed' | 'add' | 'edit' | 'delete';
export interface UseSiteCrud {
  sites: Site[]; sitesLoading: boolean; siteSubmitting: boolean;
  siteModalMode: SiteModalMode; selectedSite: Site | null;
  guidingFirstSite: boolean; setGuidingFirstSite: (v: boolean) => void;
  refresh: () => Promise<Site[] | null>;          // GET /orgs/sites?organizationId=<orgId> with orgIdOverride: orgId
  openAdd: () => void; openEdit: (s: Site) => void; openDelete: (s: Site) => void; close: () => void;
  submit: (values: Record<string, unknown>) => Promise<void>;   // POST /orgs/sites | PATCH /orgs/sites/:id via runAction
  confirmDelete: () => Promise<void>;                            // DELETE /orgs/sites/:id via runAction
  getSiteFormDefaults: (s: Site & { address?: Record<string,string>; contact?: Record<string,string> }) => SiteFormDefaults;
}
export function useSiteCrud(orgId: string | null, opts: { onUnauthorized: () => void; t: TFunction }): UseSiteCrud;
```
Behaviour is a verbatim move of the existing handlers (`OrganizationsPage.tsx:392-415, 856-990`): same URLs, same `runAction` error fallbacks, same `ActionError` catch pattern. The only addition is `orgIdOverride: orgId` on the sites GET so the hook is correct inside the record.

**Tests:** `refresh` calls `/orgs/sites?organizationId=<id>&orgId=<id>`; `submit` in add mode POSTs `/orgs/sites` with `orgId` in the body; edit PATCHes `/orgs/sites/<siteId>`; `confirmDelete` DELETEs; a non-401 failure surfaces a toast and leaves the modal open. `OrganizationsPage.test.tsx` must pass unchanged.

Commit: `refactor(web): extract useSiteCrud from OrganizationsPage`.

### Task 2.2: Contacts and Sites tabs

**Files:** Create `OrgSitesTab.tsx`; modify `OrganizationRecordPage.tsx` to render `<ContactsCard orgId={orgId} />` for `contacts` and `<OrgSitesTab orgId={orgId} />` for `sites`. `OrgSitesTab` = `useSiteCrud(orgId)` + `SiteList` (`onSiteClick` → `/settings/sites/<id>`) + the add/edit/delete modals (copy the JSX from `OrganizationsPage.tsx` modals; they become shared once, so extract `SiteModals.tsx` in `components/settings/` and use it from both pages). Tests: `OrgSitesTab.test.tsx` (add flow through the hook mock), record page test selects `#contacts` and finds `ContactsCard`'s root testid.

Commit: `feat(web): contacts and sites tabs on the organization record`.

### Task 2.3: Devices tab + `forceSingleOrg`

**Files:** Modify `apps/web/src/components/devices/DeviceList.tsx:314-365, 1040` (`forceSingleOrg?: boolean`; `const isFleetView = !forceSingleOrg && useOrgStore(...)` — keep the hook call unconditional). Create `OrgDevicesTab.tsx`: loads `GET /devices?limit=200&orgId=<id>` (via `orgFetch`), sites from the summary hook or `GET /orgs/sites?organizationId=`, renders `<DeviceList devices sites forceSingleOrg />`; filter bar limited to search/status/site. Tests: `DeviceList.test.tsx` gains "hides the Organization column when `forceSingleOrg` even in fleet scope"; `OrgDevicesTab.test.tsx` asserts the fetch URL carries the record org while the store points elsewhere.

Commit: `feat(web): devices tab on the organization record`.

### Task 2.4: Activity tab + `AuditLogViewer({orgId})`

**Files:** Modify `apps/web/src/components/audit/AuditLogViewer.tsx:120-125, 179-180`: `interface AuditLogViewerProps { timezone?: string; orgId?: string }`; when `orgId` is set, pass `orgIdOverride: orgId` on both endpoints. Create `OrgActivityTab.tsx` → `<AuditLogViewer orgId={orgId} />`. Tests: `AuditLogViewer.test.tsx` gains a case that the request carries `orgId=<prop>` while the store has another org.

Commit: `feat(web): activity tab on the organization record`.

### Task 2.5: Settings `#contacts` redirect

**Files:** Modify `apps/web/src/components/settings/OrgSettingsPage.tsx` (the `contacts` case ~629 and the tab list ~57): keep the nav entry but on activation call `navigateTo(`/organizations/${effectiveOrgId}#contacts`)`; remove `ContactsCard` from the settings render. Test: `OrgSettingsPage.test.tsx` asserts the redirect on `#contacts`.

Commit: `feat(web): org settings #contacts hands off to the record`.

### W02 verification

`tsc`; `npx vitest run src/components/organizations/record src/components/settings/useSiteCrud src/components/settings/OrganizationsPage src/components/settings/OrgSettingsPage src/components/devices/DeviceList src/components/audit/AuditLogViewer src/lib/no-silent-mutations`. Browser: add a site from the record, see it in the settings list; open Activity with the switcher on another org and confirm rows belong to the record's org.

---

## Wave W03 — Tickets, Contracts & Billing tabs, cross-links

Deliverable: the two Service Management tabs and org-name links from ticket/invoice/quote/contract detail pages into the record. Runs in parallel with W02 (file-disjoint).

### Task 3.1: Tickets tab

**Files:** Create `OrgTicketsTab.tsx`: status filter (open/all/closed mirroring `tabQuery` in `TicketsPage.tsx`), `GET /tickets?<params>&limit=100` via `orgFetch`, `<TicketQueueList tickets selectedId={null} onSelect={t => navigateTo(`/tickets/${t.id}`)} loading config />` (`config` from `GET /ticket-config` via `orgFetch`), **New ticket** → `/tickets/new#orgId=<id>` (confirm `TicketsPage`/new-ticket form reads `#orgId=`; if it does not, add that read in the same task). Tests: request URL carries the record org; empty state; New ticket href.

Commit: `feat(web): tickets tab on the organization record`.

### Task 3.2: `lockedOrgId` on invoices and quotes

**Files:** Modify `apps/web/src/components/billing/InvoicesPage.tsx:98, 167-182, 233-237` and `apps/web/src/components/billing/quotes/QuotesPage.tsx:97, 150-160, 215-218`; `apps/web/src/lib/api/quotes.ts` `listQuotes` gains `orgId?: string` and passes it explicitly (pattern: `lib/api/catalog.ts` `resolveCatalogPrice`). Copy the `ContractsList` contract (`contracts/ContractsList.tsx:84-113, 173-180, 314, 446, 483`): `lockedOrgId?: string` prop; when set, `params.set('orgId', lockedOrgId)`, hide the org column and org filter, default the create-modal org to `lockedOrgId` instead of `useOrgStore.getState().currentOrgId`, and skip hash-filter writes. Tests: `InvoicesPage.test.tsx` / `QuotesPage.test.tsx` gain "locked embed fetches with the locked org and pre-fills the create modal with it while the store points elsewhere".

Commit: `feat(web): lockedOrgId on invoices and quotes pages`.

### Task 3.3: Contracts & Billing tab

**Files:** Create `OrgBillingTab.tsx`: three stacked sections, Contracts (`<ContractsList lockedOrgId={orgId} />`), Invoices (`<InvoicesPage lockedOrgId={orgId} />`), Quotes (`<QuotesPage lockedOrgId={orgId} />`), each collapsible, contracts first. Tests: renders all three with the prop.

Commit: `feat(web): contracts & billing tab on the organization record`.

### Task 3.4: Org links from detail pages + `#contracts` redirect

**Files:** Ticket workbench header (`components/tickets/TicketWorkbench.tsx`, the org name), `components/billing/InvoiceDetail.tsx`, `components/billing/quotes/QuoteDetail.tsx`, contracts detail (`components/contracts/*Detail*.tsx`): wrap the displayed org name in `<a href={`/organizations/${orgId}`} data-testid="org-record-link">`. `OrgSettingsPage.tsx` `contracts` case → `navigateTo(`/organizations/${effectiveOrgId}#billing`)`, remove the embedded `ContractsList` from settings. Tests: each detail test asserts the link href; settings test asserts the `#contracts` redirect. The `#billing` and `#pax8/<id>` settings deep links are untouched (grep `settings/organizations/` to confirm they still resolve).

Commit: `feat(web): organization record links from ticket, invoice, quote and contract details`.

### Task 3.5: Playwright spec

**Files:** Create `e2e-tests/tests/organization-record.spec.ts` and `e2e-tests/pages/OrganizationRecordPage.ts` (Page Object; selectors by `data-testid` only, per `e2e-tests/README.md`). Uses the seeded partner admin and the first seeded org.

**Scenarios:** (1) from `/settings/organizations`, click `org-open-record-<id>` → URL is `/organizations/<id>`, `org-record-header` shows the org name; (2) navigate to `/organizations/<id>#tickets` → the Tickets tab is active and its list container is present; (3) with the OrgSwitcher on a different org, open the record → `org-record-scope-chip` names the other org and the Devices tab rows all belong to the record org (row testids carry the device org, or the Organization column is absent); (4) click `org-record-work-here` → the switcher shows the record org after reload. Use the hydration wait helper the portal login spec uses (memory: fill-before-hydration race), never a longer timeout.

Commit: `test(e2e): organization record page`.

### W03 verification

`tsc`; `npx vitest run src/components/organizations/record src/components/billing src/components/tickets/TicketWorkbench src/components/contracts src/components/settings/OrgSettingsPage src/lib/no-silent-mutations`. Browser: from the record's Tickets tab create a ticket and confirm it lands on the record's org while the switcher is on another org; open a quote and follow the org link back.

---

## Wave W04 — Sidebar regroup + Service Management mode

Deliverable: Service Desk and Billing sections, Organizations top-level, the mode stored/exposed/edited, `off` hides the module and refuses new tickets.

### Task 4.1: Migration + schema

**Files:** Create `apps/api/migrations/2026-10-12-000200-partners-service-management-mode.sql`; modify `apps/api/src/db/schema/orgs.ts:125-143` (after `aiForOfficeEnabled`). Tests: `apps/api/src/db/autoMigrate.test.ts` (runs on its own), `scripts/check-migration-naming.sh` (pre-commit), and `apps/api/src/__tests__/integration/partnersServiceManagementMode.integration.test.ts` for the CHECKs.

```sql
-- 2026-10-12-000200-partners-service-management-mode.sql
-- Partner-level Service Management mode (spec: docs/superpowers/specs/web-ui/2026-09-06-organization-record-page-design.md, Part 2)
-- Idempotent. No inner BEGIN/COMMIT (autoMigrate wraps each file). No DML, so no breeze.scope elevation is needed.

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS service_management_mode text NOT NULL DEFAULT 'native',
  ADD COLUMN IF NOT EXISTS service_management_psa_connection_id uuid
    REFERENCES psa_connections(id) ON DELETE RESTRICT;

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_service_management_mode_chk;
ALTER TABLE partners ADD CONSTRAINT partners_service_management_mode_chk
  CHECK (service_management_mode IN ('native', 'external', 'off'));

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_service_management_connection_chk;
ALTER TABLE partners ADD CONSTRAINT partners_service_management_connection_chk
  CHECK ((service_management_mode = 'external') = (service_management_psa_connection_id IS NOT NULL));
```
Schema:
```ts
serviceManagementMode: text('service_management_mode').$type<'native' | 'external' | 'off'>().notNull().default('native'),
serviceManagementPsaConnectionId: uuid('service_management_psa_connection_id').references(() => psaConnections.id, { onDelete: 'restrict' }),
```
(`psaConnections` lives in `db/schema/integrations.ts`; import it. If that creates an import cycle with `orgs.ts`, reference the FK in the migration only and keep the Drizzle column as a bare `uuid(...)` with a comment, as other cross-file FKs in this schema do.)

**Integration test:** `UPDATE partners SET service_management_mode='external'` without a connection → 23514; `mode='native'` with a connection id → 23514; `mode='bogus'` → 23514; deleting a bound connection → 23503. Run `pnpm db:check-drift` after.

Commit: `feat(db): partners.service_management_mode + psa connection binding`.

### Task 4.2: `serviceManagement` service + `/partners/me` exposure

**Files:** Create `apps/api/src/services/serviceManagement.ts`; modify `apps/api/src/routes/orgs.ts:419-458` (projection), `:811` (`updatePartnerSettingsSchema`), the `PATCH /partners/me` handler body (validation + write). Tests: `apps/api/src/services/serviceManagement.test.ts`, `apps/api/src/routes/orgs.test.ts` (new describe blocks).

**Interfaces (produces):**
```ts
// services/serviceManagement.ts
export type ServiceManagementMode = 'native' | 'external' | 'off';
export const SERVICE_MANAGEMENT_MODES: readonly ServiceManagementMode[] = ['native', 'external', 'off'];
export async function getServiceManagementMode(partnerId: string): Promise<ServiceManagementMode>; // default 'native' when the partner row is missing
export class ServiceManagementOffError extends Error { readonly code = 'service_management_off'; readonly status = 409; }
export async function assertTicketCreationAllowed(partnerId: string): Promise<void>; // throws ServiceManagementOffError when mode === 'off'
```
`updatePartnerSettingsSchema` gains:
```ts
serviceManagementMode: z.enum(['native', 'external', 'off']).optional(),
serviceManagementPsaConnectionId: z.string().uuid().nullable().optional(),
```
PATCH validation (before the write): if `serviceManagementMode === 'external'`, `serviceManagementPsaConnectionId` must be present and must resolve to a `psa_connections` row with `partner_id = auth.partnerId` and `org_id IS NULL` → else 400 `{ error: 'External mode requires one of your partner-wide PSA connections' }`. If mode is `native`/`off`, force the connection id to `null` in the write. Until the external service desk feature ships, `external` is still accepted by the API (the UI just does not offer it). Include `serviceManagementMode` in `details.changedFields` of the existing audit write. Add both fields to `partnerPublicColumns()`.

**Tests:** service: `off` → throws `ServiceManagementOffError`; `native` → resolves; missing partner → `native`. Routes: GET `/partners/me` returns `serviceManagementMode: 'native'`; PATCH `{ serviceManagementMode: 'off' }` → 200 and the update `set` received `serviceManagementPsaConnectionId: null`; PATCH `external` without id → 400; with an id owned by another partner (mock returns no row) → 400; org-scope token → 403 (existing `requireScope`).

Commit: `feat(api): service management mode on /partners/me`.

### Task 4.3: `off` refuses new ticket creation

**Files:** Modify `apps/api/src/services/ticketService.ts:492-499` (`createTicket`: after resolving `org.partnerId`, `await assertTicketCreationAllowed(org.partnerId)`); `createTicketFromAlert` inherits (it calls `createTicket`). Map the error: `TicketServiceError('Service Management is turned off for this partner', 409, 'service_management_off')` so the alert dialog, portal and add-in routes return 409 through their existing `TicketServiceError` handling, and `aiToolsTicketing` returns `{ error }` JSON as it does for other service errors. Tests: `ticketService.test.ts` (mock `getServiceManagementMode` → `off` → 409 with the code; `native` → creates); `aiToolsTicketing.test.ts` create → error JSON mentions service management; `routes/alerts` create-ticket test → 409.

Commit: `feat(api): service management off refuses new tickets`.

### Task 4.4: Sidebar regroup + `requiresModule` gate + store field

**Files:** Modify `apps/web/src/components/layout/Sidebar.tsx:147-169, 184, 225-241, 276-288, 312, 547-572, 694-707`; `apps/web/src/stores/orgStore.ts` (persisted `serviceManagementMode: 'native'|'off'|'external'`, default `'native'`, setter); `apps/web/src/locales/*/common.json` (`nav.sectionServiceDesk`, `nav.serviceManagement`). Tests: create `Sidebar.module.test.tsx` (copy the harness from `Sidebar.featuregate.test.tsx`); update `Sidebar.nav.test.tsx` for the new order.

**Changes:**
- `NavItem` gains `requiresModule?: 'service_management'`; `NavSection` gains the same (a section-level gate hides the whole section).
- Remove Tickets from the top-level items (`:184`). New section after Backup:
  ```ts
  { id: 'service-desk', label: 'Service Desk', labelKey: 'nav.sectionServiceDesk', icon: Ticket, requiresModule: 'service_management',
    items: [ Tickets (as today), Timesheets (moved from Billing) ] },
  ```
  Billing section gets `requiresModule: 'service_management'` and keeps Quotes, Invoices, Contracts, Product Catalog.
- Top-level items gain, right after Dashboard: `{ name: 'Organizations', labelKey: 'nav.organizations', href: '/settings/organizations', icon: Building2, partnerScopeOnly: true, requiredPermission: { resource: 'organizations', action: 'read' } }`. The Settings-section Organizations entry (`:312`) is removed.
- `/orgs/partners/me` effect (`:547-572`): also read `data.serviceManagementMode` and call `useOrgStore.getState().setServiceManagementMode(mode ?? 'native')`. On any failure leave the store as is (fail open: default `native`).
- `isNavItemVisible`: `if (item.requiresModule === 'service_management' && mode !== 'native') return false;` where `mode = useOrgStore(s => s.serviceManagementMode)`. Same check in the section renderer before the item cascade. (`external` also hides the native sections; the follow-on feature adds its read-only list.)

**Tests:** `native` → Service Desk + Billing visible; `off` → both hidden, Organizations and Reporting visible; `external` → both hidden; fetch failure → visible (store default); Organizations appears once, at the top, and not under Settings.

Commit: `feat(web): service desk section, organizations top-level, service management gate`.

### Task 4.5: Modules card on Partner settings

**Files:** Create `apps/web/src/components/settings/PartnerModulesCard.tsx`; modify `PartnerSettingsPage.tsx:585-606` (render the card under `PartnerCompanyTab`); `apps/web/src/locales/*/settings.json` (`partnerSettingsPage.modules.*`). Test: `PartnerModulesCard.test.tsx`.

**Card:** loads `GET /orgs/partners/me` (or receives `serviceManagementMode` as a prop from the page's existing partner fetch, preferred), shows a radio group with two options in this wave: **Breeze service desk & billing** (`native`) and **Off (RMM only)** (`off`), each with a two-line description of what it shows/hides; saves immediately on change via `runAction({ request: () => fetchWithAuth('/orgs/partners/me', { method: 'PATCH', body: JSON.stringify({ serviceManagementMode }) }) })`, then `useOrgStore.getState().setServiceManagementMode(mode)` so the sidebar updates without reload. `data-testid="partner-modules-card"`, radios `partner-modules-mode-<mode>`. The `external` option is not rendered (follow-on feature).

**Tests:** renders the current mode checked; choosing Off PATCHes and updates the store; a failed PATCH reverts the radio and toasts (via `runAction`).

Commit: `feat(web): service management mode card on partner settings`.

### Task 4.6: Record page gating + web create-ticket surfaces

**Files:** Modify `orgRecordTabs.ts`/`OrganizationRecordPage.tsx` to read `useOrgStore(s => s.serviceManagementMode)` and pass it to `visibleTabs`; `OrgOverviewTab.tsx` hides the tickets/contracts/invoices tiles unless `native`. `CreateTicketFromAlertDialog` trigger (alerts detail) and any "New ticket" button render only when mode is `native` (`useOrgStore` read; API 409 remains the backstop). Tests: record page test with store `off` → no Tickets/Billing tabs, no tiles; alert detail test → no create-ticket button when `off`.

Commit: `feat(web): hide service management surfaces when the mode is off`.

### W04 verification

- API: `npx vitest run src/services/serviceManagement src/services/ticketService src/routes/orgs src/services/aiToolsTicketing`; integration `partnersServiceManagementMode`; `pnpm db:check-drift`; `scripts/check-migration-naming.sh`.
- Web: `tsc`; `npx vitest run src/components/layout/Sidebar src/components/settings/PartnerModulesCard src/components/organizations/record src/lib/i18n/localeParity`.
- Browser: flip the mode to Off, watch Service Desk and Billing vanish without reload, open an org record and confirm the two tabs are gone, open an alert and confirm Create ticket is gone; flip back.
- Contract grep before PR: `grep -rn "service_management_mode" apps/api/src apps/api/migrations` shows schema, migration, service, route; `grep -rn "requiresModule" apps/web/src` shows Sidebar only.

---

## Out of scope (tracked in the spec's Follow-ups)

External service desk (adapter wiring, shadow rows, status sync, company picker, the `external` radio), onboarding "RMM only" preset, partner access to suspended/churned records, `serviceManagementMode` for org-scoped users, operational `/organizations` list, Redis-cached summary.

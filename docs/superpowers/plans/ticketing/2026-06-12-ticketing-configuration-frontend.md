# Ticketing Configuration PR 2 — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the UI for the merged #1287 backend: tabbed `/settings/ticketing` (Statuses, Priorities, Categories, Export), the settings-nav move under Partner admin, the org-settings "Ticketing" tab, custom-status display + selection across the ticket UI, and priority-label decoration — per spec `docs/superpowers/specs/ticketing/2026-06-12-ticketing-configuration-design.md` §5.

**Architecture:** Astro MPA + React islands. One module-cached `fetchTicketConfig()` is the single read path for statuses/priorities; the static `statusConfig`/`priorityConfig` in `ticketConfig.ts` stay as fallbacks and are NOT removed. All mutations via `runAction` (+ `no-silent-mutations` enrollment); hash-based tab/UI state; no client permission store (admin tabs render for everyone; the API's admin gate 403s with a clear message we surface).

**Tech Stack:** React 18, Astro, Tailwind tokens, Vitest + Testing Library.

---

## Merged API surface (verified against #1287 — trust this)

| Route | Notes |
|---|---|
| `GET /ticket-config` | `{data: {statuses: StatusRow[], priorities: {low\|normal\|high\|urgent: {label: string\|null, responseSlaMinutes: number\|null, resolutionSlaMinutes: number\|null}}}}`. StatusRow: `{id, partnerId, name, coreStatus, color: string\|null, sortOrder, isSystem, isActive, createdAt, updatedAt}` ordered by sortOrder asc, name asc. Perm: `tickets:read`, partner/system scope. |
| `POST /ticket-config/statuses` | `{name (1-60), coreStatus, color? (#rrggbb\|null), sortOrder?}` → 201 `{data: row}`. Admin-gated. |
| `PATCH /ticket-config/statuses/:id` | partial `{name?, coreStatus?, color?, sortOrder?, isActive?}` (≥1 field). Admin-gated. |
| `POST /ticket-config/statuses/reorder` | `{ids: uuid[]}` (≤200, unique) → bulk sortOrder=index, returns updated count. Admin-gated. |
| `PUT /ticket-config/priorities` | `{priorities: {<priority>: {label?: string\|null (≤40), responseSlaMinutes?: int 0..525600\|null, resolutionSlaMinutes?: same}}}`. Admin-gated. |
| `GET /orgs/organizations/:id/ticket-settings` | `{data: {orgId, slaOverrides: {<priority>?: {responseMinutes?, resolutionMinutes?}}, defaultHourlyRate: string\|null, defaultBillable: boolean\|null}}` — defaults shape when no row (no 404). Org-read. |
| `PATCH /orgs/organizations/:id/ticket-settings` | `{slaOverrides?, defaultHourlyRate? (number\|null), defaultBillable? (boolean\|null)}` (≥1 field). `slaOverrides` REPLACES wholesale. Org-write + **MFA** + audit — mirror how `OrgPortalSettingsEditor` handles the MFA-required error. Echoes saved row. |
| `POST /tickets/:id/status` (existing route) | body now accepts EXACTLY ONE of `{status: core}` or `{statusId: uuid}` (+ `resolutionNote`/`pendingReason` as before). Service errors: `STATUS_NOT_FOUND` 404, `STATUS_INACTIVE` 400, `INVALID_TRANSITION` 409, resolved-without-note 400. |
| Ticket list/detail (staff + portal) | decorated with `statusName` (+ `statusColor` staff-only) — null for legacy tickets; fall back to core `statusConfig` labels. |

Error bodies `{error, code}`. Admin-gate 403 message: `"Managing ticket configuration requires an admin role"` — surface it verbatim (runAction shows the API error already). Codes worth friendly-mapping: `STATUS_NAME_TAKEN` ("A status with that name already exists."), `SYSTEM_STATUS_IMMUTABLE` ("Built-in statuses can't change their core state."), `SYSTEM_STATUS_REQUIRED` ("Built-in statuses can't be deactivated."), `STATUS_INACTIVE` ("That status is deactivated.").

**Key web precedents to mirror (read before each task):** `TicketCategoriesPage.tsx` (settings CRUD page conventions), `OrgPortalSettingsEditor.tsx` + its org-settings tab wiring (org tab + MFA handling), `TicketsPage.tsx` `parseHash`/`hashFor` (hash state), `TicketWorkbench.tsx` status select + resolve/pending forms, `lib/runAction.ts` (`runAction`, `handleActionError`), `lib/timeFormat.ts`, `settings/index.astro` (nav cards), `no-silent-mutations.test.ts` `TARGET_GLOBS` (count currently 22).

**Branch:** `feat/ticketing-config-frontend`, fresh worktree from origin/main, `pnpm install`, node PATH prefix per convention. Run web tests as `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run <files>`.

---

### Task 1: `lib/ticketConfigApi.ts` — cached config fetch + resolution helpers

**Files:** Create `apps/web/src/lib/ticketConfigApi.ts` + `apps/web/src/lib/__tests__/ticketConfigApi.test.ts`

- [ ] TDD. Exports:
```ts
export interface TicketStatusRow { id: string; name: string; coreStatus: CoreStatus; color: string | null; sortOrder: number; isSystem: boolean; isActive: boolean }
export interface PrioritySetting { label: string | null; responseSlaMinutes: number | null; resolutionSlaMinutes: number | null }
export interface TicketConfig { statuses: TicketStatusRow[]; priorities: Record<Priority, PrioritySetting> }

/** Module-cached per page load; invalidate() clears (settings pages call it after writes). */
export async function fetchTicketConfig(): Promise<TicketConfig | null>;   // null on any failure (callers fall back to static config)
export function invalidateTicketConfig(): void;
/** Display helpers with static-config fallback (import statusConfig/priorityConfig from components/tickets/ticketConfig). */
export function statusLabel(config: TicketConfig | null, coreStatus: CoreStatus, statusName?: string | null): string;   // statusName ?? config system-row name ?? statusConfig label
export function priorityLabel(config: TicketConfig | null, priority: Priority): string;  // config label ?? priorityConfig label
export function activeStatusesByCore(config: TicketConfig): Array<{ coreStatus: CoreStatus; statuses: TicketStatusRow[] }>; // six groups, core order new→closed, active rows only, sorted
```
Tests: cache returns same promise / single fetch; invalidate forces refetch; null on !ok; helpers' fallback chains; grouping order + inactive exclusion.
- [ ] Commit `feat(ticketing): cached ticket-config client + display helpers`.

### Task 2: `/settings/ticketing` tab shell

**Files:** Create `apps/web/src/components/settings/TicketingSettingsPage.tsx` (+test); modify `apps/web/src/pages/settings/ticketing.astro` to render it; `TicketCategoriesPage` becomes the Categories tab's content (import + render unchanged — do NOT rewrite it).

- [ ] Tabs: Statuses | Priorities | Categories | Export — hash state `#tab=<statuses|priorities|categories|export>` (default statuses; mirror parseHash conventions; `history.replaceState`). Testids `ticketing-settings-tabs`, `ticketing-tab-<name>`. Categories tab renders `<TicketCategoriesPage />`; Export tab renders `<BillablesExportCard />` (move it OUT of TicketCategoriesPage so it doesn't render twice — adjust TicketCategoriesPage + its test accordingly). Lazy-render tabs (only the active tab mounts).
- [ ] Tests: tab switching updates hash + renders the right child (stub children via vi.mock); deep-link `#tab=export` opens Export.
- [ ] Commit `feat(ticketing): tabbed ticketing settings shell`.

### Task 3: Statuses tab

**Files:** Create `apps/web/src/components/settings/TicketStatusesTab.tsx` + test.

- [ ] Render the six core-state groups (order new→closed, group header = core label from `statusConfig`); within each, rows sorted by sortOrder: color dot, name, `Built-in` badge when `isSystem` (testid `status-system-badge-<id>`), Inactive badge, ▲/▼ reorder arrows (testids `status-up-<id>`/`status-down-<id>`; reorder operates on the FLAT ordered active+inactive list and POSTs the full id array — #1251 reorder pattern), Edit, Deactivate/Activate toggle (hidden for isSystem).
- [ ] Add form (testids `status-add-toggle`, `status-form-name`, `status-form-core`, `status-form-color`, `status-form-submit`): name + core-state select + optional color. Edit form pre-fills; core-state select DISABLED for isSystem rows (server enforces too).
- [ ] All mutations via runAction with the friendly code map from the header table; refetch list + `invalidateTicketConfig()` after each success; catch via `handleActionError`.
- [ ] Tests: groups render from a mocked GET; add POSTs correct body; reorder POSTs full ids array; isSystem rows hide deactivate + disable core select; STATUS_NAME_TAKEN error path shows the friendly message (assert showToast).
- [ ] Commit `feat(ticketing): statuses management tab`.

### Task 4: Priorities tab

**Files:** Create `apps/web/src/components/settings/TicketPrioritiesTab.tsx` + test.

- [ ] Four rows (urgent→low): label input (placeholder = default label), response/resolution minutes inputs (placeholder = effective default e.g. "60" for urgent / "—" for normal/low; blank input = null). One Save button → `PUT /ticket-config/priorities` with the full four-priority object via runAction; refetch + invalidate after. Testids `priority-label-<p>`, `priority-response-<p>`, `priority-resolution-<p>`, `priorities-save`. Note under the grid: "Order of precedence: category SLA → org override → these defaults."
- [ ] Tests: renders fetched values; save PUTs the exact body shape (blank → null, numbers parsed int); non-admin 403 surfaces the API message.
- [ ] Commit `feat(ticketing): priority labels + SLA defaults tab`.

### Task 5: Settings nav move

**Files:** Modify `apps/web/src/pages/settings/index.astro` (and any settings nav/sidebar component it uses).

- [ ] Move the Ticketing card/link into the Partner setup/admin grouping (read the file: if cards are flat, relocate next to the Partner card; match existing card markup). Keep URL `/settings/ticketing` unchanged. Verify no other nav references break (`grep -rn "settings/ticketing" apps/web/src`).
- [ ] Commit `feat(ticketing): ticketing settings under partner admin nav`.

### Task 6: Org settings "Ticketing" tab

**Files:** Create `apps/web/src/components/settings/OrgTicketSettingsEditor.tsx` + test; modify the org-settings page/tab registry where `OrgPortalSettingsEditor` is mounted (find it: `grep -rn "OrgPortalSettingsEditor" apps/web/src`) to add a sibling "Ticketing" tab.

- [ ] GET on mount (`/orgs/organizations/${orgId}/ticket-settings`). Form: per-priority grid (urgent→low) of response/resolution minute inputs whose placeholders show "Partner default" (just the words — effective values come from `fetchTicketConfig()` priorities when available); default hourly rate input; default billable tri-state select (Inherit/Billable/Non-billable ↔ null/true/false). Save → PATCH via runAction (slaOverrides REPLACES wholesale — send the complete grid each save, omitting untouched-empty priorities as absent keys is fine since blank = null... simplest correct: build slaOverrides from ALL non-blank cells and send it; blank cell = key absent = cleared, because the object replaces wholesale). Mirror `OrgPortalSettingsEditor` exactly for: MFA-required error handling, layout, save-button state, testid style. Testids `org-ticket-sla-<p>-response`, `org-ticket-sla-<p>-resolution`, `org-ticket-rate`, `org-ticket-billable`, `org-ticket-save`.
- [ ] Tests: GET renders values incl. defaults shape; save PATCHes wholesale slaOverrides + rate (number) + billable; MFA error path matches the portal editor's behavior.
- [ ] Commit `feat(ticketing): org SLA tiers + billing defaults tab`.

### Task 7: Custom statuses across the ticket UI

**Files:** Modify `apps/web/src/components/tickets/TicketWorkbench.tsx`, `TicketsPage.tsx`, `ticketConfig.ts` types (additive `statusName?`/`statusColor?` on the ticket interfaces) + tests.

- [ ] **Workbench status select**: fetch config once (`fetchTicketConfig()`); when available, render `<optgroup>` per core state with the active custom statuses (option value = status row id); selection posts `{statusId}` (plus resolve/pending note flows keyed off the TARGET's coreStatus — the existing resolve/pending forms trigger off the chosen core state exactly as they do today for `{status}`). When config is null (fetch failed), keep today's six-core-status select posting `{status}` — the fallback path must remain fully functional. Current status display shows `ticket.statusName ?? statusConfig[status].label`.
- [ ] **Queue/list chips** (`TicketsPage` rows + workbench header chip): show `statusName` fallback core label; `statusColor` as inline style accent when present (keep the core-state Tailwind classes as base). Priority chips: `priorityLabel(config, priority)`.
- [ ] **Feed/SlaTimers**: no changes (core-state driven; verify nothing renders raw status enums to users in those paths — if a raw enum leaks, route it through statusLabel).
- [ ] Tests: select renders optgroups from config + posts statusId; fallback path posts status when config null; chip prefers statusName; existing workbench/queue tests stay green (feed the new `/ticket-config` fetch in their mocks with null/ok as appropriate).
- [ ] Commit `feat(ticketing): custom statuses in queue + workbench`.

### Task 8: Guard rails, docs, sweep, PR

- [ ] `no-silent-mutations` `TARGET_GLOBS` += `src/components/settings/TicketingSettingsPage.tsx` (if it mutates — likely not), `TicketStatusesTab.tsx`, `TicketPrioritiesTab.tsx`, `OrgTicketSettingsEditor.tsx`; bump the count (22 → as needed). Run the test.
- [ ] Docs: `apps/docs/src/content/docs/features/ticketing.mdx` — add "Custom statuses & SLA configuration" section (~20 lines: statuses mapped to core states, priority defaults, org tiers, where settings live now). Match the doc voice.
- [ ] Sweep: full web suite (`npx vitest run`), `npx tsc --noEmit`, `pnpm lint` (remember: `react-hooks/exhaustive-deps` disable directives FAIL web lint). Expect baseline 153 files/1157 tests + additions, all green.
- [ ] PR `feat(ticketing): configuration frontend — settings tabs, org tiers, custom statuses in UI`; body per house style; note the BillablesExportCard relocation and the fallback behavior for legacy/config-fetch-failure. Two-stage review, then `gh pr merge --squash --admin` when CI is green.

---

## Self-review notes (spec §5 coverage)

- Tabbed /settings/ticketing (Statuses/Priorities/Categories/Export, hash tabs) → Tasks 2-4 (+Export/Categories relocation in Task 2)
- Nav entry under Partner admin → Task 5
- Org settings Ticketing tab (SLA grid + rate + billable, MFA pattern) → Task 6
- Workbench select grouped by core state; queue chips statusName/statusColor; priority labels; statusConfig stays as fallback → Tasks 1, 7
- runAction + enrollment + hash conventions → every task, enrollment in Task 8
- Spec's "config fetched once per island" → Task 1 module cache

# Ticketing e2e Browser Test Findings — 2026-06-11

> **Resolution status (2026-06-11 EOD):** all 8 numbered bugs below are FIXED in
> PR #1245 (merged as bfc6aef9; plan: `docs/superpowers/plans/2026-06-11-ticketing-e2e-fixes.md`)
> and re-verified in the browser post-merge. Still OPEN from this doc: the "UX
> improvement notes" section (queue sort, device-select search/grouping, sticky
> composer tab, cross-tab bulk selection, site-limited banner, feed old→new for
> field edits), plus two follow-ups from the PR review: grant org roles
> `organizations:read` to kill the residual cold-load 403 (deep fix for bugs 1/8e),
> and bulk-to-pending bypassing the reason prompt (accepted asymmetry, revisit
> with the SLA engine).

Playwright-driven browser testing of native ticketing v1 + the 2026-06-10/11 hardening
(PRs #1238, #1243), on the local dev stack (rebuilt at `bc8940ff`). Two passes:
partner admin (`admin@breeze.local`) and site-restricted org user
(`e2e-sitea@breeze.local`, Org Admin, siteIds=[Default Site]; org has a second
"Site B (Branch)" site).

## Verdict on the new features (all backend behaviors PASS)

| Behavior | Result |
|---|---|
| Site scoping: queue/tabs/stats exclude out-of-site device tickets | PASS (list + stats + tab counts all consistent) |
| Deviceless tickets visible to site-restricted users | PASS |
| Direct URL to out-of-site ticket | PASS — 404 + clean not-found page with two routes back |
| Explicit `?deviceId=` out-of-site filter | PASS — 403 "Device not found or access denied" |
| Write guard: create against out-of-site device | PASS — 403 (API; form unreachable for org users, see bug 1) |
| Bulk with out-of-scope id | PASS — `{updated:1, skipped:1, skippedReasons:{OUT_OF_SCOPE:1}}` |
| Bulk unknown assignee | PASS — request-level 400 "Assignee not found" |
| RLS fix: org-scope create w/ category + partner-staff assignee | PASS — 201 (was a bogus 404 pre-#1243) |
| Category parent/self-parent validation | PASS — API 400s; UI can't even attempt (see bug 3) |
| Bulk-resolve excluded from UI status menu | PASS |
| Resolution-note enforcement on resolve | PASS — good inline UX |
| Feed/audit trail for status/assign/comments/field edits | PASS (incl. PATCH system entries) |
| Queue filters (org/priority/category/assignee) + clear-filters empty state | PASS |

## Bugs (ordered)

1. **HIGH — Org-scope users cannot create tickets in the UI.** `/tickets/new`
   unconditionally fetches `GET /orgs/organizations` (403 under org scope) and
   dead-ends on "Organizations failed to load. Retry" forever. The org is already
   known from the session. API create works fine.
2. **IMPORTANT — Workbench has no assign affordance; the "Unassigned" button fires
   an unassign.** `TicketWorkbench.tsx:172-179` always POSTs `/assign
   {assigneeId:null}`; clicking it on an unassigned ticket writes a bogus
   "unassigned this ticket" feed entry. Assigning a single ticket is only possible
   via the bulk bar. Should be an assignee combobox (assign me / teammates / unassign).
3. **IMPORTANT — `/settings/ticketing` is a stub vs the API/schema.** Name + color +
   Deactivate only: no edit/rename, no parent picker, no hierarchy display, no
   SLA/billing/default-priority fields — all of which the API supports. Category
   color is used nowhere outside the settings table.
4. **IMPORTANT — Cmd+Shift+H help shortcut is dead.** `HelpPanel.tsx:16` checks
   `e.key === 'h'`; with Shift held the key is `'H'`. One-liner:
   `e.key.toLowerCase() === 'h'`. The close button even advertises the shortcut.
5. **IMPORTANT — Detail preview pane goes stale after bulk actions** (list/stats
   refresh; pane shows old status/assignee until reselect).
6. **MEDIUM — Tickets assigned to partner staff show as "Unassigned" to org users.**
   `assigneeName` is null (org-scoped users join can't see partner-level rows) and
   the detail button literally says "Unassigned" while the Unassigned tab correctly
   excludes the ticket. Consider a redacted label ("MSP staff").
7. **MEDIUM — `GET /ticket-categories` returns `[]` under org scope** (partner-axis
   RLS; pre-existing). Org users see category data on tickets but get empty
   category dropdowns/filters. Product call needed: should org users see their
   MSP's categories? (Probably yes, read-only.)
8. **MINOR** — Pending transition never asks for a pending reason (`pending_reason`
   column exists, never populated from UI). • Bulk partial outcomes render as a
   success-styled toast with counts only — `skippedReasons` (in the response since
   #1243) is ignored; "0 updated, 2 skipped" should be warning-styled with reasons.
   • Stale "Resolution" note stays in the rail after reopen. • Requester shows
   "Unknown" on technician-created tickets. • Org filter renders (uselessly) for
   single-org users; partner-only nav + admin endpoints 403-spam the console under
   org scope. • Post-login redirect drops the original destination.
   • `PATCH /tickets/:id {status}` → misleading "No fields to update" (status is
   intentionally not PATCHable; error could say so).

## UX improvement notes

- **Queue:** no sort control (add newest/oldest/priority/breach). The "–" SlaChip
  placeholder on every row reads as broken — render nothing or tooltip "No SLA".
  Category chip (with its color) should appear on queue rows and the workbench
  header. "Breaching soon"/"Closed" tabs lack counts; "Breaching soon" needs an
  explanatory empty state while no SLAs exist. "All open" empty-state copy says
  "No tickets yet" even when closed tickets exist.
- **Create form:** device select needs search + hostname subtitle + site grouping
  (display names alone are ambiguous); category options should render hierarchy
  ("Hardware / Printers"); add an assignee picker (API supports it and auto-opens
  the ticket); disabled device select needs a "select an organization first" hint;
  picking a category currently stamps no SLA/priority defaults (fine until the SLA
  engine, but today it visibly does nothing).
- **Workbench:** feed entries for field edits should show old → new like status
  entries do; composer flips back to public "Reply" after posting an internal note
  (risk of accidental public post — make the tab sticky); status dropdown lists all
  six statuses with no indication of valid transitions until you try.
- **Bulk bar:** selection silently clears on tab switch, making cross-status bulk
  impossible — keep selection with an "N selected across views" chip or document it.
- **Site-restricted experience:** nothing tells the user their view is site-limited
  (no banner/site name), and the not-found page says "may have been deleted" for a
  ticket that's actually out of scope — append "…or you may not have access to it."
- **Keep:** j/k/Enter queue navigation, hash deep-links (`#T-2026-0006`),
  resolution-note enforcement, internal-note styling, collapsible system-feed
  groups, two-way escape from the not-found state.

## Test artifacts / data state

Local dev DB now has: categories Hardware (`b2ce18e4…`) + Printers (child,
`d3e7ab6f…`); tickets T-2026-0005 (deviceless, open), T-2026-0006 (Default Site
device, open, assigned admin), T-2026-0007 (Site B device, new — invisible to
e2e-sitea, verified), T-2026-0011 ("Org-scope RLS probe" — created by the org-scope
201 verification, safe to delete), T-2026-0009/0010 (bulk fodder, closed),
T-2026-0004 closed during mixed-bulk test. "Site B (Branch)"
(`00000000-0000-4000-8000-00000000b0b0`) seeded with WIN-DESKTOP-01,
WIN-FILESERVER-02, linux-monitor-01. `admin@breeze.local` and
`e2e-sitea@breeze.local` password hashes were reset to the documented .env value
(the seeded hash had drifted).

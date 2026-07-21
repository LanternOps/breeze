# Native Ticketing — UI Design Brief (Phase 1: Queue & Workbench)

**Date:** 2026-06-09
**Status:** Approved
**Companion to:** `2026-06-09-native-ticketing-design.md` (backend/feature spec). This brief covers UX/UI decisions for the Phase 1 technician surfaces in apps/web. Where the existing Alerts page pattern and this brief disagree, this brief wins for ticketing.

## 1. Feature Summary

The technician-facing ticketing surface in apps/web: a partner-wide queue and a ticket workbench where MSP techs triage, respond, and resolve all day. The highest-interaction-density screen in Breeze; it must feel like a calm control center, not a fire hose.

## 2. Primary User Action

Work the queue: select the next ticket that needs attention, understand it in seconds, respond (publicly or internally), and move on without losing place. Everything else (assignment, status, linking) supports that loop.

## 3. Design Direction

Product register, "calm control" per PRODUCT.md. Earned familiarity with Front/Help Scout/Linear idioms; a tech fluent in those tools should trust this instantly. Light mode primary, dark supported. Brand teal carries selection/focus/identity only; status colors stay strictly semantic (amber = SLA at-risk, red = breached; never decorative). Density: compact-but-breathing rows (~44px), tables over cards, no card grids, no modals where inline works. Quiet by default: color appears only where attention is needed. Stay consistent with existing apps/web component vocabulary (badges, dropdowns, toasts, `runAction` feedback).

## 4. Layout Strategy

**Split-pane.**

- **Left — queue list** (~38–42%, min-width floor): view tabs above (My tickets / Unassigned / All open / Breaching soon / Closed), filter bar (org, priority, category, assignee, search). Rows: internal number (mono), title, org, priority badge, SLA cell, assignee avatar, updated-at.
- **Right — workbench pane** for the selected ticket:
  - Header: internal number (mono), title, org › site › device breadcrumb, status dropdown, assignee picker, SLA timing.
  - Activity feed: newest at bottom; composer docked at bottom.
  - Properties rail (collapsible, ~260px, far right): priority, category, due date, source, linked alerts, requester.
- **Expand affordance** (`↗` / `Enter` on focused detail) opens the same ticket full-page — same components, wider feed — for deep work.
- Selection synced to `window.location.hash` (`#T-2026-0142`) for deep links (per the no-query-params convention).
- Below ~1100px: pane collapses to list-then-detail navigation (the full-page view).

## 5. Key States

| State | Treatment |
|---|---|
| Queue empty (true zero) | Teaching empty state: where tickets come from (portal, email, alerts, manual), "Create ticket" action, link to ticketing settings |
| View empty (filters) | Light: "No tickets match" + inline clear-filters action |
| No selection | Quiet placeholder in right pane with keyboard hints (j/k, Enter). Auto-select first row on load |
| Loading | Skeleton rows (queue) and skeleton feed (pane). No mid-content spinners |
| Feed extremes | 1-comment and 200-entry tickets both work. System events (status/assignment) are compact single-line entries; long runs collapse ("4 status changes — show") |
| Composer sending | Optimistic append with pending style |
| Composer failed | Inline retry, draft preserved |
| Attachment rejected | Inline reason |
| Drafts | Persist per-ticket in memory within session |
| Ticket load error | Pane-level error with retry; queue keeps working |
| SLA in queue | Muted relative time (healthy) → amber chip "38m left" (≥80% elapsed) → red chip "Breached" (static, no pulse). Same vocabulary in workbench header |

## 6. Interaction Model

- **Keyboard core set:** `j/k`/arrows move queue selection (pane follows); `Enter`/`o` expand full-page; `a` assign to me; `r` focus reply; `n` focus internal note; `e` resolve (opens inline resolution-note form — spec requires a note); `Esc` returns focus to list. Shortcuts suspended while any input focused. Focus ring brand teal, always visible.
- **Composer:** tabbed Reply / Internal note; **public reply is the default**, resetting per ticket. Internal mode is unmistakable: amber-family tinted background across the whole composer, persistent "Internal — not visible to requester" label, send button reads "Add internal note" (vs "Send reply"). Cmd+Enter sends.
- **Inline mutations:** status, assignee, priority, category change in place via dropdowns — no modals. Optimistic update + toast via `runAction`; each writes a system feed entry. Resolve is the only flow demanding extra input (inline expansion, not modal).
- **Bulk:** checkbox column on hover/selection; bulk action bar slides up from bottom of list (assign, status).
- **Create ticket:** primary button above queue; full-page form (org, title, description, optional device, category, priority). Not a modal.
- **Motion:** 150–200ms ease-out on pane swaps and feed appends. No decorative motion, no load choreography.

## 7. Content Requirements

- Ticket numbers always mono (`T-2026-0142`).
- Relative timestamps ("12m ago") with absolute on hover.
- SLA chips: "38m left", "Breached 2h ago".
- Composer placeholders: "Reply to {requester}…" / "Add an internal note…".
- Resolve form label: "Resolution note (visible to requester)".
- Errors: plain noun+verb, no apologies ("Reply failed. Retry."). No em dashes anywhere in UI copy.
- Dynamic ranges: queue 0–thousands (paginate/virtualize at 100+); titles ≤200 chars (truncate + tooltip); long org names truncate middle; feed 1–200+ entries.

## 8. Implementation References

impeccable: `interaction-design.md` (composer + keyboard focus management), `spatial-design.md` (split-pane + rail), product register (full state vocabulary per component: default/hover/focus/active/disabled/loading/error).

## 9. Open Questions (non-blocking, resolve at build)

- Virtualized list vs pagination for the queue at scale; decide with real perf data.
- Properties rail: collapsed by default at mid widths, or only below the breakpoint?
- Tab order persistence: fixed tabs in Phase 1; per-user saved views are Phase 2+.

## Decisions Log

| Question | Decision |
|---|---|
| Layout model | Split-pane (email-client style) with full-page expand |
| Composer default | Public reply; internal note opt-in with heavy visual shift |
| Keyboard | Core set in Phase 1 (j/k, Enter, a, r, n, e, Esc); command palette deferred |
| SLA visual language | Quiet until it matters: muted → amber chip at-risk → red chip breached; no bars, no row tinting |

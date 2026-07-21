# Shape — Mobile Systems Tab

> Produced via `$impeccable shape` on 2026-05-06. Phase 3 of the mobile build (phase 1: approval mode, phase 2: Home/AI tab). Hand off to `$impeccable craft` for implementation. Replaces the existing Alerts and Devices tabs once 3c lands.

## 1. Feature Summary

The Systems tab is the fleet-health surface of Breeze Mobile. A single scrollable view: bold one-line health summary at the top, the active issues that demand attention next, then context (orgs, recent activity). The job is "what's broken, where, and what just happened" in two glances. Drilldown lifts the existing detail screens for now; redesign comes after.

This is the surface that lets a tech tap once on the bus and trust the answer to *"is anything on fire?"*.

## 2. Primary User Action

**Read the hero in under 2 seconds, decide whether to drill or move on.**

Everything below the hero is supporting evidence. The hero is the lead.

## 3. Design Direction

**Color strategy: Restrained.** Same baseline as the Home tab. The tab is mostly Surface 0/1 with status colors (approve green, deny red, warning amber) doing semantic work on the breakdown bar and severity dots. Brand teal carries identity affordances (focus, links) but doesn't appear on status. Per `DESIGN.md`'s Tinted Neutral Rule and One Voice Rule.

**Theme scene sentence:** *A tech, on the bus at 7:42am, checks last night's noise; later, the same tech in the office at 2:14pm glances at the tab between meetings to see what came in.* → Dark canonical, light supported (matches the rest of the app).

**Anchor references:**
- **Linear inbox** — issue rows with severity dots, calm density, tap-to-expand without leaving the surface.
- **Datadog Mobile (good parts)** — at-a-glance health summaries, severity ordering.
- **Things 3** — the way the hero leads, the way list rows breathe.

Per-surface override: the hero earns slightly heavier type than baseline (Title 22/28 SemiBold) so it carries weight without competing with the approval-mode Display register.

## 4. Scope

- **Fidelity**: Production-ready, in three milestones.
- **Breadth**: Full Systems tab across phases 3a/3b/3c.
- **Interactivity**: Shipped. Pull-to-refresh, tap-to-drill, inline filtering by org.
- **Time intent**: Polish until it ships, but reuse existing detail screens (3c) without redesign — that's a separate pass.

## 5. Layout Strategy

Single scrollable surface. No tabs-within-tab, no bottom nav inside the tab. Hierarchy from top to bottom:

| Section | Height | Treatment |
|---|---|---|
| **Hero** | ~96px | One-line headline (Title 22/28 SemiBold) + 6px breakdown bar + meta row |
| **Active Issues** | flex | Section header (Meta-Caps) + severity-ordered list of alert rows. Hidden when zero. |
| **Orgs** | flex | Section header + rows. One per org, sorted by issue count desc. |
| **Recent (24h)** | flex | Section header + rows. Last 24h of alerts, acked or not. |

**Visual hierarchy rules:**
- The hero is the only Title-sized text on the surface. Section headers are Meta-Caps (11/14, +1.0 letter-spacing).
- Lists are spacious rows divided by 1px Surface Border, not cards. The brief's anti-card-grid principle applies; rows give density without visual chunking.
- The breakdown bar (6px tall, no rounding, no gaps) sits directly under the hero and uses approve-green / warning-amber / deny-red proportions — same component as the FleetStatusRow inline block in the Home tab. Reuse it.
- Sections collapse silently when empty. **No "No issues" placeholder rows** — if there are no active issues, the Active Issues section disappears and Orgs leads.
- Pull-to-refresh is the only manual refresh affordance. Soft refresh on tab focus is implicit.

## 6. Key States

### All healthy (most common ambient state)
- Hero: *"423 devices, all healthy."* (single line)
- Breakdown bar: full-width approve-green.
- Active Issues section absent.
- Orgs section: rows show *"{n} devices, healthy"* in Text Medium.
- Recent section: present if any alerts in last 24h, else absent.

### Mixed (the workload state)
- Hero: *"12 issues across 3 organizations."* with the count drawn in Text High.
- Breakdown bar: proportional segments (green / amber / red). Offline devices roll into the warning slice.
- Active Issues section: severity-ordered rows. Critical (deny-red dot) first, then high, then medium.
- Each row: 6px severity dot · alert title (Body Medium, single line) · device hostname or org name (Meta, Text Medium) · relative time right-aligned (Meta, Text Low).

### One issue, one org (the focused state)
- Hero: *"1 issue."* No org count when there's just one.
- Single row in Active Issues. Orgs section may still show but is downweighted (filed as supporting evidence).

### Loading
- Hero: skeleton bar (Surface 2 fill, ~70% width, ~24px height) where the count goes.
- Breakdown bar: Surface 2 fill, no segments.
- Active Issues: 3 skeleton rows (Surface 2 horizontal bars at Body height).
- No full-screen spinner. No spinner anywhere — only skeletons.

### Error fetching
- Last-known data stays visible.
- Inline row at the top of the offending section: *"Couldn't refresh. Pull to try again."* in deny-red Meta.
- Pull-to-refresh retries.

### Empty (no devices in the user's org)
- Hero: *"No devices yet."*
- Below: *"Pair your first device from the Breeze web portal."* in Text Medium Body.
- No CTA button — the user has to go to the web portal anyway, so the copy is the directive. Keep it small; this is a rare state.

### Refreshing (pull-to-refresh in flight)
- Standard RN refresh control with brand-teal tint.
- Hero stays intact during refresh; numbers tween to the new value (320ms `withTiming`, ease-out-quint) when they change. **No skeleton on refresh** — only on initial load.

### Filtered to one org
- After tapping an org row, the Active Issues section filters to that org and a small header chip appears: *"Acme Corp ×"*. Tapping the × clears.
- Orgs section collapses (the chosen org is implied by the filter).
- Recent section also filters to that org.
- This is local state only; no route change.

## 7. Interaction Model

- **Pull-to-refresh**: standard `RefreshControl` on the outer ScrollView. Triggers `summary` + `alerts/inbox` + `devices` in parallel. The pill in the Home tab updates as a side effect since alerts feed both.
- **Tab focus**: refresh `summary` and `alerts` automatically (debounced if the user just refreshed manually).
- **Tap an Active Issue row**: pushes `AlertDetailScreen` (existing). 3c reskins this; 3a-3b reuse as-is.
- **Tap an Org row**: filters the surface to that org via local state (no route push). The chip at the top shows the active filter.
- **Tap a Recent row**: same as Active Issue — pushes `AlertDetailScreen`.
- **Long-press an Active Issue row**: action sheet — *Acknowledge*, *Resolve*, *Mute for 1h* (mute deferred), *Copy ID*. Acknowledge + resolve already exist in the alerts API.
- **Drill device from issue**: in the existing `AlertDetailScreen`, the affected device is shown as a card; tap pushes `DeviceDetailScreen`. We don't need to wire this; it's already there.
- **Tab switching**: 180ms cross-fade (`duration.fast`) like the Home tab.

## 8. Content Requirements

**Hero copy templates** (priority order, first match wins):
- Loading: *"…"* (a single Title-sized middot, Text Low, while the API resolves)
- Empty (no devices): *"No devices yet."*
- All healthy: *"{n} devices, all healthy."* (e.g. *"423 devices, all healthy."*)
- One issue: *"1 issue."*
- Multiple, one org: *"{n} issues."*
- Multiple, multiple orgs: *"{n} issues across {m} organizations."*

**Breakdown bar legend (below the bar, single Meta line)**:
- All healthy: *"{online} online · {maintenance} maintenance"* (omit zero terms)
- Mixed: *"{online} online · {warning} warning · {offline} offline"* (omit zero terms; never show all four labels)

**Section headers** (Meta-Caps):
- *ACTIVE ISSUES*
- *ORGANIZATIONS*
- *RECENT (24H)*

**Active Issue row**:
- *{severity dot}* · *{alert title}* · *{device hostname or org name}* · *{relative time}*
- Title truncates with ellipsis at one line. Long device names truncate before time.

**Org row**:
- *{org name}* (Body Medium, Text High)
- *{device count} devices · {issue count} issues* (Meta, Text Medium). When zero issues: *{n} devices, healthy*.

**Recent row**:
- *{severity dot}* · *{alert title}* · *{relative time}*
- One line, no device name (it's already in the alert detail).

**Filter chip**:
- *{org name} ×* (Meta-Caps, Surface 2 fill, brand-teal × icon)

**Forbidden phrasing** (carried from DESIGN.md):
- Em dashes anywhere. Use middots, periods.
- Apologies. *"Sorry, we couldn't load…"* — forbidden. *"Couldn't refresh."* is the entire surface area for failure.
- Gerund chains. *"Loading your fleet…"* — forbidden. Skeletons speak for themselves.
- Decorative emoji or icons leading list rows. The severity dot is the only iconography.
- *"View all"* / *"See more"* CTAs at the end of sections. Sections are full lists with sensible defaults; if the user wants more, the list itself scrolls.

**Relative time format** (consistent with the Home tab):
- `< 1 min` → *just now*
- `< 60 min` → *{n}m ago*
- `< 24h` → *{n}h ago*
- `< 7d` → *{n}d ago*
- `>= 7d` → *{n}w ago*

## 9. Recommended References

For the implementer:
- **`reference/animate.md`** — for the breakdown-bar segment transitions, the count tween on refresh, the filter-chip enter/exit.
- **`reference/typeset.md`** — for the Title/hero treatment and the Meta-Caps section header rhythm.
- **`reference/clarify.md`** — for the hero copy ladder and the empty/loading/error copy.
- **`reference/harden.md`** — for the per-section error fallbacks and the partial-data-on-refresh-failure behavior.
- `DESIGN.md` and `DESIGN.json` are the authoritative tokens. **Reuse the FleetStatusRow proportion bar from `apps/mobile/src/screens/chat/blocks/FleetStatusRow.tsx`** rather than building a new one — extract it if needed.

## 10. Open Questions for Build

1. **Org membership scope.** The mobile JWT carries `orgId` and `partnerId`. Does the user see only their own org's devices, or all orgs under their partner? The summary endpoint accepts an optional `orgId` query; without it, scope follows the JWT. **Action:** verify during build that an MSP tech with partner scope sees the cross-org rollup (the brief assumes this is the typical case). If they only see their own org by default, the orgs section becomes single-row and we collapse it.

2. **Recent activity persistence.** The 24h window is computed against `alerts.triggeredAt`. If a tech opens the app at 8am Monday after a quiet weekend, the Recent section may be empty. Acceptable, or do we widen to 48h / 72h with a "show more" affordance? **Recommendation:** 24h fixed for v1; widen if users report it feels empty.

3. **Mute action.** The long-press menu spec includes *Mute for 1h* but no mute API exists. **Recommendation:** ship long-press without mute; add when backend exposes a suppress-by-id endpoint. Don't show greyed-out menu items.

4. **Org list endpoint.** No dedicated `/orgs` endpoint visible in `mobile.ts`. We can derive the org list by grouping the device + alert lists client-side. **Recommendation:** start client-side derivation. If org metadata (logo, partner name) is needed later, scope a small `/orgs` endpoint then.

5. **Breakdown bar segment ordering.** Approve-green / warning-amber / deny-red is the natural left-to-right reading order, but offline devices are conceptually *worse* than warning. Should offline visually pair with deny-red (right side) or stay in the warning slice? **Recommendation:** offline rolls into the warning-amber slice for the breakdown bar (it's a fleet-health visualization, not a severity ramp), and the legend says *{n} offline* explicitly. Critical alerts drive the deny-red slice's width, computed from `summary.alerts.critical / total` proportionally.

6. **Pull-to-refresh during in-flight stream on Home tab.** Pull on Systems triggers `fetchAlerts` which is the same slice the Home tab's StatusPill reads. If a stream is mid-flight on Home, this is a benign re-fetch. **Confirm during build** that the alertsSlice's optimistic state doesn't fight with the refresh.

---

## Decisions Locked During Discovery

These were resolved before writing the brief; recording so future-craft doesn't re-litigate:

- **Active issue definition: critical + high + medium *active* alerts.** Offline devices are NOT in the issue list — they roll into the breakdown bar's warning slice with a labelled count below.
- **No new backend for 3a or 3b.** The existing `/api/v1/mobile/summary`, `/alerts/inbox`, and `/devices` endpoints suffice. Org grouping is client-side.
- **3c reuses existing AlertDetailScreen + DeviceDetailScreen as-is.** They use react-native-paper and will look slightly off-style; redesign is a separate pass after the Systems tab ships.
- **Pull-to-refresh is the only manual refresh.** No refresh button in the header. Soft refresh on tab focus is implicit.
- **Filter is local state, not a route.** Tapping an org row filters the visible surface; no nav stack push. The chip is the cue.
- **No tab badge on Systems.** The hero IS the badge.
- **No "View all" CTAs.** Sections are full lists.
- **Tab collapse: soft cut.** 3a-3b ship Systems alongside Alerts + Devices (third tab, temporary 4-tab nav). 3c ships the drilldowns AND deletes the redundant Alerts + Devices tabs in the same commit.

## Phase 3+ Scope (added post-implementation, when justified)

- Reskin AlertDetailScreen + DeviceDetailScreen to DESIGN.md tokens. Currently react-native-paper with off-tokens; functional but visually off-tone.
- Filter expansion: severity, time-window, "my devices only".
- Mute / suppress action wired (requires backend).
- Per-org metadata enrichment (logo, partner name).
- Push-driven live updates so the surface refreshes silently when an alert fires (today the StatusPill on Home updates; Systems is pull-only).
- Dedicated `/orgs` endpoint if client-side derivation becomes too noisy.

## Suggested Build Order

`$impeccable craft` is the next step. Three sub-crafts in this order:

1. **3a — Hero + Active Issues**: the load-bearing read. Builds the Systems screen shell, the hero, the breakdown bar (extracting a `FleetBar` primitive from FleetStatusRow), the Active Issues list, pull-to-refresh, all key states (loading / mixed / healthy / empty / error). Ship as a third tab next to Home/Alerts/Devices/Settings (5 tabs temporarily — accept the crowded tab bar for one milestone).

2. **3b — Orgs + Recent + Filter chip**: the supporting context. Adds the Orgs and Recent sections, the org-filter local state, the chip. Polish pass over the assembled tab.

3. **3c — Drilldowns + tab collapse**: wire `AlertDetailScreen` + `DeviceDetailScreen` into a Systems navigation stack. Delete the standalone Alerts and Devices tabs in the same commit. Final state: Home, Systems, Settings (3 tabs). Phase 4 collapses Settings into the avatar sheet.

Run `$impeccable polish` after 3b and again after 3c.

# Device Overview UI polish — design

**Date:** 2026-06-24
**Branch:** `worktree-device-overview-ui`
**Status:** Approved (design), pending implementation plan

## Problem

User feedback on the Device Details → Overview tab (from a hosted MSP, on v0.83.1):

1. **Activity pane is supposed to show automated activity, not just human actions** — automated
   patching, automations, scheduled scripts, etc. Verify whether it does, and surface it if not. The
   pane is also supposed to include Alerts.
2. **Empty Activity pane wastes horizontal real estate.** When a device has no recent actions, the
   right-hand Activity column still reserves ~1/3 of the width on large screens, leaving a tall empty
   gap. Make it dynamic until it's replaced with richer content later.
3. **Reliability card is confusing:**
   - Each factor card (Crashes / Application hangs / Uptime) shows a bare `0–100` number. Next to the
     word "Crashes", a green **`100`** reads like "100 crashes" when it actually means a perfect
     factor health score (no crashes). Users expect "0 crashes = good".
   - The "At risk" badge and the overall Score have no explanation — no tooltip, no click-through.
   - (macOS↔Linux factor order/weight inconsistency — explicitly **out of scope**; work-in-progress
     is acceptable for now.)

## Findings (current behavior)

### Activity feed
- Component: `apps/web/src/components/devices/DeviceActivityFeed.tsx`. Reads
  `GET /devices/:id/events` (`apps/api/src/routes/devices/events.ts`), source table `audit_logs`.
- It filters server-side on a fixed set of action prefixes (`ACTION_RULES`):
  `device.command`, `script.`, `device.remote_access`, `device.patch`, `device.software`,
  `device.maintenance`, `device.filesystem.cleanup`, `device.decommission`,
  `device.permanent_delete`, `device.restore`.
- It already surfaces an `initiatedBy` chip (Automation / Policy / Schedule / AI / Integration) when
  present, and already shows a pinned **active-alerts banner** at the top of the card
  (`GET /devices/:id/alerts?status=active`). So "Alerts in the pane" already exists; it only renders
  when there are active alerts.
- **Gap:** Automated patch runs and automation/scheduled scripts are written by
  `services/commandQueue.ts → queueCommand()` as `agent.command.<type>` (e.g.
  `agent.command.install_patches`, `agent.command.script`) with `actorType: 'system'` and **no
  `initiatedBy`**. `agent.command.%` is **not** in the feed's filter, so automated activity never
  appears. It also wouldn't carry an Automation badge as-is (null `initiatedBy`).
- **Dedup hazard:** A *manual* patch/script run writes BOTH a route audit
  (`device.patch.install.queue`, `script.execute` — `actorType: 'user'`) AND an `agent.command.*`
  row. Naively adding `agent.command.*` to the feed would double-list manual actions. The clean
  discriminator is `actor_type = 'system'`: automated commands have no route-audit twin; manual ones
  are already represented by their richer route audit.

### Reliability panel
- Component: `apps/web/src/components/devices/DeviceReliabilityPanel.tsx`. Reads
  `GET /reliability/:id`. Factor cards render `driver.score` (0–100), colored by `scoreClass()`
  (≤50 destructive, ≤70 warning, ≤85 info, else success). The crash/hang counts are the evidence
  rows beneath. The "At risk" badge renders when `reliabilityScore <= 70`. No tooltips exist.
- Shared tooltip primitive available: `apps/web/src/components/shared/HelpTooltip.tsx` — a
  hover+click help-icon tooltip taking a `text: string` and optional `className`.

## Design

### 1. Reliability factor cards — `Health N/100`
In `DeviceReliabilityPanel.tsx`, change each driver card's bare `{driver.score}` to an explicit
**`Health {driver.score}/100`** label, keeping the `scoreClass()` color (green = good, amber/red =
bad). Add a `HelpTooltip` per card:

> "Factor health 0–100; 100 = no issues detected. Counts to {weight}% of the overall reliability
> score. The raw counts are listed below."

The crash/hang/uptime **counts** remain in the evidence rows (unchanged) — those are the real
numbers users want. This removes the "is 100 a crash count?" misread without discarding the weighted
scoring model. The `topIssues` fallback card (renders `issue.count` with a severity label) is **not**
ambiguous and is left unchanged.

### 2. Reliability "At risk" + Score explainers
Add accessible `HelpTooltip`s (hover + focus/click):
- **Score** — next to the "Score" label:
  > "Reliability score {score}/100 — {band}. Bands: ≤50 critical, ≤70 poor, ≤85 fair, else good."
  (`band` from the existing `scoreBandLabel()`.)
- **At risk badge** — a help icon beside the badge:
  > "Shown when the reliability score is ≤ 70. Biggest drag: {top driver label} (health {n})."
  Top driver = first of `drivers` (already sorted by lost points) or, if no drivers, the first
  `topIssues` entry's label. Guard for the no-driver case.

### 3. Activity pane — collapse when empty
`DeviceActivityFeed` gains an optional callback `onHasContentChange?(hasContent: boolean)`, invoked
after each load with `events.length > 0 || activeAlerts > 0`. `DeviceDetails.tsx` holds an
`activityHasContent` state (default `true` to avoid a flash on the common populated case) and chooses
the Overview layout:

- **Has content** → unchanged: `grid gap-6 lg:grid-cols-3`, main `lg:col-span-2`, Activity as the
  right rail.
- **Empty** → main content spans full width (single column), and Activity renders as a **slim
  full-width strip** at the bottom.

To support the strip, `DeviceActivityFeed` takes a `layout?: 'rail' | 'strip'` prop. In `strip`
layout the empty state is a single compact inline row (icon · "No recent actions on this device" ·
"View all activity →") instead of the stacked heading/paragraph/link. The `rail` layout is the
current rendering. When the feed is non-empty it always uses the rail layout (and the grid stays
3-col), so the strip only ever shows the compact empty state.

Reflow: during the initial load the rail layout is assumed; if the feed resolves empty, the layout
collapses once. This one-time reflow on empty devices is acceptable.

### 4. Automated activity in the feed
**API — `apps/api/src/routes/devices/events.ts`:**
- Add an opt-in boolean query param `includeAutomated` (`'true'|'false'`, default `false`).
- When `true`, OR an extra condition into the existing action-prefix group:
  `(action LIKE 'agent.command.%' AND actor_type IN ('system','agent'))`. The `actor_type` guard is
  the dedup — manual `agent.command.*` rows (`actor_type='user'`) are excluded because they are
  already shown via their route audit.
- Add labels to `actionLabels` for the surfaced automated commands:
  - `agent.command.install_patches` → "Patches installed"
  - `agent.command.rollback_patches` → "Patches rolled back"
  - `agent.command.script` → "Script ran"
  - `agent.command.software_uninstall` → "Software uninstalled"
  - `agent.command.software_update` → "Software updated"

**Web — `DeviceActivityFeed.tsx`:**
- Request with `&includeAutomated=true`.
- Extend `ACTION_RULES` with icons for the new `agent.command.*` prefixes (Download for patches,
  Terminal for script, Package for software), so each row gets a sensible icon.
- **Badge:** when `initiatedBy` is null but `actor.type` is `system`/`agent`, render an **"Automated"**
  chip (re-using the existing initiator-chip styling). Existing `initiatedBy` labels still take
  precedence when present.

**Why "Automated" and not "Schedule"/"Automation":** the audit row for a system-dispatched command
carries no reliable `initiatedBy`, and `queueCommand` can't always distinguish schedule vs automation
vs policy. "Automated" is honest. Plumbing fine-grained `initiatedBy` through the `queueCommand` call
sites is a deliberate follow-up (below).

## Out of scope (follow-ups)
- Fine-grained `initiatedBy` (schedule vs automation vs policy) plumbed through `queueCommand` call
  sites (`patchJobExecutor.ts`, `automationRuntime.ts`, BullMQ workers) for richer badges.
- macOS↔Linux reliability factor order/weight inconsistency (user said WIP is fine).

## Testing
- **API:** unit test for `events.ts` `includeAutomated` — asserts the `agent.command.% AND
  actor_type IN ('system','agent')` predicate is added only when the flag is set, and that a manual
  `agent.command.*` row (`actor_type='user'`) is excluded while a system one is included. Add label
  coverage for the new `actionLabels` entries via `formatActionMessage`.
- **Web:** `DeviceActivityFeed` tests — `onHasContentChange` fires with correct boolean; `strip`
  layout renders the compact empty state; the "Automated" chip appears for a null-`initiatedBy`
  system row. `DeviceReliabilityPanel` tests — factor card shows `Health N/100`; tooltips render
  expected text for the At-risk and Score explainers.
- Follow the `breeze-testing` skill conventions (Vitest + Drizzle mocks for API, jsdom for web).

## Files touched
- `apps/api/src/routes/devices/events.ts` (+ test)
- `apps/web/src/components/devices/DeviceActivityFeed.tsx` (+ test)
- `apps/web/src/components/devices/DeviceReliabilityPanel.tsx` (+ test)
- `apps/web/src/components/devices/DeviceDetails.tsx` (layout switch)

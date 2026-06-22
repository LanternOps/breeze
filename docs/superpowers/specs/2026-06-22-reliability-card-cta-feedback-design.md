# Device Reliability Card — Primary CTA + Feedback UI (Issue #1721, Parts 1 & 2)

**Date:** 2026-06-22
**Issue:** #1721 — *"Device Reliability card: unclear actions + uptime should be device-type-aware"*
**Status:** Design approved

## Background

Issue #1721 is a three-part product-owner UI walkthrough of the Device Reliability
card (`apps/web/src/components/devices/DeviceReliabilityPanel.tsx`, mounted in
`DeviceDetails.tsx`):

1. **Unclear next action / weak CTA** — the card is read-only; a tech who sees a
   reliability problem has nothing to *do* from the card.
2. **Confusing ML-feedback buttons** — "Failure / Replaced / False alarm" read like
   commands, have inverted icon semantics (failure = green check), and aren't
   explained as model-training controls.
3. **Uptime should be device-type-aware** — uptime was weighted 30% for every device,
   unfairly tanking laptops/workstations that are expected to sleep.

**Part 3 is already shipped** in PR #1804 (merged 2026-06-22): device-role-aware
weight profiles (`infra` vs `workstation`), uptime dropped to 0% for workstation-class
roles with the weight redistributed to fault factors, the chosen profile persisted in
`details.weightProfile`/`details.factors`, and the uptime top-issue suppressed for
workstation roles. The issue is intentionally left **open** for Parts 1 & 2.

**This spec covers Parts 1 & 2 only** — a contained, frontend-focused change with a
tiny AI-store extension. No API or scoring changes.

## Goals

- Give the card a clear primary action: **"Ask AI about reliability"**, opening the
  device-scoped AI assistant **auto-seeded** with a prompt summarizing the snapshot.
- Consolidate the three ML-feedback buttons into a single, de-emphasized
  **"Mark outcome"** menu, visually separated from the remediation CTA, with
  past-tense labels, corrected icon semantics, and a line clarifying the controls
  train the model.

## Non-Goals

- No scoring / weight-profile changes (Part 3, done in #1804).
- No driver-tile deep-linking. There are no dedicated crash/service/hardware detail
  tabs in `DeviceDetails` today (only `#eventlog`, `#anomalies`, `#performance`), and
  the approved CTA is the seeded AI assistant. Driver tiles remain read-only.
- No change to the ML-feedback API contract. Outcome values
  (`failure_confirmed` / `replaced` / `false_alarm`) and the
  `POST /reliability/:id/feedback` endpoint are unchanged.
- No backend change to `GET /reliability/:id`. The card already receives `hostname`,
  `osType`, and `status` in the snapshot response (`getDeviceReliability` returns
  them via `ReliabilityListItem`); only the panel's local TypeScript type needs to
  surface them.

## Part 1 — Primary CTA: "Ask AI about reliability" (auto-seeded)

### AI store extension (`apps/web/src/stores/aiStore.ts`)

`startDeviceTask` gains an optional third parameter `initialMessage`. It currently has
**zero UI callers** (declared + implemented, never invoked), so extending the
signature is safe.

```ts
startDeviceTask: (deviceId: string, ctx: AiPageContext, initialMessage?: string) => Promise<void>;

startDeviceTask: async (deviceId, ctx, initialMessage) => {
  set({ pageContext: ctx, sessionId: null, messages: [], isFlagged: false, flagReason: null, isOpen: true });
  await get().createSession({ deviceId });
  if (initialMessage && get().sessionId) {
    await get().sendMessage(initialMessage);
  }
},
```

**Sequencing is safe:** `createSession` is awaited; on success it sets `sessionId`
and clears `isLoading`. `sendMessage` then sees a valid `sessionId` with
`isStreaming`/`isLoading` both false. If `createSession` failed (error set,
`sessionId` still null), the `get().sessionId` guard skips the send rather than
firing a session-less message.

### Card UI

Add a prominent primary button to the header action area (`Sparkles` icon,
`bg-primary text-primary-foreground`), visually separated from the feedback menu.

On click it:
1. Builds an `AiPageContext` of `type: 'device'` from the snapshot — `id` (deviceId),
   `hostname`, `os` (from `osType`), `status`. (The panel's `ReliabilitySnapshot`
   type is extended with `hostname`, `osType`, `status`, which the API already
   returns.)
2. Builds a **client-side seed prompt** from the data already on the card and calls
   `startDeviceTask(deviceId, ctx, seedPrompt)`.

**Seed prompt** (assembled from snapshot fields the card already holds — score, band,
trend, `uptime30d`, `mtbfHours`, and the top 3 `drivers` with their score + a couple
of evidence values). Shape:

> "Review this device's reliability and recommend what to do. Score {score}/100
> ({band}), trend {trend}. 30-day uptime {uptime}%, MTBF {mtbf}. Top factors dragging
> the score: {driver label (score N): key evidence}; … . What are the likely root
> causes and what remediation — scripts, checks, or a ticket — do you recommend?"

A small `buildReliabilitySeedPrompt(snapshot)` helper in the panel keeps this testable
and out of the click handler. MTBF renders as `{n}h` or "unknown" when null.

**Auto-send behavior is intended:** clicking immediately starts an AI turn (token
usage, approval flow as configured). Approved by product owner.

## Part 2 — Consolidate feedback into a "Mark outcome" menu

Replace the three inline buttons (`DeviceReliabilityPanel.tsx:249-277`) with one
low-prominence dropdown menu, matching the established `SavedViewsMenu` idiom:
`useClickOutside(open, rootRef, …)`, `aria-haspopup`/`aria-expanded`, a
`role="menu"` panel with `bg-popover`, and `data-testid`s throughout.

- **Trigger:** a subtle/ghost button `Mark outcome ▾` (`ChevronDown`), preceded by a
  small muted label **"Was this accurate?"**. Placed in the header, visually
  separated from the primary CTA (e.g. its own group / divider).
- **Menu items** (past-tense labels, corrected icons; outcome values unchanged):

  | Label | Outcome | Icon | Tone |
  |---|---|---|---|
  | Device failed | `failure_confirmed` | `AlertTriangle` | destructive (was a green `CheckCircle`) |
  | Device replaced | `replaced` | `Wrench` | neutral |
  | False alarm | `false_alarm` | `XCircle` | muted |

- **Footer helper line** inside the menu: *"These train the reliability model — they
  don't change the device."*
- Clicking an item calls the existing `submitFeedback(outcome)` unchanged (still wraps
  the POST in `runAction` with the existing success/error toasts), then closes the
  menu. The `labeling` disabled state still disables items while a submission is in
  flight.

## Components & data flow

```
DeviceReliabilityPanel (fetches GET /reliability/:id → snapshot)
 ├─ header: score / trend / uptime / MTBF / score bar
 ├─ actions:
 │   ├─ [Ask AI about reliability]  ──click──▶ aiStore.startDeviceTask(deviceId, ctx, seedPrompt)
 │   │                                            ├─ open panel + device-scoped session
 │   │                                            └─ sendMessage(seedPrompt)  (auto-seed)
 │   └─ "Was this accurate?"  [Mark outcome ▾] ──▶ submitFeedback(outcome) → POST /reliability/:id/feedback
 └─ driver/top-issue tiles (read-only, unchanged)
```

No new network calls beyond the existing AI session/message endpoints and the
unchanged feedback POST.

## Error handling

- **Ask AI:** `createSession` failure sets `aiStore.error` (surfaced in the sidebar)
  and the `sessionId` guard prevents a session-less send. The card button itself does
  no error toasting — it delegates to the AI sidebar's existing error UI.
- **Feedback:** unchanged — `submitFeedback` keeps the `runAction` wrapper and the
  existing success/error toasts and `handleActionError` catch.

## Testing

- **`DeviceReliabilityPanel.test.tsx`:**
  - Rework the three feedback tests (false alarm / replaced / failure) to open the
    "Mark outcome" menu, click the item, and assert the POST body
    (`outcome` + `snapshotComputedAt`) — preserving existing coverage through the new
    menu affordance.
  - Add: the "Ask AI about reliability" button calls `startDeviceTask` with the
    deviceId, a device-typed context, and a seed string containing the score (mock
    `useAiStore`).
  - Keep the existing error-state, empty-state (404), and disabled-flag tests.
- **`aiStore` test:** add/extend coverage that `startDeviceTask` forwards a provided
  `initialMessage` to `sendMessage` (and does not send when omitted or when session
  creation failed). If no `aiStore` test file exists, add a focused one for this
  method with `fetchWithAuth` mocked.

## Acceptance criteria mapping (issue #1721)

- [x] Part 3 — role-aware weights / uptime drop / persisted profile / suppressed
  uptime top-issue (#1804, merged).
- [ ] **Part 1** — card has a clear primary action: "Ask AI about reliability" seeded
  with the snapshot. *(this spec)*
- [ ] **Part 2** — ML-feedback consolidated into a de-emphasized "Mark outcome" menu,
  past-tense labels, corrected icon semantics, heading clarifying it trains the model,
  visually separated from remediation. *(this spec)*
- [ ] Tests cover the updated card UI (`DeviceReliabilityPanel.test.tsx`) and the
  `startDeviceTask` seeding (`aiStore`). *(this spec)*
```

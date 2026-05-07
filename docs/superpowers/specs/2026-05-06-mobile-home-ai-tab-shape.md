# Shape — Mobile Home / AI Tab

> Produced via `$impeccable shape` on 2026-05-06. Phase 2 of the mobile build (phase 1 was approval mode). Hand off to `$impeccable craft` for implementation.

## 1. Feature Summary

The Home tab is the daily-use surface of Breeze Mobile. A single-thread AI conversation: text in, AI response out, with structured **inline blocks** (device cards, fleet-status rows) that render as the AI invokes tools. Status pill at the top reinforces ambient trust — connected, nothing critical pending. The composer is thumb-zone anchored. Avatar opens settings as a side sheet, never a separate tab.

This is the same AI agent the Breeze Helper desktop app talks to today; mobile just consumes the existing SSE protocol and renders selected `tool_result` events as visual blocks instead of inline markdown.

## 2. Primary User Action

**Ask a natural-language question, get a trustworthy answer in under 8 seconds with one or two glanceable structured blocks instead of a wall of text.**

The job is "the AI told me the right thing and I believed it." Trust is the design loyalty — same as approval mode, expressed differently. Density and read-time matter; the AI must not feel like ChatGPT-with-a-skin.

## 3. Design Direction

**Color strategy: Restrained, with brand teal as identity affordance.** Approval mode is Committed (status colors heavy); Home is calmer — the brand teal carries the streaming pulse, the focus ring on inputs, link-style affordances, but most of the surface is the dark Surface 0 / 1 ramp from `DESIGN.md`. Status colors appear only when blocks need them (a deny-red dot on a critical alert, an approve-green dot on a healthy device).

**Theme scene sentence:** *A tech, on the bus at 7:42am, checks last night's noise — they want to know whether anything broke before they reach the office, in two glances and three taps.* → Dark, same as the rest of the app.

**Anchor references:**
- **Linear mobile** — calm density, AI-led inline rendering, two-tab discipline, the "tap a row to expand" pattern.
- **Things 3** — sparse confidence, generous whitespace, motion that breathes.
- **Apple Messages** — composer ergonomics: thumb-zone, send-button affordance, not over-styled.

Per-surface override: nothing visually overrides DESIGN.md; this is the canonical rest-state of the design system. (Approval mode's heavier register is the override; Home is the baseline.)

## 4. Scope

- **Fidelity**: Production-ready.
- **Breadth**: Home tab in full — header, conversation, composer, three inline-block types, settings sheet, all key states.
- **Interactivity**: Shipped. Real SSE streaming against the user-scoped chat endpoint, real keyboard handling, real haptics on send.
- **Time intent**: Polish until it ships. The chat surface is where users will spend 80% of their session time once they trust the approval flow.

## 5. Layout Strategy

**Three vertical zones, top to bottom:**

| Zone | Purpose | Treatment |
|---|---|---|
| **Top bar** (~56px + safe area) | Identity + ambient trust | Avatar (left, 32px circle, brand-tinted) · Status pill (right, semantic colored dot + 1-line label or hidden) |
| **Conversation** (flex 1) | The AI thread | Spacious rows, no card-per-message. User messages right-aligned with bg-2 fill; AI messages left-aligned, no fill, just text + inline blocks |
| **Composer** (~76px + safe area) | Input | Pill input + send icon button; thumb-zone anchored; sticky to bottom; remains visible during streaming |

**Visual hierarchy rules:**
- The conversation is the only thing that scrolls. Header and composer are sticky.
- AI messages and user messages share the same vertical rhythm but render differently. **No bubbles for the AI.** AI is just text-on-canvas, the way a Linear or Things app integrates AI replies. User messages are subtle Surface-2 pills (rounded.lg, internal padding spacing.4).
- **Inline blocks render between AI text paragraphs, full conversation width.** Blocks are slightly elevated via the Surface 2 ramp, never a card-grid. They appear as the tool result streams in — empty skeleton first, fills in over ~200ms when the result arrives.
- Streaming pulse (3 brand-teal dots, fade-in/out staggered) lives under the latest AI message until `done` event.
- **No avatar bubble bezels** for the AI. The conversation should feel like the AI is the canvas, not a chat partner across a table.

## 6. Key States

### Default (active conversation)
- Header: avatar + status pill.
- Conversation: messages scroll; latest message anchored to the bottom-above-composer.
- Composer always visible; Send is brand-teal when input has text, Surface 3 (disabled-look) when empty.

### Cold open (no history)
- No empty-state illustration. Above the composer, three suggested chips render in a horizontal row:
  1. *"What broke last night?"* (queries critical alerts)
  2. *"Show fleet status"* (queries device aggregate)
  3. *"What ran via MCP today?"* (queries audit log)
- Chips are Surface 2 fill, Body Medium type, rounded.lg, 1px transparent border that becomes brand-teal on press. Tap a chip → it lifts into the composer (replaces the placeholder with the chip text), then sends. Subtle haptic.tap on press.
- A muted single line above the chips: *"Ask Breeze."* in Text Medium. No more.

### Streaming
- The user message renders immediately on send (optimistic).
- An AI "thinking" row appears: 3 brand-teal dots pulsing in sequence (300ms each, staggered 100ms). Cap line height matches Body, dots are 4px circles.
- On first `content_delta`, the dots are replaced by text that types in as deltas arrive. **No fake typewriter** — chars land exactly as the deltas arrive.
- On `tool_use_start` mid-stream, render a Meta-Caps caption below the current AI text: *"CHECKING FLEET"* with a brand-teal small spinner.
- On `tool_result`, the caption is replaced by the inline block (or removed if the tool isn't in v1's render whitelist).
- On `message_end` / `done`, the streaming pulse stops. Composer regains focus capability.

### Inline blocks (v1: Device Card + Fleet Status Row)
**Device Card** — renders for tool results from `breeze.devices.get`, `breeze.devices.search`:
- Surface 2 fill, rounded.md, padding spacing.4, full conversation width.
- Top row: device hostname (Body Medium, Text High) + tiny status dot (4px, approve-green / warning-amber / deny-red / Text Low for offline).
- Below: 2-line meta — OS · last-seen · org name (Meta type, Text Medium).
- Tap → no drilldown in v1. Long-press → action sheet ("Copy hostname", "View on web", "Ask another question about this device").

**Fleet Status Row** — renders for `breeze.fleet.status` and similar aggregates:
- No card chrome. A single row with a horizontal bar showing healthy/issues/offline proportions (3 colors, no gaps, no rounding, height 6px) above one line of Body type: *"423 devices · 12 issues · 3 offline."*
- Tap → expands inline (180ms reveal) to show the per-org breakdown as a 3-column rows list. Tap again → collapse.

**Generic Tool Indicator** (fallback for tools without a v1 block):
- Single Meta-Caps line: *"BREEZE.PATCHING.LIST · COMPLETED"* in Text Low, no chrome.
- The AI's natural-language summary follows in normal body. The tool itself is acknowledged but not visualized.

### Approval-required mid-stream
- The chat surface remains in place. Approval mode is a separate route handled by `ApprovalGate` (already built in phase 1). When a high-tier tool call requires approval, the existing approval takeover surfaces, the stream pauses, and on resume (approve or deny), the chat picks up where it left off. **No inline approval UI in the chat surface itself.** This is a deliberate split: Home is calm; approval is the heavy register.

### Offline
- Top bar pill turns deny-red: *"Offline · Approvals still work."* (clamped to 32 chars max).
- Composer is disabled with placeholder *"Reconnect to ask."* The send button is Surface 3.
- Existing messages remain visible. No retry button at the message level — the next send retries when connection returns.
- Cold-open chips hidden when offline.

### Error (request fails after stream started)
- The partial AI reply remains. Below it, a single line: *"Stopped. Tap to retry."* in deny-red Body Medium. Tap retries the user's last message.
- No full-screen error.

### Streaming aborted (user backs out, sends another message)
- The in-flight request is aborted server-side via the existing helper-style 409 contract. Frontend silently truncates the partial AI message and queues the new send.

### Settings sheet (avatar tap)
- Right-edge slide-in sheet, 80% screen width, dimmed scrim.
- Contains: signed-in identity (avatar + email), Biometric on/off toggle, Auto-lock window (Picker: Every open / 15 min / 1 hour), Notification preferences (per-tier), Paired sessions / Connected apps (link to push), Sign out, Build version + commit hash bottom-pinned in Text Low Meta type.
- Sheet motion: 280ms (duration.exit) slide-in from right with the dim scrim fading 0→0.55 in 240ms.

### First run (signed in, never chatted)
- Same as Cold Open. No separate first-run flow on the AI tab — auth/biometric onboarding happens before this surface ever renders.

## 7. Interaction Model

- **Send**: tap the send button OR Cmd/Return on hardware keyboard → optimistic user message + haptic.tap → SSE stream begins.
- **Composer focus**: keyboard avoiding view raises the composer; conversation auto-scrolls to keep latest in view.
- **Streaming pulse**: brand-teal 3-dot wave under the latest AI row until `done`. Animated via `withRepeat(withTiming(...), -1, true)` on opacity, staggered.
- **Inline block drilldown**: in v1, no nav-stack drilldown. Fleet Status Row expands inline. Device Card has long-press only. (Phase 3 / Systems tab will own a real device-detail screen; Home will then push to it.)
- **Long-press on AI message**: action sheet — Copy text · Report response · Regenerate. (Regenerate re-issues the previous user message in a new turn.)
- **Long-press on user message**: Copy · Edit and resend.
- **Pull-to-refresh on Home**: explicitly disabled. Refresh is implicit — when there are new alerts, the status pill updates; new conversations are user-driven.
- **Tab switch**: 180ms cross-fade (DESIGN.md duration.fast). Composer focus is dropped on tab switch; keyboard dismisses.
- **Tab badge for Home**: none. The status pill is the channel, not a badge.
- **Avatar tap**: opens settings sheet (not push, not modal, not tab). The conversation stays composed underneath, dimmed by the scrim.
- **Offline → online transition**: the deny-red pill quietly fades to its connected state over 320ms (duration.swell). No success toast, no celebration. Calm restoration is the design.
- **Background → foreground**: if a stream was active when the app backgrounded, abort and show the Error state for that message. Cleaner than trying to resume.

## 8. Content Requirements

**Top status pill copy** (in priority order; first matching state wins):
- Offline: *"Offline · Approvals still work"* (deny-red dot + text)
- Critical alerts unacked, count > 0: *"{n} critical"* (deny-red dot + count, Meta type)
- Warning alerts unacked, count > 0: *"{n} warning"* (warning-amber dot + count)
- Default: brand-teal 6px dot, no text. (Glanceable trust without literal "Connected".)

**Cold-open lead line** (single line above the chip row):
- *"Ask Breeze."*

**Cold-open chip labels:**
- *"What broke last night?"*
- *"Show fleet status"*
- *"What ran via MCP today?"*

**Composer placeholder:**
- Default: *"Ask Breeze."*
- Offline: *"Reconnect to ask."*

**Streaming captions (mid-stream tool indicators):**
- Generic verb form, no gerund chains. *"CHECKING FLEET"* not *"Checking the fleet..."*. *"FETCHING DEVICE"*, *"LISTING ALERTS"*, *"RUNNING QUERY"*. Meta-Caps type, Text Low color, paired with a 12px brand-teal spinner.

**Inline-block copy templates:**
- Device card top row: `{hostname}` · `{status-dot}` (no text label needed; the dot color carries semantic).
- Device card meta row: `{os}` · `{lastSeenRelative}` · `{orgName}` — separator middot, never a comma.
- Fleet status row: `{n} devices · {issues} issues · {offline} offline` — when `issues === 0 && offline === 0`, collapse to `{n} devices, all healthy.`

**Error copy:**
- Mid-stream failure: *"Stopped. Tap to retry."*
- Send failure (no stream started): *"Couldn't send. Tap to retry."*
- Empty AI response: *"No reply. Tap to retry."*

**Long-press action sheet:**
- *Copy text*
- *Report response*
- *Regenerate*

**Forbidden phrasing** (carried from DESIGN.md):
- Em dashes (`—`) anywhere in copy. Use middots (`·`), commas, periods.
- Apologies. *"Sorry, I had a hiccup..."* — forbidden. *"Stopped."* is the entire surface area for failure copy.
- Gerund chains. *"Loading your devices..."* — forbidden.
- "Welcome back!", "Let's", "Hey there", or any conversational pleasantry. The AI is competent, not chatty.
- Markdown horizontal rules in AI replies. They render as visual gunk on small screens.

## 9. Recommended References

For the implementer (`$impeccable craft` / direct build):
- **`reference/animate.md`** — for the streaming pulse, inline-block enter, settings-sheet slide-in, status-pill state changes.
- **`reference/typeset.md`** — for the AI-message-as-canvas treatment (no bubble) and for getting the Meta-Caps tool captions right.
- **`reference/clarify.md`** — for chip labels, error copy, and the status-pill copy ladder.
- **`reference/harden.md`** — for offline, error, abort, background-restore, and the SSE-protocol contract edges.
- **`reference/onboard.md`** — for the cold-open chip surface (it is the empty state).
- `DESIGN.md` and `DESIGN.json` are the authoritative tokens. Do not introduce new colors, sizes, or radii without updating both.

## 10. Open Questions

These need resolution during build, not before:

1. ~~**User-scoped chat endpoint exists?**~~ **RESOLVED.** `POST /api/v1/ai/sessions` (CRUD) and `POST /api/v1/ai/sessions/:id/messages` (SSE stream) already exist under user-JWT auth (`apps/api/src/routes/ai.ts`). The SSE protocol matches what Helper consumes: `message_start`, `content_delta`, `tool_use_start`, `tool_result`, `message_end`, `approval_required`, `error`, `done`, plus plan events (`plan_step_start`, `plan_step_complete`, `plan_screenshot`, `plan_complete`, `warning`, `title_updated`) which mobile can ignore in v1. **Build-time caveats:**
   - The route is gated by `authMiddleware` + `requireMfa()` + `requirePermission(ORGS_READ/WRITE)` + `requireScope('organization', 'partner', 'system')`. Mobile login already handles MFA (`mobile.ts`), but verify the session token mobile holds satisfies `requireMfa()` after the initial challenge — if it doesn't, mobile may need a refresh-with-MFA dance or a session-MFA-proof token.
   - Mobile users must have a non-`device`/`agent` scope — confirm during build that the JWT payload's `scope` claim is `organization` or `partner`.

2. **Tool-name → block mapping authority.** The mapping `breeze.devices.get → DeviceCard`, `breeze.fleet.status → FleetStatusRow` lives client-side in v1. As the AI tool catalog grows, this will drift. Defer formalization to phase 3+: when the third or fourth block is added, lift the mapping into a registry that can be populated server-side.

3. **`tool_use_start` arguments display.** Should we show the tool args in the streaming caption (e.g. *"FETCHING DEVICE · dahlia-prod-01"*), or keep it tool-name-only? **Recommendation:** name-only for v1 (privacy and visual calm); revisit after dogfooding.

4. **Critical-alerts polling cadence for the status pill.** WebSocket subscribe vs. interval poll vs. push-driven. **Recommendation for v1:** poll on tab-focus + on app-foreground; revisit if it feels stale.

5. **Approval-required mid-stream UX detail.** The brief defers to phase 1's `ApprovalGate`. Confirm during build that the chat surface gracefully resumes after approval/deny without losing the partial AI reply or the user's place in the conversation.

6. **Generic tool indicator visibility.** Should we render *"BREEZE.PATCHING.LIST · COMPLETED"* for every tool that doesn't have a v1 block, or hide non-rendered tools entirely? **Recommendation:** show by default, with a developer-only toggle to hide. Visibility builds trust (the AI is auditable); we can quiet it later.

---

## Decisions Locked During Discovery

These were resolved before writing the brief; recording so future-craft doesn't re-litigate:

- **Block render contract: Path A (client interpretation).** Mobile interprets `tool_result` events from the existing SSE stream and decides which to render as visual blocks. No backend protocol change. Tool-name → block mapping is a client-side registry.
- **AI is canvas, user is bubble.** AI messages are unboxed text-on-canvas. User messages are subtle Surface-2 pills. Asymmetry is the design.
- **Two tabs, no third for settings.** Avatar opens settings as a right-edge sheet over Home. Settings is a *menu*, not a *tab*.
- **No drilldown in v1.** Tap on inline blocks does not push a screen. Long-press handles secondary actions. Real device-detail navigation is phase 3 work alongside the Systems tab.
- **No pull-to-refresh on Home.** Refresh is event-driven via the status pill and streaming.
- **No tab badge for Home.** The status pill is the only ambient channel on this tab.
- **Inline blocks v1 set: Device Card + Fleet Status Row.** Alert block is deferred to phase 3 (Systems tab will surface alerts as primary).

## Suggested Build Order

`$impeccable craft` is the next step. Three crafts in this order:

1. **Streaming chat shell** — composer, conversation rendering, SSE plumbing, streaming pulse. The base everything sits on.
2. **Inline blocks (Device Card + Fleet Status Row)** — once the shell can render text reliably, add the structured blocks behind the tool-name registry.
3. **Top bar (avatar + status pill) + settings sheet** — the chrome and ambient trust signals.

After step 1, run a brief polish pass to verify motion and density before adding the blocks. After step 3, run `$impeccable polish` on the whole tab before moving to phase 3 (Systems).

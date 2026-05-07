# Design Brief — Breeze Mobile

> Produced via `$impeccable shape` on 2026-05-06. Hand off to `$impeccable craft` for implementation, starting with approval mode.

## 1. Feature Summary

A trusted-device companion app for Breeze RMM. Primary job: out-of-band approval surface for MCP step-up (and future PAM elevation) requests, the security identity that makes high-tier AI agent actions safe. Secondary jobs: AI conversation with the Breeze agent, fleet status glances, push-delivered alerts. Users are MSP techs, sysadmins, and owners of their own systems.

## 2. Primary User Action

**Approve or deny a step-up request in under 5 seconds with full confidence in what's being asked.**

Everything else (AI chat, status, alerts) is ambient. Design loyalty goes to the security moment.

## 3. Design Direction

**Color strategy: Committed.** One color carries the surface. Brand anchor: `oklch(58% 0.13 200)` — cool teal-leaning cyan. Status semantics: approve `oklch(70% 0.18 145)`, deny `oklch(62% 0.22 25)`, warning `oklch(78% 0.15 75)`. Neutrals tinted toward brand (`oklch(15% 0.012 200)` dark surface, `oklch(98% 0.005 200)` light). PRODUCT.md anti-references (default blue, gradient text, generic system fonts) explicitly violated by the current skeleton — this brief moves us off them.

**Theme scene sentence:** *The owner of a 30-tech MSP, in bed at 11:47pm, glances at their phone because Breeze just buzzed — they need to read the request, trust it's real, and tap once.* → Dark is canonical, light is supported but not the design.

**Anchor references:**
- **Duo Mobile / Okta Verify** — push approval ergonomics, but warmer.
- **Linear mobile** — calm density, AI-led inline rendering, two-tab discipline.
- **Things 3** — sparse confidence, generous whitespace, motion that breathes.

Per-surface override: approval takeover briefly shifts toward higher gravity (more chroma in status bands, larger typography) than the rest of the app.

## 4. Scope

- **Fidelity**: Production-ready.
- **Breadth**: Full app (2 tabs + approval mode + settings menu + auth flow).
- **Interactivity**: Shipped. Real push notifications, real biometric, real AI streaming.
- **Time intent**: Polish until it ships. This is a security surface — sloppy reads as untrustworthy.

## 5. Layout Strategy

**Two-tab IA.** Approvals are not a destination, they're a moment.

| Surface | Top | Body | Bottom |
|---|---|---|---|
| **Home (AI)** | Avatar (settings menu) · status pill | Conversation, AI renders inline blocks (status row, alert, device card) | Composer (text + send), thumb-zone anchored |
| **Systems** | Bold one-line health summary + breakdown bar | Active issues → orgs → recent activity, scroll | (none — pull-to-refresh) |
| **Approval (mode)** | 60s countdown ring | Who · What (display) · Details (mono, collapsed) · Risk band | Deny (sm, left) · Approve (lg, right, biometric) |

**Visual hierarchy rules across all surfaces:**
- Thumb zone (bottom 30%) is reserved for primary action.
- One card on screen at a time, only for the in-focus item. Lists are spacious rows with dividers.
- Status indicators use the named color roles consistently — green is *only* healthy/approve, red is *only* critical/deny, amber is *only* warning. No decorative use.
- Approval mode is intentionally heavier than the rest of the app — the register shift is the design.

## 6. Key States

### Home (AI) tab
- **Cold open (no history)**: warm welcome line, 3 suggested chips ("Last night's alerts", "Show fleet status", "What ran via MCP?"). No empty-state illustration.
- **Active conversation**: messages scroll, composer always visible.
- **Streaming**: 3-dot pulse tied to actual token stream, not fake. AI rendered blocks (status row, device card) appear as they arrive.
- **Offline**: composer disabled with a top banner — *"Offline. Approvals still work."* (Critical: approval queue is local-cached so it works without network for already-delivered requests.)
- **AI error**: inline retry, never a modal.

### Systems tab
- **All healthy**: hero reads e.g. *"423 devices, all healthy."* Below, just orgs + recent activity. No zero-state padding.
- **Mixed**: hero reads *"12 issues across 3 organizations."* Active issues section appears with severity ordering.
- **Loading**: skeletons for the hero number and the list rows; never a full-screen spinner.
- **Empty (new user, no orgs paired)**: a short pairing CTA inside the Systems shell — not a separate onboarding screen.
- **Error fetching**: inline row "Couldn't refresh — pull to try again." Last-known data still shown.

### Approval mode
- **Incoming**: 400ms blur-up + slide-up with soft haptic. Countdown ring starts at 60s.
- **Reading**: Details collapsed by default; chevron to expand. Risk band always visible.
- **Approving**: tap → biometric → green wash sweeps up from bottom (200ms) → card lifts and dismisses (300ms) → success haptic → return to prior surface (Home or Systems) with a brief toast: *"Approved · Delete 4 devices in Acme Corp."*
- **Denying**: tap → optional reason sheet (skippable) → red flash on Deny → sharp dismiss → toast: *"Denied · request will be logged."*
- **Expired**: countdown reaches 0 → card dims with strikethrough ring → auto-dismisses after 2s → silent (no haptic).
- **Recursive (AI on this phone is the requester)**: same UI, but Approve adds a 5s "Hold to confirm" gesture *after* biometric — explicit deliberate moment for self-approval.
- **Multiple pending**: queue indicator at the top ("1 of 3 pending"), swipe between them. No tab badge — full takeover for each.
- **Report as suspicious**: tertiary link below buttons → opens a sheet with one-tap "This wasn't me" → revokes the requesting OAuth client immediately and signs out the suspicious session.

### Auth / first run
- **Sign in**: email + password (or magic link if Breeze supports), then biometric enrollment, then push permission, then a single-screen "What this app does" with three lines (approve requests · talk to AI · check systems) — not a multi-step onboarding.
- **Locked**: app reopens locked → biometric to enter (configurable: every open / after 15min / after 1hr).

### Settings menu
- Biometric on/off · Auto-lock window · Notification preferences (per-tier) · Paired sessions list with revoke · Sign out · Build version + commit hash (techs notice this).

## 7. Interaction Model

- **Tab switching**: 180ms cross-fade, no slide. Tab bar persists across screens within a tab.
- **Push to approval**: tap notification → unlock → straight to approval mode, bypassing tabs.
- **Approve**: requires biometric every time, no "remember for 5 minutes." Recursive case adds 5s hold.
- **Deny**: single tap, no biometric.
- **AI-rendered blocks → drilldown**: tapping a device card or alert in chat pushes a focused detail screen within the Home tab stack, not a modal. Back returns to chat with scroll position preserved.
- **Long-press on AI message**: copy / report / regenerate.
- **Pull-to-refresh on Systems**: only place. Home tab refreshes implicitly via streaming.

## 8. Content Requirements

**Headlines (display type, write tight):**
- Approval *what*: imperative voice, present tense, plain English. *"Delete 4 devices in Acme Corp."* Not *"A request to perform device deletion has been initiated."*
- Systems hero: factual, single line. *"423 devices, all healthy."* / *"12 issues across 3 organizations."*

**Mono (approval details):**
- Tool name verbatim: `breeze.devices.delete`
- Arguments formatted: pretty-printed JSON or labeled key/value, line-wrapped for narrow screens.
- Request ID: short prefix shown, full ID copyable.

**Risk band copy templates:**
- *"Low impact: read-only."*
- *"Medium impact: changes settings. Reversible."*
- *"High impact: deletes data. Reversible within 30 days."*
- *"Critical: irreversible."*

**Empty / edge state copy (no AI tells, no apologies):**
- All healthy: *"No issues. Everything's running."*
- Offline: *"Offline. Approvals still work."*
- Expired: *"This request expired."*
- Denied confirmation toast: *"Denied · logged."*
- Suspicious report confirmation: *"Reported. Session revoked."*

**Forbidden phrasing**: em dashes, "Welcome back!", "Let's", apologetic AI ("Sorry, I encountered an error..."), gerund chains ("Loading your devices..."). Use periods, plain nouns and verbs, present tense.

## 9. Recommended References

During build, lean on these impeccable refs:
- **`reference/product.md`** — register baseline.
- **`reference/animate.md`** — for the approval entrance/exit, the green-wash success, the queue swipe.
- **`reference/harden.md`** — for the offline path, expired requests, biometric failure, push permission denied, and recursive self-approval safeguards. This app is security-critical; edge cases are first-class features.
- **`reference/clarify.md`** — for the approval copy and risk band templates.
- **`reference/typeset.md`** — for the Geist scale and the mono/sans interplay in approval prompts.
- **`reference/colorize.md`** — for the Committed teal rollout (where the brand color appears, where it doesn't).

## 10. Open Questions for Build

1. **Push notification payload**: how much detail can/should be in the lock-screen notification itself? Recommendation: action verb + org name only, no arguments. Full details require unlock. Confirm before wiring.
2. **Biometric fallback**: if biometric fails (sweaty thumb, sunglasses + Face ID), do we allow passcode? Yes for v1, but log the fallback. Revisit.
3. **OAuth client display**: how the requesting client identifies itself ("Claude Desktop · Todd's MacBook Pro"). Need to confirm what the OAuth registration metadata actually contains and how we display unverified/sketchy clients differently from trusted ones (faded vs. bold name? "Verified" badge?).
4. **Multi-account**: does a single phone bind to one Breeze identity, or can a tech with two MSPs paired to it switch contexts? v1: one identity. Revisit if real demand.
5. **Geist license**: confirm Geist's OFL terms cover bundled use in a published mobile app. Free, but verify before locking.

---

## Decisions Locked During Discovery

These were resolved in the shape conversation; recording them so future-craft doesn't re-litigate:

- **Recursive AI step-up**: same phone CAN approve its own AI's request, but requires biometric AND a 5s hold-to-confirm.
- **Live signal on approvals**: just the requested action and where it was initiated (client name + machine). No screenshots, no session previews — privacy/perf cost not worth it.
- **Voice on AI tab**: text only for v1.

## Phase 2+ Scope (added post-implementation)

Captured during the phase 1 build / verification but not designed yet. Each becomes its own brief when picked up.

### Device & client lifecycle management

A trusted-device security model is incomplete without lifecycle controls. Lost phones, retired laptops, decommissioned MCP integrations — all need a clean revocation path. Two parallel surfaces share the same UX patterns and audit primitives:

**1. User's own mobile devices** (the phones running Breeze Mobile):
- *Schema*: extend `mobile_devices` with `status` (`active`/`blocked`), `blocked_at`, `blocked_by_user_id`, `blocked_reason`. Tracking columns (`last_active_at`, `model`, `os_version`, `app_version`) already exist.
- *User self-service* — Mobile Settings → "This device + others": list of paired devices, per-row last-active timestamp, "Revoke" action that flips status to `blocked` and clears push tokens. Cannot revoke the current device (must do that from another device or via web).
- *Web Settings → Security → Devices*: same list as a richer table view. Owner of own systems case.
- *Admin oversight* — Web admin UI under user detail: org/partner admin sees a user's devices and can block one (incident response: "Sarah just lost her phone — block it now"). Block on a user's primary device should require a confirmation modal explaining the user will be locked out of approvals until they re-pair.
- *Approval enforcement*: blocked devices return 401/403 from `/api/v1/mobile/approvals/*`. Their push tokens are excluded from `getUserPushTokens()`.
- *Audit trail*: every block/unblock writes to `audit_log` with actor, target device, reason.

**2. OAuth clients per user** (Claude Desktop, Cursor, Breeze AI agent sessions, future MCP integrations):
- Schema basis already exists via `oauth_clients` + `oauth_grants` + `oauth_sessions`.
- *Mobile Settings → "Connected apps"*: list of clients the user has authorized, each row shows last-seen + last-approval-decided. Revoke action invalidates all grants for that client.
- *Web Settings → Connected apps*: same. The brief's "Paired sessions list with revoke" line in Settings hints at this — formalize here.
- *Admin oversight*: org/partner admin can revoke a specific client app for a specific user, or block a client app *globally* across the org (e.g., "no one in Acme Corp may use Cursor over MCP for the next 30 days").
- *Distinct from device blocking*: revoking Claude Desktop ≠ blocking the user's iPhone. Both surfaces in Settings, never collapsed into one list.

**Cross-cutting concerns:**
- **Self-lockout protection**: when revoking the *only* trusted device or the *only* paired OAuth client, surface a clear warning. Don't silently brick the account.
- **Re-pairing flow**: after a device is blocked, the user must re-enroll from a fresh sign-in. Existing biometric enrollment + push permission flow covers it; just need to make sure the blocked status forces a fresh `mobile_devices` row insert rather than reactivating the blocked one.
- **Notification when blocked**: if a device is blocked admin-side while the user is logged in, the next API call returns a structured error the app uses to render a "This device has been deactivated by your administrator" full-screen state. No silent failures.
- **Activity feed per device/client** (deferred even further): per-row drilldown to "what did this device approve in the last 30 days." Useful for forensics. Storage cost grows with approval volume — defer until justified.

### Other phase 2+ items already captured elsewhere

These live in the verification doc but worth listing here for one-stop reference:

- MCP step-up enforcement (the missing wire between "Claude calls a tool" and "an approval row exists in `approval_requests`")
- Server-issued `isRecursive` flag (replacing the label-prefix heuristic)
- Background expiry job to flip `status='expired'` server-side
- Report-as-suspicious sheet (currently a stub Pressable)
- Multi-pending swipe between queued approvals
- AI tab + Systems tab + full Settings polish
- In-app agent step-up labeling decision (always-mobile vs. tiered inline-WebAuthn fallback)

## Suggested Build Order

`$impeccable craft` is the next step. Break into three crafts in this order:

1. **Approval mode** — the load-bearing surface, riskiest to get wrong. Build first so the rest of the app inherits its visual gravity.
2. **Home / AI tab** — the daily-use surface. Once approval mode locks the design language, this is mostly applying it to a chat shell.
3. **Systems tab + auth shell + settings** — the supporting surfaces.

Run `$impeccable document` after step 1 so the locked tokens (color, type, motion) are written to `DESIGN.md` before the rest of the app is built — keeps surfaces consistent and avoids drift.

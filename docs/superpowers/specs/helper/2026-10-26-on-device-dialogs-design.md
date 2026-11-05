# On-device dialogs: one branded, stateful end-user experience: Design

Epic: LanternOps/breeze#10190
Defects in scope: #10177 #10178 #10179 #10180 #10181 #10182 #10183 #10184 #10185 #10186 #10187 #10188 #10189 · earlier: #4940 #4941 (closed), #8138 (closed)
Builds on: `agent/2026-10-08-agent-localization-helper-runtime-branding-design.md` (Phase 2 localization + runtime branding), `helper/2026-10-12-endpoint-messaging-and-live-chat-spec.md` (message cards), `docs/superpowers/plans/pam/2026-10-18-pam-user-decision-reaches-server.md` (#8971), `docs/superpowers/plans/pam/2026-10-16-pam-approval-user-experience.md` (#8928)
Date: 2026-10-26
Status: draft — Gate A on §7

## Decisions already made (Todd, 2026-10-26 — binding, not reopened here)

1. **Breeze Assist is the required renderer** for the branded experience. The native helper is a degraded fallback that mirrors copy, button semantics and safe defaults with stock chrome. No native visual parity work.
2. **The elevation request renders on the interactive desktop via Assist**, stateful (waiting / approved / denied). Dismissing the UAC credential box is handled separately (#10177).
3. **Branding source = the existing partner branding settings** (logo, name, colours), delivered to the agent through the policy/heartbeat path; org override where the portal already has one.
4. **Localisation:** product strings in the eight locales; MSP-provided copy shown verbatim, with placeholders.

Where a decision has a consequence the decision text did not spell out, this spec states the consequence and, if it needs a call, raises it in §7. It does not re-argue the decision.

---

## 1. Problem

Recording the end-user videos on a Windows 11 lab VM (agent 0.124.0) showed that every prompt works, but they look like three different products, and none of them tells the person at the keyboard who is asking, why, or what happens next.

| Moment | Renderer today | Defects |
|---|---|---|
| Restart after patching, postpone allowed | native user-helper, `MessageBoxTimeoutW` Yes/No (`agent/internal/userhelper/notify_prompt_windows.go`) | No MSP name; the body explains the buttons ("Select Yes to restart now…", `notify_prompt.go:83-94`); **Yes is the default, so Enter restarts**; auto-closes after 2 min (`heartbeat/reboot_prompt.go:146`) (#10181); a second `notify_result` is logged at WARN on every answer (#10182); docs omit all of it (#10189) |
| Restart warnings without postpone, reminders | WinRT `ToastText02` titled "Breeze" (`toast_xml.go`) | Silenced by Do Not Disturb / Focus Assist (Windows 11 turns it on for the first hour after setup); nothing persists to find later. No DND detection exists anywhere in the agent |
| Last minute before restart | Windows itself (`shutdown /r /t 60`, `patching/reboot_plan.go:245-250`) | "You're about to be signed out" — not ours, but the last thing the user sees |
| Cancel a restart that is not scheduled | — | Reported as a failed command (#10186) |
| UAC capture | SYSTEM-role helper, custom Win32 window drawn on the **input desktop** (`userhelper/pam_dialog_desktop.go`), 90 s self-denying countdown | After "Approve" nothing says "waiting on your IT team" (#10180); a technician's approval does not close or update it (#10178); the credential prompt stays open after an approved launch because Escape does not close it (#10177); 1.5–2 min from approval to `pam_apply_v2` dispatch (#10179); no MSP name |
| Remote-support consent | Assist card, or native `MessageBoxTimeoutW` / `osascript` / `zenity` | Native default is **Allow** on Windows and macOS (#10187); the docs promise Deny and promise a refusal without Assist (#10188) |
| Session indicator / session ended | native Win32 pill (Windows only, click-through `WS_EX_TRANSPARENT`, `banner_windows.go`), Assist banner | Cannot be clicked for details or to end; nothing on macOS/Linux without Assist |
| Safe-mode reboot, macOS permission notices | toast / `osascript` | Unbranded, easy to miss |
| Breeze Assist itself | Tauri tray app | Crash-loops silently on old WebView2, no exit code logged, no runtime check (#10183); first download refused as cleartext and the retry succeeds (#10184); the agent uninstalls a hand-installed Assist when the deploy toggle is off (#10185) |

Two structural causes sit under the list:

- **Every prompt has its own wire type, renderer and timeout rule.** Restart uses `notify`/`notify_result` to the user-helper (`ipc/message.go:21-22`), elevation uses `pam_request_dialog` to the SYSTEM helper (`:27-30`), consent uses `consent_request` v2 to Assist or the user-helper (`:120-131`), the indicator uses `banner_show`, and endpoint messages use `message_*` (`:88-92`). Only consent has a "presented" acknowledgement and a cancel; only messages have replay. Nothing can update a prompt that is already on screen.
- **Nothing carries the MSP's identity to the device for prompts.** The caller-verification card fetches `{partnerName, logoUrl}` itself (`apps/helper/src/windows/callerVerifyBranding.ts`), endpoint messages snapshot a sender name per message (`services/endpointMessaging/brandingSnapshot.ts`), and the Phase 2 runtime branding decision is resolved server-side (`services/helperBranding.ts`) but not consumed by the Go agent (`heartbeat/heartbeat.go:382-390` has no `Branding` field). Agent-initiated prompts (restart, UAC) have no name to show, online or offline.

## 2. Users & scope

**End user at the keyboard.** Usually a standard user. Must be able to answer, for every prompt: who is asking (MSP name, technician per policy), what will happen, what happens if I do nothing (the real consequence, with the countdown), and what I can do (real button labels). Must be able to find a missed notice afterwards.

**MSP admin.** Owns the brand (Settings → Partner → Branding, org override in the portal branding row), the restart policy copy (`config_policy_patch_settings.reboot_prompt_*`), the postpone budget, the consent mode and identity level (`config_policy_remote_access_settings`), and the Breeze Assist deploy toggle (helper policy). All of these already exist and are already partner-wide-capable (`configuration_policies` is `org_id` XOR `partner_id`, `configuration_policies_one_owner_chk`). This epic adds **no new branding home** and at most two policy fields (§4).

**Technician.** Sees server-side what the user is looking at: the elevation request in `/pam` (already), "waiting for user · 0:23" on a consent-mode session start (already), the restart's "Postponed N of M" badge (already, from `heartbeat.rebootStatus.deferralsUsed`), and — new — which renderer the device can use ("Breeze Assist" vs "native fallback" vs "unavailable: WebView2 x.y") so a degraded prompt is explainable before the user calls.

**Platforms.** Windows first. macOS and Linux wherever Assist runs: Assist already runs there as the console user with `assist` + `consent_ui` (`sessionbroker/broker.go:2856-2866`). On Windows Assist is admitted **only in the active console session and only as a non-SYSTEM process** (`broker.go:2840-2853`) — this single fact drives most of the edge-case behaviour in §3.7.

**Native fallback matrix** (what the user gets when Assist cannot render in that session):

| Prompt | Windows native | macOS native | Linux native |
|---|---|---|---|
| Restart prompt | user-helper `TaskDialogIndirect` with real labels (replaces `MessageBoxTimeoutW` Yes/No), Postpone default | `osascript display dialog`, real labels, default = Postpone (today default = first action) | daemon-drawn `zenity --question` (today), Postpone default |
| Restart notices / final warning | toast + `FallbackDialog` when toasts are muted | `display notification` | `notify-send`, then `wall` |
| Elevation request (decision) | SYSTEM helper Win32 window on the input desktop (today's bones, catalog copy); also the W07 renderer of the first question while UAC owns the secure desktop (§3.4) | — (UAC capture is Windows-only) | — |
| Elevation states (waiting/approved/denied) | toast + `FallbackDialog` (#8928 PR 1 toasts) | — | — |
| Remote consent | `TaskDialogIndirect` Allow/Deny, **Deny default** (#10187) | `osascript`, **default Deny** (#10187) | `zenity`, Deny default |
| Session indicator | native pill (made clickable: §3.5) | none — documented | none — documented |
| Notices | toast + `FallbackDialog` | `display notification` | `notify-send` |
| Persistent notification list | none — documented degradation | none | none |

## 3. Proposed design

### 3.1 The prompt host contract

One contract, spoken by every renderer: Assist, the native user-helper and (for elevation) the SYSTEM helper. The agent owns every prompt; renderers draw what the agent says and report what the person did.

#### Messages

Agent → renderer:

| Type | Payload (summary) |
|---|---|
| `prompt_show` | full current state: `promptId`, `rev`, `lease`, `kind`, `state`, `presentation`, `copy`, `facts`, `actions`, `defaultActionId`, `timing`, `focus`, `listEntry`, `locale`, `direction`, `identityRef` |
| `prompt_update` | `promptId`, `rev`, `lease` and the fields that changed (`state`, `copy`, `actions`, `timing`); a field present replaces the old one |
| `prompt_close` | `promptId`, `rev`, `lease`, `reason` (`resolved` / `superseded` / `withdrawn` / `expired` / `fenced`) |
| `prompt_action_result` | reply on the `prompt_action` envelope: `accepted` / `rejected_stale` / `rejected_invalid`, plus the resulting `rev` |
| `prompt_branding_sync` | the effective identity (§3.6) or `{cleared:true}`; sent on connect and on change |

Renderer → agent:

| Type | Payload |
|---|---|
| `prompt_presented` | `promptId`, `rev`, `lease`, `visible` (the renderer's honest answer: window created on a drawable desktop and not behind a lock it can detect). Window creation is **rendered**, not **seen** (§3.2) |
| `prompt_action` | `promptId`, `rev`, `lease`, `actionId`, `via` (`click` / `keyboard` / `list`) |
| `prompt_closed` | `promptId`, `rev`, `lease`, `reason` (`hidden` / `render_failed` / `replaced`). Hiding a window is never a domain action: closing the "waiting" card does not cancel the request |

#### Fields

- **`promptId`** — a stable idempotency key derived from the domain object, never random: `elevation:<requestId>`, `consent:<nonce>`, `session:<sessionId>`, `restart:<scheduleGeneration>`, `notice:<source>:<id>`. A second `prompt_show` with the same id replaces the first; it never draws a second window.
- **`rev`** — monotonic per `promptId`. Renderers drop any message whose `rev` is not greater than the last one applied. Every renderer message echoes the `rev` it acted on.
- **`lease`** — `{rendererSession, epoch}`: the IPC session key of the renderer the agent assigned the prompt to (from `AuthResponse.SessionKey`) and a per-prompt epoch the agent bumps every time it moves the prompt to another renderer. The agent rejects (`rejected_stale`) any action or `prompt_presented` whose lease is not the current one. A disconnect does **not** prove the old window is gone — consent already plans for a cancel that fails and leaves a window up until its own timeout (`heartbeat/consent_gate.go:261`) — so the lease, not the connection state, decides which window's clicks count.
- **`kind`** — from a closed registry (below). A renderer only receives kinds it advertised and holds the scope for.
- **`state`** — `pending` (waiting on the person at the keyboard) → `waiting` (waiting on someone else) → one terminal state: `approved`, `denied`, `expired`, `cancelled`, `failed` (approved but could not be carried out, e.g. the elevated program did not start). Not every kind uses `waiting`. Delivery outcomes (`unavailable`, `render_failed`) are recorded but are not states the user sees. A terminal state is shown for a kind-defined linger (8 s default), then the window closes and the list entry stays (§3.2). Terminal states are persisted as tombstones for 24 h so a late replay or a re-delivered server command cannot resurrect a decided prompt.
- **`actions` and transitions** — at most three per state: `{id, label, role}` with `role` ∈ `safe` / `proceed` / `neutral`. Each kind has an explicit transition table (which action is valid in which state, and what it does), so a prompt can take more than one action over its life (Send request → Cancel request; Details → End session). An action is idempotent on `(promptId, actionId, rev)`; the agent revalidates it against the live domain state (the request may have been approved meanwhile) and answers `prompt_action_result`. The renderer shows a brief "working" state until the result and **never replays an unacknowledged click after a reconnect** — after replay the user sees the current state and can act again. Decision states carry exactly one `safe` action and `defaultActionId` must name it; a renderer handed anything else refuses the prompt (`prompt_closed{render_failed}`) and the agent falls back. Esc and the window close button map to the `safe` action in a `pending` decision and to "hide" everywhere else.
- **`timing`** — two separate budgets, never one: `presentWithinMs` (how long the agent waits for `prompt_presented`; 10 s, the consent precedent at `consent_gate.go:80-86`) and the response budget, which is either `deadlineUnixMs` (an absolute domain deadline: the restart time, the server's request expiry) or `responseMs` (a window that starts at presentation, used only where that is the domain rule, i.e. consent). Plus `expiry: {actionId|null, text}` — the consequence sentence ("If you do nothing, the request is cancelled."). **Expiry is decided by the agent's timer, never by the renderer**; a replay or a renderer switch never restarts a deadline.
- **`presentation`** — `modal` (focused window, used only where the user just initiated the action or the decision is time-critical), `card` (non-modal window, bottom-right, stays until resolved or hidden), `indicator` (session pill), `list_only` (entry only).
- **`copy`** — plain-text slots: `title`, `body`, `consequence`, `operatorNote`, `stateDetail`. Rendered by the agent (see "Who renders copy"). Two renderer-owned placeholders only: `{remaining}` (live countdown, `M:SS`, computed from `timing`) and `{time:<unixMs>}` (local wall-clock formatting). Everything else is already substituted.
- **`facts`** — label/value rows (Program, Publisher, Command line, Technician). Plain text, truncated with a "Show more" affordance in Assist.
- **`focus`** — `steal` or `no_activate`; set from the kind table and the foreground state (§3.2).
- **`listEntry`** — `{persistent, expiresAtUnixMs}`; whether the prompt also lives in the notification list.
- **`locale` / `direction`** — the locale the agent rendered in, so Assist renders its own chrome in the same language; `direction` is `ltr` for all eight locales today and exists so a future RTL locale is not a contract change. (Locale is not part of `AuthRequest` today, `ipc/message.go:249-289`.)
- **`identityRef`** — `{scopeId, logoSha256}` of the MSP identity in force when the prompt was created. A prompt and its list entry keep the identity they were created with (the endpoint-message send-time snapshot rule, `brandingSnapshot.ts:8`); entries whose `scopeId` no longer matches the device's (org move, partner change) are purged, not re-branded.
- **Ownership** — every prompt and list entry is bound to the session it was shown in **and** the user principal (Windows: session id + user SID + logon id; Unix: uid + session id). A list entry is never replayed into another user's session, including after fast user switching or an RDS reconnect into a different session.

#### Kind registry

| Kind | Copy class | Presentation | Actions per state (role) | Default | Expiry | Wave |
|---|---|---|---|---|---|---|
| `notice.info` | breeze | card + list | `ok` (safe), optional `open_settings` (neutral, macOS permissions) | `ok` | — | W04 |
| `restart.prompt` | operator | card | pending: `restart_now` (proceed), `postpone` (safe, label shows the resulting time, only while budget remains) | `postpone` | none: the restart happens at `deadlineUnixMs` whatever the card does (stated) | W05 |
| `restart.final` | operator | card, `steal` | closing rung (OS countdown running): `ok` (safe) | `ok` | the OS restarts at the end of its countdown (stated) | W05 |
| `remote.consent` | breeze | modal, `steal` | pending: `allow` (proceed), `deny` (safe) | `deny` | per `consent_unavailable_behavior` + occupancy (stated) | W06 |
| `remote.session` | breeze | indicator | `details` (neutral), `end_session` (§7 OD-5), `report_problem` (§7 OD-6) | — | ends with the session | W06 |
| `elevation.request` | breeze | card; `modal` only when the user is looking at the default desktop (§3.4) | pending: `send_request` (proceed), `cancel` (safe), `use_local_credentials` (neutral, #8928 PR 2); waiting: `cancel_request` (safe-for-domain), `hide` (neutral) | `cancel` / `hide` | pending: cancelled (stated); waiting: the server's request TTL (stated as a time) | W07/W08 |

**Copy class and scopes.** The broker enforces the trust boundary, not only the renderer. Two scopes, each granted only on advertisement:

- `prompt` — Breeze-owned kinds (`notice.info`, `remote.*`, `elevation.request`). Same rule as `consent_ui` today: it "carries Breeze-owned consent wording only and must never carry operator-chosen text" (`ipc/message.go:221-228`).
- `prompt_operator` — kinds whose body may carry MSP copy (`restart.*`).

The broker refuses to send a kind over a session that lacks the kind's scope. On the producer side, `breeze`-class prompts are built only by typed constructors in the agent that take catalog keys and typed parameters (program name, technician name, times) — no free string from a server payload can reach any slot, label or fact of a `breeze` kind. `operator` kinds render MSP copy verbatim in `title` / `body` / `operatorNote` and, for restart, the `restart_now` label; the identity header, the safe action's label and all action semantics stay Breeze-owned. Assist additionally refuses a `breeze`-class prompt with a non-empty `operatorNote` (defence in depth). Endpoint messages keep their shipped `message_*` contract and `messaging` scope (§3.5).

#### Who renders copy: the agent

The agent renders every string from **one catalog** (JSON in `packages/shared`, embedded into the Go binary at build time and imported by Assist for its chrome strings), in the session's locale, and sends finished strings. Assist owns chrome only: the identity header (from `prompt_branding_sync`), layout, theme, focus order, screen-reader labels and its own chrome strings (the notification list, "Show more", "Working…"), rendered in the `locale` the prompt carries.

Why the agent and not Assist templates:
- the native fallback mirrors the copy **by construction** — the same Go function produced it — which is what decision 1 asks for;
- a new agent never depends on Assist knowing a new template key, so agent ↔ Assist skew cannot produce a blank or English-only prompt;
- operator text with placeholders (`{{countdown}}` in `reboot_prompt_*`) is substituted in one place, already validated by `handlers_patch.go:404`.

Locale: the session's UI language (Phase 2 OD1, approved: Helper language follows the logged-in user's session locale), falling back to the OS language, then `en`. The eight locales are `en de-DE es-419 fr-FR fr-CA it-IT pt-BR tr-TR`. The caller-verify catalog (`callerVerifyMessages.ts`) is missing `fr-CA` today; the shared catalog closes that.

#### Versioning and the compatibility rule

- `ipc.ProtocolVersion` stays **1**. It is checked by exact equality at auth and a mismatch is a permanent reject (`broker.go` auth path), so bumping it would brick every skewed helper.
- A renderer advertises `AuthRequest.promptProtocolVersion` (int, absent = 0) and `promptKinds` (`[]string`, each kind with its own semantic version, e.g. `"restart.prompt@1"`). This is the same additive pattern as `ConsentProtocolVersion` and the `Supports*` booleans (`ipc/message.go:262-288`). The broker clamps the protocol version to its own, grants `prompt` / `prompt_operator` only for advertised kinds of that class, and records the kinds on the session. A new kind, or a new version of one kind, needs no protocol bump; a change to the envelope or the common fields bumps `promptProtocolVersion`, and the agent speaks the clamped version.
- **Rule 1 — the agent decides per prompt from the live, authenticated renderer.** At show time, per session, the agent uses `prompt_*` only if the renderer it chose holds the scope and advertised the kind at a version the agent speaks; otherwise it sends the legacy type exactly as today (`notify`, `consent_request` v2, `banner_show`, `pam_request_dialog`). Server-side records of the helper version or capabilities are never the deciding input — they go stale across crashes, updates and session changes. So agent and Assist can ship in either order.
- **Rule 2 — the server holds a kill switch, not the capability.** The heartbeat carries `promptHost.enabledKinds` (server configuration, empty by default). The agent intersects it with the renderer's advertisement; a kind not enabled server-side is sent the legacy way. This is how each wave is turned on per environment and turned off without an agent release.
- **Rule 3 — legacy senders are deleted only after a fleet floor, per path.** The legacy branches toward old **Assist** builds are removed only in an agent release after the server enforces a minimum Assist version (through the `helperUpgradeTo` offer) and telemetry shows no connected Assist below it. Assist versions are offered by the server, not bundled with the agent, so they skew independently. The legacy branches toward the **native** helpers can go once the agent itself has shipped their replacement, because those helpers ship in the same package (`breeze-user-helper.exe`, `sessionbroker/userhelper_path.go`) — but only after a release in which an agent update that leaves an old helper process running across the update has been tested.
- **Rule 4 — unknown is never silent for a decision.** Today an unknown message type is dropped (agent: WARN, `broker.go` "unknown message type from helper"; Assist: silently, `client.rs` `_ =>` arm). A `prompt_show` the renderer cannot draw gets an explicit `prompt_closed{render_failed}`, and the agent falls back. A missing `prompt_presented` within `presentWithinMs` is treated the same way.
- **Rule 5 — one fixture set, two implementations.** The wire contract is pinned by golden JSON fixtures in `packages/shared` that both the Go and the Rust test suites decode and re-encode, including the old/new combinations in §8.

#### Choosing a renderer

Per prompt and per target session, at show time:

1. Assist in that session holding the kind's scope and advertising the kind, the kind enabled server-side, and the session drawable for Assist (§3.7).
2. The native user-helper in that session (the SYSTEM helper for `elevation.request` while UAC owns the secure desktop, §3.4). It ships with the agent, so it speaks the contract in the same release.
3. A legacy helper via the legacy type (rule 1).
4. Headless: Linux daemon-drawn `zenity` / `notify-send` / `wall` (today's `reboot_prompt_desktop.go` path).
5. None: the prompt is recorded `unavailable` and the kind's no-renderer rule applies (restart proceeds; consent follows `consent_unavailable_behavior` with today's occupancy rules; elevation reports `elevation-unable` as today, `pam_unable_report.go`).

**Exactly one authorized renderer per prompt per session.** The agent keeps `promptId → (session, principal, lease, rev, state)`. Moving a prompt to another renderer bumps the lease epoch first, so a window the agent can no longer reach cannot act even if it is still on screen; the agent also sends it `prompt_close{fenced}` if the connection is up. If Assist disconnects with a decision open, the agent waits a short grace (10 s) and then re-shows the prompt on the native renderer with the **remaining** response budget. The grace is deliberately shorter than the watcher's 30 s respawn check (`helper/watcher.go:10`): a decision should not sit invisible for up to 30 s, and the user losing a few seconds to a second window is the lesser harm. When Assist reconnects, the agent closes the native copy (new lease), replays every open list entry **without activation**, and restores at most one decision surface. Legacy renderers have no lease or close support, so on the legacy path exactly-one is best-effort (today's behaviour) and stated as such.

This also closes two old fan-out bugs by construction: one prompt per Windows session (`notify_targets.go` already picks one helper per session, #4940), and a duplicate or late answer to an already-decided prompt is answered `rejected_stale` and logged at DEBUG, not WARN (#10182).

### 3.2 Persistent notification list (DND-resistant delivery)

Windows Focus Assist / Do Not Disturb, macOS Focus and GNOME's "do not disturb" suppress **OS notifications**, not ordinary application windows. So Breeze stops depending on OS notifications for anything that matters. This is DND-*resistant*, not DND-proof: a window can still be behind a full-screen app, on another macOS Space, or hidden by a Linux compositor (all to be checked in the lab legs, §8), and persistence proves the user *can* find a notice, not that they did.

Four delivery stages are tracked separately, and only the last one is ever called "seen":

| Stage | Meaning | Evidence |
|---|---|---|
| delivered | the renderer received `prompt_show` | IPC reply |
| rendered | a window was created | `prompt_presented` (today's `message_presented` fires here too, `apps/helper/src-tauri/src/ipc/client.rs:514`) |
| visible-eligible | rendered on the active, unlocked desktop of the owning session | agent session state + `prompt_presented.visible` |
| acknowledged | the person acted (any action, including "hide") | `prompt_action` |

- **Decisions are Assist windows, never OS toasts.** `restart.prompt`, `elevation.request` and `remote.consent` are Assist cards or modals and are not muted by DND.
- **Informational notices are Assist-drawn cards plus a list entry.** The card is a small always-on-top, non-activating Assist window (bottom-right) that stays until hidden or superseded; the entry stays in the list until it expires. An OS toast is sent only by the native fallback, never as the primary surface.
- **The list lives in the agent, by extending the endpoint-message store.** The agent already persists, expires and replays message cards with a 50-entry cap and tombstones (`heartbeat/message_store.go:10-38`). That store is generalised to all list entries — one inbox, not two — and gains the ownership key it lacks today (it is keyed by message id only, `message_store.go:42`): session + user principal (§3.1 "Ownership"). Assist keeps no durable state, so an Assist crash, update or watcher respawn loses nothing.
- **Replay never storms.** On Assist connect the agent replays entries into the list and the tray badge **without activating anything**, and restores at most one eligible decision surface (the oldest pending decision). Visible cards are capped at three per session; the rest collapse into the list. Retention is bounded (§7 OD-3); entries that would expose details to another user are never replayed across principals.
- **Where the user finds it.** Tray menu "Notifications (2)", a badge on the tray icon, and a "Notifications" tab in the Assist window, all keyboard-reachable. Windows 11 hides most tray icons in the overflow, so the badge is not relied on; the on-screen card is.
- **What lives there.** Live entries with actions ("Restart scheduled for 14:30 · 2 postponements left · Restart now / Postpone until 15:30"), outcome entries ("Your request for 7-Zip was approved by Northwind IT"), and after-the-fact entries ("Your computer restarted at 03:12 to finish installing updates" — written before the OS restart, shown after the next sign-in).
- **Focus rules.** `focus: steal` only for a `modal` that answers something the user just did (elevation on the default desktop) or a time-critical decision (`remote.consent`, the `restart.final` closing card), and at most once per focus interval — the message card's existing critical-only, rate-limited focus rule (`apps/helper/src-tauri/src/ipc/message.rs:250`) becomes the host's rule. Everything else is `no_activate`. When the foreground app is full-screen or presenting (Windows `SHQueryUserNotificationState` = `QUNS_BUSY` / `QUNS_RUNNING_D3D_FULL_SCREEN` / `QUNS_PRESENTATION_MODE`), cards are drawn but never steal focus, and non-urgent cards wait until it ends. macOS and Linux have no equivalent query in this design; there cards simply never steal focus except consent. Remote consent is never deferred: the technician's start would time out.
- **Accessibility.** Every card is keyboard-reachable (tab order: safe action first), has screen-reader labels for the identity header, facts and actions, announces once when shown, and announces the countdown only at 60 / 30 / 10 s — a ticking `aria-live` region would interrupt reading. Esc maps as in §3.1. High-contrast and the OS text-size setting are honoured; the brand colour yields to them.

### 3.3 Restart (W05)

This wave changes the renderer and the copy, **not the restart policy**: which rungs exist, which are deferrable, how a postponement re-plans and the deadline all stay as they are (`patching/reboot_plan.go`, `heartbeat/reboot_prompt.go:164-199`, `patching/reboot_deferral.go`).

| | Today | New |
|---|---|---|
| Who renders | user-helper `MessageBoxTimeoutW` / toast | Assist `restart.prompt` card; native `TaskDialogIndirect` fallback (comctl32 v6; the user-helper's embedded `asInvoker` manifest must declare it, `cmd/breeze-user-helper/main.go`) |
| Buttons | Yes / No + a legend that explains them | "Restart now" / "Postpone until 15:30" |
| Default | Yes (= restart) | Postpone |
| Lifetime | closes after ≤ 2 min | stays until the next rung or a decision; the live list entry keeps the actions |
| Copy | title "Restart Scheduled", body + "You can postpone this restart N more times." | who ("Northwind IT needs to restart this computer to finish installing updates"), when ("at 14:30" via `{time:}`), budget ("2 postponements left"), consequence ("If you do nothing, the computer restarts at 14:30. Save your work before then.") |
| Reminders (60/15/5 min) | toasts | `prompt_update` on the same card and list entry; Postpone offered on every rung that is deferrable today, while budget remains |
| Closing rung (T-60 s, OS countdown running) | toast "Restarting Now", then Windows' own box | `restart.final` card with the live countdown and "OK"; Windows' own box still follows (§7 OD-4) |

- **Postpone label shows the result, not the interval.** A postponement is clamped to the deadline (`reboot_deferral.go:74-82`), so "Postpone 1 hour" can be a lie; the label is "Postpone until 15:30", computed by `ComputeDeferral` before the card is drawn, and the action is hidden when the budget is used up or the clamp leaves less than the minimum gap.
- **All sessions stay in step.** The same `promptId` is fanned out one per session (today's `notifyTargets`); the first accepted decision is applied and every other session's card gets the `prompt_update` with the new time, instead of timing out on its own (#4940's lingering duplicate).
- **Postponing does not reopen the prompt** (`leadRungWarnsOnly`, #4941 already fixed); the card collapses to its list entry.
- **The operator copy** (`reboot_prompt_title/body/button`) fills `title`, `body` and the `restart_now` label; `{{countdown}}` becomes `{remaining}`. It never fills the identity header or the Postpone label.
- **Who owns the last minute** stays with the OS (`shutdown /r /t 60 /d p:2:17`, `reboot_plan.go:245-250`): it survives an agent crash in the last minute, and the code records why the earlier `/t 0` design failed — the closing notice raced session teardown and "essentially never rendered" (`reboot_plan.go:48-53`). §7 OD-4 asks Todd to confirm, since it means Windows' own box remains the last thing the user sees.
- **Cancel with nothing pending** returns success `{cancelled:false, reason:"no_reboot_scheduled"}` (#10186); with a restart pending it closes the card (`prompt_close{withdrawn}`) and leaves "Restart cancelled by Northwind IT" in the list.
- **Locked or no session.** A rung that fires while the session is locked is not presented; its list entry is, and the card is shown at unlock with the remaining time. The restart time never moves for presentation. With no interactive session the restart proceeds as today; the after-restart entry is the record.

### 3.4 Elevation request (W07, W08)

**The constraint decision 2 runs into.** Today the decision window is drawn by the SYSTEM helper on the *input* desktop (`OpenInputDesktop` + `SetThreadDesktop`, `userhelper/pam_dialog_desktop.go:22-77`). With the Windows default `PromptOnSecureDesktop=1` that is the secure desktop, next to `consent.exe`. Assist is a user-level process admitted only in the console session (`broker.go:2819-2853`; console-bound because of its cross-user token capability). While UAC owns the secure desktop **nothing Assist draws is visible**, and Assist can never draw there. So an Assist card can ask the first question only after the UAC prompt is closed.

That makes decision 2 a two-step delivery (§7 OD-1 asks Todd to confirm the staging):

- **W07 — transitional (explicitly degraded first question).** The first question stays where UAC is; everything after "Send request" is the Assist card on the interactive desktop. This fixes #10178 and #10180 with prerequisites that are already planned.
- **W08 — destination (decision 2 in full).** Breeze closes the UAC prompt as soon as it captures it and asks the first question on the Assist card. This needs prerequisites that do not exist yet (listed below), so it is its own wave.

**W07 flow.**

1. UAC appears. ETW capture → `RunPamFlow` → submit (unchanged).
2. **First question where the user is looking.**
   - UAC on the secure desktop (the default): the SYSTEM helper draws `elevation.request` on the input desktop as today, but through the prompt contract: catalog copy, MSP name in the header (text; GDI, no logo), "Send request to Northwind IT" (proceed) / "Cancel" (safe, default) / "Use administrator password" (neutral, #8928 PR 2).
   - UAC on the default desktop (`PromptOnSecureDesktop=0`): Assist draws it as a `modal` next to UAC. The two surfaces are independently actionable: if the user answers UAC directly (an admin types a password), the agent sees `consent.exe` exit and closes the card (`prompt_close{superseded}`).
3. **After "Send request"** (require-approval verdict): the agent closes the UAC prompt with the kind-aware targeted dismiss (consent prompt: Escape; credential prompt, `Credential Dialog Xaml Host`: its Cancel button or `WM_CLOSE` — #10177), then shows the `waiting` card on Assist: "Request sent to Northwind IT · waiting for approval · you can keep working", with "Cancel request" and "Hide". If the dismiss cannot be proven, the card says "You can close the Windows prompt; your request stays with Northwind IT" rather than pretending. An unproven Approve-time dismiss never engages the fail-closed gate (#8928 D1).
4. **The server decision pushes the state** (#10178):
   - approve → `pam_apply_v2` is enqueued from the respond route immediately (#10179; target: dispatched within 2 s of the decision when the agent is connected; the repeatable worker stays as the safety net) → on `verified_active`, `prompt_update{state:approved}` "Approved by Northwind IT — 7-Zip is starting"; on `failed`, `state:failed` "Approved, but 7-Zip couldn't start. Contact Northwind IT."
   - deny / expire → #8928's `pam_request_notify` (`{requestId, outcome, reason?}`, gated on `pamUserNotifyProtocolVersion`) → `prompt_update{state:denied|expired}` with the server-sanitized reason (≤ 500 runes, controls stripped).
   - a decision that arrives while the first question is still open closes that window (`prompt_close{superseded}`) and shows the outcome card. The race in #10178 disappears because the dialog is no longer an independent 90 s round-trip that ends in a deny.
5. **Cancel request** calls #8971's withdraw route (`withdrawn`, reason `user_cancelled`) and records the decline locally, so an approval that crosses it cannot launch the program (#8971's agent-side refusal). **Hide** only closes the window.
6. **No Assist in the session** (RDP, RDS, crash-loop): the states are #8928 PR 1's toasts with `FallbackDialog`, same catalog strings.

- **End-user-allowed verdict** (the policy lets the user self-approve): unchanged in W07 — the agent types local-admin credentials into `consent.exe`, which needs UAC open, so it stays on the secure desktop; the outcome is a list entry.
- **Never re-show the native window blindly.** A fallback to the SYSTEM-helper window rechecks the requester's session and principal and which desktop is the input desktop before drawing; `pam_dialog_desktop.go:37` attaches to whatever input desktop exists at that instant, which after a lock or a user switch is not the requester's.
- **Technician name.** The card shows the MSP name; the deciding technician's name only if the device's remote-access `technician_identity_level` is `name` or `name_email` (§7 OD-7).

**W08 prerequisites (destination: dismiss first, ask on Assist).**

- **#10177 kind-aware dismissal**, proven on both prompt kinds and both `PromptOnSecureDesktop` settings.
- **Argument-faithful launch.** Managed v2 token launch builds the command line from the target path alone (`pamactuator/tokenlaunch_windows.go:181-182`: `CommandLine: "\"<TargetPath>\""`). Once Breeze closes UAC up front, Breeze must start the program the user asked for, so the captured arguments, working directory and environment must be carried through request, approval and launch — and qualified against installer patterns (`msiexec /i`, bootstrappers that wait on the elevated child, which will see `ERROR_CANCELLED` from their own `ShellExecute`).
- **Requester-bound launch.** The session for the launch is resolved as the first active session whose bare username matches (`tokenlaunch_windows.go:403-411`). With fast user switching or RDS that can be a different session from the one that asked. The verified SID and logon session from the ETW capture must be carried end to end.
- **End-user-allowed without typing into UAC.** With UAC closed, the self-approve verdict needs a local token launch instead of credential typing.
- **"Use administrator password" relaunch.** With UAC closed, this choice relaunches the original command unelevated in the user's session so Windows asks again, with a one-shot capture bypass bound to (SID, session, executable hash, 60 s) so Breeze does not intercept its own relaunch.
- **#8971 and #8928 PR 1 implemented and tested**, not only planned.

Until W08 ships, the W07 behaviour is what users get on the default UAC configuration, and the docs say so.

### 3.5 Remote support (W06) and endpoint messages (W04)

- **Consent.** Assist card as today (Deny focused, Esc = deny, `ConsentDialog.tsx`), moved onto the prompt contract as `remote.consent` with the identity header and the technician per `technician_identity_level`. The native fallbacks get Deny as the default **now**, as a standalone fix ahead of any wave (#10187: `MB_DEFBUTTON2` on Windows, `default button "Deny"` on macOS), and on Windows move to `TaskDialogIndirect` with real "Allow" / "Deny" labels in W06. The countdown text states the policy consequence: "If no one answers, the session starts in {remaining}" (`proceed`) or "…is declined in {remaining}" (`block`). Expiry stays the agent's decision via the consent v2 semantics and `consent_occupancy.go`; nothing about the decision matrix changes.
- **Session indicator.** `remote.session` replaces `banner_show` for Assist: a pill that can be clicked. Expanded: technician (per `technician_identity_level`), MSP name, "View only" / "View and control", started at, and the actions in §7 OD-5/OD-6. The native Windows pill stays as the fallback and becomes clickable only if OD-5 picks "end session"; otherwise it stays click-through. macOS/Linux without Assist: no indicator, documented (#10188).
- **Ended.** "Remote session ended · 14 min · Northwind IT" card + list entry (replaces the toast when Assist is present).
- **Endpoint messages (W04)** keep their shipped `message_*` wire contract and `messaging` scope. Only the Assist renderer converges: the message card and the prompt card become one component, so they look the same, and message cards join the one notification list (§3.2). No wire change.

### 3.6 Branding delivery

**Sources (decision 3), one resolver.** A new server function `resolvePromptIdentity(orgId)` returns:

| Field | Source | Org override |
|---|---|---|
| `partnerName` (who is asking) | `partners.name`, trimmed, ≤ 120 | **none** — the name is never org-overridable, same rule as endpoint messages (#9396, `brandingSnapshot.ts:14-19`): an org-level policy writer must not choose who a prompt appears to come from |
| `logo` | `partners.settings.branding.logoUrl` (Settings → Partner → Branding) | `portal_branding.logo_url` via `resolveDocumentBrand` (`services/partnerDocumentBrand.ts:50-60`) |
| `primaryColor` | `partners.settings.branding.primaryColor` | `portal_branding.primary_color` via `resolveDocumentBrand`; a Phase 2 helper runtime `accentColor` may override the colour only (endpoint-message precedent) |

`resolveMessageBranding` (endpoint messages) and `callerHelperBranding` (caller verify) are refactored to call it, so one function answers "what does this MSP look like on a device" (settings rule 5). No admin UI writes the org logo/colour yet (`partnerDocumentBrand.ts:1-10`); the override works the day one does.

**Wire.** A new heartbeat response block `promptIdentity`, sibling of `helperSettings` and not inside it — native fallback prompts need the MSP name even on a device with no helper policy (where `helperSettings` is absent or `helperEnabled:false`). Shape and semantics copy the approved Phase 2 branding decision (OD3):

```json
"promptIdentity": {
  "state": "set",
  "scopeId": "<opaque, sha256(partner:org) prefix>",
  "partnerName": "Northwind IT",
  "primaryColor": "#1F5FAD",
  "logo": { "sha256": "<hex>", "mime": "image/png", "bytes": 18234 }
}
```

`state:"cleared"` deletes the cached identity; an absent block keeps the last-known one; a `scopeId` change (org move, partner change) or a re-enrol clears it — and purges list entries created under the old `scopeId` — before anything else is applied. Each prompt pins the identity it was created with (`identityRef`, §3.1), so a branding edit never re-brands a decision already on screen. It is sent only to agents that report `securityCapabilities.promptIdentityProtocolVersion: 1`, and is resolved with the device's other settings on the existing per-device cache (120 s).

**Logo bytes.** The device never fetches a remote URL. The agent fetches the bytes over its authenticated API channel (`GET /api/v1/agents/:id/prompt-identity/logo`, answered only for the current `sha256`) when the hash changes. The server decodes a `data:image/…` value or fetches an `https://` value once through the existing `ssrfGuard`, and accepts only PNG, JPEG or WebP (magic-byte check), ≤ 256 KB, ≤ 1024 px per side; SVG and anything else resolve to "no logo" (text wordmark). The agent stores it in a SYSTEM-owned, user-readable branding directory and sends it to Assist inside `prompt_branding_sync` (base64; well under the 16 MB IPC frame cap, `ipc/message.go:174`).

**Offline.** Last-known identity survives agent restarts and outages. A device that has never received one shows the localized generic "your IT support team". The native fallback shows the name only (no logo in stock chrome).

**Assist rendering.** Identity header: logo (if any) + "Northwind IT"; the accent colour is used for the header rule and the primary button, checked against the Phase 2 contrast rule (`helperBrandingContrast.ts`) and replaced by the default palette when it fails. Light/dark follow the OS.

### 3.7 Desktops and sessions

| Situation | Restart | Elevation | Consent / indicator | Notices |
|---|---|---|---|---|
| Console session, unlocked | Assist card | first question: W07 native on the secure desktop / W08 Assist; states on Assist | Assist | Assist card + list |
| Console session, **locked** | not presented; list entry; card at unlock (`WTS_SESSION_UNLOCK`) with remaining time; restart still happens on time | cannot originate while locked; a `waiting` card stays and its outcome is visible at unlock | unchanged occupancy rules: an expired prompt on a locked screen is "not seen" (`consent_occupancy.go:183-193`) | queued, shown at unlock |
| **UAC on the secure desktop** | cards are hidden behind it; they are already on screen when it closes | §3.4 step 2 | — | — |
| **No interactive session** | restart proceeds (today); after-restart list entry at next sign-in | cannot originate | `consent_unavailable_behavior` on a positively empty session, as today | dropped unless `persistent` |
| **RDP on a client SKU** (the user's session is not the console) | Assist is not admitted in that session (`broker.go:2852`) → native `TaskDialogIndirect` in the RDP session | SYSTEM-helper window (as today) + toast states | native fallback in that session (strict per-session routing, `consent_gate.go:577-583`) | native toast |
| **RDS host** (on-demand lifecycle, `lifecycle_mode.go`) | per session, native fallback | per session, SYSTEM helper (PAM hold keeps one, `lifecycle_pam_hold.go`) | per session, native | native |
| **Fast user switching** | prompt fans out one per active session (`notify_targets.go`); a switched-away (disconnected) session gets its entry, bound to its own principal, when it becomes active again | routed only to the requester's session, never another user's (`pam_flow.go:81-88`); the W08 launch must also be bound to that session (§3.4) | strict per session | per session and principal |
| **Assist crashes mid-prompt** | grace 10 s, then native with the remaining time (deadline unchanged); replay without activation on reconnect | waiting state on native toast in between; replay on reconnect | today consent v2 reports `unavailable` and the decision matrix applies; the host does not re-ask, so a lost prompt never turns into a second chance to allow | replay |

The agent decides "drawable" per session at show time from the session state it already tracks (active / connected / disconnected, console id, lock state) and re-evaluates on `WTS_SESSION_*` notifications; Assist's `prompt_presented{visible}` is the second check. Widening Assist to non-console sessions is §7 OD-9.

### 3.8 Assist reliability (W01)

An unreliable Assist silently turns every prompt into the degraded fallback, so these are part of the experience, not housekeeping.

- **Runtime check before launch (#10183).** On Windows the agent reads the WebView2 Evergreen runtime version (`HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}\pv`, and the per-machine/per-user variants) and refuses to launch below the minimum the shipped Tauri/wry build requires (a build-time constant in the Assist package, reported in its manifest so the agent does not hard-code it). It reports `helperInstallIssue: webview2_outdated` with the found version; the device page shows "Breeze Assist unavailable: WebView2 90.0.818" and prompts use the native fallback. Installing the runtime is §7 OD-10.
- **Crash-loop diagnostics (#10183).** The watcher (`agent/internal/helper/watcher.go`) records the exit code and the last stderr lines for every restart, logs them with the WARN it already ships, and reports `helperInstallIssue: crash_loop` (with the last exit code) after it gives up. It retries after a long backoff (6 h) and on every Assist update instead of never.
- **Install ownership (#10185).** §7 OD-8.
- **One download policy (#10184).** Every Assist download path (per-session migration, regular update, retry) goes through the same `netpolicy.ControlPlaneDownload` decision with the same `ControlPlaneOrigins`; the decision is logged once per process, not per attempt.
- **Start hidden (#8138, done).** Invariant kept: no prompt kind ever surfaces the main window (`lib.rs` builds it `.visible(false)`; window-state never restores VISIBLE). Prompt cards are their own windows, like the consent and banner windows today (`ipc/desktop.rs`).
- **Health visible server-side.** The `helperCapabilities` heartbeat object gains `promptHost: {protocolVersion, kinds}` so the technician view can say which renderer a device has (§2).

## 4. Tenancy & data model impact

- **No new tables. No new `org_id` tables.** All state is either existing policy, existing audit, or on the device. Nothing to register in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` or `CORE_TENANT_EXPORT_POLICY` unless a device column is added (below).
- **Branding: no new setting, no new home.** Settings rule 9 statement for the PRs: home = Settings → Partner → Branding (`partners.settings.branding`); level = partner default, org override through `portal_branding`; resolver = `resolvePromptIdentity` (wrapping `resolveDocumentBrand` + `partners.name`); places that configure "how the MSP looks on a device": before 3 (Partner → Branding for the endpoint-message accent, partner login branding for the caller-verify logo, helper runtime branding for Assist colours); after 2 if §7 OD-2 (a) is taken (Partner → Branding for name/logo/colour on every device surface, helper runtime branding as the Assist colour override), 3 otherwise. This epic adds consumers, not a home.
- **New heartbeat response block** `promptIdentity` (no storage) and agent capability `securityCapabilities.promptIdentityProtocolVersion`. There is no "policy snapshot version" in this path today (helper settings are re-resolved per heartbeat with a 120 s cache, gated only by `retainState`); this spec does not invent one. The block's `set` / `cleared` / absent semantics are the versioning.
- **Policy fields: at most two, both on existing partner-wide-capable policy features** (`configuration_policies` is already `org_id` XOR `partner_id`; the SELECT-only partner branch is load-bearing on the agent-auth path, `docs/agents/tenancy-rls.md` item 3):
  - `config_policy_remote_access_settings.allow_user_end_session` — only if §7 OD-5 picks "configurable".
  - helper policy `inlineSettings.prompts.notificationRetentionDays` — only if §7 OD-3 makes retention configurable.
  Both default to the safe value, and both would be classified in `CORE_TENANT_EXPORT_POLICY` per the registry's existing treatment of the parent table.
- **Device columns (optional).** If the technician view needs the prompt renderer persisted (rather than read live), add it to the existing helper status columns on `devices` (`helper_install_issue` already carries the issue codes; a new column would need an export-policy classification as an org-cascade table column). Preferred: reuse `helper_install_issue` with the new codes `webview2_outdated` and `crash_loop`, and keep `promptHost` telemetry-only like `helperCapabilities` today.
- **Audit.** Outcomes that change the machine or a remote party's view are audited through existing paths, with a new `renderer` detail (`assist` / `native` / `headless`) so "the user says they never saw it" is answerable:
  - consent: already audited with consent protocol + outcome (`routes/remote/helpers.ts consentMarkerAuditDetails`) — add `renderer`;
  - elevation: `elevation_audit` + `writeAuditEvent` (`pam.elevation_request.*`, `agent.elevation_request.*`) and #8971's `withdrawn` event — add `renderer`, and `user_cancelled` / `local_credentials` reasons;
  - restart: today a postponement is only a counter (`rebootStatus.deferralsUsed`). The server writes `device.reboot.user_postponed` / `device.reboot.user_restart_now` audit events when the reported counter or state changes — no new route.
  Prompt presentation itself (shown, seen, dismissed) is device telemetry in the agent log at INFO, not audit.

## 5. Security & safety

- **Safe defaults everywhere.** Every decision kind has exactly one `safe` action; it is the default-focused button, Esc and the close box map to it, and a renderer that is handed anything else refuses the prompt (§3.1). Countdown expiry never turns into a `proceed` unless a policy explicitly says so (consent `proceed`), and the copy then says so before it happens.
- **The native fallback must never** (#10187 class): default to Allow/Yes/Restart; turn a timeout into consent; render operator text on a `breeze`-class kind; show a prompt the agent can no longer act on (a `prompt_close` always wins); or draw a second copy of a prompt already live elsewhere. Each is a unit test on every renderer.
- **What proves "this is your MSP".** The identity header comes only from `prompt_branding_sync`, which comes only from the agent's own server-resolved `promptIdentity`; prompt payloads cannot set it. The name is `partners.name` and cannot be changed by org-level policy writers (#9396). Operator copy can never fill the header, the action semantics or any `breeze`-class kind. Renderers accept prompt messages only over their authenticated IPC session (same channel and HMAC envelope as consent today), and the broker sends a kind only to a session holding that kind's scope (`prompt` for Breeze-owned kinds, `prompt_operator` for kinds that may carry MSP copy — the `consent_ui` / `messaging` split carried forward). A Breeze window never asks for a password: the catalog has no such string, the only password box in any flow is Windows' own UAC, and the docs say so. Residual risk, stated: any local process can draw a lookalike window; the defences are that Breeze never asks for credentials and that every real prompt also appears in the notification list, which a lookalike cannot write to.
- **No secrets in copy.** Server-supplied text that reaches a prompt is limited to the MSP name, the technician name (per identity level), the deny reason (sanitized and capped server-side, #8928) and the operator restart copy (validated on write and again on the agent, `handlers_patch.go:404`). The command line shown on an elevation request is the user's own, captured on the device. No token, URL or internal identifier is rendered; the logo is bytes, never a URL.
- **Rate limits.** Per session: one `modal` at a time (others queue); at most one card per kind per `promptId`; notices de-duplicate by `promptId`; a cap of 10 new cards per 10 min per session, beyond which new notices go list-only. Server-originated kinds keep their existing limits (endpoint messages, consent starts).
- **Agent-shipped code is high blast radius.** Every wave that changes the agent ships behind a server-side gate (§8) and has a real-Windows lab leg before fleet promote.

## 6. Out of scope

- Endpoint messaging and live chat **feature** work (tracked by the endpoint-messaging spec); only the renderer convergence in §3.5.
- The technician-side web UI beyond the renderer/health label and the existing "Reason (shown to the user)" labels from #8928.
- Native visual parity (decision 1): the native fallback gets correct copy, labels and defaults, not Assist's look.
- Widening Assist to non-console Windows sessions or new OSes (§7 OD-9 records the question; the work is a separate security design).
- Logo/icon branding of native or signed assets (tray icon, executable icon) — Phase 2 §11 deferral stands.
- Changing the PAM decision matrix, the consent decision matrix, or the reboot ladder timings beyond §3.3.

## 7. Open Decisions

Only what decisions 1–4 do not already settle. Each has a recommendation; "Quorum" records where the independent review (`codex exec`, GPT-6, xhigh, read-only) disagreed with the author's first position.

**OD-1 — Elevation: staging decision 2.** While UAC owns the secure desktop (the Windows default) Assist cannot be seen, so the first question can only be on Assist after Breeze closes UAC (§3.4).
- (a) **Staged:** W07 ships the Assist states after "Send request" with the first question still drawn natively next to UAC (explicitly degraded); W08 delivers decision 2 in full (dismiss first, ask on Assist) once its prerequisites are built and qualified. Pros: #10178/#10180 fixed on the already-planned dependencies; the risky launch-fidelity work is isolated. Cons: two waves; the first question looks native until W08.
- (b) **Destination only:** skip W07; W08 is the first elevation wave. Pros: one change for users. Cons: #10178/#10180 wait for argument-faithful, requester-bound launch and the relaunch bypass, which do not exist yet.
- (c) **Hybrid permanently:** keep the native first question on the secure desktop for good. Cons: amends decision 2.
- **Recommend (a).** Quorum: the author first proposed (c); the reviewer judged (c) incompatible with decision 2 except as a transitional path and showed that (b)'s launch path drops arguments (`tokenlaunch_windows.go:181-182`) and resolves the session by bare username (`:403-411`). (a) is the resolution on the merits.

**OD-2 — Caller-verify logo source.** The caller-verification card shows `partner_login_branding.logo_url` (the technician login page logo); prompts would show the Settings → Partner → Branding logo with portal org override. (a) Move caller verify onto `resolvePromptIdentity` (one "MSP on a device" concept). (b) Leave it. **Recommend (a)** — two logos for the same MSP on the same device fails "one concept, one home"; it changes which logo appears on the caller-verify card for partners who set both.

**OD-3 — Defaults: postpone budget, countdowns, list retention.**

| Setting | Today | Recommended |
|---|---|---|
| Postpone allowed (`rebootAllowDeferral`) | off unless opted in | keep off; the policy editor previews the user's card |
| Postpone count / interval | 3 × 60 min (cap 10) | keep |
| Consent response window | 30 s (`consentTiming.ts:13`) | keep |
| Elevation first question | 90 s (`pam_flow.go:24`) | keep |
| Elevation waiting | server TTL 15 min (`pamJobs.ts:38`) | keep, shown as a time ("IT has until 14:45") |
| Present budget | — (consent 10 s) | 10 s for all kinds |
| Terminal-state linger | — | 8 s |
| Notification list | — | 7 days, 50 entries per session, fixed (not a policy) |

**Recommend** the right-hand column; no default changes fleet behaviour.

**OD-4 — Who owns the last minute of a restart.** (a) Keep `shutdown /r /t 60`: robust if the agent dies; Windows' own "You're about to be signed out" stays the last thing the user sees, after Breeze's closing card. (b) Agent-owned last minute with `/t 0`: Breeze's card is last, but the code records that this design raced session teardown and the notice "essentially never rendered" (`reboot_plan.go:48-53`), and an agent crash in that minute skips the restart. **Recommend (a)** (author and reviewer agree).

**OD-5 — Can the user end a remote session from the indicator?** (a) No; details and "report a problem" only. (b) Always. (c) Policy `allow_user_end_session` on `config_policy_remote_access_settings` (partner-wide-capable), default on; ending asks for confirmation, is audited `ended_by_user`, and the technician sees why. **Recommend (c)** — it is the user's computer, but MSPs running unattended maintenance in notify mode need to turn it off.

**OD-6 — "Report a problem" on the indicator.** (a) Omit. (b) Opens Assist's existing "Request support" flow pre-filled with the session. (c) New in-session alert to the technician. **Recommend (b)** — no new backend.

**OD-7 — Technician name on elevation outcomes.** (a) MSP name only. (b) Reuse the remote-access `technician_identity_level` (`name_email` / `name` / `generic`). **Recommend (b)** — one identity setting, not a second one for PAM.

**OD-8 — Assist installed by other means (#10185).** (a) The agent marks the installs it makes (ownership marker) and manages only those; an unmarked install is left alone and reported as `helperInstallIssue: unmanaged_install`; turning deploy on adopts it at the next server-offered version. (b) Keep removing it and document that the policy toggle is the only supported way. **Recommend (a).**

**OD-9 — Assist outside the Windows console session (RDP, RDS).** Assist is console-bound because of its cross-user token capability (`broker.go:2819-2824`); a separate presentation-only role would be needed. (a) Native fallback in those sessions for this epic; separate security design later. (b) Include it here. **Recommend (a)** and file the follow-up — it is the biggest remaining gap (every RDP user gets the degraded experience).

**OD-10 — WebView2 runtime too old.** (a) Report it (device badge, docs, script-library remediation) and use the native fallback. (b) The agent installs the Evergreen runtime when policy allows (external download from Microsoft, or a bundled offline installer of ~150 MB). **Recommend (a)** now; revisit if lab or field data show it is common.

**OD-11 — Deploy Assist by default.** Decision 1 makes Assist the required renderer, but the helper policy defaults to `enabled: false` (`helperSettings.ts:84-90`). (a) Keep opt-in. (b) Default on for new partners and newly created helper policies. (c) Default on fleet-wide where no helper policy exists. **Recommend (b)** — (c) silently installs software on every existing customer's machines.

**OD-12 — Wave order.** As §9: standalone fixes now; Assist reliability first; contract dormant; copy and identity; then the lowest-risk kind (notices) before restart, remote support and elevation. **Recommend as listed.** Quorum: the author's first draft had one broad host wave and reliability late; the reviewer split the host into dormant increments and moved reliability first — adopted.

## 8. Test & rollout notes

**Contract and unit (CI).**
- Golden JSON fixtures for every message and kind, decoded and re-encoded by both the Go and the Rust suites.
- Skew matrix per enabled kind: new agent + old Assist (legacy path), old agent + new Assist (Assist never receives `prompt_*`), new + new, new agent + native only, server kind disabled.
- Fencing and replay: stale-lease action → `rejected_stale`; duplicate action; disconnect during a click (no replay of the click); replay after a terminal state (tombstone wins); replay without activation; one restored decision surface.
- Safety: `breeze`-class kind with operator text refused (broker and Assist); a decision without exactly one safe default refused; Esc maps to safe; expiry never maps to proceed unless the policy says so; native renderers default to the safe action (#10187 as a regression test on every OS).
- Ownership: list entries never cross user principals; `scopeId` change purges entries and identity.
- Catalog: key parity and non-empty strings in all eight locales (the web `localeParity` pattern); placeholder sets equal across locales.
- Identity: resolver precedence (partner → portal org override; name never overridden); logo validation (PNG/JPEG/WebP magic, size, dimensions; SVG refused; https fetched only through `ssrfGuard`).
- Restart: Postpone label equals `ComputeDeferral`'s clamped time; every session's card updates on one decision.

**Lab legs (real machines, before fleet promote of each agent wave).**
- Windows 11 current release, standard user and admin: every kind; Focus Assist / DND on (fresh install first hour); lock during a restart rung, unlock; full-screen game and PowerPoint presenting; Narrator and high contrast; 150 % and 200 % scaling, two monitors.
- Windows 11 21H2 image with the inbox WebView2 (90.x): Assist refused with the reported reason, native fallback works, device badge correct.
- UAC: `PromptOnSecureDesktop=1` and `=0`; consent prompt (admin) and credential prompt (standard user); approve, deny, expire, cancel request, use administrator password; technician decision crossing the user's click; approval while the screen is locked.
- RDP into a Windows 11 client; an RDS host with three sessions; fast user switching between two users with prompts pending in both.
- Kill Assist mid-prompt; update Assist mid-prompt; agent update with a prompt open.
- macOS (current and previous release): consent, notices, permissions notice, restart; Focus on; the card over a full-screen app and on another Space.
- Linux GNOME on Wayland and on X11: Assist cards, `zenity` fallback, DND on.

**Rollout.**
- Every agent wave ships dormant: the server's `promptHost.enabledKinds` (empty by default) turns a kind on per environment, and turning it off reverts to the legacy path without a release (§3.1 rule 2).
- Canary org pins for agent waves as usual; clear them at the next promote.
- Legacy removal is its own later change after the fleet floor (§3.1 rule 3).
- Videos to re-take after W05/W06/W07 are enabled: the restart video, the elevation (UAC) video and the remote-support video; W08 needs a second elevation take.

## 9. Proposed waves

Each wave is independently shippable and leaves the device no worse if it stops there. "Agent / Assist / API / Web" is the split; the IPC order is in the last column.

| Wave | Content | Agent | Assist | API | Web/docs | IPC order |
|---|---|---|---|---|---|---|
| **W00 — standalone fixes (now, as issue fixes, no new contract)** | #10187 native Deny default; #10179 immediate `pam_apply_v2` enqueue; #10186 cancel with nothing pending succeeds; #10182 duplicate answer at DEBUG; #10184 one download policy; #10188 / #10189 docs describe today's behaviour | ✓ | | ✓ | docs | none |
| **W01 — Assist reliability** | WebView2 runtime check; exit code + stderr on watcher restarts; `crash_loop` / `webview2_outdated` issue codes and a long-backoff retry; install ownership (OD-8); `promptHost` capability telemetry; renderer label on the device page | ✓ | manifest field | ✓ | label | none |
| **W02 — contract, dormant** | `prompt_*` types, `promptProtocolVersion` + kinds, `prompt` / `prompt_operator` scopes, leases, transitions, tombstones; generalised list store with ownership; replay; Assist host component and list UI behind no enabled kind; native renderer in the user-helper (`TaskDialogIndirect`) and SYSTEM helper; golden fixtures | ✓ | ✓ | `enabledKinds` field (empty) | | Assist and agent in either order; nothing is sent until W04 enables a kind |
| **W03 — copy and identity** | shared catalog in eight locales; `resolvePromptIdentity` (and endpoint-message / caller-verify refactor, OD-2); heartbeat `promptIdentity` + capability; logo endpoint; agent cache + `prompt_branding_sync` | ✓ | ✓ | ✓ | | identity is sent only to agents reporting the capability |
| **W04 — notices (first enabled kind)** | `notice.info` (safe mode, macOS permissions, session ended); endpoint-message card on the shared component and in the one list | ✓ | ✓ | enable kind | | enable only after the W02 Assist build is the offered version |
| **W05 — restart** | `restart.prompt` / `restart.final`; real labels, Postpone default, clamped label, multi-session sync; audit events from `rebootStatus` changes | ✓ | ✓ | audit, enable kind | policy preview | as W04 |
| **W06 — remote support** | `remote.consent` + `remote.session` (clickable, OD-5/6/7); native `TaskDialogIndirect` consent | ✓ | ✓ | `allow_user_end_session` if OD-5 (c) | policy field | as W04 |
| **W07 — elevation, transitional** | states on Assist after "Send request"; kind-aware Approve-time dismiss; server push; catalog copy on the native first question | ✓ | ✓ | enable kind | | after #8971, #8928 PR 1 and #10177 are merged and lab-tested |
| **W08 — elevation, destination** | dismiss first and ask on Assist; argument-faithful, requester-bound launch; self-approve via token launch; local-credentials relaunch bypass | ✓ | ✓ | launch payload | | after W07 and its own lab qualification |
| **W09 — docs and videos** | `features/end-user-experience` page; remote-access, patch-management and PAM pages updated; three videos re-taken | | | | ✓ | — |
| **Later — legacy removal** | delete legacy senders per §3.1 rule 3 | ✓ | | fleet floor | | after the floor holds |

Ordering notes:
- W00 and W01 can start immediately and in parallel; W01 first among the waves because an unreliable Assist makes every later wave degrade silently.
- W02 → W03 → W04 is strict. W05, W06 and W07 can run in parallel after W04.
- The rule from the issue — "Assist renderer must ship before the agent stops sending legacy IPC" — holds by construction: the agent never stops sending legacy to a renderer that did not advertise a kind (§3.1 rule 1), and legacy code is deleted only after the server-enforced fleet floor (rule 3).

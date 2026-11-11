---
title: Wisp on the device — the MSP's tech at every desk, through Breeze Assist
status: approved by Todd 2026-11-07 (r3: builder check, Fable review and Codex quorum folded in)
date: 2026-10-29
builds_on:
  - ai-mcp/2026-10-19-wisp-orchestrator-design.md (Wisp engine; §12 "customer-staff doors" named this follow-on)
  - helper/2026-10-26-on-device-dialogs-design.md (prompt host, copy classes, notification list, restart cards — epic #10190)
  - helper/2026-10-12-endpoint-messaging-and-live-chat-spec.md (message cards, technician live chat)
  - ai-mcp/2026-10-25-ai-surface-cohesion-assessment.md ("Breeze Assist" = the end-user door)
tracking_issue: (register after the plan)
---

# Wisp on the device — design

## 1. Intent

Today an MSP tech keeps computers maintained partly by nagging people. Todd, 2026-10-29: *"I notice a laptop hasn't updated in a month, or an issue comes up that can be solved by updates that haven't been running, and I remind the user to leave their computer on. So it's preventive."* The tech has to notice first, then find the person, then follow up — and most of the time nobody notices until something breaks.

This phase puts Wisp in **Breeze Assist** on each computer so it can do that part of the job for the MSP: watch the device for maintenance that needs the person's cooperation, ask them plainly ("your computer's healthy, but it needs one overnight restart this week — which night works?"), follow up, and hand the problem to a human with a ticket when the person keeps dodging. The same Wisp also becomes the end user's first line of support: troubleshoot, answer questions, point at the MSP's knowledge and reputable articles, apply known fixes, and — when the MSP allows it — take full control to fix the computer, under the same consent dialog and banner a technician's remote session uses.

One agent, a new door. The orchestrator spec built Wisp as "Wisp, for Todd" — an agent working for a technician. This is "Wisp, for Northwind IT, on Dana's laptop" — an agent working for the MSP, talking to the MSP's customer's staff.

### 1.1 What the user sees (the picture Todd confirmed)

- A periodic, short check-in in Assist: *"Your computer's healthy. One thing: it needs an overnight restart this week to finish updates. [Pick a night] [Not this week]"*.
- Picking a night ("Wednesday — I'll leave it plugged in") schedules the work for that night, reminds them at the end of the day, and keeps the computer awake on AC until it is done.
- Dodging gets a follow-up at the next check-in, a little firmer: not more often and never guilt-tripping, but plainer about the facts and the consequence ("updates are now 34 days behind; some security fixes are waiting"). After the MSP's threshold, Wisp stops asking and files a ticket.
- At any time the user can open Assist and talk to the assistant about a problem; it diagnoses, explains, fixes what policy allows, and files a ticket with everything it gathered when it can't.
- The assistant is branded as the MSP ("Northwind IT Assistant"). The word "Wisp" is not shown to end users.

## 2. Goals, non-goals, anti-goals

**Goals**
1. **Preventive care loop.** Wisp detects device maintenance that needs the user (pending restart, updates not installing because the device is never on, disk nearly full, broken backup/OneDrive sync, worn battery…), asks the user, schedules the work around them, and follows up — with no technician involvement until escalation.
2. **One MSP dial for how often Wisp checks in**, and maintenance asks ride along with the check-ins. Escalation to a ticket after an MSP-set number of unanswered or declined asks.
3. **Support chat that is Wisp.** Where the partner is entitled and the policy selects Wisp, Assist's existing chat becomes Wisp: troubleshooting, Q&A, knowledge lookup, known fixes, and full control — each gated by one MSP security dial. Elsewhere the classic Assist chat is unchanged.
4. **Tickets from the device.** The user (or Wisp, on escalation) files a ticket from Assist with the gathered context attached, and sees its status in Assist afterwards.
5. **Requests, outages and "is this legit?"** — software/admin requests go through the existing approval flow; known outages are told to users instead of producing duplicate tickets; users can ask whether an email or pop-up looks suspicious.
6. **Metered separately.** Every model call this door causes is tracked as on-device Wisp usage, per org and per device, and capped (Todd: "we'd want it tracked as on-device Wisp usage at least. We can start with tracking." Pricing is a later decision).

**Non-goals (this phase)**
- Pricing or a separate SKU for on-device Wisp (metering only).
- A new MSP-facing report. The MSP already works from the patch compliance view and tickets; escalation tickets plus a few columns are the report (Todd: "the report wouldn't need to be built for the MSP").
- Portal and Outlook add-in doors (orchestrator §12 names them; they follow this one and must not be made harder).
- Changing patch or restart **policy**. Deadlines, rungs and deferral budgets stay owned by the patch/maintenance policy (on-device dialogs §3.3). Wisp works *in front of* them, getting the work done before a hard deadline forces it.
- RDS / RDP-only users. Assist runs in the console session only today (`agent/internal/sessionbroker/broker.go:1144-1164`), so remote-desktop users get no chat door in this phase, not a degraded one.
- Self-hosted availability (same stance as Wisp, orchestrator §2).
- Voice, mobile, languages beyond the eight shipped locales.

**Anti-goals (would make this a failure even if it works)**
- **Nag fatigue.** Users learning to dismiss Assist, or uninstalling it. One check-in rhythm; asks only when something needs the person; never stealing focus; never during a presentation or meeting; follow-ups never come more often and never shame; escalation goes to the MSP, not louder at the user.
- **A user talking Wisp into anything.** Elevation, software installs, disabling security, reaching another device, reading another user's data. The tool surface is fixed by MSP policy before the conversation starts; nothing said in chat widens it.
- **Model-written text in a decision.** A consent, restart, schedule or fix card whose buttons or consequences were written by the model. Decisions use catalog copy only (dialogs spec copy classes); the model chooses parameters, never wording of the decision.
- **Taking orders from content.** During full control, screenshot analysis or "is this legit?", anything on the screen or in a pasted message is data, never instructions.
- **Self-consent.** Anything the Assist process can do on its own counting as the person's OK (§6.3).
- **Invisible control.** Wisp driving the computer without the same consent and stop-banner a technician gets, or with nobody there.
- **Cross-user leakage** on a shared computer: one person seeing another's thread, asks or tickets.
- **A surprise bill** because one chatty user or a noisy fleet ran the meter, or one desk draining the budget for everyone else.
- **A ghost.** On-device Wisp acting under a departed technician's authority. It has no technician authority at all (§4).

## 3. Shape of the work

Two loops share one thread per person per device:

| | Care loop (proactive) | Support chat (reactive) |
|---|---|---|
| Starts | deterministic evaluator on the worker | the user opens Assist and types |
| Model calls | none to detect, decide or ask; only when the user replies in chat | every turn (metered, capped) |
| User sees | check-in card + decision cards + list entries | the Assist chat window |
| Ends | item resolved, or escalated to a ticket | resolved, or a ticket |
| Gated by | check-in cadence + escalation threshold | the security dial (support tier) |

The care loop is **deliberately model-free** to detect, decide when to ask, and render the ask: at 10 000+ devices a model call per device per check-in is cost and latency nobody needs, and catalog copy is translatable and reviewable. The model enters only when a person talks back.

## 4. Identity and authority (the core security decisions)

### 4.1 Who Wisp acts for here

The orchestrator's delegation ceiling (`wisp_grants`, "Wisp for Todd") does **not** apply on this door. Borrowing a technician's grant would give a device-side chat far more reach than it needs, tie end-user help to one tech's continued employment (the "ghost" anti-goal), and contradict the orchestrator §12 inverse gate (operator authority driving end-user effects).

Instead on-device Wisp runs under a **device-door ceiling** — today's Assist chat authority, made explicit:

```
device-door ceiling = helper policy support tier for this device   (config policy, partner → … → device; re-resolved every message, as today)
                    ∩ device pin (every tool pinned to the Assist's own device; unscoped tools denied, helperToolFilter.ts)
                    ∩ PAM governance for every mutating tool      (org pam_rules / pam_org_config decide; §6.3)
                    ∩ on-device Wisp enabled for this device      (entitlement ∩ partner switch ∩ policy mode)
```

Its authority comes from the MSP's **policy**, written by an MSP admin, not from a person's session. Audit reads *"Northwind IT Assistant on DANA-LT (for DANA-LT\\dana)"*: actor = the device-door AI principal (the existing helper session shape, `ai_sessions.contextSnapshot.source = 'helper'`), stamped with device id and the **attested** OS principal (§4.2). PAM `ai_tool_action` requests today name only the hostname as subject (`pamToolActionGovernance.ts:45-46,145`); they gain the attested OS principal as a subject field so `matchUser` rules and the audit line work.

### 4.2 Who the user is: agent-attested, never self-reported

Today the server has no OS-user principal on this path. `helperAuth` authenticates one device-scoped token (`middleware/helperAuth.ts:189-219`), and the only "user" is `helperUser`, a free-text name typed into Assist's first-run "What's your name?" box (`apps/helper/src/App.tsx:18-21`), stored unverified (`routes/helper/index.ts:274,342`). That cannot carry threads, asks or ticket visibility on a shared computer.

**Decision:** the **agent** (running as SYSTEM/root, already authenticating Assist per IPC session — dialogs spec §3.1 "Ownership") attests the session principal (Windows SID + logon id; Unix uid + session id) and, where the OS knows it, the user's UPN/email (Entra/AD-joined sessions). The server receives it as a credential it can verify — **agent-minted per-(device, principal) helper tokens** pushed over the existing `helper_token_update` IPC path *(my call between the two options the reviews raised; an agent-signed per-request session claim is the alternative; quorum to confirm)*. Consequences:

- `helperUser` becomes a display name only; it is never identity.
- Threads, care asks and list entries are keyed by the attested principal.
- **Token lifecycle** *(Codex)*. Principal tokens are:
  - short-lived;
  - stamped with the device's helper-token generation;
  - revoked when the OS session logs off, a different principal is attested, or the device is re-enrolled or moved.

  Today `helperAuth` looks tokens up device-wide (`middleware/helperAuth.ts:83`), and session access checks only device ownership (`routes/helper/index.ts:147`). **Every** helper chat endpoint must check the principal binding: history, stream, attachments and tool results.

  A tool that runs after a delay (queued, awaiting consent) re-checks the principal, tier and entitlement at execution time.
- **Principal-aware tools on shared computers.** The device pin (`helperToolFilter.ts:148`) stops other *devices*. It does not stop another *person's* data on this device. In the device door:
  - Screenshots and screen analysis capture only the attested principal's session.
  - File and log tools exclude other users' profile paths and per-user logs.
  - A Diagnostics-tier read on a multi-session host is limited to machine-wide facts.

**Two layers (Todd, 2026-10-30: "exactly").**

| Layer | How it is proven | What it unlocks |
|---|---|---|
| **Device floor** — no sign-in | agent-attested OS principal (above) | check-ins and care asks; chat about *this* computer at the policy's tier; tickets it created from this device |
| **Signed-in customer user** — SSO | Microsoft Entra sign-in in Assist, binding to the **same** `portal_users` Entra identity the AI-for-Office door already uses (`schema/portal.ts:120-125`, unique on `(entra_tenant_id, entra_oid)`) | "my tickets" across all their devices; ticket requester; software/admin requests (§6.7); one identity shared with the portal and the Office add-in |

- **Silent where the OS allows.** On Entra-joined/registered Windows, Assist obtains the token for the signed-in work account through Web Account Manager with no prompt; on macOS through Microsoft's Platform SSO / Enterprise SSO extension when the MSP has deployed it, otherwise one interactive sign-in. Non-Microsoft identity providers are a follow-on.
- **Binding is strict.** The Entra identity must resolve to an **active** `portal_users` row in **this device's org**, at its current `authEpoch` (a password reset or a revoke invalidates it). Never match on email or UPN alone.
- **Both layers must agree.** A sign-in binds to the attested OS principal it happened in; it is dropped when that session ends or a different principal is attested, so a signed-in identity is never reachable from another person's session on a shared computer. The SSO token is held by the agent's per-principal credential store, not by Assist alone.
- **No sign-in, no person-scoped data.** An unsigned principal sees only tickets it created from this device; requests and cross-device ticket history ask the user to sign in (catalog copy). A typed name never maps to a contact. A technician may still map an OS principal to a contact by hand for devices without Entra.
- Escalation tickets (§5.4) use the signed-in user as requester when one is bound, otherwise none.

This realises orchestrator §12's `client_user` door with one addition: the device floor lets Wisp help before anyone signs in, but nothing person-scoped is reachable without the SSO layer. *(Quorum item Q1.)*

### 4.3 The two-door rule

- Technician-side Wisp (assessments, grants) still **cannot message devices**: `send_endpoint_message` stays on the agent deny list (`aiToolExposure.ts:54-57`), unchanged. Technician Wisp learns about device asks only through concerns and tickets (§5.4).
- Device-side Wisp has **no technician tools**: no fleet reads, no other devices, no tickets except its principal's (§4.2), no memory beyond its own thread and the end-user-audience knowledge of §6.5; it never writes shared Wisp memory.
- **The reverse channel is untrusted.** Ticket bodies, concern notes and attachments produced by the device door contain end-user and model text that technician Wisp will later read with real authority. They are stamped `origin: device_door` and wrapped with `wrapUntrustedData` / `UNTRUSTED_TOOL_OUTPUT_RULE` whenever technician-side AI reads them.
  - `origin` is **server-owned**: set from the authenticated door, never from request bodies. It is kept through ticket comments, attachments, summaries and anything later derived from them.
  - Wrapping is advice to the model, **not an authorization boundary** *(Codex)*. Device-door text, however poisoned, cannot by construction:
    - widen a grant;
    - confirm or publish a memory block (that is a human action, §6.5);
    - satisfy a PAM approval.
- Neither door can drive the other. A care ask is produced by deterministic code from device state and policy, not by any model's tool call.

## 5. The care loop

### 5.1 Care items

A **care item** is one thing on one device that needs the user: `pending_restart`, `updates_stalled` (patches approved but not installed for N days because the device was off or asleep at the window), `disk_nearly_full`, `backup_stale` / `onedrive_sync_broken`, `battery_worn`, `mfa_not_enrolled` and `password_expiring` (only when an identity integration provides the fact), plus a code-owned registry for more. Each kind declares: detector, evidence, the user-side action (schedule a night, restart now, free space with help, sign in to OneDrive, contact IT…), whether it is schedulable, its escalation default, and its catalog copy keys.

Table `device_care_items` *(name is the builder's)*: `org_id`, `device_id`, `kind`, `status` (`open` · `asked` · `scheduled` · `resolved` · `escalated` · `suppressed`), `evidence` jsonb (handles, not prose), `first_seen_at`, `asks_count`, `declines_count`, `unanswered_count`, `last_asked_at`, `next_eligible_ask_at`, `scheduled_for`, `resolved_at`, `escalation_ticket_id`. One **live** row per (device, kind[, principal]), where live means any status except `resolved` and `suppressed`; `scheduled` and `escalated` count as live.

Tenancy and registration:
- Shape 5 with denormalized `org_id`.
- Forced RLS and same-org composite FKs.
- Full cascade / merge / export registration per `docs/agents/tenancy-rls.md`.
- `evidence` is `excludedOpen`.

Most kinds are **device-level**: the restart is the device's, and any signed-in person may answer it. Kinds about a *person* (`mfa_not_enrolled`, `password_expiring`, `onedrive_sync_broken`) carry the principal and are only ever shown to that principal *(Codex)*.

**Device move to another org** *(Codex; my call)*: care items are dropped and re-detected under the new org. Device threads (§6.1) and their ticket links **are not restamped**. They close and stay with the source org, like `fix_outcomes`, so one customer's conversations never become another customer's history.

Detection is a deterministic worker job (hourly sweep plus heartbeat-triggered re-evaluation of the device that just reported), never a model call. Resolution is detected the same way (the restart happened; the patches installed).

### 5.2 Signals that must exist first

| Signal | Today | Needed |
|---|---|---|
| Pending restart | Windows registry, Linux; **macOS stub always false** (`agent/internal/patching/reboot_detect_other.go`) | macOS detection (`softwareupdate` restart-required, pending install receipts) |
| Laptop vs desktop | the agent reads SMBIOS chassis type (Windows/Linux, `collectors/classify_*.go`) and model name (macOS has no chassis type) only to classify workstation/server; **nothing stored** | persist a portable flag on `devices` (export-policy classification) |
| On AC power | `battery_status.pluggedIn` | — |
| Last patch install / scan / pending reboot | patch compliance (`routes/patches/compliance.ts:154,379-391`) | — |
| Missed window because off | partly inferable from offline gaps vs patch schedule | explicit "window missed: device offline/asleep" fact from the patch job |
| When the user usually stops work | boot metrics, heartbeat online gaps, session events | a per-device **usage profile** (typical last-active time per weekday), derived deterministically; cold start = 08:00–18:00 local on weekdays until 14 days of data |
| Presentation / meeting | Windows `SHQueryUserNotificationState` (dialogs spec §3.2) | camera/mic-in-use where the OS exposes it (builder's per-OS choice) |

### 5.3 Check-ins and asks

- **Check-in cadence** (MSP dial, §8): `off` · `monthly` · `every two weeks` · `weekly`. A check-in is one `care.checkin` card + list entry summarising the computer's state in catalog copy, with any open asks attached. Below `weekly`, a check-in with nothing to ask is skipped *(my call: "healthy, nothing to do" is only worth saying occasionally)*.
- **Asks ride along**: open care items surface at the next check-in, not on their own schedule. One exception: an item whose patch/restart policy deadline falls before the next check-in is asked early, once, so the user gets to choose before the policy forces it.
- **Schedulable asks** use `care.schedule` (Breeze copy class): the server proposes up to three slots from the usage profile, the device's patch schedule and **never later than the policy deadline** ("tonight after 6", "Wednesday night", "Thursday night"), plus `not_this_week` (the safe default) and `talk_to_assistant` (opens the chat). Only typed parameters (times, counts) are server-supplied; all wording is catalog.
- **What runs on the chosen night** *(corrected: maintenance windows only suppress work, they never run it — `schema/maintenance.ts:53,80-93`)*:
  1. a **one-off patch job** for this device with `scheduledAt` = the slot, through the existing patch job path (`routes/patches.ts` `scheduledAt`);
  2. the pending restart **re-planned to the slot** through the existing reboot plan (`schedule_reboot`, new `reboot_source = user_scheduled`). Accepting a night **does not consume a deferral**; it moves the restart earlier-or-equal to the deadline, and the policy's pre-slot rungs are suppressed until the slot;
  3. a `care.reminder` card at the user's usual stop time ("Leave DANA-LT plugged in and open tonight");
  4. a new agent command `keep_awake_until(slot_end)` honoured only on AC (Windows power request / execution state, macOS `caffeinate` + `pmset` scheduled wake, Linux `systemd-inhibit`), plus wake-on-LAN through a site relay where one exists;
  5. the outcome in the list ("Updated and restarted overnight · 03:12").
- **A failed night is never the user's fault.** Lid closed, unplugged, network down: the item goes back to `open`, the counters do not move, and the next check-in says "it didn't finish last night — that's on us, want to try another night?". Execution-state requests do not override lid-close sleep; the reminder copy says "plugged in and open".
- **One restart asker at a time.** An active policy `restart.prompt` rung suppresses care asks about the same restart; an accepted night suppresses the policy rungs until the slot; Windows' own final box (dialogs OD-4) is unchanged.
- **Respect rules**: never `steal` focus; never present during full-screen/presentation or detected meetings (deferred until it ends); never in the first 15 minutes after sign-in; never outside the usage-profile working hours; locked session → list entry only.
- **Counting toward escalation.** Only an explicit `not_this_week` counts as a decline. An ask counts as unanswered only if it reached the dialogs spec's **visible-eligible** stage (§3.2) and the next check-in arrives with no action; Esc/close of the card is "not now" and counts as unanswered at most once per check-in. Because asks ride on check-ins, reaching the default threshold needs three separate check-in cycles — a day of accidental dismissals can never escalate.
- **Following up**: the next ask uses the firmer catalog variant (§1.1) — facts and consequence, no guilt, never more often than the cadence.

### 5.4 Escalation

When `declines_count + unanswered_count` reaches the MSP threshold (default 3), or a kind-specific hard limit passes (e.g. updates 45 days behind), Wisp:
1. stops asking about that item (status `escalated`),
2. files **one** ticket (source `ai`, `device_id` set, requester = mapped contact or none, `origin: device_door`) with the care item's history and evidence — deduplicated: an open escalation ticket for the same item is updated, not duplicated,
3. raises/updates a `wisp_concerns` row (subject `device`) when the org has technician Wisp, so it appears in the tech's brief instead of only in the queue,
4. tells the user once, in catalog copy: "We've passed this to Northwind IT; someone will be in touch."

The MSP sees escalations in their normal ticket queue. The patch compliance view gains a "care" column (open/escalated asks); the builder checks the compliance CSV export and adds the reboot fields if they are missing there (the compliance query already has `pendingReboot`).

## 6. Support chat

### 6.1 Assist chat becomes Wisp (when entitled and selected)

Assist already has an AI chat (`ai_sessions` per device, 24 h sessions, tiered tools, PAM for mutations, org AI budget reservation and `maxTurnsPerSession` already applied — `routes/helper/index.ts:323-335,438-479`, `services/helperAiAgent.ts`). Where on-device Wisp is enabled (§8), this phase:
- gives it the Wisp persona and system prompt under the MSP's name, with the device's care state and the principal's open tickets as context;
- puts a durable **device thread** above the bounded sessions — one per (device, attested principal), in its own table (`wisp_threads` is grant-keyed with a unique grant, `schema/wispThreads.ts:41-56`, so it cannot be reused) — holding a running summary, the care items' history and ticket links, so Tuesday's conversation knows Monday's (mirrors orchestrator §6; tenancy shape 5);
- shows check-ins, asks and their outcomes in the same thread, so "why do you keep asking me to restart?" has an answer in context;
- moves its spend into the on-device budget namespace and caps (§9).

Partners without the entitlement, or a policy left on `classic`, keep today's Assist chat unchanged.

### 6.2 The security dial (support tier)

One MSP dial, extending today's Assist `permissionLevel` (helper configuration policy) rather than adding a second setting. Wisp mode **keeps every tool today's levels grant** — nothing is silently removed from existing policies — and adds one level below and the recipe catalog:

| Tier | What Wisp may do on this device | Stored value |
|---|---|---|
| **Advice** *(new)* | answer, explain, cite knowledge and articles; read only the device facts Assist already shows the user | `advice` |
| **Diagnostics** | + today's `basic` tools (health, disk, logs, screenshot/analyze screen) | `basic` |
| **Fixes** | + today's `standard` tools (PAM-governed as today) + **known-fix recipes** with the user's OK (§6.3) | `standard` |
| **Full control** | + today's `extended` tools, with `computer_control` and `execute_command` under the remote-session consent (§6.4) | `extended` |

Today's default when no policy sets a level is `basic` on the chat path (`routes/helper/index.ts:66`; `helperPermissions.ts:14` names a different fallback — the builder reconciles them and states the default in the policy tab). The level stays re-resolved on every message, as today.

### 6.3 Known fixes and the user's OK

Today every mutating Assist tool becomes a PAM elevation request decided by an MSP admin; the end user's own approve route was **removed on purpose** (`routes/helper/helperApprove.removed.test.ts`) because whatever holds the helper token could approve itself. This phase adds a narrow, differently-proven path; it does not bring that route back.

- **Fix recipes** are code-owned (like Operator recipes): name, typed params, OS, the exact effect, reversibility, catalog copy for the fix card. Examples: restart print spooler, clear temp/caches, flush DNS, restart OneDrive, reset network adapter, repair Office. The model picks a recipe and parameters; it cannot compose an arbitrary command through a recipe.
- **New PAM verdict `user_consent`**, alongside today's `auto_approve` / `auto_deny` / `require_approval` / `ignore` (`schema/pam.ts:31-36`). PAM rules are org-scoped (`pam.ts:189`), so the recipe default is a **code default per recipe** (`user_consent`) applied when no org rule matches. Precedence: an org rule matching the recipe wins; with no matching rule, an org whose `pam_org_config.default_unmatched_verdict` is `auto_deny` keeps denying (the MSP chose that deliberately; the policy tab warns that Fixes needs a PAM rule there); otherwise the recipe default applies.
- **How consent is proven.** `user_consent` is satisfied **only** by a `prompt_action` on a `fix.confirm` card that the **agent** relays over the agent channel. That action is bound to a **single-use challenge** the server issued for this execution, covering:
  - the execution id;
  - the recipe id, version and a digest of its parameters;
  - the device and its helper-token generation;
  - the attested principal and session;
  - an expiry of two minutes.

  It is **never** satisfied by anything sent with the helper HTTP token, so a stolen token alone cannot approve anything.
- **What this does and does not prove** *(Codex DISAGREE, resolved on the merits)*. Assist renders the card and holds the lease (`agent/internal/prompthost/host.go:483,860`), and it runs as the user. Code running as the user can therefore produce the same action the user would. `user_consent` proves "this person's desktop session agreed", which is equivalent to the user doing it themselves, nothing stronger. So:
  - Each recipe declares a **risk class**. `user_consent` is the code default only for **`low`** recipes: fixed effect, fixed or enumerated parameters, reversible, no data loss, no security, account or network-exposure change (spooler restart, flush DNS, clear temp, restart OneDrive).
  - Every other recipe defaults to `require_approval`, as today.
  - The removed route let the helper approve **any** pending mutation. This path can reach only `low` catalog recipes.
  - Per-device rate limit on consent-approved recipes, so even a hostile session gets only a few printer restarts.
  - An isolated consent path (input Assist cannot synthesize, e.g. a secure-desktop prompt) is a follow-on. When it exists, higher risk classes may use `user_consent`.
- The fix card is Breeze copy class: catalog text naming the effect ("Restart the printing service. Anything printing now will need to be sent again."), `run_fix` (proceed) / `cancel` (safe, default). A timeout is never consent.

### 6.4 Full control

At the **Full control** tier, the first `computer_control` or `execute_command` in a session goes through the **same** `remote.consent` / `remote.session` kinds a technician's session uses (Todd: "same as the tech session. We'd use the same dialogs, because why make two"), with the identity line naming the assistant instead of a technician ("Northwind IT Assistant wants to work on your computer"), the stop button, and the session indicator for the whole duration. Differences from a technician session, all fixed in code:

- **Timeout and no-one-there always deny.** The AI door ignores `consent_unavailable_behavior` (which can be `proceed` for technicians, `promptkinds/remote.go:180`, `consent_gate.go:267`). No visible-eligible, explicit `allow` → no control.
- Consent is proven the same way as §6.3 (agent-relayed `prompt_action`), never via the helper token.
- It creates a `remote_sessions` row (kind `ai`) so it shows in session history and counts toward occupancy; `end_session` stops it immediately and removes control tools for the rest of that chat session.
- **The stop control is always on** for the AI door. It ignores `AllowUserEndSession = false` (`promptkinds/remote.go:274`). The session also ends on any of:
  - screen lock;
  - OS session change;
  - a different principal being attested;
  - loss of the control channel.
- **Technician approval stays on by default** *(Codex; changes r2)*. Unrestricted GUI control can type into a shell or answer a UAC prompt, so the user's click alone would amount to self-elevation. Defaults:
  - `execute_command` → `require_approval`.
  - `computer_control` → `require_approval` until the agent ships an **AI-door actuator**, then `user_consent`. The actuator confines input to the attested user's own desktop at the user's own privilege: no secure desktop, UAC or credential UI, no Winlogon, no input while locked. It must be enforced in the agent, not by the model, and pass a lab leg per OS.
  - The user still sees the same `remote.consent` dialog in both cases. The technician's approval is an extra gate, not a replacement.
- Everything seen on screen is wrapped as untrusted tool output; Wisp never follows instructions found on screen, never types credentials, and never acts on a UAC/credential prompt (dialogs rule "a Breeze window never asks for a password" extends to the assistant).

### 6.5 Knowledge and articles

Todd: "knowledge is what the AI learns and saves", plus documents the MSP uploads to existing storage. So the MSP's knowledge has two sources, both already in Breeze. No outside integration (IT Glue, Hudu) in this phase.

- **What Wisp has learned**: Wisp memory (`ai_memory_blocks`, `schema/aiMemoryBlocks.ts`). The device door reads only blocks that are:
  - org-owned (this device's org) or partner-owned
  - `confirmed`
  - marked with a new **`audience = end_users`**

  The new column defaults to `technicians`. Technician memory holds things a customer must not read ("this user is difficult", internal workarounds, account names), so nothing is shared by default. Sharing is explicit:
  - A technician flips a block to end users in the memory UI.
  - Or technician-side Wisp proposes `end_users` when it saves a block. That proposal only takes effect when a human confirms the block, which is the existing confirm gate.

  The device-door query is its **own strict predicate**, not the technician recall. Technician recall returns unconfirmed blocks too, only ranking confirmed ones first (`services/wisp/memoryBroker.ts:169-174`). The device-door predicate requires all of:
  - same tenant;
  - org- or partner-owned;
  - `status = confirmed`;
  - `audience = end_users`;
  - not superseded.

  It projects only a user-facing summary field. **Publishing to end users is its own human action** that approves the current content revision *and* the audience together. Today's confirm returns an already-confirmed block unchanged (`memoryService.ts:140`), so it cannot double as publish. Any later edit to the content resets the audience to `technicians`. *(Codex.)*

  User-owned blocks (a technician's own preferences) are never readable from the device door. A `work_summary` or `concern_outcome` block is shareable only as its user-facing summary field, never its evidence pointers. The device door **never writes** shared memory in this phase. What the user tells it stays in the device thread and in tickets. Technician Wisp can learn from those through the untrusted reverse channel (§4.3), and a human confirms anything worth keeping. *(My call: otherwise any end user could plant "facts" that technician AI would later act on.)*
- **Documents the MSP uploaded**: the org document library (`org_documents`, `schema/orgDocuments.ts`). The device door reads exactly the set the customer portal already shows: `portal_visible`, not deleted, this org. It reuses `services/portal/documentsReadModel.ts` so there is one definition of "customer-visible", including its visible-version selection (`:45`).
  - Every retrieval re-checks visibility.
  - Extracted text is invalidated when a document is hidden, deleted or superseded.
  - **Sign-in required** *(Codex; my call)*. The portal read model assumes an authenticated customer, so documents *and* published memory need the SSO layer, or a technician's manual principal→contact mapping (§4.2). At the device floor, Wisp still has the allowlisted articles and the device's own facts. The library is org-scoped only. Partner-wide end-user documents (a "how to reach us" sheet for every customer) are left to the builder: either a partner-level library or per-org copies. Documents are stored as bytes, so the builder adds text extraction and search for the assistant to cite them.
- **Tool plumbing**: Assist's client-declared tools today *replace* the device toolset rather than join it (`routes/helper/index.ts:248-250`). The builder merges the two tool sources.
- **External articles**: lookup restricted to an allowlist of vendor support domains (Microsoft Support/Learn, Apple Support, Google Workspace help, the MSP's own domains), cited with the host always visible (endpoint-messaging link rule). No general web browsing.

### 6.6 Tickets from Assist

- `create_ticket` (device-door tool, available when tickets are enabled for the org): Wisp drafts subject, description and category from the conversation; the user sees a `ticket.confirm` card with the summary and "Send to Northwind IT" / "Edit" / "Cancel". Attachments: the conversation summary, Wisp's diagnostic findings, and screenshots the user consented to. Source `ai`, `device_id` set, requester = the signed-in user (§4.2) or none, `origin: device_door`. Filing works without sign-in.
- **Ticket status in Assist**: a Tickets tab lists tickets this principal created from this device, plus — when signed in — every ticket whose requester is that user, with status, assignee and last update; a list entry appears when status changes or a technician replies; replies from Assist append a comment. Never the org's queue.
- **Ticket visibility** *(Codex)*:
  - "My tickets" follows the canonical `requesterContactId` of the bound portal user (`schema/portal.ts:180`), not the login itself.
  - Assist shows only public comments and customer-visible attachments, enforced independently of the ticket query (`portal.ts:325`). Internal notes never reach the device.
- Portal tickets gain attachment upload while we're here *(builder may split this out if it grows)*.

### 6.7 Requests

"I need Adobe" or "I need admin rights to install this" never runs anything. Wisp collects what is needed and files it through the **existing** routes: an elevation request (PAM, technician decides) for "run this installer as admin", or a ticket of type request for software the MSP provisions. Wisp tells the user plainly that a person at the MSP decides.

### 6.8 Known outages

Before troubleshooting connectivity, email or line-of-business problems and before filing a ticket, Wisp checks the org's open incidents for the device's org/site (connection-health incidents, anomaly incidents, and technician-marked **known issues** — a flag a tech sets on an open ticket or incident with a one-line user-facing note). If one matches, it says so ("Northwind IT knows the internet is down at the Main St office and is working on it") and offers to notify the user when it is resolved instead of opening a new ticket. Subscribing makes the user a notification recipient only. It **never grants access** to the incident's internal ticket, comments or attachments *(Codex)*. This lookup is org-scoped, so it is an **explicit exception to the device pin** (`HELPER_TOOL_SCOPING`, `helperToolFilter.ts:112-159`) with a strict projection — the user-facing note, site and status only — and its own test.

### 6.9 "Is this legit?"

The user pastes text, drops a screenshot, or forwards an `.eml`. A phishing message can carry instructions aimed at the assistant, so:
- **Code does the facts first**: header authentication results (SPF/DKIM/DMARC), sender vs reply-to, link host extraction and lookalike-domain checks, attachment types. No link is opened or fetched.
- The model sees the content wrapped as untrusted plus those facts, and returns a **structured verdict** (`looks_suspicious` · `no_red_flags_found` · `cant_tell`) with reasons; the copy never says an item is safe ("no red flags found — here's what to check before you click").
- A `looks_suspicious` verdict offers to file a security ticket with the artifact attached so the MSP can act tenant-wide.

## 7. Delivery surfaces

- New prompt kinds, all Breeze copy class, eight locales, safe defaults, never a free server string in a slot, each behind its own `promptHost.enabledKinds` kill switch (dialogs rule 2): `care.checkin`, `care.schedule`, `care.reminder`, `fix.confirm`, `ticket.confirm`. The persistent notification list (dialogs §3.2) holds asks, outcomes and ticket updates.
- The device **thread** (chat window) is where model-written text lives. The model never writes into a card.
- No Assist in the session: asks degrade to the native fallback for `care.schedule` only (other kinds wait in the list), per the dialogs spec renderer order.
- Branding: the assistant's display name is "{partner name} Assistant", from the server-resolved `promptIdentity` the dialogs use (an org-level policy writer cannot rename it). A custom display name is a partner branding field *(builder may defer)*.

## 8. Settings (Rule 9)

| Concept | Home | Level | Resolver | Places configured before → after |
|---|---|---|---|---|
| On-device assistant mode (`classic` / `wisp`) | Helper configuration policy (`HelperTab`) | partner → org → site → group → device | `resolveHelperPermissionLevelForDevice` family | 0 → 1 |
| Support tier (security dial) | Helper configuration policy | same | same | 1 → 1 (gains `advice`) |
| Check-in cadence | Helper configuration policy | same | same | 0 → 1 |
| Escalation threshold | Helper configuration policy | same | same | 0 → 1 |
| On-device spend caps (org daily/monthly, per-device daily) | AI budgets (`ai_budgets` + partner `settings.aiBudgets`, resolved by `effectiveSettings.ts`; a present partner value wins) | org row, partner over it | existing AI budget resolver | 0 → 1 |
| Fix-recipe PAM overrides | PAM rules (existing) | org | PAM evaluator | 1 → 1 |
| Commercial entitlement | Partner Entitlements (`wisp` key) | partner | `requireEntitlement` | 1 → 1 |
| Governance switch | Wisp partner settings (existing switch also governs this door) | partner | existing | 1 → 1 |

Todd framed cadence as "an AI/Wisp setting"; it lives in the helper policy because that is where the device-level AI dial already lives, and the policy resolves down to device groups (e.g. a quieter cadence for executives). The policy tab labels the section "Wisp on this device". *(Confirmed by Todd, 2026-10-30.)*

The memory `audience` flag (§6.5) is a property of each memory block, not a setting, so it adds nothing to this table.

## 9. Cost and metering

- **Separate namespace with its own allowance** *(corrected by Codex)*. On-device spend reserves against a new `device` budget namespace (precedent: the Office add-in's `client` namespace, `schema/clientAi.ts:43-57`).
  - A namespace alone is not enough. Today every namespace still shares one **global org cap** (`schema/ai.ts:273-277`), so a `client`-style sub-cap would still let desks eat technicians' headroom.
  - The `device` namespace therefore gets an **independent allowance**: technician admission does not count device spend, and device admission checks only the device caps. Total spend still lands in the org's usage for reporting and billing.
  - Reservation is atomic across the org and device caps. It covers concurrent calls, retries, thread summarisation and screenshot analysis.
- **Precedence** follows today's resolver: platform defaults, then the org's `ai_budgets` row, then the partner's `settings.aiBudgets`, where a partner value that is present **wins** (`services/effectiveSettings.ts:194-199`). It is not "org override".
- **Per-device metering is new storage.** `ai_cost_usage` is keyed by (org, period) only (`schema/ai.ts:4-21`); per-device breakdown needs a bucket table keyed (org, device, period) feeding the AI usage page. No pricing change.
- **Caps**: per-org daily and monthly on-device caps plus a **per-device daily cap**, so one device (today allowed 30 messages / 60 s) cannot drain the org's cap and silence every other desk. Defaults set per plan by the builder; partner-editable. When a cap is hit, chat answers in catalog copy ("I can't look into this right now — want me to send it to Northwind IT?") and `create_ticket` still works **without model admission**: the ticket is filed from a deterministic form (subject, the user's own words, device facts). The care loop is unaffected (no model calls).

## 10. Retention and erasure

Device threads, their messages and screenshots captured under diagnostics or full control are end-user personal data. They follow `ai_sessions` retention with an on-device default the builder sets (proposed 90 days for screenshots, thread summaries until the device or principal is removed), are deleted with the device and org cascades, and are covered by tenant export/erasure (EU tenants). Full-control screenshots are never used to train or persisted beyond the session's evidence needs.

## 11. Platform matrix

| | Windows | macOS | Linux |
|---|---|---|---|
| Care detection | full | needs pending-restart detection (§5.2); portable via model name | pending restart via existing detector; others best-effort |
| Keep awake / wake | power request + WoL | `caffeinate` + `pmset` scheduled wake + WoL | `systemd-inhibit`; WoL |
| Presentation/meeting quiet | `SHQueryUserNotificationState` + camera/mic in use | camera/mic in use where TCC allows; else never-steal-focus only | never-steal-focus only |
| Full control | yes | yes (existing TCC prerequisites) | as remote access supports today |
| Console session only | yes | yes | yes |

Windows is the first lab target; macOS follows in the same phase.

## 12. Dependencies, sequencing and waves

- **On-device dialogs epic #10190** must be enabled (W09 #10223) — this phase's cards are prompt-host kinds.
- **Wisp engine** first launch, the 10-28 prod-review fixes (#10383–#10418, epic #10425) and the working-set feature #10364 — per Todd's 10-25 rule, registered features with open waves finish before this one starts building. Writing and approving this spec now is fine; implementation queues behind them.
- **Partner Entitlements W1** (already a Wisp prerequisite).
- §6.5 knowledge needs no connector or integration. It builds on Wisp memory (feature #9906) and the org document library (#5573).

| Wave | Content |
|---|---|
| W01 Identity & foundations | agent-attested principal + per-principal helper tokens; PAM subject field; helper policy fields (mode, `advice`, cadence, threshold) + tab; `device` budget namespace, caps, per-device usage buckets; device thread table; portable flag; macOS pending-restart detection; Wisp persona in Assist |
| W02 Care engine | care registry + table + evaluator (pending restart, updates stalled, disk); usage profile; `care.*` kinds; slot → one-off patch job + `user_scheduled` reboot + `keep_awake_until` + WoL; suppression rules; escalation ticket + concern; compliance care column |
| W03 SSO & tickets in Assist | Entra sign-in in Assist (WAM silent on Windows, Platform SSO / interactive on macOS) bound to `portal_users` + the attested principal; `create_ticket` + `ticket.confirm`; attachments; Tickets tab, status entries, replies; manual principal → contact mapping; portal attachment upload |
| W04 Support depth | recipe catalog with risk classes + `fix.confirm` + PAM `user_consent` with challenge-bound, agent-relayed consent; full control via `remote.*` with AI-door rules (technician approval default; the user-privilege actuator may split into its own wave); article allowlist; MSP knowledge (memory `audience` column + share control + proposal on save; portal-visible documents with text extraction; merged tool sources) |
| W05 Awareness & requests | known-issue flag + outage lookup exception; requests via elevation/ticket; "is this legit?" pipeline; care kinds backup/OneDrive, battery, MFA/password (integration-gated) |
| W06 Docs & rollout | end-user and MSP docs, lab legs per OS, per-kind kill switches, default-on per plan |

## 13. Questions answered by Todd (2026-10-30)

1. **Knowledge**: what Wisp learns and saves, plus documents uploaded to existing storage → §6.5 (Wisp memory with an end-user audience flag, and portal-visible org documents). No outside KB integration in this phase.
2. **Cadence home**: the helper policy, as recommended → §8.

## 14. Calls I made (glance at these while reading)

- Device-door ceiling from MSP policy, not a technician grant (§4.1).
- Agent-attested identity via per-principal helper tokens; typed name is display only (§4.2).
- Layered identity confirmed by Todd: device floor with no sign-in, Entra SSO (same identity as the Office add-in) for anything person-scoped; SSO bound to the OS session it happened in (§4.2).
- `send_endpoint_message` stays denied to technician Wisp; device-door text is untrusted on the way back (§4.3).
- Care loop is model-free (§3); care items are per device, not per person (§5.1).
- Check-ins below weekly skip "nothing to do" (§5.3).
- Accepting a night does not consume a deferral and never goes past the deadline; failed nights don't count against the user (§5.3).
- Escalation default 3, counting only explicit declines and visible-but-unanswered asks across separate check-ins (§5.3–5.4).
- Wisp mode keeps all of today's tier tools; adds `advice` and recipes (§6.2).
- PAM `user_consent` proven only by agent-relayed card actions; `auto_deny` orgs keep denying (§6.3).
- `user_consent` only for `low`-risk recipes, bound to a single-use challenge; anything riskier keeps technician approval (§6.3).
- Full control: timeout always denies; stop control always on. Technician approval **plus** the user's consent by default, until an agent-enforced user-privilege actuator ships; then the user's consent alone (§6.4). **This changes r2. Todd to glance.**
- Device move: threads and ticket links stay with the old org; care items are re-detected (§5.1).
- Org knowledge (documents and published memory) needs sign-in; the device floor gets articles and device facts (§6.5).
- Separate `device` budget namespace with per-device cap (§9).
- Learned knowledge reaches end users only per block, by a human-confirmed `audience = end_users`. The default is technicians-only. The device door never writes shared memory (§6.5).
- Uploaded documents: "customer-visible" means exactly what the portal shows (`portal_visible`); there is no second flag (§6.5).

## 15. Review record

- **Builder check** (fresh general-purpose reviewer, 2026-10-29): six questions — identity (→ §4.2), tier reshape (→ §6.2 keeps today's tools), what runs the chosen night (→ §5.3), full-control consent (→ §6.4), budget home (→ §9 namespace), quorum items surfaced (→ §14) — and five factual corrections (PAM verdict names, existing budget reservation and max-turns, maintenance occurrences only suppress, no per-device cost dimension), all folded in.
- **Fable review** (claude-fable-5-1, 2026-10-30): DISAGREE on self-reported identity (→ §4.2), critical self-consent hole (→ §6.3 agent-relayed consent), reverse-channel untrusted text (→ §4.3), scheduling mechanism (→ §5.3), full-control timeout (→ §6.4), per-device cap (→ §9), "firmer" vs anti-goal and Esc-as-decline (→ §1.1, §5.3), three restart askers (→ §5.3), lid-close (→ §5.3), outage lookup vs device pin (→ §6.8), "is this legit?" injection (→ §6.9), client tools replace device tools (→ §6.5), thread table (→ §6.1), console-only Assist (→ §2), retention (→ §10), per-kind kill switches (→ §7). Its chassis claim was checked and partly wrong (the agent reads chassis type for classification but does not store it).
- **Codex quorum** (gpt-6-astra, xhigh, read-only, 2026-10-30). I checked its cited claims against the code and they held.

  | Item | Verdict | Folded into |
  |---|---|---|
  | Q1 identity and ceiling | agree with changes | §4.2 token lifecycle, endpoint binding, strict Entra binding, principal-aware tools |
  | Q2 two doors | agree | §4.3 server-owned origin; wrapping is not authorization |
  | Q3 consent | **disagree**: a compromised Assist can synthesize `prompt_action` | §6.3 single-use challenge + `low` risk class + rate limit; §6.4 technician approval kept for full control until the actuator ships, forced stop, end on lock/session change |
  | Q4 tables | agree with changes | §5.1 live-row uniqueness, per-principal kinds, device-move disposition |
  | Q5 settings and cost | agree with changes; two factual corrections | §8 and §9: partner wins; global org cap means an independent allowance is needed; deterministic ticket fallback |
  | Q6 knowledge | agree with changes | §6.5 strict predicate, publish as its own action, version and visibility re-checks, sign-in required |
  | Extras | — | §6.6 ticket visibility by `requesterContactId` and public-only comments; §6.8 outage subscription grants no access |

## 16. Left to the builder

Table and column names; care kinds beyond the first three; usage-profile algorithm beyond the cold-start default; slot computation details; the fix recipe list beyond the examples; check-in copy (catalog, eight locales); thread summary format; default caps per plan; screenshot retention value; whether the per-principal token or a signed claim is cheaper if the quorum prefers the latter.

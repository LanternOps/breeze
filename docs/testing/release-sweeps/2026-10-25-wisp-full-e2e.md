# Wisp (#9906) — full end-to-end verification (2026-10-25)

| | |
|---|---|
| Range | `origin/main` `8d1871dfe1` + the open sweep PR #10109 (`qa/sweep-2026-10-24-delta`), merged into `qa/wisp-full-2026-10-25` |
| Scope | Every Wisp wave W01–W08 with a **live Anthropic key**: grants, home, chat tools, triage engine, watches, nudges, brief, digest, specialists, links, memory, partner switch, admin page, scope/entitlement/flag gates |
| Not in scope | Mobile app (W06c/W08c — `apps/mobile`, Vitest only), thread attachments (no artifact store on the wt-stack), `analysis` specialists (`BREEZE_AI_WORKSPACE_ENABLED` off), ticket-cluster incidents (no tickets in the seed) |
| Stack | `pnpm wt-stack up --rebuild` on `qa/wisp-full-2026-10-25`, baseUrl `http://localhost:38081`; `tsx watch` did not pick up source edits through the bind mount, so each API fix needed `docker restart <api>` |
| Flags | `IS_HOSTED=true`, `BREEZE_AI_AGENTS_ENABLED=true`, `BREEZE_WISP_ENABLED=true`, `AI_OPERATOR_TASKS_ENABLED=true`, `BREEZE_WORKSPACE_ENABLED=false`, `TOOL_SOURCES_ALLOW_PRIVATE_EGRESS=false`, `PARTNER_TRUST_MODE=off`, real `ANTHROPIC_API_KEY` from the root `.env` |
| Seed | Default Partner (enterprise → `wisp` enabled by plan), Default Organization, two E2E devices, `admin@breeze.local` (TOTP enrolled during the run, platform admin set by SQL for the admin leg), two SQL-created users (`orgtech@breeze.local` Org Technician, `viewer@breeze.local` Partner Viewer, admin's password hash) |
| Driver | skill `feature-testing`; Playwright MCP + curl + psql; prior coverage from `2026-10-24-1b450020a3-to-main-delta.md` Group 2 was not repeated blindly |
| Model spend | ≈ $0.60 on the Default Partner (chat turns + 5 assessments + 1 patch-plan specialist) |

## Fixes applied (on `qa/wisp-full-2026-10-25`)

| Commit | Area | What | Test |
|---|---|---|---|
| `ef67814775` | API `services/wisp/threads.ts` | **Every Wisp chat session failed to open** (`POST /ai/sessions` → 500, home said "Could not open the conversation"). `attachSession` escaped the request transaction into a fresh system connection, which cannot see the just-inserted `ai_sessions` row ("AI session … not found"). It now runs on the caller's own connection in **system scope for its own statements only** (transaction-local `breeze.scope` flipped and restored, also on throw): joining the caller's context alone was not enough, because a partner-wide grant opened from an organization-scoped token has no partner-axis access and would not see the thread (review finding on #10146). Background callers still open a system context. | `threads.test.ts` (org/partner/system ambient cases, restore-on-throw) + `wispThreadsRls.integration.test.ts` three new cases against real Postgres (19/19) |
| `8adf73e754` + `cd647fe3a8` | API `services/wisp/grantAuthority.ts` | **`launch_specialist` was unreachable from anywhere.** W07 put it in `AGENT_HUMAN_ONLY_TOOLS` (agents may never call it) and W02's ceiling floor folds that whole registry into every grant, so the human's own Wisp turn — the only intended caller — got "Wisp can't use this tool under your current grant." for a `*:*` grantor. The floor and `assertWithinCeiling` now share one predicate that exempts `launch_specialist`; agents stay denied by the registry; the coordinator still gates by kind. Existing revisions keep the old snapshot until "Refresh grant". | `grantAuthority.test.ts` two new cases (red confirmed against HEAD) |
| `2b606c463e` | API `routes/devices/core.ts` | `GET /devices?search=` was a case-sensitive `LIKE` on hostname with the text unescaped; the W08 entity picker ("Search by name or number") found nothing for "macOS". Now `ILIKE` over hostname OR display name, wildcards escaped (`routes/devices/searchFilter.ts`). | `searchFilter.test.ts` (red → green); `devices.test.ts` mock gained `ilike` |

## Results by leg

Status ∈ `PASS | PARTIAL | FAIL | BLOCKED | N/A`. Rows marked *(fixed)* failed first and pass after the commit named above.

### A. Gates

| Leg | Result | Evidence |
|---|---|---|
| A2 org-scoped user (Org Technician) | PASS | `/wisp` → 302 `/wisp/chat`; no `wisp-toggle`; `GET /wisp/grants`, `/wisp/thread`, `/wisp/home`, `/orgs/partners/me` → 403; `GET /wisp/memory?scope=org` → 200 and `/settings/wisp-memory` renders My memory + Client. ⚠️ The sidebar still shows a "Wisp" entry for this user (it lands on the chat page). |
| A3 Partner Viewer (no `ai_sessions:use`) | PASS | Sidebar has no Wisp entry; `/wisp/grants`, `/wisp/home`, `/wisp/memory` → 403; `/partner/me/entitlements` → 200. ⚠️ A direct visit to `/wisp` shows a generic "Could not load the Wisp home. Try again" rather than a no-access state. |
| A4 locked entitlement (`partners.plan='free'`, API restarted to clear the 60 s cache) | PASS | `/partner/me/entitlements` → `wisp disabled/plan`; `/wisp/grants/preview`, `/wisp/home`, `/wisp/memory` → 403 `entitlement_required`; `/wisp` shows `wisp-home-locked` "Wisp is available on Pro and higher plans." + See plans → `/settings/plan`; side panel `wisp-toggle-locked`. ⚠️ The "Start Wisp" button still renders above the lock; `/settings/wisp-memory` still says "Failed to load memory." (paper cut 63). |
| A1 flag off (`BREEZE_WISP_ENABLED=false`, API recreated, grants/threads/concerns left in place) | PASS | `/orgs/partners/me` → `wispEnabled:false`; `/wisp/home`, `/wisp/grants`, `/wisp/memory`, `/wisp/partner-settings` → 404; `/wisp` → `/wisp/chat`; no toggle, no Settings card, no partner switch; `wisp_grants`/`wisp_threads`/`wisp_concerns` rows untouched (1/1/2). ⚠️ The sidebar "Wisp" entry still shows (it opens the chats page). |

### B. Grants

| Leg | Result | Evidence |
|---|---|---|
| B5 step-up before MFA enrolment | PASS | Modal: "Wisp needs a passkey or an authenticator app. Set one up in your profile first.", Confirm disabled (paper cut 61 still: no link to the profile). |
| B6 create org-scoped grant from `/wisp` | PASS | Wrong code → 400 "That code was not accepted. Try again."; right code → `grants/preview` 200 → `mfa/step-up` 200 → `POST /wisp/grants` **201** → toast "Wisp is on" → home renders Active, `0¢ of 500¢ today · resets in 7 h` (enterprise default 500¢/day, 30-min tick). |
| B8 re-enter existing grant (#10105) | not re-run | issue still OPEN; code unchanged. |
| B9 refresh grant | PASS | TOTP → `POST /wisp/grants/:id/refresh` 200 → toast "Grant refreshed"; revision 2 written, `current_revision_id` moved. ⚠️ The open chat session stays pinned to revision 1 (by design: a session's grant is immutable) — nothing tells the user to start a new conversation, so the refreshed ceiling does not apply to the conversation they are in. |
| B10 pause / resume (home + side panel) | PASS | Pause → toast "Wisp paused", status Paused, banner "You paused Wisp. It won't check in or nudge you until you resume.", Resume shown; Resume → "Wisp resumed", Active. **#10104 reproduces on the new home:** after a reload while paused `GET /wisp/concerns` and `/activity` → 409 `grant_inactive`, "Couldn't load concerns / activity", and the panes stay broken after Resume until a manual reload. |
| B11 system pause (budget) | PARTIAL | At 501¢/500¢ the wake tick skipped with `budget_exhausted` and sent the nudge **"Wisp paused for today — budget reached"**, but the grant row stayed `active` and the header shows Active + "Raise today's budget". The copy says paused, the state says active (see paper cut 7). #10106 not re-run. |
| B12 budget & check-in popover | PASS (paper cut 68 holds) | 3000¢ / 5 min → toast "Wisp settings saved" and the server clamped to 2500 / 15 silently; 500 / 60 → saved and shown. |
| B13 spend meter | PASS | 403¢/500¢ → `wisp-spend-meter` `data-state=warn`; 501¢/500¢ → `exhausted` + "Raise today's budget" button, which opens the budget popover. |
| B14 partner switch (`/settings/ai-agents`) | PASS | Switch off → toast "Wisp turned off"; `/wisp` shows `wisp-home-disabled` "A partner administrator turned Wisp off under Settings → AI Agents"; grant paused `partner_disabled` immediately; `POST /wisp/grants` → 403 `PARTNER_DISABLED` (preview stays 200). Switch on → "Wisp turned on", grant Active again. ⚠️ While partner-disabled the header still offers "Resume" and "Raise today's budget". |
| B15 revoke → thread readable | PASS / ❌ #10104 | Confirm "Turn off Wisp for this scope? Open threads stay readable." → `POST …/revoke` 200, toast "Wisp is off", home back to "Put Wisp to work". The thread page then shows Revoked but **"Couldn't load concerns / activity"** (`/wisp/concerns`, `/activity` → 409 `grant_inactive`) — the dialog's promise does not hold. |

### C. Memory

| Leg | Result | Evidence |
|---|---|---|
| C16 `/settings/wisp-memory` | PASS | Client tab → pick Default Organization → `backup-vendor` Fact Unconfirmed Medium "From conversation" → Confirm → toast "Memory confirmed.", status Confirmed. Paper cut 65 holds (Client tab opens on "Select a client" with an org already in the header). |

### D. Thread and chat (live model)

| Leg | Result | Evidence |
|---|---|---|
| D17 first live turn on `/wisp` | PASS *(fixed `ef67814775`)* | "Please remember that I prefer short answers…" → `list_organizations`, `query_devices`, a correct two-sentence answer. ❌ The model wrote "Noted: I'll keep answers short." without calling `remember`; no memory block was written (paper cut 1). |
| D17 side panel ↔ home hand-off | PASS | Thread page "Open in chat" opens the side panel in Wisp mode; side panel "Open in Wisp" → `/wisp`; the same session shows in both. |
| D18 chat tools under the ceiling | PASS | One turn: `remember` (org fact), `raise_concern` (medium, device), `link_entity` (device) — each a Tier-2 inline **Approval Required** card with a ~3-min timer, approved one after another; DB: `ai_memory_blocks` unconfirmed fact, `wisp_concerns` medium open, `wisp_thread_links` row `added_by_grant_id` set; home needs-you and links panels show them after the 30 s poll / reload. |
| D19 focus switcher | not re-run | PASS in the 10-24 sweep. |
| D20 attachments | BLOCKED | no artifact store (`BREEZE_AI_ARTIFACT_CAPTURE_ENABLED` + S3) on the wt-stack. |

### E. Links (W08)

| Leg | Result | Evidence |
|---|---|---|
| E21 picker → chip → remove | PASS *(fixed `2b606c463e`)* | "Link an item" → tabs Tickets…Users → Devices → "e2e-mac" → pick → toast "Linked to Wisp", `POST …/links` 201, "2 of 50 linked"; chip remove (aria "Remove E2E Windows Test Device") → `DELETE` 204, toast "Link removed". Before the fix "macOS" returned "No matches." (`GET /devices?search=macOS` → 0 rows). |
| E22 Link-to-Wisp buttons | PASS | Device detail: "Link to Wisp" → click → "Linked in Wisp" (POST 201); the other device shows "Linked in Wisp"; org record header shows "Link to Wisp". Tickets/quotes/invoices/contracts: no fixtures (N/A). ⚠️ Each detail page calls `GET /wisp/thread` twice, the first without the org → 404 then 200. |

### F. Concerns, triage, watches

| Leg | Result | Evidence |
|---|---|---|
| F24 needs-you on `/wisp` | PASS | Grouped MEDIUM / LOW with subject chips, age, "digest only", Useful / Not useful, Snooze (inline "1 hour / Until tomorrow 9:00 / 7 days"), Dismiss, Resolve; Snooze 1 hour → `POST …/snooze` 200 `{success:true}`, "quiet until …", and the recipient row is created on demand for a chat-raised concern. `#concern=<id>` deep link expands that row (`aria-expanded=true`). |
| F25 onboarding assessment on grant create/resume | PASS after setup | First wake: `assessment skipped { reason: 'onboarding', skipped: 'no_effective_agent' }` — the seed has no AI agent and **nothing on the home says so** ("Nothing on Wisp's radar right now", paper cut 2). After creating a partner-wide Alert triage agent (shadow) and pause/resume, `wisp.grant.resumed` → assessment run completed in ~10 s, 3¢: activity "CHECK Checked Default Organization — I found nothing that needs action… both new alerts … appear to be synthetic test data", `href` `/ai-agents/runs/<id>`, run DTO `wisp: { grantorName: "Breeze Admin", depth: 0 }`. |
| F26 run detail provenance (W07b) | PASS | `/ai-agents/runs/<id>` shows `run-detail-wisp` **"Wisp for Breeze Admin"** on both the assessment and the patch-plan specialist run. |
| F28 watches API + execution | PASS | `POST /wisp/watches` (`grantId, orgId, kind: alert_pattern, cadenceMinutes 15`) → 201; wrong shape → 400 with field errors; the watch ran at its `nextDueAt` (`last_ran_at` 17:40Z) and queued an assessment (run 2, 3¢). ⚠️ Unknown fields (`subject`, `reason`) are dropped silently into `params: {}`. |
| F27 ticket cluster / partner-level concern | N/A | no tickets in the seed. |

### G. Nudges

| Leg | Result | Evidence |
|---|---|---|
| G29 bell → thread page, feedback | PASS *(fix `840793ac21` verified)* | Bell → brief item → `/ai/wisp/thread/<id>`; Useful → `POST …/feedback` 200, toast "Thanks. Wisp will remember that.", label **"You marked this useful"** survives a reload (`wisp-concern-feedback-given-*`); rollup line "Wisp picture · 1/1 orgs · 0 high / 1 medium / 0 low"; live line "Checking Default Organization…" while an assessment ran. |
| G30 nudge preferences / settings API | PASS | `GET/PUT /wisp/nudge-preferences` (`proactivity chatty`, `briefTimeLocal 07:30`, `briefTimezone America/Chicago`, `quietOverride urgent_only`) → 200; invalid enum → 400 with field errors; `PUT /wisp/nudge-settings {urgentCapableSeverities:["high"]}` → 200. **No web UI exists for any of these** (mobile only). |
| G31 digest | PASS | Two open concerns with `nudge_count = 2` on one grant, `last_digest_at` null → the `13,28,43,58` cron sent **"Wisp: 2 concerns waiting"** at 18:13:00Z (deep link to the thread), `last_digest_at` stamped. A single qualifying concern sends nothing (the digest needs ≥ 2 per grant). |

### H. Brief

| Leg | Result | Evidence |
|---|---|---|
| H32 morning brief | PASS | Fired on the first digest tick after the grant (17:13Z, default 08:00 local = UTC): notification "Good morning — nothing needs you", sections Spend; home brief card "This morning's brief · Sent Nm ago"; activity row BRIEF. Re-arming (`last_brief_at` null) re-stamped at 17:58Z but sent nothing — the per-thread-per-day dedupe key held. ⚠️ "Good morning" was delivered at 17:13 UTC (paper cut 3); the card's "Spend 0¢" snapshot sits next to a header reading 501¢. |

### I. Activity

| Leg | Result | Evidence |
|---|---|---|
| I33 timeline + live line | PASS | assessment / brief / nudge rows with detail, org, cost, `href`; `current` live line during a run; `load more` not reached (< 50 rows). |

### J. Specialists (W07)

| Leg | Result | Evidence |
|---|---|---|
| J34 `launch_specialist` sweep | PARTIAL *(ceiling fixed `8adf73e754`/`cd647fe3a8`)* | Before the fix: "Wisp can't use this tool under your current grant." (grantor `*:*`). After the fix and a **new** conversation on revision 2: the coordinator answered `invalid_params` (the model sent a `goal` param) then `no_sweep_schedule` — the org has no sweep schedule, so the happy path is BLOCKED by fixtures. ⚠️ Each call demanded **two** sequential inline approvals (Tier 2 then Tier 3) before a deterministic refusal; the card copy reads "Wisp wants to run a health sweep at 64233cbe: …" (raw org-id prefix). |
| J35 `launch_specialist` patch_plan | PASS | After creating a partner-wide Patching agent: inline approval → `{"admitted":true,"runId":"ac01aefd…"}`; run profile `patch`, completed in 9 s, 4¢, summary names both devices' missing updates and adds a maintenance-window escalation; `grant_id`/`grant_revision_id` set, `depth 0`, "Wisp for Breeze Admin". The human's in-chat approval is the gate; no `/approvals` card is created for a human-requested asks-first kind. |
| J36 `bulk_ticket_reply` | N/A | no tickets. |
| `/wisp/chat` "New Conversation" | ❌ | Creates a plain session (`POST /ai/sessions {}` — no `wispGrantId`); `launch_specialist` then fails `wisp_grant_required` after an approval was still demanded. The page is titled "Wisp — chats", so people will expect Wisp (issue below). |

### K. Admin and misc

| Leg | Result | Evidence |
|---|---|---|
| K37 `/admin/wisp` (platform admin) | ❌ FAIL | Page shows `wisp-admin-disabled` "Wisp is not enabled on this deployment (BREEZE_WISP_ENABLED)" on a flag-on stack: `GET /admin/wisp/overview` and `/admin/wisp/grants` → **404** — `routes/admin/wisp.ts` / `services/wisp/adminOverview.ts` (W07 plan Task 9) were never built, and the page reads a 404 as "disabled". |
| K38 `/workspace` → `/wisp/chat` | PASS | 301; "Wisp chats" multi-tab page renders, `#session=` kept. |
| K39 gap-finder CLI `--dry-run` | PASS | `pnpm --filter @breeze/api wisp:gap-finder --partner <id> --dry-run` prints the readiness inventory + partner snapshot prompt; no model call. |
| `/settings` catalog card, sidebar "Wisp" entry, sidebar "Open in Wisp" | PASS | all present and routed. |
| Approvals page | PASS | `/approvals` shows "No approvals waiting" — every Wisp tool approval was decided inline. |

## UI/UX paper cuts (new this run)

| # | Where | Observation | Severity | Disposition |
|---|---|---|---|---|
| 1 | Wisp chat | Model says "Noted: I'll keep answers short." without calling `remember`; nothing is persisted. The Wisp system prompt is the generic "You are Breeze AI…" with no guidance to persist preferences via `remember`. | med | issue |
| 2 | `/wisp` home | With no effective AI agent for the org every assessment skips (`no_effective_agent`) and the home just says "Nothing on Wisp's radar right now." — no readiness hint to create an agent. | med | issue |
| 3 | Brief | "Good morning — nothing needs you" delivered at 17:13 UTC on grant day; brief fires as soon as local time ≥ `briefTimeLocal`. | low | noted |
| 4 | `/wisp` home | No "new conversation" control; only the side panel has one. After "Refresh grant" the open conversation keeps the old revision's ceiling with no prompt to start a new one. | med | issue |
| 5 | Chat tools | Three tool calls in one turn = three sequential ~3-min approval cards; `launch_specialist` needs two approvals per call (Tier 2, then Tier 3) even when the coordinator will refuse deterministically (`invalid_params`, `no_sweep_schedule`, `wisp_grant_required`). | med | issue |
| 6 | Approval card | "Wisp wants to run a health sweep at 64233cbe: …" — raw org-id prefix instead of the org name. | low | noted |
| 7 | Budget exhaustion | Nudge says "Wisp paused for today — budget reached" while the grant stays `active` and the header shows Active + "Raise today's budget". | low-med | noted (relates to #10106) |
| 8 | Partner-disabled header | "Resume" and "Raise today's budget" still offered while the partner switch is off. | low | noted |
| 9 | Home "Talk to Wisp" card | Empty state is the generic "Breeze AI Assistant — Ask about your devices…" with the generic suggestion chips, not Wisp-branded. | low | noted |
| 10 | Sidebar (org-scoped user) | "Wisp" nav entry shows for an org-scoped user; it lands on the plain chat page. | low | noted |
| 11 | `/wisp` (Partner Viewer) | Generic "Could not load the Wisp home. Try again" for a 403. | low | noted |
| 12 | Detail pages | `WispLinkButton` calls `GET /wisp/thread` twice on load (first without org → 404). | low | noted |
| 13 | Watches API | Unknown body fields silently dropped (`params: {}`). | low | noted |
| 14 | `/admin/wisp` | 404 from a missing API is rendered as "not enabled on this deployment". | med | issue (K37) |
| 15 | Home panels | Needs-you and Linked items only pick up chat-tool writes on the next 30 s poll or a reload. | low | noted |
| 16 | Agent wizard | Kind cards are disabled when an org-only agent of that kind exists, with no explanation; scope cannot be changed on edit. (Not Wisp code.) | low | noted |

## Issues filed

| Issue | Title | From |
|---|---|---|
| #10141 | `/admin/wisp` has no API behind it — page reports "not enabled" on a flag-on stack | K37 |
| #10142 | `/wisp/chat` "New Conversation" opens a plain session, not a Wisp session (+ no new-conversation control on the home, refresh grant leaves the open conversation on the old revision) | J34, B9, paper cut 4 |
| #10143 | Model acknowledges a preference without calling `remember`; no readiness hint when the org has no effective agent | D17, F25, paper cuts 1–2 |
| #10144 | `launch_specialist` asks for two sequential approvals per call, even before a deterministic refusal (+ org-id prefix in the card) | J34, paper cuts 5–6 |
| #10145 | Budget-exhausted nudge says "paused for today" while the grant stays active; partner-disabled header still offers Resume; sidebar entry / viewer error states | B11, B14, A2, A3, paper cuts 7–11 |
| still open from 10-24 | #10104 (reads while paused/revoked 409), #10105 (re-entry TOTP), #10106 (system pause Resume), #10107, #10108 | |

## Summary

| Group | PASS | PARTIAL | FAIL (fixed) | FAIL (open) | BLOCKED / N/A |
|---|---|---|---|---|---|
| A Gates | 4 | 0 | 0 | 0 | 0 |
| B Grants | 7 | 1 | 0 | 1 (#10104 on revoke/pause reads) | 0 |
| C Memory | 1 | 0 | 0 | 0 | 0 |
| D Chat | 3 | 0 | 1 (session open) | 0 | 1 (attachments) |
| E Links | 2 | 0 | 1 (device search) | 0 | 0 |
| F Triage/watches | 4 | 0 | 0 | 0 | 1 (ticket cluster) |
| G Nudges | 3 | 0 | 0 | 0 | 0 |
| H Brief | 1 | 0 | 0 | 0 | 0 |
| I Activity | 1 | 0 | 0 | 0 | 0 |
| J Specialists | 1 | 1 (sweep: no schedule) | 1 (ceiling) | 1 (`/wisp/chat` plain session) | 1 (bulk ticket reply) |
| K Admin/misc | 4 | 0 | 0 | 1 (`/admin/wisp`) | 0 |
| **Total** | **31** | **2** | **3** | **3** | **3** |

**Top findings:**
1. Wisp chat could not open a session at all (`POST /ai/sessions` 500) — fixed `ef67814775`. This was invisible to the 10-24 sweep because that stack had no AI key.
2. `launch_specialist` was denied by the grant ceiling for every grantor — fixed `8adf73e754` + `cd647fe3a8`.
3. `/admin/wisp` has no API behind it (W07 Task 9 never landed) — open.
4. `/wisp/chat` "New Conversation" is not a Wisp session — open (design call).
5. Everything else in W01–W08 that a browser can reach works end to end with a live model: grants/step-up/refresh/pause/resume/partner switch, memory, chat tools, assessments, watches, nudges, brief, feedback, links, picker, Link-to-Wisp, provenance, spend meter, scope and permission gates.

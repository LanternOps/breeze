# UI QA sweep — delta `b113a52d3f` → `0bb2bd4ea1` (2026-10-26)

| | |
|---|---|
| Range | `b113a52d3f` (end of the 10-25 delta sweep) → `origin/main` `0bb2bd4ea1` (52 commits) |
| Stack | the 10-25 sweep stack (project `breeze-wt-sweep-2026-10-25-main`, `http://localhost:34124`) upgraded in place: worktree moved to `sweep/2026-10-26-main` @ `0bb2bd4ea1`, api/web/portal images rebuilt + recreated, Postgres kept (13 new migrations auto-applied) |
| Flags enabled | `IS_HOSTED=true`, `BREEZE_WISP_ENABLED=true`, `BREEZE_AI_AGENTS_ENABLED=true`, `FLOWS_ENABLED=true`, `AI_OPERATOR_*`, `PARTNER_TRUST_MODE=off`, `TOOL_SOURCES_ALLOW_PRIVATE_EGRESS=false`, live `ANTHROPIC_API_KEY` |
| Driver | skill `ui-qa-sweep`; main session drives the browser |

## Change inventory

Status ∈ `TODO | PASS | PARTIAL | FAIL | BLOCKED | N/A`.

| PR | Surface | Title | Route / click-path | Status |
|---|---|---|---|---|
| #10281 | ci | M365 executor Node version | — | N/A |
| #10257 #10263 #10254 #10261 #10262 #10267 #10251 | deps | dependabot bumps | covered by nav crawl (web build, vite plugin-react) | PASS |
| #10274 | shared | prompt host contract schema | — | N/A |
| #10273 | chat tools | W10 AI-agent read tools | /ai-risk guardrails rows | PARTIAL |
| #10237 | auth | MFA factor state sync | /settings/profile MFA; forced MFA setup | PASS |
| #10270 | flows | W5 PR A webhook trigger, budgets, for-each | /flows | N/A (web in PR D) |
| #10235 | agreements | partner default expiry + reminders | billing settings → agreements; Send dialog | PASS |
| #10239 | devices | Breeze Assist availability; helper policy default deploy | device list/info; config policy Helper tab | PASS (fixed) |
| #10152 | wisp | /wisp/chat tabs under grant; New conversation; refresh hint | /wisp, /wisp/chat | PARTIAL |
| #10151 | wisp | /admin/wisp overview API + error state | /admin/wisp | PASS |
| #10233 | agreements API | contract_documents append-only | signed agreements still render | PASS |
| #10241 | chat tools | W09 SNMP / network monitoring tools | /ai-risk guardrails rows | PASS |
| #10230 #10228 | assist/agent | WebView2 sidecar, reliability | — | N/A (agent, lab) |
| #10116 | api + web | reattach wave 1b-2 (WebhookForm event list) | /settings/webhooks form | PASS |
| #10205 #10234 #10214 #10206 #10014 | docs | — | — | N/A |
| #10226 | api | portal may frame inline public PDFs (#10192) | public signing page preview | PASS |
| #10243 | wisp | thread timeline + Load earlier | /wisp thread | PASS |
| #10240 | wisp | companion surface restyle | /wisp, /ai/chat, panel | PASS (fixed) |
| #10238 | wisp API | wisp_thread_posts + timeline | with #10243 | PASS |
| #9744 | billing | invoice line Name, NULL quantity, locale counts | contracts allowance cells | PASS |
| #10156 | wisp | pause copy, partner-disabled header, viewer gates | /wisp as admin + viewer | PASS |
| #10203 | patches | update rings decide feature updates | /patches#update-rings form; device patch tab | PASS (fixed) / PARTIAL |
| #9444 #10209 #10208 | agent | reconnect, cancel_reboot, consent default | — | N/A (agent, lab) |
| #10202 | portal | agreements list/detail/sign | portal /agreements | FAIL → #10290 (fixed dashboard) |
| #10201 | qa | previous sweep (Wisp grant fix) | regression check partner-wide grant | PASS |
| #10204 | chat tools | W08 topology tools | /ai-risk guardrails rows | PARTIAL |
| #10175 | flows | Tool Catalog W04 PR B enable/run/runs tab/timeline | /flows → detail → run | PASS (fixed) |
| #10163 | topology | map fits screen, no scroll fight | /network topology | PARTIAL |
| #10154 | wisp | remember preferences; readiness hint | /wisp concerns panel | PASS |
| #10109 | qa | previous-previous sweep fixes | spot check | PASS |
| #10059 | api | file upload/copy/move need scripts:execute | device file browser as admin | BLOCKED |
| #10071 | settings | org settings full width | /settings/organization | PASS |
| #10121 | mobile | — | — | N/A |
| #10191 | agreements | remind, expiry reaper, events | agreement requests table Remind | PASS |
| #10168 | flows | Tool Catalog W04 PR A runner + approvals | with #10175; AI initiator chip | PASS |
| #10172 | billing API | partners.billing_enabled + skipped periods | — | N/A (API only) |
| #10173 | api | force-reboot step-up canonical id | device reboot (force) | BLOCKED |
| #10166 | unifi | W2 agent collection | — | N/A (agent) |
| #10242 | tests | — | — | N/A |

## Summary

| Area | Result |
|---|---|
| Nav crawl (79 routes) | PASS |
| Wisp companion surface, timeline, New conversation, /admin/wisp, readiness, pause/resume, viewer gate | PASS (1 fix) |
| MFA factor sync (#10207 #10229) | PASS |
| Update rings feature updates | PASS (1 fix) · device leg BLOCKED (lab) |
| Agreements defaults, Remind, public PDF | PASS |
| Portal agreements | dashboard FIXED · detail PDF FAIL (#10290) · date mismatch (#10291) |
| Flows enable / run / runs / timeline | PASS (1 fix) |
| AI tool waves W08–W10 | catalog PASS · under Wisp FAIL (#10289) |
| Breeze Assist availability + default deploy | PASS (1 a11y fix) |
| Webhook event, contracts, org settings width | PASS |
| Topology fit | PARTIAL (no assets) |
| File ops perm, force-reboot step-up | BLOCKED (offline fixtures) |

### Fixes on the branch
- `e350682b4c` Wisp morning brief spend in dollars ("4¢ of 500¢" → "$0.04 of $5.00").
- `473194b50f` + `7d2885f8f4` update-ring badge names the Windows version ("Windows 10 22H2").
- `226d7ca4b2` portal dashboard counts agreements to sign; card under the heading.
- `e2f7559c5a` flow runs tab "No runs match this filter." (8 locales).
- `9707490ad2` Breeze Assist deploy toggle is a named switch.

### Issues filed
- #10289 (P1, design) Wisp grant strips 34 agent-denied tools from chat; flows cannot be drafted while Wisp is on.
- #10290 (P1) portal agreement detail PDF blank (session file route DENY).
- #10291 portal agreement expiry 11/10 vs November 9 (SSR UTC).
- #10292 Wisp readiness copy "no AI agent" with a non-Triage agent.
- #10293 contract manual line empty quantity → "2-decimal money string".
- #10294 agreements: internal label as customer title; expiry default jump.
- #10295 Partner Viewer: Require MFA banner + dashboard 403s.
- Comments: #10195 (mixed voice on /ai/chat), #10200 (viewer leg fixed; 404 lines), #8909 (one-click ring delete).

### Top findings
1. **Grant-driven voice × agent deny floor** (#10289): every AI-tool wave that adds an agent-denied tool now also removes it from human chat for Wisp users. This is the systemic item; it grows with each wave.
2. **Two PRs, one surface, opposite assumptions**: #10202 framed a session-auth PDF route on the same day #10226 documented session routes as DENY by design (#10290). Same-day cross-PR contracts need a check at merge.
3. **SSR vs client formatting** in the portal (#10291): timestamps in Astro-rendered components format in the server's zone.

### State left behind
- Stack `breeze-wt-sweep-2026-10-25-main` (http://localhost:34124) **left running**, upgraded to `0bb2bd4ea1`; Wisp grant Active (paused/resumed once).
- Data added: ring "QA Sweep Pin Ring", flow "QA sweep flow" (disabled, 1 run), contract "QA sweep contract 10-26" (draft), 2 signed agreement requests, MFA enrolled+disabled on orgtech.

## Sweep log (append as you go)

### [Nav crawl] — PASS (22:58Z)
- ✅ 79 routes (every sidebar link incl. Tickets, Billing, Agreements, Flows, Wisp, `/wisp/chat`, `/ai/chat`, all `/admin/*` as platform admin, a device detail) return 200, render, and log no console errors and no 4xx/5xx `/api` calls. Covers the dependabot web bumps (vite plugin-react, postcss, typescript tooling).
- ℹ️ `/network` is not a route (my guess for topology); topology lives under Network Discovery.

### [#10240 #10243 #10238 Wisp companion surface + timeline] — PASS (with one fix)
- ✅ `/wisp` renders the thread column + rail: identity card "Active · All organizations", spend meter `$0.04 of $5.00 today · resets in 2 h`, Pause, Needs your attention, Workers, Linked items 3 of 50, Activity, All chats / Memory.
- ✅ `GET /wisp/thread/:id/timeline?limit=50&excludeSessionId=…` 200; prior turns, a finished analysis-run card ("finished after the conversation moved on — Open the full run") and the Morning Brief post render in order. No "Load earlier" (thread < 50 items, expected).
- ❌→✅ FIXED `e350682b4c`: the Morning Brief post's Spend line read **"4¢ of 500¢ today"** beside the rail's **"$0.04 of $5.00 today"**. Server string in `services/wisp/brief.ts` (pre-existing, newly visible now the thread renders brief posts). Now dollars; brief tests red→green, wisp suite 943/943.
- ⚠️ UI/UX: `GET /wisp/thread/:id/activity?limit=50` fires twice on every `/wisp` load (duplicate fetch).

### [#10152 /wisp/chat tabs + New conversation] — PASS / PARTIAL (voice)
- ✅ `/wisp` "New conversation" (`wisp-home-new-conversation`): `DELETE /ai/sessions/<old>` 200 → `POST /ai/sessions` 201; DB: new session `wisp_grant_id` = the partner-wide grant, old one `closed`. Live turn answered ("Default Organization has 2 devices … both offline").
- ✅ `/wisp/chat` → `/ai/chat` (by design, #10171). New tab: `POST /ai/sessions {"wispGrantId":"9a8d…","approvalMode":"per_step"}` → tab header shows **Wisp**.
- ⚠️ UI/UX: in that Wisp tab the empty state still says "Breeze AI — Ask about your devices…" with the generic prompts, the composer placeholder is "Ask about your devices…", and the reply is labelled **"Breeze AI"** under a "Wisp" header. Same mixed voice as #10195 (panel) on the full-page surface → commented on #10195.
- ⚠️ UI/UX: the grant lookup tries the org scope first, so every `/ai/chat` load under a partner-wide grant logs a red `404 /wisp/thread?orgId=…` console line (by design; #10200 class) → commented on #10200.

### [#10151 /admin/wisp overview] — PASS (closes #10141 leg)
- ✅ As platform admin: `GET /admin/wisp/overview` 200; table "Default Partner · enterprise · 1 active · 0 paused · 0 checks · 1 specialist request · 1 open concern · 0 exhausted". Read-only + Refresh.

### [#10154 remember + readiness hint] — PASS / ⚠️ copy
- ✅ Readiness concern raised by the assessment tick at 23:01: "Wisp can't check this organization yet — no AI agent is configured. Create one under Settings → AI Agents." with Open / Snooze / Dismiss / Resolve; `/admin/wisp` counts it.
- ⚠️ UI/UX: the partner has an **enabled** "QA Patching agent" (shadow). Assessments need a **Triage**-kind agent (`createAndEnqueueAgentRun kind:'triage'`), so "no AI agent is configured" is wrong for this partner; it should name the missing Triage agent. → issue.

### [#10156 Wisp pause copy / viewer gates] — PASS (viewer leg) / ⚠️
- ✅ Partner Viewer: sidebar shows no Wisp / Breeze AI entries; direct `/wisp` → `GET /wisp/home` 403 → **"You don't have access to Wisp"** (was the generic "Could not load the Wisp home. Try again" in #10200 item 2).
- ⚠️ UI/UX: that access-denied page still renders the rail-nav links **All chats → /ai/chat** (access denied for a viewer) and **Memory → /settings/wisp-memory** → comment on #10200.
- ⚠️ UI/UX: the partner "MFA isn't required for your team — **Require MFA**" banner shows for a Partner Viewer, whose CTA lands on partner security settings they cannot change.
- ⚠️ UI/UX: viewer dashboard fires 403s `GET /time-entries/running` and `GET /audit-logs/logs?limit=5` on every load (widgets hide silently; red console lines).
- ℹ️ Org Technician (org-scoped) still sees an unlocked sidebar **Wisp** that redirects to `/ai/chat` — intentional per #10156 ("keep it for org-scoped tokens"), already on #10200.
- Pause/partner-disabled header copy not re-driven (grant left active for Todd; unit-covered in the PR).

### [#10237 MFA factor state sync, closes #10207 #10229] — PASS
- ✅ Org Technician → Profile → Authenticator app **Enable** → password confirm → `POST /auth/mfa/setup` 200 → setup key + 6 digit inputs → `POST /auth/mfa/enable` 200 → recovery codes → **Back** → card reads **"Enabled — Your account is protected"** immediately and after reload (#10229).
- ✅ **Disable** → code + current password → `POST /auth/mfa/disable` 200 → **"Disabled"** immediately and after reload (#10207). Account left with MFA off.

### [#10203 update rings decide Windows feature updates] — PASS (with one fix) / PARTIAL (device leg)
- ✅ Patches → Update Rings → New Ring: "Windows feature updates" select Block (default) / Allow the newest release / Pin to a release; Pin reveals Windows version (11/10) + Release, with the WUfB target-release note.
- ✅ Validation: release `abc` → inline "Enter a release like 25H2.", no request sent. Valid → `POST /update-rings` 201 `featureUpdates:{mode:"pin",product:"windows-10",targetVersion:"22H2"}`, toast "Update ring created", row appears.
- ✅ Edit pre-fills pin / windows-10 / 22H2; switch to Allow → `PATCH` 200 `{mode:"allow"}` → badge "Feature updates: newest"; Block shows no badge.
- ❌→✅ FIXED `473194b50f`: the list badge read **"Feature updates: 22H2"** for a Windows 10 pin — ambiguous, 22H2 is a release of both Windows 10 and 11. Now "Feature updates: Windows 10 22H2" (existing product labels, no new locale keys); test red→green; verified live after a web restart.
- ⚠️ UI/UX: Delete on a ring with no linked policies fires immediately: no confirmation, no undo (by design since #8909, which confirms only when policies are linked). One mis-click loses a ring's whole rule set. Reproduced by accident: a Delete click 12 s after create (audit `update_ring.delete`).
- ⚠️ UI/UX: `/patches#update-rings` does not select the tab; the tab's hash is `#rings`.
- BLOCKED: device Patches tab reason "blocked_by_feature_update_policy" and the agent WUfB writes need a Windows lab device with a pending feature release (lab leg already owed per the PR).
- Left behind: ring "QA Sweep Pin Ring" (pin Windows 11 25H2, no devices).

### [#10235 agreement defaults + automatic reminders] — PASS / ⚠️
- ✅ Settings → Billing → **Agreements** tab: Default link expiry (30) + "Send automatic reminders" (off). `400` → inline "Enter a whole number of days from 1 to 365." and no request. 14 days + reminders on reveals Remind every (3) / Stop after (3) with "Counts every reminder on the request, manual or automatic."; set 7 / 2 → `PATCH /partner/billing-settings` 200 `agreementDefaultExpiryDays:14, agreementReminderIntervalDays:7, agreementMaxReminders:2`, toast "Billing settings saved", values survive reload.
- ✅ Send for signature: after picking the org, `GET /contracts/agreement-requests/defaults?orgId=` → expiry pre-fills **11/09/2026** (+14) and the hint reads "Default: 14 days, from Billing settings → Agreements. Automatic reminders go out every 7 days, up to 2 in total."
- ⚠️ UI/UX: before an org is picked the expiry field shows a hard-coded **+30 days** (11/25/2026), then jumps to +14 on org pick. The default is partner-level, so it can be read on open.
- Automatic reminder job (hourly worker) not observed (needs 7 days of clock).

### [#10191 Remind] — PASS
- ✅ Awaiting signature row → **Remind** → `POST …/remind` 200 → toast "Reminder recorded, but email isn't configured. Copy the signing link and share it." → row "Reminded 1 time". **Copy link** → toast "Signing link copied", clipboard has `/portal/agreement/<token>`.

### [#10226 inline public PDF (closes #10192)] — PASS
- ✅ Public signing page in a clean context: the PDF iframe renders (Chrome viewer, page 1/1). File route answers `X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`; no console errors. Sign → `POST` 200 `status:"signed"` → "Signed. We're emailing a copy…".
- Still open and reproduced: #10199 (reload of the link after signing → "This agreement link is invalid or has expired.").

### [#10202 portal agreements list/detail/sign] — PASS (with one fix) / FAIL (detail PDF)
- ✅ Portal nav "Agreements"; list shows Awaiting signature (Review & sign) and Signed agreements with **Signed copy** / **Original** (both `200 application/pdf`). Detail → name + checkbox → `POST /portal/agreements/:id/accept` 200 → "Signed. You can download your signed copy below." → list + dashboard update.
- ❌→✅ FIXED `226d7ca4b2`: with an agreement to sign, the dashboard rendered the **"Awaiting your signature" card above the "Dashboard" heading** and, under it, **"Nothing is waiting on you."** (the awaiting-you line counted proposals + invoices only). DashboardTiles now takes the agreements read, places the card under the heading, and says "1 agreement is waiting for you." (A, B and C joining). Tests red→green; portal suite 1600/1600, portal tsc clean; verified live.
- ❌ BUG → issue: the portal **detail** page's inline PDF is blank. `GET /api/v1/portal/agreements/:id/file` answers `X-Frame-Options: DENY` + `frame-ancestors 'none'` (console: "Framing … violates … frame-ancestors 'none'"). #10226 allowlisted only the two token routes and documents session routes as deliberately DENY, so this needs a security decision, not a sweep patch.
- ⚠️ UI/UX → issue: the same request shows **Expires 11/10/2026** on the portal list and dashboard card but **November 9, 2026** on the detail page. Stored `2026-11-10 06:59:59Z` (end of 9 Nov, sender's zone). The SSR list/dashboard format in the server's UTC; the `client:load` detail formats in the browser zone.
- ⚠️ UI/UX: the portal list and dashboard card title a request by its internal **Label** ("Portal sign 10-26") while the detail and the signing page title it by template ("QA Master Services Agreement"). The Send dialog does not say the label is customer-visible.

### [#10233 contract_documents append-only] — PASS (regression)
- ✅ The pre-existing signed agreement (10-25) still lists, downloads (certified 19.5 KB, original 610 B) and links after the migration; new signatures file normally.

### [#10175 #10168 Tool Catalog W04 — enable / run / runs / timeline] — PASS (with one fix) / PARTIAL
- ✅ Drafted "QA sweep flow" in Breeze AI chat (`validate_flow` ×2 → `draft_flow` approval card → Approve → Flow draft card "Steps: 1 · Error: 0 · Warning: 0" + id). `/flows` lists it (Draft · Tier 1 · Manual); detail shows "Created in Breeze AI" (#10168 initiator chip), Overview / Runs tabs.
- ✅ **Enable** → dialog "Enabling publishes this version… No step in this flow needs approval." → `POST /flows/:id/enable` 200 → toast "Flow enabled", header Run now / Disable.
- ✅ **Run now** → Start run → `POST /flows/:id/runs` 202 `{runId, duplicate:false}` → navigates to `/flows/runs/:id`: Completed · Version 1 (publication 1) · Manual · From the web app · Organization · 19 ms; step `list_offline query_devices` Completed "No approval needed"; **Show details** lazy-loads the step (`GET …/steps/:id` 200) with Input/Output JSON (2 offline devices).
- ✅ Back to runs → `#runs` tab lists the run; status filter re-queries. **Disable** → "Disabling stops new runs and cancels runs that are in progress…" → toast "Flow disabled".
- ❌→✅ FIXED `e2f7559c5a`: filtering the Runs tab by a status with no runs (Failed) said **"No runs yet."** although the flow had a completed run. Now "No runs match this filter." (`runs.emptyFiltered`, 8 locales); tests red→green.
- ⚠️ UI/UX: the Run flow dialog for a flow with no inputs is just "Run flow · Cancel · Start run" — no line saying what will run, or where.
- ⚠️ UI/UX: Run now gives no toast; the page navigates to the run (fine), but a failed `POST` would be the only feedback path to check.
- PARTIAL: approval-paused runs (Tier 3 step → `/approvals` → resume) and #10270's webhook trigger / budgets / for-each are API-only until W5 PR D (web) lands; not driven.

### [Wisp × chat tools] — FINDING (design) → issue
- ❌ With an active Wisp grant, **every** new `/ai/chat` tab and the side panel run as a Wisp session (#10152/#10171: "+ New" offers only "New chat"). `draft_flow` is agent human-only, so it is never delegable: the turn ends "Wisp can't use this tool under your current grant." and **flows cannot be drafted at all** while Wisp is on (chat is the only place flows are drafted). The same applies to every human-only tool. Workaround used: Pause Wisp → plain chat → draft → Resume (grant restored Active).
- ✅ Pause / Resume (#10156 copy): Pause → `POST …/pause` 200 → "Paused · You paused Wisp. It won't check in or nudge you until you resume." → Resume → `POST …/resume` 200, no step-up. While paused, `/wisp` logs three 409s (concerns, activity ×2) = #10104.

### [#10204 W08 topology · #10241 W09 SNMP/network · #10273 W10 AI-agent reads] — PASS (catalog) / FINDING (under Wisp)
- ✅ /ai-risk Guardrails lists the new Tier 2/3 rows with plain descriptions: Run Topology Diagnostic (Start/Cancel), Manage Topology Manual / Monitoring / Templates (incl. Publish/Revoke), Apply Topology Template (Preview / Apply), Diagnose Connectivity, Manage Snmp Templates, Manage Known Guests, Trigger Unifi Sync. Tier 1 reads (get_topology_graph, get_snmp_metrics, W10 list_*/get_*) are not listed there (page shows guardrailed tiers only).
- ✅ Live chat (grant-driven Wisp tab): `list_ai_agent_schedules` → "1 schedule … cron 0 2 * * * UTC, enabled, never enqueued"; `list_fleet_designs` → 0.
- ❌ Same turn: `list_operator_tasks` (W10) and `get_topology_graph` (W08) → "Wisp can't use this tool under your current grant." The Wisp ceiling floor is both agent deny registries (`agentDeniedToolNames()`), now **34 tools**: draft_flow, run_flow, cancel_flow_run, send_endpoint_message, manage_alert_correlations, all 6 topology tools, manage_known_guests, get_unifi_status, trigger_unifi_sync, ioc_hunt, the diagnostic-access set, search_c2c_items, get_user_risk_*, m365_query_*, list/get_operator_task(s), confirm/retract_memory… Several are agent-denied only because an `ai_agent` principal is not a user (W08-D1), which does not hold for a human's Wisp chat. Combined with grant-driven voice, every one of them is unreachable from chat for a user with an active grant → same issue as the draft_flow finding.
- ⚠️ #10197 still: "Manage Snmp Templates", "Trigger Unifi Sync" title-casing.

### [#10239 Breeze Assist availability + helper policies default deploy] — PASS (with one a11y fix)
- ✅ Device → **Details** tab row "Breeze Assist: **Not deployed**" (no helper version). With `helper_install_issue='crash_loop'` seeded on the Windows fixture: row "**Unavailable: keeps closing**" + notice "Breeze Assist kept closing right after it started…, so the agent stopped restarting it. It tries again after 6 hours…"; device list pill "**Assist unavailable**" with tooltip "Breeze Assist kept closing right after it started; the agent tries again after 6 hours." Fixture reverted.
- ℹ️ The notice read "(since —)" only because my seed left `helper_install_issue_since` NULL; the agent sets it.
- ✅ Config policy (no helper link yet) → More → **Breeze Assist**: "Not configured", Deploy toggle **on** by default (OD-11 b).
- ❌→✅ FIXED `9707490ad2`: that Deploy toggle was a bare `<button>` (no `role="switch"`, `aria-checked` or name) beside correctly-built sibling switches, so its on/off state was invisible to assistive tech and tests had to infer it from disabled checkboxes. Now a named switch (`data-testid="helper-deploy"`); test red→green, 843/843.

### [#10116 reattach wave 1b-2 (web: webhook event)] — PASS
- ✅ Integrations → Webhooks → new webhook form lists **Device Reinstalled** — "Triggered when a reinstalled machine is reattached to its existing device record." (no raw `longTail.*` keys). Server-side rebind is agent/lab territory.

### [#9744 contract lines: Name, NULL manual quantity] — PASS / ⚠️
- ✅ New contract "QA sweep contract 10-26" → Manual quantity line ($25 × 1) → estimate $25.00. A NULL quantity can no longer be stored: `contract_lines_manual_quantity_chk` rejects it (tried in SQL), so the new "quantity missing" cell is legacy-row only.
- ⚠️ UI/UX → issue: clearing Quantity and pressing Add line sends `manualQuantity:""` → 400 → toast **"Manual quantity: must be a 2-decimal money string"**. A quantity is not money, and the form could catch an empty quantity before sending.
- AI-usage locale formatting (#9669) not driven.

### [#10163 topology map fits the screen] — PARTIAL
- ✅ Discovery → Topology: map panel fits the viewport (document height 933 px at a 1080 px viewport, no page scroll), Expand / Edit map present.
- BLOCKED: no discovered assets in the seed, so wheel-zoom vs page-scroll could not be exercised.

### [#10071 org settings full width] — PASS
- ✅ Organization settings and Partner Settings render in the same full-width container (1728 px content, no `max-w-*`).

### [#10059 file ops need scripts:execute · #10173 force-reboot step-up] — BLOCKED
- Both need an online device (file browser / reboot). Fixture devices are offline; the API changes are unit-covered in their PRs.

### [Previous-sweep issues re-checked]
- Closed and verified on this stack: #10192 (public PDF), #10207 + #10229 (MFA), #10141 (/admin/wisp API), #10142 (/wisp/chat tabs under grant), #10143 (readiness hint), #10145 (pause copy, viewer gates).
- Still reproduce: #10199 (signing link after signing), #10195 (mixed voice, now also on /ai/chat), #10200 (404 console lines; viewer leg fixed), #10104 (409s while paused), #10197 (title-casing).


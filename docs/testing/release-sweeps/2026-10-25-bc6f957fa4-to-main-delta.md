# UI QA sweep — delta `bc6f957fa4` → `b113a52d3f` (2026-10-25/26)

| | |
|---|---|
| Range | `bc6f957fa4` (end of the 10-24 delta sweep) → `origin/main` `b113a52d3f` (36 commits) |
| Gate | none waited on; previous sweep PR #10109 still OPEN (Integration shard 9 red) |
| Stack | `pnpm wt-stack up --rebuild` on `sweep/2026-10-25-main` @ `b113a52d3f`, baseUrl `http://localhost:34124` (caddy port pinned), project `breeze-wt-sweep-2026-10-25-main` — **left running for Todd to test Wisp** |
| Flags enabled | `IS_HOSTED=true`, `BREEZE_WISP_ENABLED=true`, `BREEZE_AI_AGENTS_ENABLED=true`, `AI_OPERATOR_TASKS_ENABLED=true`, `AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED=true`, `AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED=true`, `PARTNER_TRUST_MODE=off`, `TOOL_SOURCES_ALLOW_PRIVATE_EGRESS=false`, live `ANTHROPIC_API_KEY` |
| Focus | Wisp (#10146 #10158 #10070 #10066 #10033) and AI surface cohesion #10131 (W01–W06: #10153 #10155 #10157 #10165 #10171 #10148) |
| Driver | skill `ui-qa-sweep`; main session drives the browser, subagents do code/vocab audit |

## Change inventory

Status ∈ `TODO | PASS | PARTIAL | FAIL | BLOCKED | N/A`.

| PR | Surface | Title | Route / click-path | Status |
|---|---|---|---|---|
| #10169 | chat tools | W07 alert correlation / signal triage tools | /ai-risk guardrails rows; chat | PASS |
| #10167 | agreements | signature certificate, Send for signature dialog, status chips | /agreements/signed | PARTIAL |
| #10171 | web | one chat door — grant voice, /wisp locks, /ai/chat | /ai/chat, /wisp, panel, redirects | PASS |
| #10110 | release skill | — | — | N/A |
| #10061 | agent | rollback exec modes | — | N/A |
| #10060 | office | assistant markdown resource loads | — | N/A (lab) |
| #10165 | web | AI section collapse, Settings → AI hub, Wisp lock, palette gates | sidebar, /settings/ai, ⌘K | PASS |
| #10164 | tests | — | — | N/A |
| #10162 | agreements | public signing page, emails | portal /agreement/<token> | FAIL |
| #10160 | chat tools | W06 PSA config / ticket-ops tools | /ai-risk guardrails | PASS |
| #10153 | web | chat door is Breeze AI everywhere | header, panel, scripts editor, office | PASS |
| #10155 | web | Operator work is an AI task | /operator, alert delegate, device tab | PASS |
| #10157 | web | Approve/Deny, dollars, four tier names | approvals, /ai-risk, wisp meter | PASS |
| #10158 | wisp | refuse doomed launch_specialist before approval card; org name | Wisp chat | PARTIAL |
| #10146 | wisp | session attach, launch_specialist ceiling, picker search | /wisp thread + picker | FAIL |
| #10150 | ai-risk | operator-minted secret intents in reveal feed | /ai-risk approvals | BLOCKED |
| #10148 | knowledge | relabel to Knowledge | ee pages (flag off) | BLOCKED |
| #10130 | chat tools | W04 security/incident/device-op tools | /ai-risk guardrails | PASS |
| #10147 | docs | — | — | N/A |
| #10127 | agreements | agreements:send permission + lifecycle API | roles | PASS |
| #10140 | docs | — | — | N/A |
| #10128 | recipes | identity_onboarding web surface | /operator#tab=library | PARTIAL |
| #10124 | security agents | Control D / NextDNS vendors | config policy → security agents | PASS |
| #10118 | recipes API | — | with #10128 | PARTIAL |
| #10117 | chat tools | W03 backup/DR/virt tools | /ai-risk guardrails | PASS |
| #10087 | ai | per-domain lazy tool index | chat behaviour | PASS |
| #10070 | wisp | W08b Wisp home | /wisp | PASS |
| #10069 | docs | — | — | N/A |
| #10063 | mobile | — | — | N/A |
| #10066 | wisp API | W08a home API, link tools | with #10070 | PASS |
| #10067 | docs | — | — | N/A |
| #9443 | backup | per-snapshot key root, prefix UI | config policy → backup S3 | PASS |
| #10033 | wisp | W07b provenance, /admin/wisp overview | /admin/wisp, run detail | PASS |
| #9767 | chat tools | W02 PSA/billing write tools | /ai-risk guardrails | PASS |
| #10056 | chat | move conversations W5 | /ai/chat + panel | PASS |
| #10058 | tests | — | — | N/A |

## Sweep log (append as you go)

### [Nav crawl] — PASS (main session, 03:27Z)
- ✅ 66 sidebar destinations + `/admin/wisp`, `/workspace` render; no 5xx; `/workspace` 301 → `/ai/chat` ✓; `/ai-workspace` and `/ai-agents` are plain 404 pages (nothing links to them).
- ⚠️ UI/UX: `/wisp` with no grant logs a console error from `GET /wisp/home` 404 `no_grant` — an expected state should not be a red console line (P1).
- ⚠️ UI/UX: `/admin/wisp` as a non-platform admin → `GET /admin/wisp/overview` 403, page shows a "not enabled" style empty state rather than "you need platform admin" (P2). The route now exists (403, not 404) — #10141 is partly addressed; verify the platform-admin leg.

### [#10070 / #10157 Wisp grant — "All organizations"] — FAIL → FIXED `2d0f6ffa96` (see Fixes)
- ❌ BUG: Start Wisp → scope "All organizations" → TOTP → `GET /wisp/grants/preview?orgId=<ambient>` 200 (org-scoped ceiling) → `POST /auth/mfa/step-up` 200 → `POST /wisp/grants {orgId:null}` **403 `STEP_UP_REQUIRED`** → toast "Your access changed while you were confirming. Enter a new code to continue." — every attempt, forever. Root cause: `fetchWithAuth` injects the switcher's `?orgId=` into the partner-wide preview; the same injection makes `fetchWispThread(null)` a 404 `no_active_grant`, so an existing partner-wide grant was invisible to the side panel/home whenever an org was selected. Fix: `skipOrgIdInjection` on both reads in `apps/web/src/lib/wispGrant.ts` (+ red tests).
- ✅ After fix: preview `{scope:{orgId:null}}` → 201 → home "All organizations · Active · **$0.00 of $5.00 today** · resets in 21 h" (dollars ✓ #10157), brief/needs-you/activity/links panels render with empty states.
- ✅ Step-up modal copy "Turn on Wisp / Wisp works within what you are allowed to do. Confirm it is you to continue." radios "This organization / All organizations".
- ⚠️ UI/UX: the modal's error line and the toast say the same sentence at once (double messaging) (P3).
- ⚠️ UI/UX: MFA enrol → `POST /auth/mfa/enable` 200 then two 401s (notifications, approvals count) before the silent refresh — red console lines on a success path (P3).
- ⚠️ UI/UX: Breeze AI side panel opened by itself during the flow and stays open across navigations (persisted open state) — not a bug, but the panel default-open after a shortcut is easy to trigger (noted).

### [#10171 side panel in Wisp voice] — PASS (with paper cuts)
- ✅ Header button tooltip "Breeze AI (⌘⇧A)". With an active partner-wide grant the panel renders `wisp-thread-header` (scope "All organizations", Active, "$0.00 of $5.00 today", Pause Wisp, "Working on" focus select, attachments toggle, "Open in Wisp" → `/wisp`). No `wisp-toggle` anywhere ✓. `ai-open-in-assistant` hidden in Wisp mode ✓.
- ✅ Live turn (Sonnet 5.5): "Which of my devices are offline?" → `POST /ai/sessions/:id/messages` 200 → "Searched devices" → correct two-device answer in ~10 s, "Answered by Claude Sonnet 5.5".
- ❌→⚠️ The panel that was already open when the grant was created stayed "Breeze AI" (no Wisp header) until closed and reopened — the grant lookup runs only on panel open (P2).
- ⚠️ UI/UX: under a Wisp header the empty state still reads "Breeze AI — Ask about your devices, alerts, metrics…" with the generic quick prompts; mixed voice (P2; prior run's paper cut 9 still stands).
- ⚠️ UI/UX: header counter stays "0 msgs" after a completed exchange (P3; #10108 adjacent).
- ⚠️ UI/UX: #10107 holds — the open panel covers the bell/theme/account header icons.
- ⚠️ Noise: panel open fires `GET /wisp/thread` (200) then `GET /wisp/thread?orgId=` (404) then `/wisp/thread` again — two probes + a red console line per open (P3; prior paper cut 12).

### [#10070 / #10066 Wisp home — links, pause/resume, partner switch] — PASS
- ✅ Link an item → picker with 11 kinds (Tickets, Quotes, Invoices, Contracts, Devices, Organizations, Sites, Alerts, Agent runs, AI tasks, Users); search "MACOS" matches case-insensitively; row click → `POST /wisp/thread/:id/links` 201 → toast "Linked to Wisp", chip, "1 of 50 linked"; remove → "Link removed" ✓.
- ✅ Pause → 200 → toast "Wisp paused", status Paused, control copy "You paused Wisp. It won't check in or nudge you until you resume.", thread box "Wisp is paused. Resume it from the header to keep talking." Resume → "Wisp resumed", Active.
- ❌ (open #10104) reload while paused → `GET /wisp/concerns` 409 and `/thread/:id/activity` 409 → "Couldn't load concerns" / "Couldn't load activity" cards.
- ✅ Partner switch (`/settings/ai-agents`): off → `PUT /wisp/partner-settings` 200, toast "Wisp turned off"; `/wisp` shows `wisp-home-disabled` "Wisp is turned off — A partner administrator turned Wisp off under Settings → AI Agents. Your chats still work. Open AI Agents settings"; side panel drops to Breeze AI ✓; on → "Wisp turned on", grant back to Active automatically ✓.
- ❌ (open #10145) while partner-disabled the home still shows the grant header "Paused" with a live **Resume** button beneath the disabled banner.
- ⚠️ UI/UX: the switch card text reads "Wisp enabled" both on and off — the label does not follow the state (P3).
- ⚠️ UI/UX: copy says "Settings → AI Agents" / "Open AI Agents settings" while the sidebar entry is "Agents" under Workers and the hub card is "AI Agents" (P3; vocabulary drift).
- ⚠️ UI/UX: spend meter still "$0.00" and Activity "Nothing yet" after a live chat turn — chat turns neither show in Activity nor move the meter visibly (sub-cent rounding?) (P3, confirm intent).

### [#10165 sidebar / palette / Settings → AI hub] — PASS
- ✅ AI section order: Wisp, Breeze AI (`/ai/chat`), **Workers** heading, Agents (`/settings/ai-agents`), Runs, AI Tasks (`/operator`), Findings (`/fleet`), Impact. No AI Usage / Script authoring / Tool Sources entries.
- ✅ ⌘K empty state shows "Ask Breeze AI" (opens the panel) and "Open Wisp"; typing "wisp" finds `/wisp` (recent) and the "Wisp memory" setting; "?" sheet lists "Toggle Breeze AI ⌘+Shift+A".
- ✅ `/settings/ai` hub: AI Agents, AI Usage, AI Providers & Models (`/settings/partner#ai-provider`), Script authoring, Wisp memory, Tool Sources (Knowledge sources absent with the ee flag off ✓).
- ✅ `/wisp/chat#session=x` and `/workspace#session=x` → `/ai/chat`.
- ⚠️ UI/UX: palette quick actions are not searchable — typing "breeze ai" or "ask" returns "No results found" (P2).
- ⚠️ UI/UX: the legacy redirects drop the `#session=` fragment for an unknown id (fine), re-check with a real id below.
- ⚠️ UI/UX: `/settings/ai-agents` kind list has "Open fix memory" / "Open fleet design" links (fine) but the page title is still "AI Agents" while the nav says "Agents" (P3, vocabulary).

### [#10153 / #10155 / #10157 cohesion copy] — PASS (paper cuts)
- ✅ `/operator` title "AI Tasks", tabs Tasks / Library, empty "No AI tasks yet. Tasks you start from the Library, a ticket, a contact or an alert appear here." Library shows Offboard a person (readiness + setup required list) and the new Onboard card.
- ✅ `/alerts/:id` button "Start an AI task" → dialog "Start an AI task — The workers will investigate and try to resolve this with the recipe below. … Recipe: Service recovery".
- ✅ Device detail: "AI Tasks" tab lives in the More overflow (secondary until it has a count); "Link to Wisp" → "Linked in Wisp" + toast "Linked to Wisp".
- ✅ `/ai-risk` Guardrails: "Tier 1 — Reads (147 tools)", "Tier 2 — Acts and logs (66)", "Tier 3 — Asks first", "Tier 4 — Blocked". W02–W07 tools present (Manage Quotes/Tickets/Billing Catalog/Notification Channels, Execute Dr Plan, Manage Software Policy, Configure Network Baseline, Manage Ticket Config/Forms, Manage Time Suggestions, Manage Alert Correlations, Manage Device Anomalies, Reliability Feedback, Link Entity, Launch Specialist); reads sit in collapsed Tier 1 categories.
- ✅ `/fleet` title "Findings", description "Cross-device patterns the workers found, worth one action instead of many".
- ⚠️ UI/UX (P2): Guardrails tool names are naive title-case of the key — "Sync Edr Data", "Manage Dr Plan", "Manage Dns Policy", "Manage Ai Agents (Authorize Supervised Key)". Acronyms should stay upper-case.
- ⚠️ UI/UX (P2, vocabulary): `/ai-risk` → Approvals tab filter chips read "All · Pending · Approved · **Rejected**" (spec: Denied) — `security:aiRiskApprovalHistoryFeed.rejected`.
- ⚠️ UI/UX (P3, vocabulary): Guardrails row "Operator Plan — Approve an AI task plan" (tool key `operator_plan` leaks the retired noun).
- ⚠️ UI/UX (P3): Breeze AI context badge on `/fleet` says "Fleet Orchestration" (`FleetOrchestrationPage.tsx:247`) while the page is "Findings".
- ⚠️ UI/UX (P3): `/ai/chat` tab header shows "$0.06 this month · 1 msg" above an empty-state body — counter and body disagree on a fresh tab.

### [#10127 / #10162 / #10167 agreements — send for signature, public signing] — PARTIAL (one FAIL)
- ✅ Template create (modal is a plain `fixed inset-0` div, no `role=dialog`) → "Template created" → Upload PDF → "PDF version uploaded" (v1 Draft) → Publish.
- ✅ `/agreements/signed` → Send for signature dialog (org, template "QA Master Services Agreement — v1", contract optional, recipients, cover, expiry, label) → "Create draft & preview" (`POST /contracts/agreement-requests` 201, draft) → preview "This template is an uploaded document. The uploaded file is what the customer signs." → Send (`/send` 200) → toast "Sent, but email isn't configured. Copy the signing link from Awaiting signature and share it." → row under **Awaiting signature** with Copy link ("Signing link copied", `GET …/link` 200) and Void; `#status=pending` in the hash.
- ✅ Public page `/portal/agreement/<token>`: partner name, "Agreement from Default Partner for Default Organization", Awaiting signature, expiry, cover message, Download agreement, name + **required** email, signature preview, agree checkbox; Sign disabled until all three are set. No prices/lines. Sign → `POST /agreements/public/<token>` 200 `{status:"signed"}` → "Signed. We're emailing a copy to … If it doesn't arrive, contact Default Partner."
- ❌ BUG (P1, customer-facing): the inline document preview on the public signing page is blank — the iframe loads `GET /api/v1/agreements/public/<token>/file` which the API serves with `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`; Chrome shows "localhost refused to connect." inside the frame and logs a CSP violation. Download still works. The portal quote view's contract block (`/quotes/public/<token>/contract-file/<blockId>`, `documentHostComponents.tsx:85`) frames the same way and has the same defect (pre-existing). Fix: a path-keyed secure-headers variant (XFO SAMEORIGIN + `frame-ancestors 'self'`) for the two inline public file routes, following `byTrustCrossOriginPath`, or render via a fetched blob URL.
- ⚠️ UI/UX (P2): re-opening the signing link after signing shows "This agreement link is invalid or has expired." — no "already signed" state and no way to download the signed copy from the link; with email unconfigured (the toast case above) the signer has no copy at all.
- ⚠️ UI/UX (P3): recipients were not prefilled (the seed org has no billing contact) and the helper text still promises prefill — fine, but there is no hint when the org has no billing contact.
- ⚠️ UI/UX (P3): the Send dialog keeps "Select an agreement template" as a selectable placeholder option after one is chosen.
- ✅ Certified PDF (`?copy=certified`, 19 KB) appends a "Signature certificate" page: agreement, template v1, document id, parties, accepted-by (cursive + printed name + email), accepted-at UTC + local, signer IP, user agent, how, source request id, original-file SHA-256 + content hash, verification note. "Original" download returns the untouched 610-byte upload.
- ⚠️ UI/UX (P3): certificate "Signer IP" prints `::ffff:172.31.2.10` (IPv4-mapped form, and the caddy container's IP on this stack — check prod trusted-proxy resolution) and "How" says "via emailed link" even when the link was copied, not emailed.
- ⚠️ UI/UX (P3): the Create Policy button on `/configuration-policies/new` is disabled with tooltip "Select an organization for this policy." while the org select is still hidden (scope radio defaults to "A specific organization" but the message precedes any visible select).

### [#9443 backup S3 prefix / #10124 security agents vendors] — PASS
- ✅ Config policy → Backup → New destination → S3: key-prefix field with help "New snapshots are stored under <prefix>/snapshots/. Existing snapshots stay where they are. Changing it makes the next backup a full backup." Inline `aria-invalid` errors: `a//b` and `..` → "must not contain empty…segments", `snapshots` → "must not contain a \"snapshots\" segment", 300 chars → "at most 256 characters", `bad char!` → "use only letters, digits and …", `customer-a/site-1` → ok.
- ✅ Config policy → More → Security Agents: Huntress, SentinelOne, **Control D**, **NextDNS** cards; the DNS vendors show "Coming soon", platform notes (Windows automatic, macOS/Linux not supported), built-in package link, `controld_provisioning_code` tenant-variable note + link, coverage note (presence via service_running, install state in the generated software policy).
- ⚠️ UI/UX (P3): the Control D / NextDNS card says "Coming soon" and, in the same card, "it cannot be turned on until it is [in the catalog]" — two different reasons for the disabled toggle.

### [#10158 doomed launch_specialist refused before the approval card] — PASS
- ✅ "Run a health sweep on Default Organization now." → Wisp answered itself with read tools (orgs, alerts, devices, fleet health, posture) — a sensible, correct sweep summary, no writes.
- ✅ Forced call: "Use launch_specialist … health_sweep" → "Launch specialist — Failed — no_sweep_schedule" with **no approval card** rendered; model explained it did not retry.
- ⚠️ UI/UX (P3): the refusal surfaces the raw code `no_sweep_schedule` to the user; the tool result carries no human sentence or next step ("configure a sweep schedule under …").
- ✅ Forced `launch_specialist` kind `patch_plan` with no Patching agent configured → "Launch specialist — Failed — no_effective_agent", no approval card; model offered `list_ai_agents` / `manage_patches` instead. (One-card + org-name leg continues below once a Patching agent exists.)
- ⚠️ UI/UX (P3): same raw-code surfacing (`no_effective_agent`); the model guessed the meaning and said "the error doesn't explain itself".
- ✅ With a Patching agent (shadow) created via the 4-step wizard ("Agent saved"): forced `launch_specialist patch_plan` → **exactly one** inline approval "Your Approval Is Required — Wisp wants to run a patch plan at **Default Organization**: QA sweep: plan this month's Windows patches" with Show parameters / Approve / Deny (#10158 ✓ one card, org name, Approve/Deny wording ✓ #10157).
- ❌ BUG (P2): Approve → `POST /mobile/approvals/:id/approve` 200 → the launch then fails "admission_skipped (agent_disabled)" because the wizard creates the agent disabled ("Created disabled" on the review step). The doomed-launch pre-check (#10158) covers `no_effective_agent` but not a disabled effective agent, so the user is asked to approve work that cannot run.
- ⚠️ UI/UX (P3): the approval record says `requestingClientLabel: "Breeze AI"` for a Wisp-initiated action (vocabulary; Approvals page will attribute it to Breeze AI).
- ⚠️ UI/UX (P2): the agent wizard logs **93 missing i18n keys** — 90 `settings:aiAgentsPage.catalog.tools.*` (every W02–W07 tool plus many reads: `manage_software_policy`, `remediate_software_violation`, `validate_flow`, `test_ticket_routing_rule`, `search_script_library`, `get_alert_correlations`, `list_links`, …) and 3 `catalog.actions.manage_software_policy.*`; the capability lists fall back to humanized keys.
- ✅ Agent enabled via Edit drawer (`ai-agent-enabled`, note "Enabled and the mode are separate switches and a run needs both") → "Agent saved", card "Running · Next run …". Re-run: one card → Approve → "admitted: true" + run id → `/ai-agents/runs` shows the run **Completed · Manual · 2 findings to review · No action needed · 7s**; run detail carries `run-detail-wisp` **"Wisp for Breeze Admin"** (#10033 ✓) and "Cost $0".
- ⚠️ UI/UX (P3): the wizard's note says "You'll decide whether to start it running on the last step", but the review step only states "Created disabled" — enabling needs a second trip through Edit.
- ⚠️ UI/UX (P3): Wisp home Activity still "Nothing yet" and spend "$0.00" after a specialist run it launched; the run is visible only under Runs.

### [RBAC + platform admin legs] — PARTIAL
- ✅ Org Technician (`orgtech@breeze.local`, org scope, has `ai_sessions:use`): sidebar shows Wisp + Breeze AI only, **no Workers heading** ✓; `/wisp` → `location.replace` → `/ai/chat` ✓.
- ❌ (open #10145) the org-scoped user's sidebar Wisp entry is unlocked (no `nav-wisp-locked`, no title) and just bounces.
- ⚠️ Noise: org tech's app shell fires `GET /partner/billing/payment-settings` 403 and `GET /orgs/organizations/:id/effective-settings` 403 on every page (P3; same class as the tracked `/admin/*` 403s).
- ⚠️ First org-tech visit to `/wisp` bounced to `/login?next=/ai/chat&reason=session-expired` seconds after a fresh login; not reproducible on the second attempt (noted, not filed).
- ✅ Partner Viewer (no `ai_sessions:use`): no AI doors in the sidebar, no header Breeze AI button, `/ai/chat` → "Access denied" ✓.
- ❌ (→ #10200) Partner Viewer on `/wisp` gets "Could not load the Wisp home. Try again" with a Retry that cannot succeed.
- ✅ Admin re-login after `is_platform_admin=true` (TOTP step-up) → Administration nav shows Wisp → `/admin/wisp`.
- ❌ (open #10141, reproduced) `GET /api/v1/admin/wisp/overview` → **404 `Not Found`** (route still absent) and the page says "Wisp is not enabled on this deployment (BREEZE_WISP_ENABLED)" on a flag-on stack — misleading copy for a missing route.
- N/A #10148 Knowledge relabel (ee `BREEZE_WORKSPACE_ENABLED` off on wt-stack); #10150 reveal feed (needs real identity effects); #10128 onboarding launcher present in the Library (card + Start) but the recipe flag is off and no M365/Google connection — not driven.

## UI/UX paper cuts

| # | Where | Observation | Severity | Disposition |
|---|---|---|---|---|
| 1 | `/wisp` no grant | `GET /wisp/home` 404 `no_grant` → red console line on an expected state | P1 (noise) | #10200 |
| 2 | Wisp step-up modal | "All organizations" grant impossible (STEP_UP_REQUIRED loop) | P1 | fixed `2d0f6ffa96` |
| 3 | Wisp step-up modal | error line + toast carry the same sentence at once | P3 | noted |
| 4 | MFA enrol | two 401s then silent refresh after `/auth/mfa/enable` | P3 | noted |
| 5 | Side panel | panel open before the grant stays Breeze AI until reopened | P2 | #10195 |
| 6 | Side panel | Wisp header over "Breeze AI — Ask about your devices…" empty state | P2 | #10195 |
| 7 | Side panel | "0 msgs" after a completed exchange | P3 | #10108 |
| 8 | Side panel | covers bell / theme / account header icons | P2 | #10107 |
| 9 | Side panel | three `/wisp/thread` probes per open, one a 404 | P3 | #10200 |
| 10 | `/wisp` paused | 409 → "Couldn't load concerns / activity" | P2 | #10104 |
| 11 | `/wisp` partner-disabled | header still "Paused" + live Resume under the disabled banner | P2 | #10145 |
| 12 | `/settings/ai-agents` | switch card label "Wisp enabled" in both states | P3 | #10198 |
| 13 | Wisp copy | "Settings → AI Agents" vs nav "Agents"; "Turn on Wisp again" toast for a deleted toggle | P3 | #10198 |
| 14 | `/wisp` | spend meter "$0.00" / Activity "Nothing yet" after chat turns and a launched specialist run | P3 | noted — confirm intent |
| 15 | ⌘K | quick actions not searchable | P2 | #10196 |
| 16 | `/settings/ai-agents`, `/ai-agents/runs` | page titles "AI Agents" / "Agent Runs" vs nav "Agents" / "Runs" | P3 | #10198 |
| 17 | `/ai-risk` Guardrails | "Sync Edr Data", "Manage Ai Agents", "Operator Plan" | P2 | #10197 |
| 18 | `/ai-risk` Approvals tab | filter chip "Rejected" (spec: Denied) + 5 other leftover keys | P2 | #10198 |
| 19 | `/fleet` | Breeze AI context badge "Fleet Orchestration" | P3 | #10198 |
| 20 | `/ai/chat` | tab header "$0.06 this month · 1 msg" above an empty-state body | P3 | noted |
| 21 | Agreement template modal | plain `fixed inset-0` div, no `role=dialog` | P3 | noted |
| 22 | Public signing page | inline PDF blank (XFO DENY / frame-ancestors 'none'); quote contract block too | P1 | #10192 |
| 23 | Public signing page | re-open after signing → "invalid or expired", no signed copy | P2 | #10199 |
| 24 | Send dialog | recipients not prefilled when the org has no billing contact, no hint | P3 | noted |
| 25 | Send dialog | placeholder option stays selectable | P3 | noted |
| 26 | Certificate | Signer IP `::ffff:172.31.2.10`; "How: via emailed link" when copied | P3 | #10199 (How) / noted (IP) |
| 27 | `/configuration-policies/new` | Create disabled with "Select an organization" before the select is visible | P3 | noted |
| 28 | Security Agents card | "Coming soon" and "cannot be turned on until it is in the catalog" in one card | P3 | noted |
| 29 | Wisp `launch_specialist` | raw codes `no_sweep_schedule` / `no_effective_agent` / `agent_disabled` shown to the user | P3 | #10193 |
| 30 | Wisp `launch_specialist` | approval card for a disabled agent, failure after Approve | P2 | #10193 |
| 31 | Approval record | `requestingClientLabel: "Breeze AI"` for a Wisp launch | P3 | #10193 |
| 32 | Agent wizard | 93 missing `catalog.tools.*` / `catalog.actions.*` i18n keys | P2 | #10194 |
| 33 | Agent wizard | "You'll decide whether to start it … on the last step" but review only says "Created disabled" | P3 | noted |
| 34 | Org tech shell | `payment-settings` / `effective-settings` 403s on every page | P3 | noted |
| 35 | Org tech sidebar | Wisp entry unlocked, bounces to `/ai/chat` | P2 | #10145 |
| 36 | Partner Viewer `/wisp` | generic load error + useless Retry | P2 | #10200 |
| 37 | `/admin/wisp` | 404 route → "not enabled (BREEZE_WISP_ENABLED)" on a flag-on stack | P1 | #10141 |

## Fixes applied

| Commit | PR/area | What | Test |
|---|---|---|---|
| `2d0f6ffa96` | #10070 / #10171 Wisp grant | `fetchWispThread(null)` and `mintWispGrantStepUp({orgId:null})` pass `skipOrgIdInjection` so a partner-wide grant previews/reads partner-wide instead of picking up the switcher's `?orgId=` | `wispGrant.test.ts` (2 new, red→green), `WispGrantStepUpModal.test.tsx` (2 updated), Wisp web suites 249/249 |

## Issues filed

| Issue | Title | From row |
|---|---|---|
| #10192 | [Portal] Public agreement signing page: inline PDF preview is blank (XFO DENY / frame-ancestors 'none') | agreements |
| #10193 | [Wisp] launch_specialist approval card for a disabled agent, fails after Approve; raw refusal codes; "Breeze AI" label | #10158 |
| #10194 | [Web] AI agent wizard logs 93 missing i18n keys (catalog.tools.*) | agent wizard |
| #10195 | [UI] side panel keeps Breeze AI voice until reopened after a grant is created | #10171 |
| #10196 | [UI] ⌘K quick actions not searchable | #10165 |
| #10197 | [UI] Guardrails tool names naive title-case; "Operator Plan" | #10157 |
| #10198 | [UI] approval vocabulary leftovers (Rejected/refused) + Wisp copy drift + Fleet Orchestration badge | #10157 / #10153 |
| #10199 | [Portal] signing link after signing → "invalid or expired" | #10162 |
| #10200 | [Wisp] /wisp non-happy states: no-grant 404 console error, viewer generic load error | #10070 |

## Summary

| Group | PASS | PARTIAL | FAIL | BLOCKED | N/A |
|---|---|---|---|---|---|
| Nav crawl (66 + 3 extra) | 1 | | | | |
| Wisp (#10070 #10066 #10146 #10158 #10033 #10171) | 5 | 1 | 1 (fixed) | | |
| Cohesion (#10153 #10155 #10157 #10165 #10148) | 4 | | | 1 | |
| Chat tools W02–W07 (#9767 #10117 #10130 #10160 #10169 #10087) | 6 | | | | |
| Agreements (#10127 #10162 #10167) | 2 | | 1 | | |
| Recipes / ai-risk (#10128 #10118 #10150) | | 2 | | 1 | |
| Backup / security agents (#9443 #10124) | 2 | | | | |
| RBAC + admin | | 1 | | | |
| Non-UI commits | | | | | 10 |

**Top findings:**
1. **Partner-wide Wisp grants could not be created at all** (ambient `?orgId=` injection → ceiling-hash mismatch → STEP_UP_REQUIRED loop) and an existing partner-wide grant was invisible to the panel/home whenever an org was selected — fixed on this branch (`2d0f6ffa96`). The earlier Wisp E2E only exercised org-scoped grants.
2. **The customer-facing agreement signing page shows a blank document** (#10192) — the API's global anti-framing headers block the inline PDF; same for the quote contract block. Signing still works, so it is a trust/UX break rather than a functional one.
3. **Grant-driven voice has seams**: panel stays Breeze AI until reopened, mixed-voice empty state, approval records labelled "Breeze AI", `/admin/wisp` route still missing (#10141), 93 untranslated tool labels in the agent wizard.
4. **Doomed launches are not all caught before the card**: a freshly created (disabled) agent still gets an approval card (#10193).
5. Everything else in the delta that a browser can reach works end to end with a live model: Wisp home/links/pause/partner switch, live turns, one-card specialist launch → run → "Wisp for Breeze Admin", `/operator` AI Tasks, "Start an AI task", four tier names, dollars, Settings → AI hub, palette gates, redirects, send-for-signature → public sign → certified PDF, S3 prefix validation, Control D/NextDNS cards.

**Oldest PR reached:** #10058 (full delta covered).

**Before the release cut:** lab legs for #10060 (Office add-in), #10148 (ee Knowledge relabel with pgvector), #10150 (real identity effects), #10128 (M365/Google connection + `AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED`); decide #10104 (reads while paused); merge #10109 (previous sweep fixes; shard-9 flake, branch updated 10-26); fix #10192 before any customer sees a signing link.

**Stack left running** for Todd's Wisp test: `http://localhost:34124`, `admin@breeze.local` / `BreezeAdmin123!`, TOTP setup key `TCUK NAZN W3NF NMKI C4G6 ULFC FKA2 V32Z` (admin is platform admin; partner-wide Wisp grant Active; Patching agent "QA Patching agent" enabled, shadow; template "QA Master Services Agreement" + one signed agreement; config policy "QA sweep policy"); extra users `orgtech@breeze.local` (Org Technician) and `viewer@breeze.local` (Partner Viewer), same password. Tear down with `pnpm wt-stack down` from this worktree on branch `sweep/2026-10-25-main`.

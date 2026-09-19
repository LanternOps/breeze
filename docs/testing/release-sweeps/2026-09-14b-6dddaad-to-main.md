# Pre-release sweep (follow-up) — v0.113.0 sweep base `6dddaadec` → main `eee22184a` (2026-09-14)

| | |
|---|---|
| Range | `6dddaadec` (base of the morning sweep `2026-09-14-v0.113.0-to-main.md`, 2026-09-14 19:44Z) → `origin/main` `eee22184a` (#5807, 2026-09-15 00:06Z) — 17 commits |
| Gate | 33 open non-draft PRs against main (deps run #5836–#5858, agreements W02 #5835, evidence W01 #5842, helpdesk #5872, morning-sweep fixes #5871, #5855–#5857, #5873); none waited on, none merged |
| Stack | `pnpm wt-stack up` on `qa/sweep-post-v0.113.0-b` @ `eee22184a`, baseUrl `http://localhost:32819` |
| Flags enabled | `BREEZE_AI_AGENTS_ENABLED`, `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`, `BREEZE_AI_SCRIPT_AUTHORING_ENABLED`, `LLM_PROVIDER_CATALOG_ENABLED`, `MCP_BOOTSTRAP_ENABLED`, `MCP_OAUTH_ENABLED`, `WEBAUTHN_RP_ID=localhost` (no new flags in the diff) |
| Driver | skill `pre-release-sweep`; inventory: sonnet Explore; browser groups: opus, sequential |

## Change inventory

Status ∈ `TODO | PASS | PARTIAL | FAIL | BLOCKED | N/A`. Every row must leave `TODO`.

| PR | Merged | Surface | Title | Route / click-path | Expected visible outcome | Prereq | Status |
|---|---|---|---|---|---|---|---|
| #5807 | 09-15 00:06Z | web | Measured impact band — exposure-time cohorts on /ai-agents/impact (W04) | `/ai-agents/impact` → section `data-testid="measured-band"`, 7/30/90 pills, cohort rows `measured-cohort-*`, `measured-technician-minutes` | "Measured (correlational)" section; never says "saved"; omission placeholder `measured-*-omitted` under n<20/arm | AI_AGENTS_READ; ≥20 touched + ≥20 untouched items per cohort/window for real numbers | PARTIAL |
| #5869 | 09-14 23:59Z | api-only | Stream artifact blob puts through multipart Upload | `createS3BlobStorage().put()` via AI artifact capture/export | sha256 lands; over-`maxBytes` aborts with `BlobTooLargeError`, no partial object | S3 bucket configured (`S3_BUCKET`/`ARTIFACT_S3_BUCKET_*`) — not on this stack | BLOCKED |
| #5865 | 09-14 23:58Z | ci-test-chore | workspace nightly leak check sortBy | N/A | nightly job green | Vercel Sandbox creds | N/A |
| #5864 | 09-14 23:53Z | ci-test-chore | docs-only classifier under merge_group | N/A | docs-only queue entries skip code jobs | — | N/A |
| #5853 | 09-14 23:20Z | ci-test-chore | deflake Windows agent tests | N/A | Test Agent (Windows) stable | — | N/A |
| #5833 | 09-14 23:19Z | web + api | Ticket checklist primitive — table + registrations + REST + ticket card (W01) | `/tickets/[id]` main column `data-testid="ticket-checklist-card"`: `ticket-checklist-add-input` + `ticket-checklist-add`, `ticket-checklist-toggle-<id>`, `-edit-`, `-delete-`, `-up-`/`-down-`. REST `GET/POST /api/v1/tickets/:id/checklist`, `PATCH/DELETE /api/v1/tickets/checklist/:itemId`, `POST /api/v1/tickets/:id/checklist/reorder` | items + live progress; tick persists done_at/done_by; API-key tick → 403 `CHECKLIST_TICK_REQUIRES_USER` | TICKETS_WRITE, partner scope; tick needs interactive session | PARTIAL |
| #5834 | 09-14 23:18Z | web + portal | Agreements vocabulary — copy pass (W01) | `/quotes/[id]` "Agreement templates" + empty-state link "No agreement templates yet"; T&C helper line; `ContractDetail.tsx` new "Invoice note" row (renders `contract.terms`); Signed agreements panel description; portal proposal blocks say "agreement" | label swaps visible; no functional change | quote with no template; contract with non-empty terms | PASS |
| #5806 | 09-14 23:14Z | web (thin) + api | Narrative email delivery — authority gate, claim-before-send, reconciliation (W03) | `/ai-agents/runs/[id]` block `data-testid="narrative-delivery-summary"` (`-sent`/`-refused`/`-pending`/`-unknown`/`-unresolved`); `report_run_deliveries` rows; `routes/reports/recipients.ts` 409 on system-managed definition | delivery block appears when total>0 or unresolved | narrative report run with export-authority recipients; email transport for actual send | PARTIAL |
| #5692 | 09-14 (queue) | api-only (inert) | Additive API error codes with client-side translation (Task 3 of #3859) | `jsonError()` + `ERROR_CODES`; `runAction` translates `errors:<CODE>` — zero routes adopt it yet | nothing browser-observable | unit tests only | N/A |
| #5805 | 09-14 22:22Z | api-only | Harden the autonomous ticket private-note lane (W03) | AI triage private note → `audit_logs` row `actorType='ai_agent'`; CHECK `ticket_comments_agent_note_private_chk` rejects public AI note | DB/audit assertions | live AI autonomy run; else DB-level check only | PARTIAL |
| #5802 | 09-14 22:19Z | web + api | AI scorecard W02 — device page surfaces | device Overview right rail `data-testid="device-ai-activity-signal"`; Scripts history `AiInitiatorChip`; `GET /api/v1/devices/:id/scripts` (`aiInitiatorKind`,`hasAiOrigin`), `/ai-origin?source=execution\|command&sourceId=`, `/ai-activity?days=7` | chip/signal render only with an AI-dispatched execution; zero-state renders nothing | seeded AI-origin script execution / device_command | PASS |
| #5800 | 09-14 22:19Z | api-only | Per-event helpdesk admissions with ordered loop guard (#4212) | comment on a ticket repeatedly → distinct `ai_agent_runs` per comment (dedupe `ticket-commented:<id>`), 6th refused (cap 5) | `ai_agent_runs` count/dedupe keys | triage autonomy enabled | PARTIAL |
| #5791 | 09-14 21:57Z | portal | Hardware Lifecycle timeline hover, device links, e2e (W03) | portal `/reports/lifecycle` → `LifecyclePlanTable`; hover quarter cell `title="Q3 2027"`; click Computer cell on device row → `/devices#<id>` row rings ~3 s | tooltip + link + highlight | `enable_lifecycle=true` (seeded), report row `hardware_lifecycle` (seeded), devices with purchase dates | PASS |
| #5773 | 09-14 21:57Z | ci-test-chore | typecheck packages/shared in CI | N/A | Type Check covers shared | — | N/A |
| #5781 | 09-14 21:05Z | ci-test-chore | port intent-self-approve e2e onto grant-gated helper | N/A | spec passes | — | N/A |
| #5782 | 09-14 21:05Z | api-only | backup transferredSize finalized from terminal result | complete a backup job | `backup_jobs.transferredSize` = bytesBackedUp − referencedBytes | live backup target | BLOCKED |
| #5799 | 09-14 21:05Z | ci-test-chore | Integration Tests shard timeout 40 min | N/A | shard 3 no longer times out | — | N/A |

### Non-browser rows

- #5865, #5864, #5853, #5773, #5781, #5799 — CI/test only → **N/A** (verified by their own CI runs; #5864 additionally by the merge-queue runs that landed #5865/#5869 after it).
- #5692 — inert seam, zero adopting routes → **N/A** for browser QA; unit suites cover it.
- #5869 — needs S3 → **BLOCKED** locally (no bucket on the wt-stack).
- #5782 — needs a live backup target → **BLOCKED** locally.

Groups: 1 Tickets (#5833, #5805, #5800) · 2 AI agents (#5807, #5806) · 3 Devices/Portal (#5802, #5791) · 4 Billing copy (#5834).

## Sweep log (append as you go)

### [Group — area] — agent, timestamp

#### [#PR / area] — PASS | PARTIAL | FAIL | BLOCKED
- ✅ what was checked, concretely
- ❌ BUG: symptom → API actual (status + body) vs UI actual
- ⚠️ UI/UX: paper cut (also copy to the list below)
- BLOCKED: prerequisite

### [Group 1 — Tickets] — opus, 2026-09-15T00:26Z

Setup: ticket **T-2026-0001** (`3a4786ab-0bc0-4529-af19-12c1973f7b4a`, Default Organization) created through `/tickets/new`. Everyday-workflow baseline: ✅ create ticket works and toasts `Ticket T-2026-0001 created`, redirects to `/tickets#T-2026-0001`.

#### [#5833] — PARTIAL
- ⚠️ **Empty checklist is unreachable from the UI on this build.** `TicketChecklistCard` returns `null` when `total === 0 && mode === 'full'` (`apps/web/src/components/tickets/TicketChecklistCard.tsx:206`), and the `ticket-checklist-add-input` / `ticket-checklist-add` controls live *inside* that card — so a fresh ticket shows no card and there is no other add affordance anywhere in `apps/web/src`. `GET /tickets/:id/checklist` → 200 `{"data":{"items":[],"done":0,"total":0}}` (verified). Known, planned gap: the W01 plan leaves the empty-state affordance open and W02 (templates, "Apply template") resolves it — **W02 is not on main**. Net: at this commit a technician cannot start a checklist from the browser at all. First item seeded via REST to test the rest.
- ✅ Card position: main column (between description and feed), not the rail (verified in DOM). Also renders in the `/tickets` split-pane preview once items exist.
- ✅ Add via UI: 2 items added; live progress `0/1 → 0/2 → 0/3`.
- ✅ Tick via UI: progress `0/3 → 1/3`; DB `done_at`, `done_by_user_id` = admin, `org_id` denormalized (verified via psql).
- ✅ Edit label, reorder (`ticket-checklist-up-<id>`), delete — each re-checked in `ticket_checklist_items` and after a full reload; positions renumbered 0/1/2 on reorder (verified).
- ✅ REST (bearer, partner scope): GET 200 `{items,done,total}`; POST 201 full item body (`position`, `done:false`, `source:'manual'`, `sourceTemplateItemId:null`); PATCH `{done:true}` 200 stamps `doneAt`/`doneByUserId`; reorder 200 renormalizes; DELETE 200 `{deleted:true}`. Negatives: partial reorder list → 400 `CHECKLIST_REORDER_MISMATCH` `details:{expected:3,received:1}`; DELETE twice → 404; PATCH unknown uuid → 404 (all verified).
- ⚠️ API-key tick → 403 `CHECKLIST_TICK_REQUIRES_USER` **not reproducible live** (not-checked black-box): routes sit behind JWT `authMiddleware`; an API key is rejected at the door (`Bearer <key>` → 401 `Invalid or expired token`, `X-API-Key` → 401). Gate is reachable only by an MCP/AI-agent principal. Verified by source + unit test instead: `routes/tickets/checklist.ts:63-75`, `checklist.test.ts:213/:230`.
- ✅ Bonus: resolve/close soft-confirm fires — choosing Closed with 1/2 ticked raised "Unfinished checklist — 1 of 2 steps is unticked. Resolve anyway?" (verified).

#### [#5805] — PARTIAL
- ✅ DB CHECK verified live: INSERT `ticket_comments` with `is_public=true, origin_principal_kind='ai_agent'` (rolled back) → `violates check constraint "ticket_comments_agent_note_private_chk"`; same insert with `is_public=false` succeeds. `\d ticket_comments` shows `CHECK (origin_principal_kind <> 'ai_agent' OR is_public = false)`, partial unique index `ticket_comments_one_ai_note_per_run_uq`, RLS policy `breeze_ticket_parent_ai_agent_insert`.
- ✅ (inferred, source) `addAiTriageNote` (`services/ticketService.ts:1622`) inserts `originPrincipalKind:'ai_agent', isPublic:false, commentType:'internal'` then `createAuditLogAsync({ actorType:'ai_agent', actorId: runId, action:'ticket.comment', initiatedBy:'ai', … })`.
- BLOCKED (live half): no `audit_logs` row observable — `ai_agents` and `ai_agent_runs` are both 0 rows on this stack.

#### [#5800] — PARTIAL
- ✅ Per-event admission is live-observable: two UI comments produced two separate admission attempts in the API log, `dedupeKey: 'ticket-commented:<commentId>'` matching the comment row id; ticket creation logged `ticket-created:<ticketId>` (verified).
- BLOCKED: every attempt ends `admission skipped { reason: 'no_effective_agent' }` (zero `ai_agents`), so `ai_agent_runs` stays 0 and the cap-of-5 never engages.
- ✅ (inferred, source) `MAX_TRIAGE_RUNS_PER_TICKET = 5` (`services/aiAgents/ticketHelpdeskSubscriber.ts:302`); `triageRunCeilingReached` fails closed on read error. In-file header notes the cap is **soft** (check-then-act not ticket-locked; advisory lock keyed `(agentId, orgId)`) — flagged as a fast-follow in code; confirm it's tracked.

#### Everyday ticket checks
- ✅ Create → toast; ✅ Assign to self → toast `Assigned` + timeline; ✅ Status → Pending opens "What are you waiting on?" form, submit → toast `Status updated` + timeline; ✅ Comment ×2 → 201, both in feed and after reload (no toast; `TicketComposer` has no `successMessage` — measurement, not finding).

#### Paper cuts
| Where | Observation | Severity |
|---|---|---|
| `/tickets/<id>` checklist card | Ticket with no checklist shows nothing — no card, no "Add checklist" affordance; checklist can only be started via API until W02 ships. | Medium |
| `locales/en/checklists.json:28-30` | Close-gate copy says "Resolve anyway?" / "Resolve anyway" for a shared resolve/close gate. | Low |
| same | `body_one`: "1 of 2 steps is unticked" — plural noun, singular verb. | Low |
| `ticket_checklist_items.position` | UI delete leaves sparse positions until next reorder; invisible to users. | Info |

State left on the stack: ticket T-2026-0001 (2 checklist items, 2 comments), API key "QA G1 checklist key".

### [Group 4 — Billing copy] — opus, 2026-09-15T01:02Z

#### [#5834] — PASS (one copy miss + paper cuts)
Checklist built from `git show 10adcf519 -- apps/web/src/locales/en`; all verified in the running UI:
- ✅ `/contracts` tab strip: **Contracts · Agreement templates · Signed agreements · Currency mismatches**.
- ✅ Agreement templates tab: title, description, button "New agreement template", empty state "No agreement templates yet", dialog "New agreement template" / "Create agreement template".
- ✅ Signed agreements tab: description + empty state "No unlinked signed agreements".
- ✅ Quote editor ADD SECTION menu + CONTENTS outline read "Agreement / terms".
- ✅ Quote editor agreement block: label "Agreement template"; empty state "No agreement templates yet. Create one under Contracts → Agreement templates." — "Create one" is a real `<a href="/contracts#tab=templates">` and lands on the Agreement templates tab selected (clicked, verified).
- ✅ Terms panel heading "TERMS & CONDITIONS (PLAIN TEXT)" + helper "For reusable legal terms, add an Agreement / terms section — the customer signs it with the proposal."
- ✅ `ContractDetail` "INVOICE NOTE" row renders `contract.terms` (`Net 30. G4-SWEEP-INVOICE-NOTE.`); cleared → row absent (verified both directions).
- ✅ Signed agreements panel description "Accepted with the quote, pinned to the template version the customer saw."
- ✅ Template editor body `aria-label` "Agreement template body".
- ✅ Portal proposal block (built the chain: template → publish v1 → attach → line → send; opened `/portal/quotes/<id>` as portal user): renders with footer "G4 Master Services Agreement — v1"; zero occurrences of "Contract" on the portal proposal page. Error-branch strings ("Agreement content unavailable" / "Download agreement" / "Agreement file unavailable") source-verified, runtime not-checked.
- ✅ Everyday: every mutation toasted (Draft quote created, Contract created, Line added, Contract activated, Template created, Draft version saved, Version published, send-with-undo, Proposal sent); zero 4xx/5xx on `/api/` across the session.
- ❌ BUG (copy miss, all 8 catalogs): `quotes.document.contract.unavailable` still reads **"Contract file unavailable"** while its siblings were renamed (`download` → "Download agreement", `previewTitle` → "{{name}} agreement") and the portal twin says "Agreement file unavailable". Used 3× in `apps/web/src/components/billing/quotes/QuoteDocument.tsx` (103, 298, 305). Not reachable on the happy path (needs a template version with no body and no file). Verified by grep + per-catalog read. → fixed on this branch (see Fixes applied).
- ❌ BUG (pre-existing, not a #5834 regression): on the admin quote Detail tab (`/billing/quotes/<id>`) the Agreement / terms block renders as an empty **"PRICING"** table ("No lines in this table."). Root cause `apps/web/src/components/billing/quotes/QuoteDetail.tsx:488` — `BlockView` branches on `heading`/`rich_text`/`image` then falls through to `LineTable` for every other type (`contract`, `table`, `callout`). Reproduced in browser + confirmed in source. Portal renders the same block correctly. → issue filed (see Issues filed).

#### Paper cuts
| Where | Observation | Severity |
|---|---|---|
| Contract editor → CONTENT | Both field hints now carry the *same* parenthetical: "Notes (optional, added to the Notes block on generated invoices)" and "Invoice note (optional, added to the Notes block on generated invoices)" — the copy no longer distinguishes the two fields. | Medium |
| `billing.json` `quotes.editor.toasts.contractSectionAdded` | Renamed in 8 catalogs but referenced by no component; adding the agreement section fires no toast (only the "Saved HH:MM" autosave stamp). Dead key, pre-existing. | Low |
| `/billing/quotes/<id>` + `/contracts/<id>` | Both pages fire `catalog/distributors/td-synnex-ec/status`, `pax8/integration`, `catalog/distributors/pax8/status` in a tight repeating loop — ~120 requests per visit, all 200. Pre-existing; will trip the 300/60 s limiter for anyone sweeping. | Medium |
| Quote editor agreement empty state | Copy says "under Contracts → Agreement templates" but the left nav still labels the destination "Contracts" (W03 scope). | Low |

Stack state: quote `Q-2026-0001` (Viewed, agreement block + one line), contract "G4 sweep contract" (Active), template "G4 Master Services Agreement" v1. Portal login is now `portal@breeze.local` / `BreezeAdmin123!` (password hash copied from admin; the seeder's `QaSweep2026!` was overwritten).

### [Group 2 — AI agents] — opus, 2026-09-15T01:10Z

#### [#5807] — PARTIAL
- ✅ `/ai-agents/impact` renders `measured-band` with `measured-caption`, `measured-alert-resolution`, `measured-cohort-<ruleId>`, `measured-ticket-omitted`, `measured-technician-minutes`, `measured-logging-coverage`, `measured-censored-note` (verified).
- ✅ Copy rules: "saved" absent, "before/after" exactly once, "correlational" present. Caption: "AI-touched vs untouched work of the same kind, in the same window. Not a before/after comparison, and not a causal claim — the AI generally reaches the easier items first."
- ✅ 7/30/90 pills toggle `aria-pressed` exclusively and refetch `GET /ai/agents/impact/measured?window=N&orgId=…` → 200 each.
- ✅ 30-day cohort renders: `High CPU usage` / `AI-touched 100% · 20 in cohort` / `Untouched 100% · 20 in cohort`; ticket cohort shows the omission placeholder. 7-day view `insufficient_data` — consistent with seeded `resolved_at` 10–14 days back (verified via psql).
- ✅ Estimated band above still renders (empty state); no React errors. Error state: 500 on the measured endpoint → `measured-error` "The measured comparison could not be loaded." (visible, not silent); `window=999` → 400 Zod.
- ❌ BUG: API returns `censoredP50Minutes: 5` (AI) vs `1080` (untouched) — a 216× gap — but `grep -rn censoredP50 apps/web/src` = 0 hits: `ArmFigure` (`components/aiAgents/ImpactMeasuredBand.tsx`) renders only `proportionWithinHorizon` + `n`, so both arms read 100% and read as "no difference", while `measured-censored-note` disclaims percentiles the UI never shows (`impactStatistics.ts:99-100`). → issue filed.
- ⚠️ At `window=90` `ticketFirstResponse` → `omitted:"insufficient_followup"` → copy "This window is too short… Try a longer window." on the longest window. `impactMeasuredSignals.ts:153-155` conflates "only 9 tickets in org" with "too recent". → same issue.
- ⚠️ `technicianMinutes` returns `omitted:null` + `cohorts:[]` → heading + "Time logged on 0% of AI-touched tickets and 0% of untouched ones…" above zero rows. → same issue.
- ℹ️ Measured fetch fires twice per window change — StrictMode dev double-invoke (inferred).

#### [#5806] — PARTIAL
- ✅ 409 gate on both writers of `routes/reports/recipients.ts` against the seeded `ai_org_narrative` definition: `POST …/recipients` → 409 `{"error":"report_type_system_managed","type":"ai_org_narrative"}`; `POST …/recipients/convert` → 409 same; control on `executive_summary` → 404 Contact not found (discriminating); `GET …/recipients` 200 (read not gated). Marker is `reports.type ∈ INTERNAL_REPORT_TYPES` (`schemas.ts:34`), no flag column.
- ✅ Delivery block content: `narrative-delivery-sent` "Emailed to 1 of 2 recipients"; `narrative-delivery-refused` "1 recipient was not emailed — report authority, a missing address, or the provider refused."; `-pending`/`-unknown`/`-unresolved` absent at zero. Flipping one row `sent → pending` via psql → "Emailed to 0 of 2 recipients" + "1 delivery has not been sent yet — it will be retried." (restored).
- ❌ BUG: block cannot render without a narrative payload. `RunDetailPage.tsx:1594` opens `{run.narrative && (` and the delivery summary at `:1668` is nested inside, so the effective condition is `run.narrative && (total > 0 || recipientsUnresolved)` — contradicting the block's own comment ("Rendered whenever there are delivery rows OR the recipient lookup failed"). Seeded run with `outcome='{}'` (narrative null) + `narrativeDelivery.total=2` → block absent; writing an `outcome.narrative` made it appear (restored). Reachability in prod not-checked (needs a run with deliveries but a lost/failed outcome persist). The `recipientsUnresolved` branch is unreachable for such a run. → fixed on this branch.

#### Everyday checks
- ⚠️ `/ai-agents` → 404 (no index page; only `impact`, `fleet-design`, `runs/`). Not a regression.
- ✅ `/ai-agents/runs` loads 25 rows, filters, ordering; alert-linked run opens cleanly.
- ⚠️ Run page fires `GET /ai/agents/exposure-budget?…&kind=triage` → 404, absorbed into "No active agent policy for this run's organization." Handled, but a 404-as-empty pollutes the console.
- No 5xx anywhere in the group.

#### Paper cuts
| Where | Observation | Severity |
|---|---|---|
| `/ai-agents/impact` measured band | `censoredP50/P90Minutes` never rendered; both arms read 100%; censored note disclaims values not on screen | Medium |
| `/ai-agents/impact` ticket cohort | 90-day view says "Try a longer window" — none exists; reason class flips on window length | Medium |
| `/ai-agents/impact` technician minutes | `omitted:null` + empty cohorts renders "0% … and 0% …" above zero rows | Low |
| `/ai-agents/impact` error state | no retry affordance | Low |
| `/ai-agents/runs/[id]` | delivery summary nested under `run.narrative` | Medium (fixed) |
| `/ai-agents/runs/[id]` | `exposure-budget` 404 on every run without a policy | Low |
| `/ai-agents` | bare path 404s, no redirect to `/ai-agents/runs` | Low |

DB state: all mutations restored.

### [Group 3 — Devices / Portal] — opus, 2026-09-15T01:16Z

#### [#5802] — PASS
- ✅ Device 1 Overview right rail `device-ai-activity-signal`: "AI activity 2 actions dispatched in the last 7 days"; tooltip explains counting basis. Device 2 zero-state: no signal, no chips, nothing rendered (verified).
- ✅ Scripts history: AI row carries one `AiInitiatorChip` "AI agent"; human row none. Chip is a button → provenance popover ("QA Sweep Seed Agent / Occurred … / Open agent run") → `/ai-agents/runs/70d99999-…` loads (verified end-to-end). Execution detail modal shows Run context "Not recorded" + "AI agent" side by side; list rows carry only the AI chip by design (`DeviceScriptHistory.tsx:572` vs `:715-717`).
- ✅ API: `/devices/:id/scripts` → `{aiInitiatorKind:"ai_agent",hasAiOrigin:true}` / `{null,false}`; `/ai-activity?days=7` → `dispatchedActions:2` (device 2 → 0); `?days=60` → **400** "days: Too big: expected number to be <=30" (rejects, not clamps); `/ai-origin?source=command&sourceId=<reboot>` → 200 `{kind,label,occurredAt,toolName:null,resolvable:true,agentRun:{id}}`; `has("session")` = false — keys omitted, never null (`aiOriginSummary.ts:92-93` conditional spread; the no-access branch inferred, single-partner stack); random uuid → 404; human execution → 200 `{data:null}`; cross-device lookup → 404 (no leak).
- ✅ Activity feed surfaces `ai.command.executed` as "ai › command › executed — e2e-macos.local", actor AI Agent, initiatedBy AI; `details.aiAgentRunId` stripped (redaction contract holds). Measurement note: the seeder wrote `device_commands` directly (bypassing `commandQueue.writeAiCommandAudit`), so one `ai.command.executed` audit row was seeded via psql to exercise the surface.

#### [#5791] — PASS
- ✅ `/portal/reports/lifecycle` renders both devices: macOS 4 yr / Jun 2022 / Replace now / "3 months over"; Windows 1 yr / Mar 2025 / On track.
- ✅ Quarter cell `lifecycle-timeline-quarter-12` has `title="Q3 2027"`; 40 cells from Q3 2024 forward.
- ✅ Computer cell `lifecycle-plan-row-link-<id>` = `<a href="/portal/devices#42fc7de0-…">` (withBase). Click lands there; row `portal-device-<id>` is in viewport with `ring-2 ring-primary ring-inset` at ~3.3 s, gone by ~10 s (`HIGHLIGHT_DURATION_MS = 3000`). Measurement caveat: first two reads showed `ring:false` only because the MCP round trip outran the 3 s window.
- Manual-asset rows: not-checked (no manual asset in this org).

#### Everyday checks
- ✅ Portal dashboard, portal devices list, web `/devices`, all 12 device-detail tabs switch with no new console errors.

#### Paper cuts
| Where | Observation | Severity |
|---|---|---|
| Portal lifecycle → Computer cell | With `enable_self_service=false` but `enable_reports=true`, the report is visible but its device links redirect silently to `/portal/quotes` — customer clicks a device name and lands on Proposals. Two flags gate link vs target. Suggest plain text when self-service is off. | Medium |
| Portal `DeviceList` | Hydration mismatch on every load: "Last backup" SSR "Yesterday" vs client "2 hours ago" → full tree re-render; also delays the `#<id>` scroll/ring to ~3 s. | Medium |
| `/api/v1/reliability/<deviceId>` | 404 on every device detail load without a snapshot — console noise on the happy path. | Low |
| `/ai-agents/runs/<id>` | Header "Completed: Pending" while facts block says "Finished …" — likely seed-status artifact. | Low |

Environment: `portal_branding.enable_self_service` flipped to true to reach `/portal/devices`, restored to false. One seeded `audit_logs` row left in place.

## Summary

| Group | PASS | PARTIAL | FAIL | BLOCKED | N/A |
|---|---|---|---|---|---|
| 1 Tickets (#5833 #5805 #5800) | 0 | 3 | 0 | 0 | 0 |
| 2 AI agents (#5807 #5806) | 0 | 2 | 0 | 0 | 0 |
| 3 Devices / Portal (#5802 #5791) | 2 | 0 | 0 | 0 | 0 |
| 4 Billing copy (#5834) | 1 | 0 | 0 | 0 | 0 |
| Non-browser (#5869 #5782 · #5692 + 6 CI/test) | 0 | 0 | 0 | 2 | 7 |
| **Total (17 rows)** | **3** | **5** | **0** | **2** | **7** |

Every PARTIAL is either a live-AI prerequisite this stack cannot meet (#5805, #5800 — `ai_agents` empty, no LLM provider) or a defect fixed on this branch (#5806) / filed (#5807) / covered by an open wave (#5833 → W02 #5810). No FAIL remains against the fixed tree.

### Top findings

1. **Delivery evidence gated on the wrong thing** (#5806): the narrative delivery summary was nested under `run.narrative`, so exactly the runs whose delivery matters most (outcome lost, recipients unresolved) showed nothing. Fixed (`6ba6ca4d9`). Pattern: a "render whenever X" comment sitting inside an unrelated conditional — worth a grep for other `data-testid` blocks whose stated contract is broader than their JSX ancestry.
2. **Measured impact band hides its own signal** (#5807 → #5879): the API returns a 216× median gap, the UI renders only proportion-within-horizon (100% vs 100%), and a disclaimer about percentiles that are never shown. Plus the 90-day "try a longer window" dead end. Product-level follow-up, not a one-file fix.
3. **Vocabulary passes miss the sibling key and the sibling renderer** (#5834): one un-renamed key in 8 catalogs (fixed `03a57f49a`), and the admin QuoteDetail tab still rendered every non-line block as an empty pricing table (pre-existing, fixed `f5b7cc57b`) — the customer read "Agreement", the tech read an empty "PRICING".
4. **Unstable `can` closure from `usePermissions`** (#5878): any effect depending on `[can]` re-fires every render. Fixed at the one known call site (`5faa13f72`); the durable fix is memoizing `can` in `permissions.ts` — grep `\[can\]` before assuming ContractEditor was the only one.
5. **Feature shipped without its entry point** (#5833): checklist card returns null at 0 items and the add form lives inside it; W02 #5810 is the planned resolution. Nothing broken, but a release cut before W02 ships the primitive invisible.
6. **Portal flag pairs** (#5791): `enable_reports` shows a report whose links need `enable_self_service`; the customer lands on Proposals. Filed #5880 (needs branding threaded into the lifecycle page).

Oldest PR reached: #5781/#5782/#5799 (queue-landed 21:05Z, CI/API-only). Base of the morning sweep (`6dddaadec`) is the lower bound; nothing older was re-swept.

### What a release cut still needs

- Merge #5871 (morning-sweep fixes) and this PR before tagging.
- BLOCKED rows need a hosted/staging check: #5869 (S3 artifact multipart — verify one large `export_dataset` artifact lands with the right sha256 on a bucket-backed environment) and #5782 (backup transferredSize on a live target).
- Live-AI halves of #5805/#5800 need an org with an enabled triage agent + LLM provider: confirm one `audit_logs` row with `actorType='ai_agent'` after an AI private note, and that a 6th human comment on one ticket is refused.
- No new flags to enable.

## UI/UX paper cuts

| # | Where | Observation | Severity | Disposition (fixed <sha> / issue # / noted) |
|---|---|---|---|---|
| 1 | `/tickets/<id>` checklist | No card / no add affordance at 0 items | med | W02 #5810 (open) |
| 2 | `checklists.json` close gate | "Resolve anyway" copy on a shared resolve/close gate; `body_one` singular/plural mismatch | low | noted |
| 3 | `/ai-agents/impact` | p50/p90 never rendered; 90-day "try a longer window"; empty technician-minutes state; no retry on error | med | #5879 |
| 4 | `/ai-agents/runs/[id]` | delivery summary nested under `run.narrative` | med | fixed `6ba6ca4d9` |
| 5 | `/ai-agents/runs/[id]` | `exposure-budget` 404 on every run without a policy (console noise) | low | noted |
| 6 | `/ai-agents` | bare path 404s, no redirect to `/ai-agents/runs` | low | noted |
| 7 | `/billing/quotes/<id>` Detail | agreement/table/callout blocks rendered as empty PRICING table (pre-existing) | med | fixed `f5b7cc57b` |
| 8 | `billing.json` | `quotes.document.contract.unavailable` left as "Contract file unavailable" in 8 catalogs | low | fixed `03a57f49a` |
| 9 | Contract editor CONTENT | Notes and Invoice note hints carry the identical parenthetical | med | noted |
| 10 | `billing.json` | `quotes.editor.toasts.contractSectionAdded` dead key (translated 8×, referenced 0×) | low | noted |
| 11 | `/contracts/<id>` | distributor-status effects re-fire every render (~120 GETs) | med | #5878, fixed `5faa13f72` |
| 12 | Quote editor agreement empty state | copy says "Contracts → Agreement templates" but nav still says Contracts (W03 scope) | low | noted |
| 13 | Portal lifecycle Computer cell | links redirect to Proposals when `enable_self_service=false` | med | #5880 (flag not reachable from the table without new page→prop plumbing) |
| 14 | Portal `DeviceList` | hydration mismatch on relative "Last backup" time | med | #5881 (`formatRelativeTime` computes `now` at SSR and again at hydration; local-tz day buckets) |
| 15 | `/api/v1/reliability/<id>` | 404 on happy path without a snapshot | low | noted |
| 16 | `/ai-agents/runs/<id>` header | "Completed: Pending" vs facts "Finished …" (seed artifact?) | low | noted |

## Fixes applied

| Commit | PR/area | What | Test |
|---|---|---|---|
| `6ba6ca4d9` | #5806 / ai-agents web | `RunDetailPage.tsx` delivery summary was nested under `run.narrative &&`, so a run with deliveries (or a failed recipient lookup) but no narrative payload showed nothing; extracted `NarrativeDeliverySummary`, mounted inside the narrative section and in a standalone section when narrative is null | `RunDetailPage.test.tsx` +2 (red → green), 116/116 |
| `5faa13f72` | #5878 / contracts web | `ContractEditor.tsx` three distributor-status effects depended on the unstable `can` closure and re-fired every render (~120 GETs per page view); now depend on the precomputed `canWrite` boolean (QuoteEditor pattern). Follow-up noted: memoize `can` in `usePermissions` | new `ContractEditor.distributorRefetch.test.tsx` (3 calls → 1, red → green); `ContractEditor*` 9 files / 96 tests green |
| `f5b7cc57b` | pre-existing / quotes web (found via #5834 row) | `QuoteDetail.tsx` `BlockView` fell through to `LineTable` for `contract`/`table`/`callout` blocks, rendering an empty "PRICING" table on the admin Detail tab; adds read-only renderers for the three types matching QuoteDocument/portal | new `QuoteDetail.test.tsx` 3/3 (red → green); `QuoteDetail*` siblings 11 files / 115 tests green |
| `03a57f49a` | #5834 / web locales | `quotes.document.contract.unavailable` still said "Contract file unavailable" in all 8 catalogs while its siblings and the portal twin were renamed; now "Agreement file unavailable" with each locale's own agreement term | `terminologyQuality.test.ts` new assertion (red → green), 98/98 across terminologyQuality/localeParity/translationCoverage |

## Verification of fixes

- `apps/web` `tsc --noEmit`: no errors in any touched file. 26 pre-existing `TS2769` errors at `zodResolver(...)` call sites (LoginForm, AlertRuleForm, …) are present on `origin/main` untouched files — `@hookform/resolvers` 5.4 vs `zod` 4.4 typing; web tsc is not a CI gate (Type Check runs `apps/api` + `packages/shared` only), so out of scope here.
- Per-fix unit suites listed above; eslint clean on every changed file.

## Issues filed

| Issue | Title | From row |
|---|---|---|
| #5880 | Portal lifecycle device links redirect to Proposals when self-service is off | #5791 paper cut |
| #5881 | Portal DeviceList hydration mismatch on relative "Last backup" time (SSR vs client `now`) | #5791 paper cut (pre-existing) |
| #5879 | Measured impact band never renders censored p50/p90, mislabels the 90-day omission, empty technician-minutes state (#5761 follow-up) | #5807 |
| (no new issue) | Checklist cannot be started from the UI at 0 items — already the stated scope of open W02 #5810 ("apply template"); nothing visibly broken, the card is simply absent until then | #5833 |
| #5878 | Quote/contract detail pages re-fetch distributor status in a loop (~120 requests per page view) — pre-existing since #2025; `ContractEditor.tsx:388-426` effects depend on the unstable `can` closure from `usePermissions` | Group 4 paper cut |

## Summary

| Group | PASS | PARTIAL | FAIL | BLOCKED | N/A |
|---|---|---|---|---|---|

**Top findings:**

**Oldest PR reached:** #…

**Before the release cut:** flags to enable, BLOCKED rows needing a live agent, open issues.

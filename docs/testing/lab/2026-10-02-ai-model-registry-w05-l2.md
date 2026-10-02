# AI model registry W05 — lab gate L2 results (real switching, continuation, carried-rate billing)

Feature #7598, wave W05 (#7603, PR #7763). Gate: release-blocking for v0.121.

- **Date:** 2026-10-02
- **Build:** `origin/main` @ `7580866d76` (contains #7763), `pnpm wt-stack up` in a fresh worktree
- **Models:** real platform Anthropic key (stack env only; never logged or committed)
- **Spend:** **USD 8.10** from the `ai_invocations` ledger, plus about USD 0.01 of direct Haiku calls in the summarizer check. Cap was USD 20.
- **Driver:** Playwright MCP against the web UI, with API/SQL checks after each scenario. Screenshots are in the worktree's gitignored `.superpowers/lab-w05-l2/`.

## Verdicts

| # | Scenario | Verdict |
|---|---|---|
| 1 | Same-connection resume switch, Sonnet → Opus | **PASS**, but only with a workaround for defect #7768 |
| 2 | Too big for the target → continuation | **PARTIAL**: mechanics pass; the summaries of the filler-heavy test chat were unusable (see below) |
| 3 | Interrupt, then switch | **PASS** |
| 4 | Carried rates | **NOT OBSERVED** (the binding carries them; no late delta occurred) |
| 5 | Locked surface | **PASS** |

**Defects filed (not fixed here):**
- **#7768** — the model picker vanishes once a session exists: `fetchWithAuth` injects an ambient `?orgId=` next to `?sessionId=`, and the endpoint answers 400 "Pass a session or an organization, not both." Without a workaround, scenarios 1–3 cannot be run through the composer. **Release-blocking.**
- **#7769** — opening another chat from History leaves the previous chat's picker state (`switchSession` never reloads choices). The label can show a model the next turn does not use.

## Setup

- **Cutover:** already run for the seed partner at boot (`ai_model_registry_partner_cutover` has the row; `cutover_completed_at` is set).
- **Offerings:** the backfill gave Sonnet 5.5 (partner default) and Haiku 4.5. **Opus 5.5 had a platform price but no partner offering, so I inserted one by SQL** (`partner_ai_models`, `source='platform'`, enabled). Permission: `permitted_offering_ids` is NULL (all permitted), no `required_permission`.
- **Platform rates (¢ per M tokens, in/out/cache-read/cache-write):** Sonnet 5.5 200/1000/20/250; Opus 5.5 400/2000/20/500; Haiku 4.5 100/500/10/125.
- **Windows:** Sonnet 5.5 and Opus 5.5 have 1M windows; Haiku 4.5 has 200k.
- **Stack traps hit (not product bugs):** the root `.env` copy needs `BREEZE_WORKSPACE_ENABLED=false` (no pgvector in the dev Postgres) and a free `BREEZE_DOCKER_SUBNET`/`BREEZE_CADDY_IP`/`TRUSTED_PROXY_CIDRS` when other stacks hold `172.31.0.0/24`.
- **Scenario 5 setup:** `ai_model_assignments.allow_user_choice=false` on the partner's `chat/default` row, by SQL.

## Scenario 1 — Sonnet → Opus, same connection: PASS

Chat of 3 turns on Sonnet 5.5 (two with tool calls), then Opus 5.5 picked in the composer and a question that depends on earlier history.

- **Workaround for #7768:** a Playwright route rewrite that drops `orgId` from `GET /ai/models/choices/chat?sessionId=…` (no product code changed).
- **Resume, not continuation:** same session id; `ai_sessions.model = claude-opus-5-5`; `last_turn_model = {requestedModel/servedModel: claude-opus-5-5, fallbackUsed:false}`; the UI shows "Answered by Claude Opus 5.5".
- **History intact:** asked "which number did I ask you to remember?" (7421, set two turns earlier on Sonnet) — Opus answered `7421`.
- **Menu:** shows each offering's context window and price (`1M context · $2 in / $10 out per M tokens` etc.).

Ledger (one row per turn; deltas, not cumulative; ids redacted):

| turn | served | in | out | cache-read | cache-write | cost ¢ | SDK cumulative $ | Δ SDK $ |
|---|---|---|---|---|---|---|---|---|
| 1 | sonnet-5-5 | 4 | 59 | 18,333 | 18,552 | 5.06446 | 0.051609 | 0.051609 |
| 2 | sonnet-5-5 | 6 | 205 | 56,234 | 757 | 1.52013 | 0.066810 | 0.015201 |
| 3 | sonnet-5-5 | 2 | 4 | 19,309 | 85 | 0.41183 | 0.070928 | 0.004118 |
| 4 (after switch) | **opus-5-5** | 2 | 4 | **0** | 19,496 | **9.7568** | 0.168496 | 0.097568 |

- Each billed cost equals its SDK delta to the hundredth of a cent. Turn 4 hand-check at Opus rates: 2×400 + 4×2000 + 19,496×500 = 9,756,800 → 9.7568¢.
- The resumed turn has a cold cache (cache-read 0, whole transcript written), which is the expected price of a resume on another model.
- A second Opus cold-cache switch later (Sonnet→Opus via the API) matched the same way: 18.4998¢ = 2×400 + 12×2000 + 36,950×500; SDK Δ 0.184997.

## Scenario 2 — too big for the target → continuation: PARTIAL

**Building the chat.** A message is capped at 10,000 characters, so the chat was built from ~25 pasted filler messages (random lowercase words, 1.43 chars/token on Sonnet's tokenizer) on Sonnet 5.5, plus the earlier real turns.

**Measured with the real SDK helpers** (`getSessionMessages` + `transcriptForCount` + `messages.countTokens`, in the API container; key never printed):

| persisted entries | Haiku 4.5 count | Sonnet 5.5 count | Sonnet / Haiku |
|---|---|---|---|
| 28 | 77,445 | 95,935 | 1.239 |
| 44 | 121,793 | 150,882 | 1.239 |
| 50 | 138,418 | 171,494 | 1.239 |
| 72 | 162,118 | 200,965 | 1.240 |

The same transcript is 24% smaller on Haiku's tokenizer here, so a source-model estimate would have been wrong in the permissive direction. (The spike saw 1.62× on prose; the ratio depends on the text.)

**Switch to Haiku at count 138,418 (limit 136,000):**
- `POST …/messages` with `model=Haiku` → **409 `continuation_required`**; the composer shows "This conversation is too long for Claude Haiku 4.5. Your message is kept. Continue in a new chat… / Keep the current model."
- "Continue with Claude Haiku 4.5 in a new chat" → `POST …/continue` 201 in 2.7 s. New session: `model=claude-haiku-4-5`, **`continued_from_session_id` = the source chat**, title `… (continued)`.
- **Ledger has the summary call:** `surface=chat`, `source_ref=continuation_summary`, no session id, served `claude-haiku-4-5-20251001`, input **133,417**, output 8 (first run) / 118 (second), cost 13.3¢ / 13.4¢. The summary's input was trimmed to fit the target's limit (133,417 ≤ 136,000).

**Why PARTIAL — the summaries were not sensible, both times:**
1. First run: the transcript was almost entirely filler plus "Reply with just ok". Haiku returned `No conversation was submitted.` (8 tokens), which was stored and shown as the new chat's first message.
2. Second run (after adding real tool turns to the end): the stored "summary" was Haiku *answering the last technician message* ("I understand. I will not provide the hostnames…"), not a handover. The continued chat then said it had no details.
3. Control: I ran the production summary system prompt and format (`Technician:/Assistant:` lines as the single user message) on Haiku 4.5 with a realistic 7-line IT transcript that also ends in an injected "reply with just ok" — **it summarised correctly**, and so did a variant with `<transcript>` delimiters plus a trailing "Write the handover summary" instruction.

So the mechanics work and a realistic transcript summarises fine; the filler-dominated 133k-token input is not realistic evidence of a prompt flaw. The failure shape (a summarizer that answers the last user turn) is still worth a small hardening: delimit the transcript and end with an explicit instruction, and reject a summary under some minimum length rather than storing an 8-token reply as the handover. No issue filed because the repro depends on my synthetic input.

**Headroom measurements and recommendation**

Constants today (`transcriptFit.ts`): headroom `max(32,000, 10% of window)`, output allowance `min(maxOutput, 32,000)`. Limit = 136,000 for Haiku 4.5; 868,000 for the 1M models.

Measured, not estimated:
- **Fixed uncounted overhead per request** (tool definitions + SDK/system preset — what the fit does not count): the first turn of a brand-new chat reads **~18.5k tokens on Sonnet's tokenizer** (cache-write 18,552 on turn 1 with only a 25-token user message) and **~14.2k on Haiku's** (cache-write 14,234 in the continued Haiku chat, summary included, so ~13.8k fixed).
- **Largest observed output:** 13,938 tokens (a 6,000-word essay) — under the 32k allowance.
- **Accuracy of the count:** the fit refused at 138.4k (correct) and allowed 121.8k (correct); the summary request, trimmed by the same count, came back at 133,417 reported input tokens versus a 136,000 limit, i.e. the count and the provider agree to within the trim margin.

Reading the numbers:
- **200k models:** headroom 32k is ~2.3× the measured fixed overhead of ~14k, leaving ~18k for the turn's own tool results. One large tool result fits; several do not. **Keep the 32k floor.** If tool-heavy chats near the limit get 400s, raise the floor to 40k before touching the ratio.
- **1M models:** 10% = 100k is ~5× the measured overhead, which strands 100k of a 1M window. **Recommend ratio 0.05 (50k, still ~2.7× overhead + tool results).** That raises the Sonnet/Opus limit from 868,000 to 918,000 tokens. Evidence is thin here (no chat reached 200k+ of real tool output), so treat the ratio change as optional.
- **Output allowance 32k:** observed maximum 13.9k; keep (it is the CLI's own per-request ceiling).

## Scenario 3 — interrupt, then switch: PASS

On a long turn (a 6,000-word essay on Sonnet; then a 15,000-word request on Opus, interrupted after ~4 s):

- **UI guard:** while a turn is streaming, the picker and effort controls are disabled and the textarea shows "Waiting for response…" (disabled), so the UI cannot send a switch mid-turn.
- **Server guard, forged requests during an in-flight turn:** a plain follow-up and one carrying `model=Sonnet` both got **409 `A message is already being processed for this session`**. (This is the in-process "already processing" refusal. The DB-level `SessionSwitchGuard` claim — `turn_in_progress` — was not separately reachable from outside; it is covered by `aiModelSwitchClaim.integration.test.ts`.)
- **Interrupt:** `POST …/interrupt` → 200 `{"success":true,"interrupted":true}`.
- **Interrupted-turn ledger:** one Opus row, `stop_reason=error`, tokens 0, cost 0, `chargeable=false`; reservation `settled` at 0¢, none left open. The API log carries `ai_usage_unconfirmed` (`usageNote":"delta"`) for that reservation. This is the documented `no_result` settlement: nothing billed, usage flagged unconfirmed, the SDK usage snapshot left where it was.
- **No double billing on the next turn:** switching to Sonnet and sending billed one Sonnet row of 4.02517¢ (2×200 + 4×1000 + 22,926×20 + 14,249×250), and SDK cumulative moved 0.405042 → 0.445294 (Δ 0.040252 = the row). The interrupted Opus work, a few seconds of thinking, was never billed. That is the design's under-bill-never-double-bill; the unbilled amount is under a cent here.
- **Not tested:** an interrupt on Haiku (the plan's wording) — the same code path on a different model; I used Opus to leave the switch-away rate visible.

## Scenario 4 — carried rates: NOT OBSERVED

The Opus→Sonnet turn's reservation binding does carry the old model's rate:
`carriedRates: [{ wireModel: "claude-opus-5-5", rateSnapshot: { standard: { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 500 } } }]`, and the Sonnet→Opus turn carries Sonnet's. But no late delta under the old model arrived: the CLI persisted no usage for the interrupted Opus turn, so the next delta contained only Sonnet's own usage. Billing at the carried rate remains covered only by unit/integration tests.

## Scenario 5 — locked surface: PASS

With `allow_user_choice=false` on the `chat` assignment:
- **Menu hidden:** no `ai-model-picker-button` in the sidebar after reload (screenshot `s5-locked.png`).
- **API:** `GET /ai/models/choices/chat?sessionId=…` → `{"allowUserChoice":false,"defaultOfferingId":…,"current":{…},"choices":[]}`.
- **Forged `model`:** `POST …/messages {content, model:{offeringId:<Opus>}}` → **409 `{"error":"This AI model is not available here. Choose another model.","code":"not_permitted","recoverable":true}`.**
- **Plain message** on the same session still ran (200) on the surface default.

## Other observations (not filed)

- **Haiku refusal on a benign turn:** in the continued Haiku chat, a tool-using device question ended `stop_reason=refusal`, then a second row on `claude-haiku-4-5-20251001` with `fallback_used=true`; the UI read "Claude Haiku 4.5 declined; another model answered". Seen once; the registry's refusal-fallback path works, but the refusal itself is surprising on a plain question.
- **Warn-level noise:** every session's first turn logs `ai_usage_unconfirmed` (`usageNote":"first_result"`) at `console.warn`. Probably intended (baseline turn), but it reads like an incident in logs.
- **Priced and cheap:** a full resume or continuation round costs cents; the dominant spend was ~$7.5 of Sonnet cache reads over the 36-turn filler chat.

## Clean-up

Stack torn down (`pnpm wt-stack down`; compose project and containers verified gone). The worktree's `.env` copy (it held the API key) was deleted. Nothing left running.

## Re-check 2026-10-02 (post-#7774)

**Verdict: PASS** — scenario 1 through the real composer, no workaround; #7768 and #7769 are fixed.

- **Build:** `origin/main` @ `202252ee7c` (contains #7774), fresh worktree and stack, real platform key in the stack env only (worktree `.env` deleted afterwards). Opus 5.5 offered to the partner by SQL again. Stale Playwright route shims from the first run were cleared (`unrouteAll`) before starting, so nothing masked the fix.
- **Spend:** USD **0.22** from the ledger (cap 5).

**Scenario 1 (no workaround).** Three Sonnet 5.5 turns (two with tool calls). The model picker was present and labelled "Claude Sonnet 5.5" after every message, then Opus 5.5 was picked in the composer and a recall question sent.
- **Resume, not continuation:** same session; `ai_sessions.model` and `last_turn_model.servedModel` = `claude-opus-5-5`; the UI says "Answered by Claude Opus 5.5".
- **History intact:** asked for the number remembered two turns earlier — Opus answered `7421`.
- **No 400s:** every `GET /ai/models/choices/chat?sessionId=…` in the run returned 200 (previously 400, #7768).

| turn | served | in | out | cache-read | cache-write | cost ¢ | SDK cumulative $ | Δ SDK $ |
|---|---|---|---|---|---|---|---|---|
| 1 | sonnet-5-5 | 4 | 81 | 18,326 | 18,570 | 5.09082 | 0.051868 | 0.051868 |
| 2 | sonnet-5-5 | 6 | 203 | 56,288 | 757 | 1.51921 | 0.067060 | 0.015192 |
| 3 | sonnet-5-5 | 2 | 4 | 19,327 | 86 | 0.41244 | 0.071185 | 0.004125 |
| 4 (after switch) | **opus-5-5** | 2 | 4 | 0 | 19,515 | **9.7663** | 0.168848 | 0.097663 |

One row per turn, per-turn deltas, and turn 4 hand-checks at Opus rates: 2×400 + 4×2000 + 19,515×500 = 9,766,300 → 9.7663¢, equal to the SDK delta.

**#7769 (stale picker after a History switch).** Two active chats: B on Sonnet 5.5 and C on Opus 5.5. Opening them from History in the order C, B, C, B, the picker read **Opus, Sonnet, Opus, Sonnet**, and each pick fired a fresh `choices?sessionId=<that chat>` request (200). Before the fix no request was sent and the label stayed on the previous chat's model.

**Deviation from the brief.** "New conversation" closes the previous chat, which removes it from History, so the original first chat could not be reopened. The Opus-chat half of the check used a second chat (C) that I created and switched to Opus through the API; the History hopping and picker labels were all driven through the UI.

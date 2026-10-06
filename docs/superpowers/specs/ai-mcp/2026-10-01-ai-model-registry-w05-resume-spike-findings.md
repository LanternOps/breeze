# AI model registry W05: Agent SDK `resume` across models, spike findings (#7603)

Run on 2026-10-01 by the W05 spike runner (Claude Opus 5.5). `@anthropic-ai/claude-agent-sdk` 0.3.286 (the version pinned on `main`).
Script: `apps/api/src/services/aiModels/__scripts__/sdkResumeAcrossModelsSpike.ts`.
Labels: **verified** = observed in this run · **inferred** = from types/docs or indirect evidence · **not checked**.

## Harness

Every session is shaped like breeze chat (`streamingSessionManager.ts`): a streaming-input prompt, an in-process MCP server (`createSdkMcpServer`) holding one tool `spike_lookup`, `tools: []`, `allowedTools: [mcp__spike__spike_lookup]`, `includePartialMessages: true`, `persistSession: true`, `settingSources: []`, `ENABLE_TOOL_SEARCH=false`, the `SDK_CHILD_HOST_CONTEXT_GUARDS` env, and thinking/effort passed as `query()` options. A switch recreates the `query()` with `resume: <session id>` and model B's options, which is what spec §9.2 says breeze does when the wire model changes.

`ANTHROPIC_BASE_URL` points at a local logging proxy that forwards to `https://api.anthropic.com`. The CLI child holds a placeholder key; the proxy swaps in the real `x-api-key` on the way out, so the key never reached the child, its transcript, or any output. Per request the proxy records the model, `thinking`, `output_config`, `speed`, `anthropic-beta`, a block-type summary of `messages` (no text), and the response status, `stop_reason`, error text, block types and usage. The script also reads the persisted JSONL transcripts back.

Tool chain, turn A: look up `alpha` → it names `bravo-7` → look up `bravo-7` → `CODE-4417`, plus a counting puzzle at `effort: max` so the adaptive model actually thinks. Turn B (resumed on model B): "do not call the tool for alpha/bravo-7 again; state the second key and the code from history; then look up `gamma`." A pass means B answers `SECOND=bravo-7 CODE=CODE-4417 GAMMA=GAMMA-9031` with exactly one new tool call (`gamma`).

Display: with no `thinking.display`, Sonnet 5.5 / Opus 5.5 return thinking blocks with a signature and empty text (`len=0`, i.e. omitted). Haiku 4.5 in budget mode returns full text.

## Answers

| # | Question | Answer | Label | Evidence |
|---|---|---|---|---|
| Q1 | Resume on model B with ≥2 tool calls in history: does it continue with tool history intact? | **Yes, all four required pairs plus a fifth.** Sonnet 5.5→Opus 5.5, Opus 5.5→Sonnet 5.5, Sonnet 5.5→Haiku 4.5 (adaptive→budget), Haiku 4.5 (budget)→Sonnet 5.5, and Sonnet 5.5→Haiku 4.5 with `thinking: disabled` (breeze's current Haiku mapping). Every B request carried both `tool_use`/`tool_result` pairs; every B answer recalled `bravo-7` and `CODE-4417` from history, called `gamma` once, and did not re-run the earlier lookups. No 400s. | verified | Table Q1 |
| Q2 | With adaptive thinking on A, does resuming on B fail, drop, or replay A's thinking blocks? | **The CLI drops them itself; no 400.** A's thinking blocks are persisted in the transcript (signed). Every cross-model B request carried **0** thinking blocks. Same-model resume replays them (2 blocks sent). A round trip Sonnet→Opus→Sonnet replays Sonnet's original blocks on the return leg with a 200, so the CLI filters by the model that produced each block rather than discarding them. Within B's own turn, B's new thinking blocks are sent back normally. | verified | Table Q2 |
| Q3 | A transcript over B's window but inside A's: error, auto-compaction or truncation? | **A 400, then a lossy auto-compaction that drops the user's prompt, reported as success.** Sonnet 5.5 took a 343,631-token turn (CLI reports `contextWindow: 1000000` with no 1M beta). Resumed on Haiku 4.5 (200k), the CLI: (1) sent the full transcript → `400 prompt is too long: 212762 tokens > 200000 maximum`; (2) sent a compaction request → `400 … 214091 tokens > 200000`; (3) dropped the oversized message and summarized the rest (2,073 input tokens); (4) wrote a `compact_boundary` and continued. Haiku then ignored the actual prompt ("Reply with the word STILL-HERE"), called the tool three times with keys it made up, and answered "I'm ready to continue. What would you like me to work on next?". The result was `subtype: success`, `is_error: false`. | verified (behaviour) / inferred (that the prompt was lost in compaction rather than ignored; the proxy does not record text) | Table Q3 |
| Q4 | Same model, resumed with a different effort, or with fast mode on or off: safe? | **Effort: yes.** Opus 5.5 medium → resume at `low` → resume at `max`: all 200, history intact, same-model thinking replayed, prompt cache partly reused (987 of 1,602 tokens read on the first request after the change). **Fast mode: the option reaches the wire on resume**: `speed: "fast"` plus the `fast-mode-2026-02-01` beta. But this org's fast limit is now **0 input tokens/min** (`429 rate_limit_error`), and the CLI silently retried the same request without `speed` and finished the turn on standard. Turning fast off on the next resume sent no `speed`. Whether a fast-mode request actually succeeds on a resumed session was **not checked**: the 429 blocked it. | verified (effort; fast on the wire; 429 → silent standard retry) / not checked (a successful fast resume) | Table Q4 |
| Q5 | After a switch, do `modelUsage` and per-model token counts attribute tokens correctly to A and B? | **Per model, yes; per query, no: they are cumulative.** For completed turns each `modelUsage[model]` matches the proxy's sum for that model exactly. But a resumed query's `modelUsage` **carries the earlier queries' totals from the transcript**: after Sonnet→Opus the result holds both keys, and after a same-model resume the one key holds A+B. `total_cost_usd` is cumulative the same way, both across turns of one streaming query and across `resume`. `result.usage` is per turn (B only). Keys are the **requested** id (`claude-haiku-4-5`), while the transcript records the served id (`claude-haiku-4-5-20251001`). **Interrupted and aborted turns under-count**: see Q6. | verified | Table Q5 |
| Q6 | Can a turn interrupted mid-tool-call be resumed on a different model? | **Yes, both after `query.interrupt()` (breeze's interrupt path) and after an `AbortController` abort (breeze's `remove()` path).** Interrupt ends turn A with `error_during_execution` and the SDK throws `Claude Code returned an error result: [ede_diagnostic] … stop_reason=tool_use`. The transcript holds the `tool_use`, a rejection `tool_result`, the interrupt marker and a `<synthetic>` assistant message, so the history is well-formed. Resuming on Opus 5.5 (or on the same model, as a control) continued without a 400. **In all three runs, B re-ran the interrupted tool call** (`bravo-7` executed twice). This happens on the same model too, so it is not caused by the switch. Usage: the interrupted turn's `modelUsage` counts only its first API call (the second, billed by the API, is missing), and an aborted turn emits no result at all; one abort run also had a third request billed and never persisted. | verified | Table Q6 |

### Q1 (`q1-*`; B prompt check columns: recalled key / recalled code / called gamma once / no re-lookups)

| pair | A thinking | B thinking (wire) | B request messages carried (thinking / tool_use / tool_result) | B status | checks |
|---|---|---|---|---|---|
| Sonnet 5.5 → Opus 5.5 | adaptive, max | adaptive, medium | 0 / 2 / 2 | 200, 200 | ✓ ✓ ✓ ✓ |
| Opus 5.5 → Sonnet 5.5 | adaptive, max | adaptive, medium | 0 / 2 / 2 | 200, 200 | ✓ ✓ ✓ ✓ |
| Sonnet 5.5 → Haiku 4.5 | adaptive, max | `{type:"enabled",budget_tokens:2048}` | 0 / 2 / 2 | 200, 200 | ✓ ✓ ✓ ✓ |
| Sonnet 5.5 → Haiku 4.5 | adaptive, max | `{type:"disabled"}` | 0 / 2 / 2 | 200, 200 | ✓ ✓ ✓ ✓ |
| Haiku 4.5 → Sonnet 5.5 | `enabled`, 2048 (3 thinking blocks with text) | adaptive, medium | 0 / 2 / 2 | 200, 200 | ✓ ✓ ✓ ✓ |

Transcript, Sonnet→Opus (block types per entry): `user:text`, `assistant[claude-sonnet-5-5]:thinking(sig=true,len=0)`, `…:text`, `…:tool_use`, `user:tool_result`, `…:tool_use`, `user:tool_result`, `…:thinking(sig=true,len=0)`, `…:text`, `user:text`, `assistant[claude-opus-5-5]:tool_use`, `user:tool_result`, `assistant[claude-opus-5-5]:text`.

### Q2 (thinking blocks sent on the first request of the resumed turn)

| run | A's thinking blocks in transcript | sent on B | sent on C | status |
|---|---|---|---|---|
| Sonnet → Opus (cross) | 2 | **0** | – | 200 |
| Sonnet → Sonnet (`q2-same-model`, same-model control) | 2 | **2** | – | 200 |
| Sonnet → Opus → Sonnet (`q2-roundtrip`) | 2 | **0** | **2** (Sonnet's own, original signatures) | 200, 200 |
| `setModel` live switch Sonnet → Haiku | 2 | **0** | – | 200 |

### Q3 (`q3-window`)

`countTokens` on the same filler: **Haiku 4.5: 211,831 tokens; Sonnet 5.5: 343,631**, a 1.62× tokenizer difference.

| step | request | status | detail |
|---|---|---|---|
| A, Sonnet 5.5 | 1 user message | 200 `end_turn` | `cache_creation_input_tokens: 344286`; `modelUsage.contextWindow: 1000000` |
| B, Haiku 4.5, call 1 | full transcript | **400** | `prompt is too long: 212762 tokens > 200000 maximum` |
| B, call 2 (compaction) | 1 flattened user message | **400** | `prompt is too long: 214091 tokens > 200000 maximum` |
| B, call 3 (compaction retry) | oversized message dropped | 200 | 2,073 input tokens → summary |
| B, calls 4–5 | post-compaction summary | 200 | 3 `spike_lookup` calls with invented keys (`current_task`, `work_status`, `last_context`) |
| B result | – | `success` | "I'm ready to continue. What would you like me to work on next?" (the prompt asked for `STILL-HERE`) |

Transcript after B: `…, user:text, system:compact_boundary, user:text, assistant[claude-haiku-4-5-20251001]:text, …`.

### Q4 (`q4-options`, Opus 5.5 throughout)

| step | options | wire | status | cache read / write |
|---|---|---|---|---|
| A | adaptive, medium | `effort: medium` | 200 ×3 | – |
| B (resume) | adaptive, low, `settings: { fastMode: true }` | `speed: "fast"`, `effort: low`, `+fast-mode-2026-02-01` | **429**: `exceed your rate limit of 0 fast mode input tokens per minute (… model: claude-opus-5-5)` | – |
| B, CLI retry | (same query) | no `speed`, beta still present | 200 ×2, answer correct | 987 / 615 |
| C (resume) | adaptive, max, fast off | `effort: max`, no `speed`, no fast beta | 200 | 1,698 / 84 |

In an earlier run of the same scenario (not reproduced on re-run), Opus 5.5 returned two empty `200` responses (0 output tokens). The CLI then switched the session to **Opus 4.8** on its own, with no `fallbackModel` set: the transcript gained `system:model_refusal_fallback`, the requests carried a `fallback-credit-2026-06-01` beta, and `modelUsage` gained a `claude-opus-4-8` key. The SDK types document this: on `stop_reason: "refusal"` the turn "is retried once on a fallback model … the swap is made persistent for the session" (`SDKModelRefusalFallbackMessage`, sdk.d.ts:5372). That run did not yet record `stop_reason`, so "refusal" is **inferred** from the message subtype.

### Q5 (proxy sums vs SDK result, selected)

| run | SDK `modelUsage` on the B result | proxy sum for that model | match |
|---|---|---|---|
| Sonnet→Opus, key `claude-sonnet-5-5` (A, carried) | in 6 / out 1750 / cr 1711 / cw 1029 | A calls: 6 / 1750 / 1711 / 1029 | ✓ |
| Sonnet→Opus, key `claude-opus-5-5` (B) | 4 / 97 / 1718 / 1814 | B calls: 4 / 97 / 1718 / 1814 | ✓ |
| Sonnet→Sonnet, key `claude-sonnet-5-5` | 10 / 1782 / 5423 / 2776 | **A + B** | cumulative |
| Sonnet→Sonnet, `result.usage` | 4 / 97 / 3710 / 1746 | B only | ✓ per turn |
| `total_cost_usd`, Sonnet→Opus B | 0.0318 | A 0.0204 + B 0.0114 | cumulative |
| `total_cost_usd`, `setModel` turn 2 (one streaming query) | 0.0251 | turn 1 0.0189 + turn 2 0.0063 | cumulative |

Usage on the streamed `assistant` messages is not a substitute: their `output_tokens` is a start-of-message snapshot (e.g. 49 vs 1,685 final).

### Q6 (`q6-interrupt`; A = Sonnet 5.5, blocked inside the 2nd tool call)

| run | A outcome | A `modelUsage` vs proxy | B model | B status | interrupted tool re-run on B |
|---|---|---|---|---|---|
| `interrupt()` → Opus | `error_during_execution`, SDK throws | 1 call counted of 2 billed | Opus 5.5 | 200, answer complete | yes |
| `interrupt()` → Sonnet (control) | same | 1 of 2 | Sonnet 5.5 | 200 | yes |
| `abort()` → Opus | `Claude Code process aborted by user`, no result message | none emitted; B's carried total counts 2 of 3 billed calls | Opus 5.5 | 200 | yes |

### Live `setModel` (comparison, not the breeze path)

`query.setModel(haiku)` between turns on one streaming query worked (history intact, Sonnet's thinking dropped). But the query's `thinking: adaptive` option could not follow the model: the CLI sent Haiku `thinking: {type:"enabled", budget_tokens: 31999}`. The CLI also made one extra 22-token Haiku request when `setModel` was called. **verified**

## Side observations (verified unless labelled)

- **Cross-model switches miss the prompt cache.** Every cross-model B request started with `cache_read 0` and re-wrote the whole transcript to cache on B (e.g. Opus 5.5: 1,718 tokens at the cache-write rate). Same-model and effort-only resumes read the cache.
- **Tokenizers differ by model.** The same text is 1.62× more tokens on Sonnet 5.5 than on Haiku 4.5. A transcript's size measured on A cannot decide whether it fits B.
- **The CLI's view of Haiku 4.5 differs from the registry.** `modelUsage.maxOutputTokens: 32000` vs the seed's 64,000.
- **Legacy cost path (pre-W03, inferred impact).** `streamingSessionManager` prices a platform turn as `total_cost_usd` (`Math.round(usageData.total_cost_usd * 100 * 100) / 100`, around line 1928), and `aiCostTracker.recordUsage` does the same (around line 1125). Both treat the value as per-turn. Since the SDK reports a running total across turns and across `resume` (Q5), turn *n* of a streaming session is charged turns 1…n. Not checked against production ledger rows. Worth its own issue; W03 replaces this path.

## Decisions this gates

| # | Decision (owner wave) | Outcome |
|---|---|---|
| D1 | Same-connection switching via `resume` (§9.2) (W05) | **Allowed**, under the constraints below. A continuation session is needed only for a cross-connection switch (as the spec already says) and for a transcript that fails the target fit check. |
| D2 | Must W05 strip foreign thinking blocks itself? (§9.2 "dropped, not replayed") | **No.** The CLI drops other models' blocks and keeps the target model's own, including on a round trip. Stripping them ourselves would also lose the same-model replay. |
| D3 | Switch mechanism (W05) | **Recreate the query with `resume` plus the target's wire options** (the spec §9.2 path). Not `setModel`: it cannot change `thinking`/`effort`, and it handed Haiku a 31,999-token thinking budget (#7587 territory). |
| D4 | Billing source (W03) | `modelUsage` attributes per model correctly but is cumulative for the session, and keyed by the requested id. W03 must bill the per-key **delta** from the previous result of the same session (persist the last seen `modelUsage` per session, including across `resume`), or `result.usage` for single-model turns. Interrupted and aborted turns under-count; decide whether to accept or reconcile that gap. |

## Constraints W05 must enforce

1. **Fit check against the target before switching, with the target's tokenizer** (`countTokens` on model B, plus headroom for the turn's output). On a miss, refuse the switch or start a continuation. Never let the CLI auto-compact: it drops content silently and reports `success` (Q3).
2. **Switch by recreating the query with `resume` and model B's own wire options** (`agentSdkWireOptions(B)`), never by `setModel` (D3).
3. **Switch only between turns**, never inside one. A turn that ended interrupted or aborted may be resumed on another model, but the interrupted tool call will be re-executed: approvals and idempotency must cover it (that holds without a switch too).
4. **Usage deltas, not totals** (D4). Read `modelUsage` per key minus the last value seen for that session. Do not read `total_cost_usd` as per-turn.
5. **Re-read the effective model after every turn.** The CLI can switch the session model by itself on a refusal (`SDKModelRefusalFallbackMessage`, scope `session`) and can drop fast mode on a 429. The model and options that W05 requested are not necessarily what ran. Use `modelUsage` keys, the `model_refusal_fallback` message and the init message's `model` for provenance.
6. **Expect a cache miss on a cross-model switch.** The first B call re-writes the whole transcript at the cache-write rate. The picker may warn on long chats.

## Verdict

**SAFE:** same-connection switching via `resume` works across Sonnet 5.5, Opus 5.5 and Haiku 4.5 (adaptive ↔ budget), with tool and thinking history. The CLI drops foreign thinking blocks itself. Constraints: a target-tokenizer fit check before every switch (an oversized resume degrades silently), recreate-plus-`resume` with the target's options rather than `setModel`, only between turns, and usage billed as per-model deltas.

## Spend

Estimated from the proxy-recorded usage at the seeded registry list rates: **≈ USD 1.37** across six runs (the 344k-token Sonnet turn for Q3 was USD 0.86 of it). The fast-mode request was rejected with a 429, so nothing was billed at fast rates. `countTokens` calls are free.

## 2026-10-06: re-run on Agent SDK 0.3.288

Run on 2026-10-06 by the SDK-bump runner (Claude Opus 5.5) for dependabot PR #7999, on `@anthropic-ai/claude-agent-sdk` **0.3.288**, all scenarios (`--sonnet claude-sonnet-5-5 --opus claude-opus-5-5 --haiku claude-haiku-4-5`). The harness env includes `SDK_CHILD_HOST_CONTEXT_GUARDS`, which now carries `CLAUDE_CODE_THINKING_DISPLAY_UPDATES=0`: 0.3.288's CLI otherwise defaults every adaptive request to `display: "updates"` (W01 findings, 2026-10-06 section). Every `/v1/messages` request in the run carried no `thinking-display-updates` beta, and every adaptive request carried `{"type":"adaptive"}`. Estimated spend **≈ USD 1.16** (Q3's 344k-token Sonnet turn was USD 0.86 of it), plus ≈ USD 0.08 of earlier same-day partial runs.

**Every answer matches the 0.3.286 run.** All labels **verified**.

| # | 0.3.288 result | Same as 0.3.286 |
|---|---|---|
| Q1 | All five pairs (Sonnet→Opus, Opus→Sonnet, Sonnet→Haiku budget, Sonnet→Haiku disabled, Haiku budget→Sonnet): every B request carried 0 thinking / 2 tool_use / 2 tool_result, all 200, every check ✓ ✓ ✓ ✓ (`SECOND=bravo-7 CODE=CODE-4417 GAMMA=GAMMA-9031`, `gamma` called once, no re-lookups). | yes |
| Q2 | Thinking blocks sent on B: cross-model **0**; same-model **2**; round trip Sonnet→Opus→Sonnet **0** then **2** (Sonnet's own, 200); `setModel` Sonnet→Haiku **0**. Persisted blocks `thinking(sig=true,len=0)`. | yes |
| Q3 | `countTokens`: Haiku 211,831 / Sonnet 343,631. Sonnet A 200 (`cache_creation 344,285`). Haiku B: `400 prompt is too long: 212762 tokens > 200000`, then compaction `400 … 214091 tokens`, then a 200 compaction at 2,073 input tokens, `system:compact_boundary`, three `spike_lookup` calls with invented keys (`current_task`, `last_status`, `resume_file_path`), result `success` without `STILL-HERE`. | yes (same token counts; different invented keys) |
| Q4 | Opus 5.5 effort medium → low → max: all 200, same-model thinking replayed. Fast on resume: `speed: "fast"` + fast beta → `429` (0 fast input tokens/min), CLI silently retried without `speed` (beta still present), answer correct. Fast off: no `speed`, no fast beta. No `model_refusal_fallback` this run. | yes |
| Q5 | `modelUsage` per key matches A and B; cumulative across `resume` (same-model B key = A+B; cross-model B holds both keys); `result.usage` per turn; `total_cost_usd` cumulative. Keys are the requested id (`claude-haiku-4-5`), the transcript the served id (`claude-haiku-4-5-20251001`). | yes |
| Q6 | `interrupt()` → `error_during_execution`, SDK throws `[ede_diagnostic] … stop_reason=tool_use`; `abort()` → `Claude Code process aborted by user`, no result. B (Opus, and Sonnet control) continued with 200s, and **re-ran the interrupted `bravo-7` call in all three runs**. Interrupted A's `modelUsage` counts 1 of 2 billed calls; the abort run's carried total counts 2 of 3. | yes |
| `setModel` | History intact, Sonnet's thinking dropped, Haiku sent `{type:"enabled", budget_tokens: 31999}`, one extra 22-token Haiku request at `setModel`. | yes |

New, not a resume question: each `query()` makes one `GET /api/hello` to `ANTHROPIC_BASE_URL` before its first Messages call (**unknown whether new**; the 0.3.286 run did not report non-Messages paths).

**Verdict unchanged: SAFE**, with the same six constraints. The pin moves to 0.3.288.

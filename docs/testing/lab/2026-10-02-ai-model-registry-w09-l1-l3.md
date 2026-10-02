# AI model registry W09: lab gates L1–L3 (failover against real models and a local billing service)

Feature #7598, wave W09 (#7607, PR #7775). These are release gates for v0.121.

- **Date:** 2026-10-02
- **Build:** `origin/main` at `055d03a822`, which is the #7775 merge. A fresh worktree, brought up with `pnpm wt-stack up`.
- **Models:** the real platform Anthropic key, held only in the stack's env. The BYOK connection uses the same real key as a stand-in partner key, so its funding differs. Every other provider key was blank.
- **Billing:** the billing service at `origin/main` `e3b0f4c` (idempotent deduct), run locally with `npm run dev` against the stack's Postgres. `/health` reported `creditDeductIdempotencySchema: ok`.
- **Spend:** about **USD 1.30**. The `ai_invocations` ledger holds USD 1.23 (platform 100.93¢, BYOK 22.50¢). The rest is roughly 30 unbilled CLI background calls on Haiku (about 21.5k input / 2.1k output tokens in total) plus the SDK-probe calls. The cap was USD 10.
- **Drivers:** the settings UI (Playwright MCP) for defaults and fallbacks, the API for chat, agent runs and connections, and SQL/Redis for checks. Screenshots are in the worktree's gitignored `.superpowers/lab-w09/`.

## Verdicts

| Gate | Case | Verdict |
|---|---|---|
| **L1** | Raw Agent SDK failure shapes (429 / 529 / 401 / low credit) | **PASS** for 429, 529 and 401. **Low credit is classified, then cleared** (#7784). |
| L1 | Chat, next-message failover (D5) on 529 / 429 / 401 | **PASS** |
| L1 | Chat, low credit | **FAIL**: no cooldown, so no next-message failover (#7784) |
| L1 | Agent run, per-hop failover (pre-output) on 529 / 401 / low credit | **PASS** |
| L1 | Fast-mode 429 is not a failover | **PASS** (see the note: fast mode never reaches Breeze's Agent SDK transport today) |
| **L2** | Cross-funding OFF (org override): platform → BYOK must not happen | **PASS** |
| L2 | Cross-funding ON: platform → BYOK, and platform → BYOK → platform | **PASS** |
| L2 | SQL assertion: deducts = served platform hops, amounts = priced cost | **PASS** |
| L2 | Negative control: the assertion catches a double debit | **PASS** (caught by the transaction reconciliation, part D) |
| L2 | Lost-response retry is replayed, not double-debited | **PASS** |
| **L3** | Cooldown cleared by a key rotation; next request uses the offering | **PASS** |

**Overall:** L2 and L3 pass. L1 passes for agent runs and for chat on 429 / 529 / 401. It fails on one case, chat on a low-credit error (#7784). Three more chat defects showed up along the way, none of which affects money: #7785, #7786 and #7787.

**Defects filed (not fixed here):**

| # | Severity | Summary |
|---|---|---|
| #7784 | medium | Chat: a low-credit (`billing_error`) failure never cools the offering. The result frame's `api_error_status: 400` clears the classified cause, so chat never fails over on quota. |
| #7785 | medium (UX, likely predates W09) | Chat: a turn that fails before any output shows the technician **no error**. The SSE stream is only `turn_model` + `done`. For 529, 429 and 401 this arrives after about 3 minutes of CLI retries. |
| #7786 | low | Chat: a failed turn is labelled "answered by Claude Haiku 4.5, fallbackUsed=true". Haiku here is the CLI's own background call, and the label is persisted to `ai_sessions.last_turn_model`. |
| #7787 | low | Agent run admitted onto a backup because its primary is cooling: no failover provenance is recorded (hop 0, no cause), so the usage page's `failovers` count misses it. |

## Setup

| Step | How |
|---|---|
| Stack | `pnpm wt-stack up` with `BREEZE_WORKSPACE_ENABLED=false`, a free docker subnet, caddy IP and trusted proxy, plus `BREEZE_AI_AGENTS_ENABLED=true`, which needs an api recreate. |
| Fault proxy | A local Node proxy modeled on the W05 spike harness. It is set as the stack's `ANTHROPIC_BASE_URL`, which `IS_HOSTED=false` allows, so it sits in front of **platform** traffic only. BYOK traffic goes straight to the provider: the CLI child for a partner key gets no base-URL override, and the Messages client pins the public endpoint. The proxy logs path, model, `speed`, status, the injected rule and usage, never headers or text. Rules match on model substring and optionally `speed`. |
| Billing service | A separate billing worktree at `e3b0f4c` with `npm ci && npm run dev`, connected to the stack's Postgres through a local port forward. Its own tables were created first from its drizzle schema (generated SQL, applied by hand; `db:push` failed to introspect the shared DB). Its boot `ensureSchema` created `billing_credit_deductions`. The stack's API env got the matching `BILLING_SERVICE_URL` / `BILLING_SERVICE_API_KEY`, with a lab-only key. |
| Credit wallet | **SQL:** a `billing_credit_balances` row for the seed partner (plan `enterprise`) with a purchased balance. The billing service's credit check returned `allowed: true`. |
| W03 cutover | Already run at boot (`ai_model_registry_partner_cutover` has the seed partner). |
| BYOK connection | **API** (`POST /ai/models/connections`, the W04 route). As designed, the first key moved the partner defaults onto BYOK and disabled platform Haiku, so platform Haiku was re-enabled through the API. |
| Defaults + fallbacks | **UI** (Partner settings → AI Providers & Models → Defaults by feature) for **Chat** and **AI agents**: default = platform Sonnet 5.5; backups in order = BYOK Sonnet 5.5, then platform Haiku 4.5; cross-funding switch ON. Screenshot: `setup-defaults-saved.png`. |
| Cross-funding OFF | **API:** an org override on `ai_agents` with `fallbackMayCrossFunding=false` (partner ON ∧ org OFF = OFF). This is the realistic OFF case, because the partner UI cannot save a BYOK backup on a platform default while the switch is off: it drops the entry from the draft. |
| Agent | **API:** a `triage` partner baseline plus an org override, `mode=shadow`, cooldown 0. A manual trigger runs profile `full`, which D4 maps to role `analysis`; that role inherits the `ai_agents` default. |

Offerings (ids truncated): platform Sonnet 5.5 `44e8a61e`, platform Haiku 4.5 `1aab94e6`, BYOK Sonnet 5.5 `862b5e00`, platform Opus 5.5 `c38afce8` (fast-mode check only).

## L1: real Agent SDK failure shapes

### Raw SDK frames, and what the W09 classifier makes of them

This used a lab script run in the API container: one `query()` against the fault proxy, with `observeSdkMessage` + `shouldFailOverNow(obs, ['x'])` applied to every frame. The CLI retry count was capped at 3 with `CLAUDE_CODE_MAX_RETRIES` for speed, and the default is 10. Times are seconds from start.

| Forced failure | Frames (abridged) | Classifier after each frame | Verdict |
|---|---|---|---|
| **529** `overloaded_error` | `api_retry {error:"overloaded", error_status:529, attempt:1..3}` → `assistant {error:"server_error", model:"<synthetic>"}` → `result {subtype:"success", is_error:true, api_error_status:529}` | `overloaded` (retries 1 → no failover yet; retries 2 → **failover**), then `server_error`, then `overloaded` | correct |
| **429** `rate_limit_error` | `api_retry {error:"rate_limit", 429, attempt:1..3}` → `assistant {error:"rate_limit"}` → `result {api_error_status:429, is_error:true}` | `rate_limited`, failover from retries ≥ 2 | correct |
| **401** `authentication_error` | `api_retry {error:"authentication_failed", 401, attempt:1..3}` → `assistant {error:"authentication_failed"}` → `result {api_error_status:401, is_error:true}` | `auth_failed`, **failover at once** (attempt 1) | correct. The CLI does retry 401s. |
| **Low credit** (400 `invalid_request_error`, "credit balance is too low") | `assistant {error:"billing_error"}` → `result {api_error_status:400, is_error:true}`. No retry. | `quota_exhausted`, failover at once → **then `null`** after the result frame | **defect #7784**: the result's bare 400 clears the cause |

Two more things in these frames:
- Every failed query's `result.modelUsage` holds `claude-haiku-4-5-20251001`: the CLI's own background call, which succeeds even when the main model fails. This is the cause of #7786.
- The synthetic assistant frame carries `error` and is not counted as output (`sawOutput` stays false). That is correct.

### Fast-mode 429 must not fail over

- **Real provider fast 429:** with no injection, Opus 5.5 with `settings.fastMode` hit the org's real fast-mode limit. The proxy saw `speed:"fast"` → **429 `rate_limit_error`**, followed at once by the same request **without `speed`** → 200. The SDK emitted **no `api_retry` frame**: `providerFailure` stayed `null`, the result had `fast_mode_state:"cooldown"` and the turn completed. So a fast-mode 429 is not a failover cause. **PASS.**
- **Synthetic fast 429 (control):** an injected 429 on `speed:"fast"` requests with a generic body was *not* recognised by the CLI as a fast-mode limit. It retried at `speed:"fast"` 10 times over about 115 s, with `api_retry` frames, and would count as `rate_limited`. The CLI's fast→standard switch therefore keys on something in the real 429, a header or the message text. Synthetic fast-429 injection is not representative of production.
- **Breeze surfaces:** fast mode never reaches the Agent SDK transport today. `AGENT_SDK_FAST_MODE_VERIFIED = false` (`wireParams.ts`), and a chat turn on Opus with `speed: fast` (offered by SQL, priced through `option_rates`) was sent without `speed`: `appliedOptions: {}`. A chat or agent-run fast-mode 429 therefore cannot happen until W05 L1 flips that constant. When it does, the real-provider evidence above says it will not fail over.

### Chat: next-message failover (D5)

Each case used a new chat session. The proxy fails every platform Sonnet request, the turn fails, then a second message is sent while the cooldown is live.

| Case | Turn 1 (proxy) | Cooldown set (Redis key, value, TTL) | Turn 2 served by | Ledger (turn 1 / turn 2) |
|---|---|---|---|---|
| 529 | 11 Sonnet requests over 3 min, all 529 | `ai-model:cooldown:44e8a61e` = `overloaded`, pttl 59,476 | platform Haiku | 0¢, `stop_reason=error` / `1aab94e6` platform, **hop 2, cause `cooldown`**, from `44e8a61e`, 9.30¢ (cold cache) |
| 429 | 11 × 429 over 3 min | `rate_limited`, pttl 59,803 (**60 s**) | platform Haiku | 0¢ / hop 2 `cooldown`, 0.81¢ |
| 401 | 11 × 401 over 3 min | `auth_failed`, pttl 899,753 (**15 min**) | platform Haiku | 0¢ / hop 2 `cooldown`, 0.81¢ |
| low credit | 1 × 400 | **none** | not sent; the next message would go back to Sonnet | 0¢ (**#7784**) |

- **Why platform Haiku rather than BYOK Sonnet (first in the list):** the session already counts the failed turn (`turn_count = 2`), so D5's same-connection rule skips the BYOK connection. The CLI did *not* persist the failed user message (turn 2's request carried 1 message), so this is conservative but harmless.
- **D6:** the session was not re-stamped (`ai_sessions.model` stayed `claude-sonnet-5-5`, offering `44e8a61e`, `billing_source` platform).
- **Money:** the failed turn's reservation settled at 0 with no deduct. The served turn's reservation (binding `failover: {hop:2, cause:"cooldown", fromOfferingId:"44e8a61e…"}`) was debited once under its own key.
- **UX defects on every failed turn:** no error is shown (#7785), and the turn is labelled as answered by Haiku (#7786).

### Agent run: per-hop failover (pre-output only)

Cross-funding ON, so hop 1 = BYOK Sonnet. Platform traffic goes through the proxy; BYOK goes direct.

| Run | Forced on primary | Primary requests before abort | Classifier / cooldown | Hop 1 | Ledger |
|---|---|---|---|---|---|
| `7c81da13` | 529 | 3 (original + 2 CLI retries, about 3 s) | `overloaded`, 60 s | BYOK Sonnet `862b5e00`, served | hop 0 `44e8a61e` platform 0¢ `error`; hop 1 `862b5e00` partner_key 17.96¢, cause `overloaded` |
| `78d5b8a3` | low credit | 1 | `quota_exhausted`, 15 min (pttl 888,381) | BYOK Sonnet, served | hop 0 0¢; hop 1 partner_key 1.52¢, cause `quota_exhausted` |
| `bf39446e` | 401 | 3 (about 1 s) | `auth_failed`, 15 min (pttl 895,206) | BYOK Sonnet, served | hop 0 0¢; hop 1 partner_key 1.51¢, cause `auth_failed` |

- The run row has `funding_source = platform` (admitted), `served_offering_id = 862b5e00`, `served_funding_source = partner_key`, `served_failover_hop = 1` and the cause (D7: compute stays on the admitted funding).
- Reservations: `ai-agent-run:<run>` (platform, settled 0, no debit) and `ai-agent-run:<run>:hop:1` (partner_key, settled, no debit).
- **A fresh child per hop:** hop 1's requests never reached the proxy. They went direct with the partner key, which proves hop 1 ran a new CLI child with the BYOK environment and not hop 0's child. The only request not accounted for in the ledger is the CLI's tiny Haiku background call per query (#7786 note).
- **After output, no failover:** not forced live; it is covered by the W09 unit pins. Injecting a failure mid-stream was out of reach of a status-only proxy.

## L2: cross-funding failover against the local billing service

### Cross-funding OFF (org override, partner ON): PASS

Run `8398768c`, 529 on platform Sonnet. The walk **skipped BYOK Sonnet** and served **platform Haiku** (same funding only):

```
hop 0  44e8a61e platform    0.0000¢  stop=error
hop 1  1aab94e6 platform    8.9471¢  cause=overloaded  (from 44e8a61e)
reservations: ai-agent-run:8398768c… (platform, 0, not debited), …:hop:1 (platform, 8.9471, debited)
```

No `partner_key` reservation exists for the run, so there was no BYOK hop and no BYOK deduct. A second OFF run (`a39f4de6`, below) behaved the same way.

### Cross-funding ON: PASS

- **platform → BYOK:** runs `7c81da13`, `78d5b8a3`, `bf39446e` and `bdbeb2de`. Each served on BYOK with zero deducts.
- **platform → BYOK → platform:** run `2d47247f`. The BYOK key was replaced in the DB by a sealed invalid key, a stand-in for a revoked key that gets a genuine provider 401. With a 529 on platform Sonnet:

```
hop 0  44e8a61e platform     0.0000¢  stop=error
hop 1  862b5e00 partner_key  0.0000¢  stop=error  cause=overloaded   (real provider 401 on the BYOK key)
hop 2  1aab94e6 platform     1.8287¢  end_turn    cause=auth_failed  (from 44e8a61e)
cooldowns after: 44e8a61e overloaded 60 s; 862b5e00 auth_failed 15 min
```

Exactly one deduct, for hop 2's reservation. None for the BYOK hop or the failed platform hop.

### The SQL assertion: PASS

Everything is in one database (the stack's tables and the billing service's tables share it). The query file is reproduced in full below. Parts:
- **(A)** each agent-run hop's ledger row, joined to its own reservation by hop key, to its deducts by `ai-settlement:<reservationId>`, and to its `billing_credit_transactions` row;
- **(B)** a summary over the same hops;
- **(C)** every reservation in the lab, chat included;
- **(D)** reconciliation of the wallet's `usage` transactions against the keyed deducts.

<details><summary>Query</summary>

```sql
SET breeze.scope = 'system';
-- (A) per agent-run hop
WITH hops AS (
  SELECT i.agent_run_id, i.failover_hop AS hop, i.funding_source, i.cost_cents,
         'ai-agent-run:' || i.agent_run_id
           || CASE WHEN i.failover_hop > 0 THEN ':hop:' || i.failover_hop ELSE '' END AS rkey
  FROM ai_invocations i JOIN ai_agent_runs ar ON ar.id = i.agent_run_id
  WHERE ar.queued_at >= '2026-10-02 11:30:00+00'
), joined AS (
  SELECT h.*, r.id AS reservation_id, r.billing_source, r.actual_cost_cents,
         d.n AS n_deducts, d.cents AS deduct_cents, d.credits, t.n AS n_txns
  FROM hops h
  JOIN ai_budget_reservations r ON r.idempotency_key = h.rkey
  LEFT JOIN LATERAL (
    SELECT count(*) AS n, sum(cost_cents) AS cents, sum(credits_deducted) AS credits,
           min(remaining_credits) AS remaining, min(created_at) AS at, min(partner_id::text) AS partner
    FROM billing_credit_deductions WHERE idempotency_key = 'ai-settlement:' || r.id
  ) d ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS n FROM billing_credit_transactions bt
    WHERE bt.partner_id::text = d.partner AND bt.type = 'usage'
      AND bt.balance_after = d.remaining AND bt.created_at = d.at AND bt.amount = -d.credits
  ) t ON true
)
SELECT left(agent_run_id::text, 8) AS run, hop, funding_source AS fund, round(cost_cents, 4) AS cost,
       left(reservation_id::text, 8) AS resv, round(actual_cost_cents, 4) AS settled,
       n_deducts, round(deduct_cents, 4) AS deducted, credits, n_txns,
       CASE WHEN funding_source = 'platform' AND cost_cents > 0 THEN 1 ELSE 0 END AS expected_deducts,
       (n_deducts = CASE WHEN funding_source = 'platform' AND cost_cents > 0 THEN 1 ELSE 0 END
        AND (n_deducts = 0 OR (deduct_cents = cost_cents AND n_txns = 1))) AS ok
FROM joined ORDER BY run, hop;

-- (B) summary
WITH hops AS (
  SELECT i.failover_hop AS hop, i.funding_source, i.cost_cents,
         'ai-agent-run:' || i.agent_run_id
           || CASE WHEN i.failover_hop > 0 THEN ':hop:' || i.failover_hop ELSE '' END AS rkey
  FROM ai_invocations i JOIN ai_agent_runs ar ON ar.id = i.agent_run_id
  WHERE ar.queued_at >= '2026-10-02 11:30:00+00'
), j AS (
  SELECT h.*, (SELECT count(*) FROM billing_credit_deductions d WHERE d.idempotency_key = 'ai-settlement:' || r.id) AS n,
              (SELECT sum(cost_cents) FROM billing_credit_deductions d WHERE d.idempotency_key = 'ai-settlement:' || r.id) AS cents
  FROM hops h JOIN ai_budget_reservations r ON r.idempotency_key = h.rkey
)
SELECT count(*) FILTER (WHERE funding_source = 'platform' AND cost_cents > 0) AS served_platform_hops,
       coalesce(sum(n), 0) AS deducts,
       coalesce(sum(n) FILTER (WHERE funding_source = 'partner_key'), 0) AS byok_hop_deducts,
       coalesce(sum(n) FILTER (WHERE cost_cents = 0), 0) AS failed_hop_deducts,
       count(*) FILTER (WHERE n > 0 AND cents <> cost_cents) AS amount_mismatches,
       (count(*) FILTER (WHERE funding_source = 'platform' AND cost_cents > 0) = coalesce(sum(n), 0)
        AND coalesce(sum(n) FILTER (WHERE funding_source = 'partner_key' OR cost_cents = 0), 0) = 0
        AND count(*) FILTER (WHERE n > 0 AND cents <> cost_cents) = 0) AS assertion_holds
FROM j;

-- (C) every reservation in the lab window, chat included
SELECT r.billing_source, count(*) AS reservations,
       count(*) FILTER (WHERE r.actual_cost_cents > 0) AS with_spend,
       sum((SELECT count(*) FROM billing_credit_deductions d WHERE d.idempotency_key = 'ai-settlement:' || r.id)) AS deducts,
       count(*) FILTER (WHERE (SELECT count(*) FROM billing_credit_deductions d WHERE d.idempotency_key = 'ai-settlement:' || r.id) > 1) AS multi_deduct,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM billing_credit_deductions d WHERE d.idempotency_key = 'ai-settlement:' || r.id AND d.cost_cents <> r.actual_cost_cents)) AS amount_mismatch
FROM ai_budget_reservations r
WHERE r.created_at >= '2026-10-02 11:00:00+00'
GROUP BY 1 ORDER BY 1;
SELECT count(*) AS orphan_deducts FROM billing_credit_deductions d
WHERE NOT EXISTS (SELECT 1 FROM ai_budget_reservations r WHERE 'ai-settlement:' || r.id = d.idempotency_key);

-- (D) every wallet 'usage' debit must be exactly one keyed ai-settlement deduct
WITH txn AS (
  SELECT bt.*, (SELECT count(*) FROM billing_credit_deductions d
                WHERE d.partner_id = bt.partner_id AND d.idempotency_key LIKE 'ai-settlement:%'
                  AND d.remaining_credits = bt.balance_after AND d.created_at = bt.created_at
                  AND d.credits_deducted = -bt.amount) AS matched
  FROM billing_credit_transactions bt
  WHERE bt.type = 'usage' AND bt.created_at >= '2026-10-02 11:00:00+00'
)
SELECT count(*) AS usage_txns,
       count(*) FILTER (WHERE matched = 1) AS matched_to_keyed_deduct,
       count(*) FILTER (WHERE matched <> 1) AS unmatched,
       -sum(amount) AS credits_debited,
       (SELECT sum(credits_deducted) FROM billing_credit_deductions WHERE created_at >= '2026-10-02 11:00:00+00') AS credits_in_keyed_deducts,
       (count(*) FILTER (WHERE matched <> 1) = 0
        AND -sum(amount) = (SELECT sum(credits_deducted) FROM billing_credit_deductions WHERE created_at >= '2026-10-02 11:00:00+00')) AS reconciliation_holds
FROM txn;
```

</details>

Raw output, final run (after the negative control was removed and the lost-response run was added):

```
   run    | hop |    fund     |  cost   |   resv   | settled | n_deducts | deducted | credits | n_txns | expected_deducts | ok
----------+-----+-------------+---------+----------+---------+-----------+----------+---------+--------+------------------+----
 2d47247f |   0 | platform    |  0.0000 | bb71445a |  0.0000 |         0 |          |         |      0 |                0 | t
 2d47247f |   1 | partner_key |  0.0000 | 2c6217ef |  0.0000 |         0 |          |         |      0 |                0 | t
 2d47247f |   2 | platform    |  1.8287 | 0849c842 |  1.8287 |         1 |   1.8287 |       2 |      1 |                1 | t
 6d729e47 |   0 | platform    |  2.4971 | 4b19a947 |  2.4971 |         1 |   2.4971 |       3 |      1 |                1 | t
 78d5b8a3 |   0 | platform    |  0.0000 | e77a14f5 |  0.0000 |         0 |          |         |      0 |                0 | t
 78d5b8a3 |   1 | partner_key |  1.5167 | d08912b8 |  1.5167 |         0 |          |         |      0 |                0 | t
 7c81da13 |   0 | platform    |  0.0000 | 8eb9b968 |  0.0000 |         0 |          |         |      0 |                0 | t
 7c81da13 |   1 | partner_key | 17.9632 | 5bb1c94c | 17.9632 |         0 |          |         |      0 |                0 | t
 8398768c |   0 | platform    |  0.0000 | 324e2c17 |  0.0000 |         0 |          |         |      0 |                0 | t
 8398768c |   1 | platform    |  8.9471 | 1c1bbe2e |  8.9471 |         1 |   8.9471 |       9 |      1 |                1 | t
 a39f4de6 |   0 | platform    |  0.0000 | cfe47618 |  0.0000 |         0 |          |         |      0 |                0 | t
 a39f4de6 |   1 | platform    |  1.6733 | 1bc1a1bb |  1.6733 |         1 |   1.6733 |       2 |      1 |                1 | t
 bdbeb2de |   0 | platform    |  0.0000 | 1623a060 |  0.0000 |         0 |          |         |      0 |                0 | t
 bdbeb2de |   1 | partner_key |  1.5107 | 6975312c |  1.5107 |         0 |          |         |      0 |                0 | t
 bf39446e |   0 | platform    |  0.0000 | c429f7ad |  0.0000 |         0 |          |         |      0 |                0 | t
 bf39446e |   1 | partner_key |  1.5077 | 2b070e0a |  1.5077 |         0 |          |         |      0 |                0 | t

 served_platform_hops | deducts | byok_hop_deducts | failed_hop_deducts | amount_mismatches | assertion_holds
----------------------+---------+------------------+--------------------+-------------------+-----------------
                    4 |       4 |                0 |                  0 |                 0 | t

 billing_source | reservations | with_spend | deducts | multi_deduct | amount_mismatch
----------------+--------------+------------+---------+--------------+-----------------
 partner_key    |            5 |          4 |       0 |            0 |               0
 platform       |           22 |         11 |      11 |            0 |               0

 orphan_deducts
----------------
              0

 usage_txns | matched_to_keyed_deduct | unmatched | credits_debited | credits_in_keyed_deducts | reconciliation_holds
------------+-------------------------+-----------+-----------------+--------------------------+----------------------
         11 |                      11 |         0 |             105 |                      105 | t
```

`6d729e47` (hop 0, platform Haiku) is the run admitted directly onto the backup while the primary was cooling (#7787). It was still debited exactly once.

### Negative control: PASS

In the **lab billing DB only**:
1. An **unkeyed** deduct call to the billing service for the cost of reservation `0849c842` (already settled and debited) → `200 {"creditsDeducted":2,…}`. This is the realistic double debit: a debit that bypasses the key.
2. A direct duplicate insert of that reservation's keyed row into `billing_credit_deductions` → **refused**: `duplicate key value violates unique constraint "billing_credit_deductions_partner_key_uniq"`. A double debit under the same key cannot exist at all.

Re-running the assertion after step 1:

```
 usage_txns | matched_to_keyed_deduct | unmatched | credits_debited | credits_in_keyed_deducts | reconciliation_holds
------------+-------------------------+-----------+-----------------+--------------------------+----------------------
         11 |                      10 |         1 |             105 |                      103 | f
```

**The assertion fails**, as it should. Note that parts (A)–(C) only see keyed deducts, so they stayed green. The unkeyed debit is caught by the wallet reconciliation (D), and that is why D is part of the assertion. The extra `billing_credit_transactions` row was then deleted and the 2 credits restored. The re-run went back to `reconciliation_holds = t` (10/10/0 at that point).

### Lost-response retry: PASS

A second local proxy in front of the billing service forwarded the **first** keyed deduct, let billing commit it, and then **dropped the response** (socket destroyed). The API was then **restarted**. Run `a39f4de6`, cross-funding OFF, 529 on platform Sonnet → served by platform Haiku at hop 1 (reservation `1bc1a1bb`, 1.6733¢).

```
11:40:31  deduct key=ai-settlement:1bc1a1bb…  billing 200 {"creditsDeducted":2,"remainingCredits":99895}  → response DROPPED
          reservation: credits_debit_due_at set, credits_debit_error='transport'
          API log: "platform credit debit not confirmed; the sweep retries it under the same key"
11:41:06  API restarted
11:45:00  deduct key=ai-settlement:1bc1a1bb…  billing 200, Idempotent-Replayed: true, same body
          reservation: credits_debited_at=11:45:00, error cleared
billing_credit_deductions for that key: 1 row (created 11:40:31)
billing_credit_transactions since 11:40: 1 row, -2 credits
```

The retry came from the 5-minute reservation sweep after the restart, under the same key. Billing replayed it, so nothing was debited twice.

## L3: cooldown cleared after key rotation: PASS

1. **15-minute cooldown on a connection:** in run `2d47247f` above, BYOK Sonnet got a genuine provider 401 on its invalid key → `ai-model:cooldown:862b5e00` = `auth_failed`, pttl about 888 s.
2. **Control while cooling:** run `6d729e47` was admitted directly onto platform Haiku. BYOK was skipped because it was cooling.
3. **Rotate** through the W04 route `POST /ai/models/connections/:id/key` with the valid key → `200 {configVersion: 2}`. Redis immediately after: the `862b5e00` key was **gone**, about 14 minutes before it would have expired. Only the platform Sonnet 60-s key remained.
4. **Next request:** run `bdbeb2de` (529 on platform Sonnet) → **hop 1 = BYOK Sonnet `862b5e00`, served** (1.51¢, `partner_key`, cause `overloaded`).

The legacy `POST /ai-provider/key` does not clear cooldowns. That is the known gap: W08 deletes the route, and it was not exercised here.

## Other observations (not filed)

- **The CLI retries a dead key for about 3 minutes in chat.** 529, 429 and 401 are retried 10 times with backoff up to 20 s, so with #7785 a technician waits about 3 minutes for an empty answer. Agent runs cut this short after 2 retries, or at once for 401 and quota.
- **Chat cools only after the turn ends.** That is why the first failing message always fails, even with a healthy backup (D5 as designed; in-turn replay is #7772).
- **Settings UI paper cuts (W04/W09):**
  - The "Default model" dropdown lists two "Claude Sonnet 5.5" and two "Claude Haiku 4.5" entries with no funding hint. The backup list does show "Your API key".
  - Switching cross-funding OFF silently removes a cross-funding backup from the draft list.
  - The usage-by-model view labels the BYOK Sonnet offering with its raw id `claude-sonnet-5-5`.
- **Billing transaction description:** agent-run deducts are written as "AI chat message" in `billing_credit_transactions.description`.
- **Per-query fixed cost:** a brand-new chat's first turn wrote about 94.8k cache tokens (versus about 18.5k at W05), and an agent run about 71.6k. Cold first turns cost about 24¢ on Sonnet and about 47¢ on Opus.

## Lab-only changes and clean-up

- The SQL edits were lab-only:
  - the wallet row;
  - Opus `option_rates` and offering options for the fast-mode check, later reverted;
  - the sealed invalid BYOK key, which the L3 rotation replaced.
- The fault and billing proxies, SDK probe and assertion scripts lived in the job's scratch directory and are not committed.
- Teardown: local billing stopped and its worktree `.env` deleted; `pnpm wt-stack down`; the stack worktree's `.env` deleted; the port-forward container removed.

## Re-check 2026-10-02 (post-#7789)

**Verdict: L1 PASS.** The low-credit chat case passes now. #7784 and #7786 are fixed on a live stack, and the 529 / 401 chat cases and the agent-run low-credit case have not regressed.

- **Build:** `origin/main` at `a302d00a45`, which is the #7789 merge. A fresh worktree, brought up with `pnpm wt-stack up` with the same traps as the first run: `BREEZE_WORKSPACE_ENABLED=false`, a free subnet, and `BREEZE_AI_AGENTS_ENABLED=true`.
- **Models:** the real platform key, held only in the stack env, with the fault proxy as `ANTHROPIC_BASE_URL` and the same injection bodies as the first run.
- **Billing service:** not run. It is not needed for these cases. A reservation that billing would debit is marked `credits_debit_due_at`; a 0¢ reservation never is.
- **Config (API):** Chat and AI agents default = platform Sonnet 5.5 `59cbb1ee`, backup = platform Haiku 4.5 `6f8ee408`, cross-funding off. There is no BYOK connection, so the backup is hop 1 here (it was hop 2 in the first run, behind the BYOK entry).
- **Spend:** USD 0.19 from the ledger, plus about 4.7k input tokens of CLI background calls. The cap was USD 3.

| Case | Verdict |
|---|---|
| Chat, low credit: cooldown + next-message failover (#7784) | **PASS** |
| Chat, low credit: failed turn labelled with the bound model (#7786) | **PASS** |
| Chat, 529 (regression) | **PASS** |
| Chat, 401 (regression) | **PASS** |
| Agent run, low credit (regression) | **PASS** |

### Chat, low credit: PASS

Turn 1: a single Sonnet request, injected `400 invalid_request_error` "credit balance is too low", no retry.

- **Cooldown:** `ai-model:cooldown:59cbb1ee` = `quota_exhausted`, pttl 899,524 (**15 min**). Before #7789 no key was written at all.
- **Label (#7786):** `turn_model` = `{"requestedModel":"claude-sonnet-5-5","servedModel":"claude-sonnet-5-5","fallbackUsed":false,…}`. `ai_sessions.last_turn_model` holds the same: bound model, `fallbackUsed: false`.
- **Money:** ledger row `59cbb1ee` platform, 0 tokens, **0¢**, `stop_reason=error`. Its reservation settled at 0 with `credits_debit_due_at` NULL, so it is not debited.

Turn 2, sent while the cooldown was live:

```
67c0c9c1  chat  6f8ee408 platform claude-haiku-4-5  in 3 / out 4 / cw 74,410  9.3036¢  hop 1  cause cooldown  from 59cbb1ee  end_turn
reservation binding failover: {"hop": 1, "cause": "cooldown", "fromOfferingId": "59cbb1ee…"}
turn_model: requested/served claude-haiku-4-5, fallbackUsed false
```

- **D6:** the session was not re-stamped. `ai_sessions.model` = `claude-sonnet-5-5`, offering `59cbb1ee`, `billing_source` platform.

### Regression: chat 529 and 401: PASS

| Case | Turn 1 | Cooldown | Turn 1 label | Turn 2 |
|---|---|---|---|---|
| 529 | about 3 min of CLI retries, then 0¢ `error` | `overloaded`, pttl 59,912 (60 s) | bound Sonnet, `fallbackUsed:false` (was Haiku/true before #7789) | platform Haiku, hop 1, cause `cooldown`, 0.81¢; session not re-stamped |
| 401 | about 3 min of CLI retries, then 0¢ `error` | `auth_failed`, pttl 899,921 (15 min) | bound Sonnet, `fallbackUsed:false` | platform Haiku, hop 1, cause `cooldown`, 0.81¢; session not re-stamped |

`last_turn_model` after turn 2 names the model that actually served (Haiku) with `fallbackUsed: false`. That is correct: Haiku was the resolved model for that turn, not a refusal swap.

### Regression: agent-run low credit: PASS

Run `52c6cd2d` (a triage partner baseline, profile `full`, so role `analysis`):

```
run: admitted 59cbb1ee platform → served 6f8ee408 platform, served_failover_hop 1, cause quota_exhausted
hop 0  59cbb1ee  0¢     error     reservation ai-agent-run:52c6cd2d…        settled 0
hop 1  6f8ee408  7.82¢  end_turn  reservation ai-agent-run:52c6cd2d…:hop:1  settled 7.82, binding failover {hop 1, cause quota_exhausted}
cooldown: 59cbb1ee quota_exhausted, pttl about 892 s
```

### Still open (unchanged)

- **#7785:** every failed chat turn still ends with only `turn_model` + `done`, with no error event. On 529 and 401 the empty answer arrives after about 3 minutes of CLI retries. It was out of scope for #7789.

### Clean-up

`pnpm wt-stack down`; the stack worktree's `.env` deleted; the fault proxy stopped. No billing service was started.

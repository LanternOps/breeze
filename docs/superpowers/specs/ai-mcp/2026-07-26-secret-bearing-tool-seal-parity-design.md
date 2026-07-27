# Design — Seal parity for secret-bearing AI tools

**Date:** 2026-07-26
**Branch:** `ToddHebebrand/inline-reset-password-seal-parity`
**Base:** `96371e53f` (main)
**Status:** design approved; revised after independent review (Fable + Codex gpt-5.6, both read-only)

Supersedes the deferred "Task 13 seal-parity" item in the `m365-actions-consent`
SDD progress log, which scoped the problem to the inline M365 path only.

> **Revision note.** The first draft of this spec claimed four plaintext-leaking
> paths. Two independent reviews refuted the two inline claims with the same
> evidence, verified in-session: inline tool output is regex-redacted before it
> reaches any sink. There is **one** confirmed plaintext leak, not four. The
> inline defect is real but is credential *destruction*, not exposure. §2 is
> rewritten accordingly; the fix shape survives, its motivation changes.

---

## 1. Problem

Two AI tools mint temporary credentials — `m365_reset_password` and
`google_reset_password`. Both are tier-3 and approval-gated. Three defects:

1. **One confirmed plaintext leak.** `google_reset_password` executed by the
   durable release worker stores the credential in the clear, permanently, in
   `action_intents.result` (§2.1).
2. **The inline path destroys the credential.** It is regex-redacted to
   `[REDACTED]` before every sink and never sealed, so chat shows the operator
   nothing and the reveal flow has nothing to reveal (§2.2).
3. **Plan mode executes tier-3 with no intent row**, so a credential minted
   there has nowhere to be sealed — and, independently, the durable four-eyes
   approval is bypassed (§2.4).

After approval, **either** the durable worker **or** the inline chat path can
win the release CAS (`aiAgentSdk.ts:651-661`), so the outcome of the same
operator action depends on a race.

## 2. Findings

### 2.1 Confirmed leak — Google durable path (Critical)

`sealActionResultSecrets` (`services/actionIntents/resultSecrets.ts:35-58`) is
coupled to one tool's structured output shape:

```ts
if (result.action !== 'm365.user.reset_password') return result;   // gate
const pw = result[TEMP_PASSWORD_LEGACY_KEY];                        // structured field
```

`googleResetPasswordAction` (`aiToolsGoogle.ts:287`) returns prose with the
credential interpolated. In the worker, `normalizeToolResult`
(`intentReleaseWorker.ts:73-83`) cannot parse prose as JSON, so it yields
`{ raw: "…Temporary password: X…" }` whose `action` is undefined — the seal
returns it unchanged and it is persisted (`intentReleaseWorker.ts:318, 351-353`).
The worker path applies **no redaction at all**; `compactToolResultForChat` is
inline-only.

Every downstream protection misses it, because they match jsonb **keys** while
the credential sits inside a string **value**:

- the reaper's `result ?| array['temporaryPasswordEnc','temporaryPassword']`
  (`intentExpiryReaper.ts:290-293`) — never sweeps it, so no 7-day expiry;
- `/ai/admin/tool-executions` `tempPasswordState` (`routes/ai.ts:1272-1278`) —
  reports `none`;
- the reveal route 404s on the `{raw}` shape (`routes/actionIntents.ts:55`).

**Exposure is at-rest, not an API surface.** No HTTP endpoint projects
`action_intents.result`. The exposed population is the database itself, its
backups, WAL, and any direct DB actor with an appropriate RLS context.

### 2.2 Inline paths — redacted and unrevealable, NOT leaking (corrects the first draft)

`makeSessionAwareHandler` applies `compactToolResultForChat` to the handler's
return **before** anything else (`aiAgentSdkTools.ts:475`), and that compacted
value is what reaches `safePostToolUse` (`:487`) *and* the LLM/MCP response
(`:488`). Non-JSON prose takes the `redactAiToolOutputText` branch
(`aiToolOutput.ts:442-462`), whose pattern (`logRedaction.ts:10`) matches
`password:` and replaces the value. Verified against the real template:

```
in : Reset the password for user@example.com. Temporary password: Bz9!oVnL920blvsjqqMy (…)
out: Reset the password for user@example.com. Temporary password: [REDACTED] (…)
```

Both in-repo generators emit `[!A-Za-z0-9]` only (`aiToolsGoogle.ts:230-235`,
`m365DirectGraph.ts:67-70`). Git history corroborates: the redacting branch
shipped 2026-05-05 (`2c3a8e10f`), before the M365 reset handler (2026-05-29)
and Google reset (2026-06-11).

So `ai_messages`, `ai_tool_executions`, the inline `action_intents.result`
write, the SSE stream, the browser, and the model all receive `[REDACTED]`. The
defect is that the credential is **lost** — nothing is sealed, and the operator
is shown a redaction marker.

**Residual risk (real, narrow).** The regex terminates at whitespace, `,`, `;`,
or `&`. A Delegant-brokered M365 reset returns a broker-generated password typed
`any` (`aiToolsM365.ts:267-268`) with no charset guarantee; such a value could be
partially redacted, leaking its tail. This is an argument for the structured
carrier rather than continued reliance on content-matching.

### 2.3 Path summary

| Path | Tool | Status |
|---|---|---|
| Durable worker | `m365_reset_password` | Sealed — correct |
| Durable worker | `google_reset_password` | **Plaintext at rest (Critical)** |
| Inline chat | `m365_reset_password` | Redacted, unsealed, unrevealable; Delegant charset residual |
| Inline chat | `google_reset_password` | Redacted, unsealed, unrevealable |

M365 durable is sealed **by design, not incidentally**: `executeM365ToolHeadless`
(`m365ToolsHeadless.ts:76-92`) returns `writeActionResultSchema`'s
`{ success, action: 'm365.user.reset_password', temporaryPassword, … }`
(`packages/shared/src/m365/writeActions.ts:59-70`), the shape `resultSecrets.ts`
was purpose-built against. It does **not** flow through `m365DirectGraph.ts:259`.

### 2.4 Plan mode bypasses the intent invariant (Critical, pre-existing)

`propose_action_plan` validates plan steps only for membership in `TOOL_TIERS`
(`aiAgentSdkTools.ts:1883`), not tier level; both reset tools are members
(`:174`, `:186`). In `action_plan`/`hybrid_plan` mode a matched step returns
`{ allowed: true }` (`aiAgentSdk.ts:404-432`) **before** the tier-3
`createActionIntent` branch (`:533`). No intent row exists and
`pendingIntentBySession` is unset.

Two consequences: a credential minted there has nowhere to be sealed (§6 case 2
is reachable, not theoretical), and — independently of this work — a single
user's plan approval executes a tier-3 action without the durable four-eyes
approval.

**Scope decision:** this phase applies the *minimal* fix — secret-bearing tools
bypass the plan shortcut and fall through to `createActionIntent`. The general
defect (any tier-3 tool executing via an approved plan with no intent row)
affects every tier-3 tool and is filed as its own security issue.

### 2.5 Surfaces checked, no leak found

Both reviews independently cleared: external API-key MCP (session-aware tools
unreachable; `mcpToolExecutionLedger.ts:131` stores size/hash/keys, not result
text), `clientAiTools` (separate Office registry, DLP before persistence),
helper chat (`helperToolFilter.ts` is device-scoped, excludes these tools),
playbooks, audit details (`auditPayloadSanitizer.ts:99`), Prometheus labels,
console/Sentry, session titles (derived from user content), `historyBuilder.ts`,
and admin tool-execution reporting. No embeddings, digests, summaries, or export
jobs read these rows.

## 3. Non-goals

- Re-sealing historical credentials (§7 — redact, not preserve).
- Changing `resultSecrets.ts` internals, the reveal endpoint, the burn CAS, the
  reaper, or the reveal UI. Normalising the *shape* makes all of them work for
  Google unchanged.
- The general tier-3 plan-mode bypass beyond secret-bearing tools (§2.4).
- Inline display of the credential. Approved UX is reveal-link only (§5).

## 4. Approach

Make the credential structured at the source, seal at one chokepoint both
execution paths must pass, and make an unregistered secret-bearing tool fail
loudly instead of silently.

Rejected alternatives: **redaction over prose at persistence** (content-matching
is the fragility that produced §2.2's residual risk); **seal inside the handler**
(inverts layering; the handler signature carries no intent id);
**AsyncLocalStorage collector** (no signature change, but makes the invariant
discipline rather than a compile error — its runtime guard is retained as
defence in depth, §4.5).

### 4.1 New module — `services/actionIntents/secretBearingTools.ts`

```ts
const SECRET_BEARING_TOOLS = ['m365_reset_password', 'google_reset_password'] as const;
export function isSecretBearingTool(toolName: string): boolean;   // normalizes via stripMcpPrefix

export type SecretToolResult =
  | { kind: 'success'; llmText: string; secrets: { temporaryPassword: string };
      meta?: { delegantToolCallId?: string } }
  | { kind: 'error'; llmText: string };

export function sealToolSecrets(
  result: SecretToolResult,
): { llmText: string; sealedResult: Record<string, unknown> };
```

Four requirements the reviews established:

- **Not an exported mutable `Set`.** A readonly tuple plus a module-private
  predicate; an exported `Set` lets any importer mutate the security registry.
- **`isSecretBearingTool` normalizes the name.** Tool names appear both bare and
  `mcp__breeze__`-prefixed; an unnormalized membership test silently disables
  the §4.5 guard.
- **Discriminated on `kind`.** Success *requires* `secrets`; error *forbids*
  them. A malformed success cannot silently carry nothing.
- **Seal with `ACTION_INTENT_RESULT_AAD`** (`'action_intents.result'`), or
  `unsealTemporaryPassword`'s strict decrypt (`resultSecrets.ts:81`) 500s every
  reveal.

`sealToolSecrets` is pure and synchronous — no DB, no intent id — and additionally
**asserts `llmText` does not contain the secret**, substituting a safe message if
it does. Defence in depth against a future handler reintroducing interpolation.

### 4.2 Handler changes

`googleResetPasswordAction` (`aiToolsGoogle.ts:271-291`) and
`m365ResetPasswordHandler` (`aiToolsM365.ts:244-275`) return `SecretToolResult`.
`llmText` states the reset succeeded and the credential is available for one-time
reveal, and never interpolates it. For M365 this removes `data.temporaryPassword`
from `formatResultForLlm`'s `successTemplate`.

`meta.delegantToolCallId` must be preserved: it is embedded in the JSON envelope
today (`m365Helpers.ts:37-45`) specifically so post-tool persistence can
correlate to Delegant's audit ledger (`aiAgentSdk.ts:1009`). Dropping it breaks
audit correlation.

### 4.3 Interception seam (corrected)

The first draft placed the split at `aiAgentSdk.ts:904`. **That is wrong** — the
LLM response is returned from `makeSessionAwareHandler` (`aiAgentSdkTools.ts:488`)
and the postToolUse callback returns `void`, so `:904` cannot influence what the
model receives, nor can it route a sealed blob to the intent write.

The split happens **immediately after `sessionHandler` returns**
(`aiAgentSdkTools.ts:470`), before `compactToolResultForChat`:

| Consumer | Receives |
|---|---|
| `compactToolResultForChat` → MCP/LLM response, SSE, `ai_messages`, `ai_tool_executions` | `llmText` only |
| the intent `result:` write (`aiAgentSdk.ts:1044-1045`) | `sealedResult`, carried out-of-band |
| Worker `storedResult` (`intentReleaseWorker.ts:318`) → `transitionIntent` | `sealedResult` |

Carrying `sealedResult` to the completion callback requires either widening
`PostToolUseCallback` (whose `output` is typed `string`, touching `safePostToolUse`
and ~50 `makeHandler` registrations — mechanical but real blast radius) or a
session-keyed side channel. **Decision: widen the callback.** The side channel
reintroduces exactly the implicit-coupling failure mode this design exists to
remove, and the compiler enumerates the registrations for us.

Double compaction is idempotent, so `compactToolResultForChat` needs no change.

### 4.4 Worker changes

`isReturnedToolError` (`intentReleaseWorker.ts:323`) must run against the
carrier's `llmText`; error carriers keep the `errorString()` JSON shape.
Otherwise Google release failures record as completions — the audit-integrity
bug the worker comment at `:85-96` warns about.

### 4.5 Fail-loud guard

At every persistence site, if `isSecretBearingTool(toolName)` and the value did
not come from `sealToolSecrets`, throw rather than write. This must cover the
worker's **returned-error** persistence (`intentReleaseWorker.ts:324`), not only
completed results.

**`safePostToolUse` swallows callback exceptions** (`aiAgentSdkTools.ts:228`), so
a guard that only throws inside postToolUse is decorative: the wrapper would
still return a success message to the model. Secret-tool sealing failures and
missing-intent failures must therefore be raised in the wrapper, before the
response is composed — not left to the swallowed callback.

### 4.6 Plan-mode minimal fix

In `aiAgentSdk.ts:404-432`, secret-bearing tools do not take the plan-match
shortcut; they fall through to the tier-3 `createActionIntent` branch so a
sealed credential always has an intent to live in. Tests cover both
`action_plan` and `hybrid_plan`.

## 5. Operator UX

Chat reports the reset succeeded and the credential is available for one-time
reveal. Retrieval is exclusively via the shipped `ApprovalHistoryFeed` control,
backed by `POST /action-intents/:id/reveal-secret`.

Google inherits this with no component changes — same `temporaryPasswordEnc`
key, so reveal, burn-on-read, the 7-day sweep, and `tempPasswordState` all begin
working for it. Inline executions already stamp `intentId`
(`aiAgentSdk.ts:576-587`), so the feed join works.

Known gap, unchanged: MCP-sourced intents have no feed row and so no reveal UI;
the admin API fallback applies. When `mcp_api` intents ship
(`actorContext.ts:151-156` notes they are not yet created), the §4.5 guard must
extend to that seam.

## 6. Error handling

All cases fail **closed**: the reset already happened at the provider and cannot
be undone, so the correct failure is "credential unretrievable, reset again",
never "store it in the clear".

1. **Seal produces non-v3 ciphertext** (`APP_ENCRYPTION_KEY_ID` unset). Reuse
   `resultSecrets.ts` behaviour: drop plaintext, set
   `temporaryPasswordSealFailed`. `sealToolSecrets` must **substitute** `llmText`
   here, or chat promises a reveal that 404s.
2. **No intent for the credential to live in.** Reachable today via plan mode
   (§2.4); §4.6 closes it for secret-bearing tools.

   **Revised after Task 5 review (plan owner ruling).** The original design
   dropped the credential *after* the reset had happened. That is wrong: the
   wrapper knows whether an intent exists **before** it invokes the handler, so
   it can refuse outright rather than performing an irreversible provider-side
   reset it already knows it cannot record. The guard therefore runs
   **pre-execution**, and the handler is never called.

   Two distinct operator messages, which must not be conflated:
   - *refused* — the reset did **not** happen; retrying is safe;
   - `SECRET_UNAVAILABLE_TEXT` — the reset **did** happen but the credential
     could not be sealed; the operator must reset again.

   This also removes a live failure mode: without it, a plan-mode reset would
   reset, discard the credential, instruct the operator to reset again, and
   repeat — an unbounded loop of real password resets.

   The check must be in the wrapper, not the postToolUse callback:
   `safePostToolUse` swallows callback exceptions, so a throw there would be
   absorbed while the model was still told the reset succeeded.
3. **Size cap.** The worker re-checks `MAX_RESULT_BYTES` after sealing
   (`intentReleaseWorker.ts:343-350`) since ciphertext exceeds plaintext. The
   inline path has no such check; add the equivalent.
4. **Tool returned an error / lost the completion CAS.** Error carriers have no
   `secrets`. On a lost CAS the sealed credential is not recorded — lost, not
   leaked.

## 7. Historical remediation

### 7.1 Survey (read-only, operator-run, precedes any scrub)

The realistic target population is **`action_intents.result` rows from the
Google durable path**. Inline rows contain `[REDACTED]`, so a naive
`LIKE '%Temporary password:%'` conflates safe rows with leaks and never reaches
zero on re-run.

Requirements:

- count **redacted** and **suspected-plaintext** rows separately;
- exclude `%[REDACTED]%` and `%[redacted]%` from the suspected-plaintext count;
- scope by exact tool/action name;
- cover the Delegant envelope shape `tool_output.message`
  (`m365Helpers.ts:43-45`) in addition to `raw`;
- counts only — no credential values, no tenant identifiers; run per region.

None of these predicates are indexable; expect sequential scans, run off-peak.

### 7.2 Scrub (conditional on survey counts)

Idempotent migration that **redacts rather than re-seals** — these credentials
are weeks old, all carried `forceChangePasswordNextSignIn`, and preserving a
secret nobody asked to keep is the opposite of the goal. It drops the
`temporaryPassword` key and replaces the credential in `raw`/`message`, leaving
the `temporaryPasswordExpired` marker the reaper already uses.

- **Anchor the replacement** between the literal prefix `Temporary password: `
  and the fixed suffix ` (the user must change it at next sign-in).` rather than
  matching greedily.
- **Log unconditionally.** `GET DIAGNOSTICS n = ROW_COUNT` then `RAISE WARNING`
  with a static table label and the count **even when zero** — a deliberate
  deviation from CLAUDE.md's `IF n > 0` snippet, because a zero count is itself
  the evidence that no exposure occurred. (The first draft asserted both and
  contradicted itself.) Forbid logging values, row ids, or org ids.
- Idempotent, re-runnable, no inner `BEGIN;`/`COMMIT;`, fix-forward only.
- **Post-migration assertion:** zero residual suspected-plaintext matches.

**In-window credential burn.** Sealing shipped 2026-07-21 (`d6c98e9c3`); legacy
plaintext rows younger than 7 days are legitimately revealable today
(`resultSecrets.ts:83-84`). A scrub burns credentials an operator may be about
to reveal. Accepted — operator comms: re-reset.

**Residual.** The scrub bounds *forward* exposure only. Dead tuples, WAL
archives, and base backups retain plaintext until vacuum and retention lapse.

Regex-over-prose is accepted **here only** — a one-shot pass against known
constant templates, not a load-bearing runtime path.

Mechanically unblocked: `result` is absent from the `action_intents` immutability
deny-list (`migrations/2026-07-18-action-intents.sql:95-115`), which is why the
reaper can already rewrite it; chat tables carry no immutability trigger.

### 7.3 Tenancy

No new tables and no new `org_id` columns — no RLS shape and none of the four
cascade lists are affected.

## 8. Testing

1. **Unit — `sealToolSecrets`:** seals a success carrier; rejects/substitutes an
   `llmText` containing the secret; on non-v3 drops plaintext, sets
   `temporaryPasswordSealFailed`, and substitutes `llmText`; error carriers carry
   no secret.
2. **Unit — both handlers:** the generated credential is **not a substring** of
   `llmText`. Non-containment specifically; a review on this branch's lineage
   previously caught this assertion being weakened. Also assert
   `meta.delegantToolCallId` survives.
3. **Contract/parity:** the registry equals the set of handlers that can mint a
   credential, via a source scan for `generateTempPassword` / `temporaryPassword`
   outside the registry. Requires an **explicit allowlist** for legitimate
   references (`m365DirectGraph.ts`, `writeActions.ts`, `writeActionService.ts`,
   `resultSecrets.ts`, `routes/actionIntents.ts`, `intentExpiryReaper.ts`,
   `routes/ai.ts`, tests) or it ships noisy and gets disabled.
4. **Guard tests:** a secret-bearing tool persisted without passing the
   chokepoint throws — including on the worker's returned-error path — and the
   failure is **not** swallowed by `safePostToolUse`.
5. **Plan mode:** `action_plan` and `hybrid_plan` both create an intent for
   secret-bearing tools (§4.6).
6. **Integration, real Postgres** — both tools × both paths: after execution,
   `ai_messages`/`ai_tool_executions` contain neither plaintext nor a bare
   `[REDACTED]` credential marker, `action_intents.result` carries
   `temporaryPasswordEnc`, the first reveal succeeds and the second fails. Plus a
   direct regression for §2.1 that **must fail against current `main`**.

Note: unit tests use mocks and `any` in places, so the compiler alone does not
prove correct secret routing — the integration layer is what establishes it.

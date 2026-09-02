---
tracking_issue: LanternOps/breeze#3821
wave: W05 (#3826) — Part B (act mode)
---

# Wave 4 Part B — Act Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mode: 'act'` becomes real: an agent may unattendedly execute a **closed, hard-enumerated manifest of rule-equivalent operations** (service restart, disk cleanup, process kill, saved-library scripts, built-in playbooks via a new deterministic executor, exact remediation-suggestion matches) — each with revalidate → reserve → execute → verify → always-notify — while everything else Tier-3 still becomes an approval intent, and four_eyes/T4/secrets stay structurally unreachable.

**Architecture:** A new `disposition: 'act'` branch in `checkAgentGuardrails`, sitting exactly where the shadow branch sits, granted ONLY when the live mode is `act` AND `resolveActOperation(toolName, input)` matches the manifest AND the tool is allowlisted. Act executes **through the normal tool implementation** (`allowed: true`): the pre-hook performs the manifest's revalidate (live `resolveEffectiveAgentSystem` re-check + full guardrail re-run + device-arg === run.deviceId + asset pinning/digest into the execution context) and reserves a `maxActionsPerRun` slot; the post-hook performs the op-specific verification read-back, computes execution × verification verdicts, and records everything in the ledger + outcome. This avoids double-execution and keeps tool output flowing to the model, while preserving every quorum gate. (Deviation from the quorum's literal "manifest owns execute()" shape — flagged; the gates are identical, the executor is the already-tested tool path.) Verification failures produce a rule-less alert (`context.source: 'ai_agent_act_verify'`, dnsThreatAlerts direct-insert precedent) plus a prominent notification. A new server-owned **deterministic playbook executor** runs BUILT-IN playbooks (digest-pinned definitions; each mutating step independently admitted by the manifest; verifyCondition evaluated server-side; bounded waits) — the current `execute_playbook` "model executes the steps" stub is never act-eligible. A thin agent-safe resolver maps an exact remediation-suggestion match to the manifest's `run_script` op. `SUPPORTED_AGENT_MODES` gains `'act'` with activation prerequisites (≥1 resolvable recipient, ≥1 act-eligible allowlisted tool) and explicit UI acknowledgement.

**Tech Stack:** TypeScript, Drizzle, Vitest (+ the web form + i18n). **No migrations** (manifest/verdicts live in existing jsonb columns; playbook executor uses existing `playbook_executions` statuses; alerts insert rule-less rows — `rule_id` is nullable).

**Design authority:** Program spec (wave-4 row) + advisor quorum 2026-08-27 — decisions LOCKED, do not relitigate:
- Manifest v1 exactly: `manage_services: restart` (start/stop → propose), `disk_cleanup: execute` (pinned to the latest preview plan + byte/path bounds), `manage_processes: kill` (identity revalidation, not bare PID), `run_script` (saved script + pinned content/digest via `verifiedRunScriptFor`; **per-script act authorization** — `toolAllowlist: ['run_script']` alone authorizes NO script; the agent's `protectedResources`-adjacent config gains an `actScriptIds` allowlist, see Task 6), `execute_playbook` (BUILT-INS only, digest-pinned, via the new executor), remediation-suggestion exact match (script-target only, resolved to the run_script op). `execute_command` NEVER act-eligible (lower-level alias path). NO blanket Tier-2 mutation execution — an unmatched Tier-2 mutation records a non-executable proposal exactly as shadow does.
- Revalidate before EVERY act execution; drift act→shadow converts to proposal; disabled/off/kill-switch/protected/out-of-scope → deny (fail closed, never proposal).
- Verdict model: `execution: succeeded|failed|timeout|unknown`, `verification: passed|failed|inconclusive|skipped`, `runVerdict: remediated|needs_attention|partial|no_action`. Verify-failure ⇒ run stays `completed` + alert + prominent notify; NO auto-intent; NO rollback.
- `maxActionsPerRun` reserved in the PRE-hook (slot before dispatch; failed/timeout/unknown count; read-only calls don't; each mutating playbook step counts individually).
- Tier gates untouched: four_eyes/T4/secret-bearing/site-scope/protected-resources denies sit UPSTREAM of the act branch and this plan must not move or weaken any of them.

## Global Constraints

- Run single test files as `cd apps/api && npx vitest run <path>`; typecheck with the heap bump; shared edits also run `pnpm --filter @breeze/shared test`; new web strings need en + locale files (tr-TR parity reds any missing key — check how `aiAgentsPage.modes.*` keys are registered and mirror).
- No new env vars. **`actAssets` storage decision tree (Task 6):** it must NOT be shoehorned into a semantically wrong jsonb column (`protectedResources` is protection, `toolAllowlist` is `string[]`, `limits` is numeric caps, `recipients`/`triggers` are what they say). Grep the `ai_agents` schema first; if — as expected — no existing column is a semantically honest carrier, this plan's ONE permitted migration is `ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS act_assets jsonb` (idempotent; filename sorts after the newest committed migration — check `ls apps/api/migrations/*.sql | sort | tail -1` at implementation time, never trust today's date) **plus the mandatory column registration: `CORE_TENANT_EXPORT_POLICY` gains `act_assets` under `excludedOpen`** (open jsonb container) — a new column on an org-cascade table without that entry reds the integration-only export-policy suites after merge. RLS/cascade lists are untouched (existing table, no new table). Flag the migration in the PR body.
- The act branch may ONLY be reachable when `policy.mode === 'act'`; every existing shadow/deny/propose test must pass unchanged. Snapshot v2 already carries `maxActionsPerRun` (Part A).
- Playbook executor waits: `waitSeconds` capped at 60 per step, total executor wall-clock bounded by the run's remaining `wallClockSeconds`.
- Commit after every task with trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_012o7QB15EFjEvetDAXMxmae`

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/aiAgents/actManifest.ts` (new) | The closed manifest: op matchers/normalizers/asset-authorizers/verify specs; `resolveActOperation`. |
| `apps/api/src/services/aiAgents/actRevalidation.ts` (new) | Per-op revalidate (live policy + guardrail re-run + device pinning + asset pin) + reserve counter. |
| `apps/api/src/services/aiAgents/actVerify.ts` (new) | Op-specific verification read-backs + verdict computation + verify-failure alert insert. |
| `apps/api/src/services/aiAgents/playbookActExecutor.ts` (new) | Deterministic built-in playbook executor (server-owned steps + verifyCondition + waits). |
| `apps/api/src/services/aiAgents/remediationActResolver.ts` (new) | Exact-match suggestion → run_script op resolution (agent-safe; no MFA route reuse). |
| `apps/api/src/services/aiGuardrails.ts` (modify) | `disposition: 'act'` branch + `GuardrailDisposition` widening. |
| `apps/api/src/services/aiAgents/runLoop.ts` (modify) | Pre-hook act path (revalidate+reserve+pin), post-hook verify/verdict, run verdict + notification content. |
| `packages/shared` types/validators (modify) | `SUPPORTED_AGENT_MODES` + `'act'`; `actAssets` validator; verdict types. |
| `apps/api/src/services/aiAgents/agentService.ts` + `routes/aiAgents.ts` (modify) | Act activation prerequisites (recipients + act-eligible assets) → 422 otherwise. |
| `apps/web/src/components/settings/AiAgentForm.tsx` (modify) | Enable the act option + acknowledgement + warning copy + i18n. |

---

### Task 1: Verdict types + manifest core

**Files:** create `apps/api/src/services/aiAgents/actManifest.ts` + test; modify `packages/shared/src/types/aiAgents.ts` (verdict types only)

**Interfaces (produced):**
- Shared: `type ActExecutionVerdict = 'succeeded'|'failed'|'timeout'|'unknown'`, `type ActVerificationVerdict = 'passed'|'failed'|'inconclusive'|'skipped'`, `type AgentRunVerdict = 'remediated'|'needs_attention'|'partial'|'no_action'`.
- `interface ActOperation { key: string; toolName: string; matches(input: Record<string, unknown>): boolean; normalizeTarget(input, runDeviceId: string): { ok: true; target: ActTarget } | { ok: false; reason: string }; verifySpec: ActVerifySpec }` where `ActTarget` carries the op-specific identity (serviceName / paths+planId / pid+processIdentity / scriptId+digest / playbookId+digest / suggestionId).
- `ACT_MANIFEST: readonly ActOperation[]` — entries EXACTLY: `manage_services.restart` (matches `action === 'restart'` only), `disk_cleanup.execute`, `manage_processes.kill`, `run_script` (saved script), `execute_playbook` (built-in ids only — resolve from `builtInPlaybooks`), `remediation_suggestion` (virtual op — matched by the Task 7 resolver, not by a raw tool call).
- `resolveActOperation(toolName: string, input: Record<string, unknown>): ActOperation | null` — pure, no I/O; `manage_services` with `start|stop|list` returns null; `execute_command` has NO entry (add a test asserting the manifest contains no entry for it and never will without quorum — a literal frozen key list assertion).

- [ ] TDD: matcher matrix tests (every op × matching/non-matching inputs; the frozen-key-list assertion; normalizeTarget rejects device args ≠ runDeviceId — `run_script.deviceIds` must equal `[runDeviceId]`). Commit: `feat(api,shared): act operation manifest core + verdict types (#3826)`

---

### Task 2: Guardrail `'act'` disposition

**Files:** modify `apps/api/src/services/aiGuardrails.ts` (`GuardrailDisposition` :1193; the branch at :1607-1621); extend its tests

**Contract:** widen `GuardrailDisposition` with `'act'`. Insert BEFORE the shadow branch (both are mode-specific leaves after every structural deny):

```ts
  if (policy.mode === 'act' && !readOnly) {
    const op = resolveActOperation(toolName, input);
    if (op) {
      return { ...base, allowed: true, requiresApproval: false, disposition: 'act',
        reason: `Rule-equivalent operation "${op.key}" — act mode executes with verification` };
    }
    // Unmatched mutation under act: identical semantics to shadow — propose.
    return { ...base, allowed: false, requiresApproval: false, disposition: 'propose',
      reason: `Tool "${toolName}" is not act-eligible; recorded as a proposal` };
  }
```

Tests (matrix, all against the REAL manifest): act+restart → act; act+stop → propose; act+execute_command → propose; act+tier-4 → deny (upstream, unchanged — assert order by giving a T4 tool an act-looking input); act+secret-bearing → deny; act+readonly → allow; shadow behavior byte-identical (re-run the whole existing suite); off → deny. `readOnly` Tier-2 semantics unchanged.

- [ ] TDD → green → commit: `feat(api): act guardrail disposition — manifest-matched mutations only (#3826)`

---

### Task 3: Revalidation + reserve (pre-hook act path)

**Files:** create `apps/api/src/services/aiAgents/actRevalidation.ts` + test; modify `runLoop.ts` pre-hook (`createAgentRunPreToolUse`, disposition handling ~:374-468)

**Interfaces:**
- `revalidateActExecution(args: { run: {...}; op: ActOperation; toolName; input; reserved: ActReservationState }): Promise<{ ok: true; pin: ActAssetPin } | { ok: false; downgrade: 'propose' } | { ok: false; deny: string }>` performing, in order: (1) `resolveEffectiveAgentSystem(orgId, kind)` — same-agent + enabled + `mode === 'act'` still true (mode drifted to shadow → `downgrade`; disabled/off/different agent/resolve failure → `deny`); (2) full `checkAgentGuardrails` re-run against the LIVE policy slice — anything but `'act'` → map (propose→downgrade, deny→deny); (3) `op.normalizeTarget(input, run.deviceId)` — mismatch → deny; (4) asset pin: run_script → `verifiedRunScriptFor`-equivalent snapshot+digest built NOW and stashed for the execution context (grep how `toolExecutionContext` threads `VerifiedRunScript` and reuse that seam); disk_cleanup → latest preview plan row exists, is for this device, and `paths ⊆ plan candidates` + byte bound (plan's estimatedBytes ≤ a manifest constant, 5 GiB v1); kill → input carries the process identity fields the manifest requires (name + pid — bare pid alone → deny); playbook → built-in digest match; (5) reserve: `reserved.count < snapshot.effective.limits.maxActionsPerRun` → increment, else exhausted → `downgrade` if live policy still admits proposals, else deny.
- Pre-hook integration: `disposition === 'act'` → `await revalidateActExecution(...)`; `deny` → existing deny shape; `downgrade` → flow into the existing propose branch (intent/proposal recording); `ok` → stash the pin in the run context, ledger `startToolExecution`, return `{ allowed: true }`.

- [ ] TDD: each revalidation step's failure path (live-mode drift → proposal; disabled → deny; sibling-device arg → deny; unpinned script → deny; cap exhaustion → proposal-if-admitted; reservation counts failed dispatches). Commit: `feat(api): act revalidation + action reservation in the run-loop pre-hook (#3826)`

---

### Task 4: Verification + verdicts + attention alert (post-hook act path)

**Files:** create `actVerify.ts` + test; modify `runLoop.ts` post-hook + `finishRun` + `deliverRunFinishedNotifications` content; extend `AgentRunOutcome`

**Contract:**
- Post-hook for an act-executed call: map tool result → `execution` verdict (tool isError → failed; the underlying command timeout → timeout — grep how manage_services surfaces `waitForCommandResult` timeouts; unknowable → unknown); then run `op.verifySpec`: service restart → `executeCommand(deviceId,'list_services')` + parse target service status `running` → passed/failed, read failure/timeout → inconclusive; disk_cleanup → compare the plan row's post-execute state (`bytesReclaimed`, status) + optionally a fresh snapshot read → passed/failed/inconclusive; kill → `list_processes` absence of the pinned identity → passed/failed/inconclusive; script → exit code 0 → passed, non-zero → failed, timeout → inconclusive (a script has no declared postcondition — document). Bounded: each verification read ≤ 30s.
- `outcome.executedActions[]` entries gain `{ execution, verification, verifyDetail? }`; `AgentRunOutcome` gains `runVerdict` computed at finish: all acted ops passed → `remediated`; ≥1 failed/inconclusive → `needs_attention`; mix with proposals → `partial`; no act executions → `no_action`.
- Verification `failed` (not inconclusive) → insert a rule-less alert (dnsThreatAlerts direct-insert pattern; `ruleId: null`, `context: { source: 'ai_agent_act_verify', runId, agentId, opKey, target }`, severity high) — best-effort, logged on failure.
- Notification metadata gains `verdict: runVerdict` + per-op summaries (sanitized: op key + target NAME only — never tool inputs/outputs/paths lists); notification title becomes verdict-aware (`Agent remediated …` / `Agent needs attention: …`) with priority `high` when needs_attention.

- [ ] TDD per verify family + verdict computation + alert insert + notification shape. Commit: `feat(api): act verification verdicts, attention alerts, verdict-aware notifications (#3826)`

---

### Task 5: Deterministic built-in playbook executor

**Files:** create `playbookActExecutor.ts` + test; modify the act path so `execute_playbook` (built-in, matched) routes HERE instead of the stub tool

**Contract:** `executeBuiltInPlaybookForRun(args: { runContext; playbookId; variables; reserved })`: digest-pin the built-in definition (hash the steps JSON at match time, re-hash at execute — mismatch → abort `failed`); create the `playbook_executions` row (`status: 'running'`, `triggeredBy: 'ai'`, probe-degraded user id per Part A); iterate steps sequentially: `diagnose` → read-only tool call via the same underlying services (no reservation); `act` → EACH mutating step goes through `revalidateActExecution` + reservation individually (a step whose tool/action is NOT manifest-admitted aborts the playbook with `failed` — built-ins currently only use manage_services/disk_cleanup which are admitted); `wait` → capped sleep; `verify` → evaluate `verifyCondition` against the appropriate read-back (`service_status`, `disk_usage_percent` — implement exactly the metrics the built-ins use; unknown metric → inconclusive + `onFailure` respected); `onFailure: stop|continue` honored (`rollback` → treat as stop + note, no rollback in wave 4). Terminal: update the row (`completed|failed`) + per-step results in its jsonb; surface an aggregate execution/verification verdict to the post-hook path. The pre-hook 'act' branch for execute_playbook returns `allowed: false` with a success-shaped message containing the executor's outcome (the SDK tool stub must NOT also run — the executor replaces it; this is the one op where the manifest owns execution, because the stub doesn't execute anything).
- Custom (non-built-in) playbooks under act → propose (manifest match already excludes them — test it).

- [ ] TDD: step sequencing, verifyCondition matrix, per-step reservation, digest mismatch abort, onFailure branches, wall-clock bound. Commit: `feat(api): deterministic built-in playbook executor for act mode (#3826)`

---

### Task 6: `actAssets` (per-script act authorization) + activation prerequisites + mode flip

**Files:** shared validators/types (`actAssets`), possibly ONE migration (see Global Constraints — follow the decision tree there and update `CORE_TENANT_EXPORT_POLICY` if a column is added), `agentService.ts` (activation checks), `routes/aiAgents.ts`, `effectivePolicy.ts` (merge: org may only NARROW the partner's `actAssets.scriptIds` — intersection semantics, mirror how toolAllowlist merges)

**Contract:**
- `actAssets: { scriptIds: string[] }` (validator: uuid array, max 50). `run_script`'s manifest `matches`/revalidate require `scriptId ∈ effective actAssets.scriptIds`. Empty/absent → run_script never act-eligible (proposals still work).
- Activation prerequisites (create/update where `mode: 'act'`): ≥1 resolvable recipient (reuse `resolveRecipientUserIds` against the owning org — partner-wide rows: validate against the partner's orgs? Follow how recipients are validated today and match), AND ≥1 act-eligible surface (allowlist ∩ manifest tools ≠ ∅, counting run_script only when actAssets non-empty) — else 422 `act_prerequisites_not_met` with a structured body naming what's missing.
- `SUPPORTED_AGENT_MODES` gains `'act'` (shared :130). The 422 `mode_not_supported` path dies naturally; keep its error branch for future modes.

- [x] TDD: validator, merge intersection, prerequisite 422 matrix, per-script gate in revalidation. Commit: `feat(api,shared): act activation prerequisites + per-script act authorization (#3826)`

---

### Task 7: Remediation-suggestion exact-match resolver

**Files:** create `remediationActResolver.ts` + test

**Contract:** `resolveActableSuggestion(args: { runContext; suggestionId })` — loads the suggestion; requires: same org, `deviceId === run.deviceId`, `targetType === 'script'`, `scriptId` present, status `suggested` (agent-actable BEFORE human accept — that is the point of act mode) — then re-validates via `validateRemediationExecutionApproval` (grep its contract) and resolves to the manifest `run_script` op with the suggestion's scriptId+parameters, which then flows the NORMAL act pipeline (incl. `actAssets.scriptIds` membership — a suggestion for a non-authorized script is NOT act-eligible → propose). On act execution, stamp the suggestion row (`status: 'executed'`, `scriptExecutionId`, `executedBy: null` + agent attribution in details — Part A precedent). Exposed to the model as act-eligibility of the EXISTING remediation-suggestion tool surface (grep which aiTool exposes suggestions to agents; if none exists, this resolver is wired only into the triage prompt path — check how wave 3 surfaces `remediationSuggestions` to the agent and integrate where it naturally fits; if there is genuinely no agent-facing surface, implement the resolver + tests and leave the tool wiring as a documented follow-up rather than inventing a new tool).

- [x] TDD: match matrix (wrong device/org/status/targetType), actAssets gate, stamp semantics. Commit: `feat(api): agent-safe remediation-suggestion act resolver (#3826)`

---

### Task 8: Web UI + i18n

**Files:** `apps/web/src/components/settings/AiAgentForm.tsx` (:464-482 mode select; `:57` error mapping), locale files (find every locale carrying `aiAgentsPage.modes.*` and add the new keys in ALL of them — tr-TR parity)

**Contract:** act option enabled when `supportedModes` includes it; selecting act reveals: (a) a warning banner (unattended execution, verification can fail, no rollback, single-device, action cap) — copy keys `aiAgentsPage.actWarning.*`; (b) a required acknowledgement checkbox (`data-testid="ai-agent-act-ack"`) gating the save button when mode changed TO act (client-side only — the server's 422 prerequisites are authoritative); (c) surfacing of the 422 `act_prerequisites_not_met` structured body. Handlers via `runAction` per repo standard (they already are — verify).

- [x] TDD (component tests per repo pattern) + locale keys in every locale file. Commit: `feat(web): act mode UI — warning, acknowledgement, prerequisites surfacing (#3826)`

---

### Task 9: Verification + PR

- [x] Full api suite + shared suite + typecheck + web tests (`pnpm --filter @breeze/web test` — scope to touched components if the full suite is impractical, but run the i18n parity test explicitly); contract suites (closure/registry/dispatch-boundary/envComposeParity) green; if a migration was added: migration-naming check, export-policy suite note for CI (integration-only).
- [x] Grep sweeps: no act path reaches `execute_command`; no manifest key added beyond the locked list; every `disposition === 'act'` consumer handles downgrade/deny.
- [ ] Tick checkboxes. **Open the PR**: `feature/3821-ai-agents/wave-3826-act` → main, `Closes #3826`, body: the locked manifest table, the execution-integration deviation (normal tool path + pre/post hooks vs literal manifest-executes), verify semantics, activation prerequisites, migration yes/no, and rollout guidance (act requires BREEZE_AI_AGENTS_ENABLED + per-agent opt-in + partner baseline permitting). **Stop after opening the PR.**

## Self-Review Notes

- Safety inheritance: every structural deny (T4/secrets/site/protected/allowlist/device-less) sits upstream of the new branch and is untouched; the act branch is unreachable unless live mode is act; revalidate re-runs the guardrail against LIVE policy before anything executes; the manifest is a frozen literal with a test asserting its exact key set.
- The one op where the manifest owns execution is execute_playbook (the stub executes nothing — the deterministic executor replaces it); everything else executes on the normal, already-tested tool path with gates before and verification after.
- Type consistency: verdict types (T1) consumed T4/T5; `ActOperation`/pin types (T1/T3) consumed T3-T7; `actAssets` (T6) consumed by T3's run_script pin + T7.
- Deferred (file as issues at PR time): multi-device act runs (wave 5 blast caps), custom-playbook act, rollback, per-invocation SDK correlation ids, tool-output redacted storage.

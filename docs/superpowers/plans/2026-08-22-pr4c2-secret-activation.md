# Tenant Variables #3409 — PR4c-2 Implementation Plan (secret activation: `source: 'tenantSecret'`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a script declare a parameter whose value is a **secret** tenant variable and have that value reach the agent **only** as an environment variable (`BREEZE_VAR_<UPPER_NAME>`), sealed in the PR4a envelope, gated on agent capability at enqueue **and** claim, blocked for user-context runs, and redacted from results. This is the last PR of #3409; after it, secrets are usable end-to-end.

**Branch:** `ToddHebebrand/tenant-variables-pr4c2`, based on `origin/main` at `56674b437` (contains PR0–PR4c-1). Worktree: `/Users/toddhebebrand/.herdr/worktrees/breeze/custom-script-variables`.

**Prior art (read, do not re-derive):** `2026-08-14-pr4-secret-delivery-handoff.md` (§3 design, §4 seams), `2026-08-15-pr4c1-digest-pinning-snapshot.md` (snapshot/digest), `2026-08-14-pr4a-secret-envelope-server.md`, `2026-08-14-pr4b-agent-secret-env.md`.

---

## Settled design (advisor quorum 2026-08-15, user-approved — do not relitigate)

1. **Secret delivery is DECLARED, never inferred.** A new parameter-definition arm
   `{ name, source: 'tenantSecret', variableKey }` is the only way a secret reaches a script.
   - `source: 'tenantVariable'` keeps **rejecting** a secret target (policy denial, unchanged).
   - `{{var.<secret>}}` content tokens stay **permanently** rejected (save 400 + dispatch failure, unchanged).
   - A `tenantSecret` binding whose target is **not** a secret, or is missing/unreadable, **fails the device closed**. No default value, no caller override, no fallback to a plaintext variable.
2. The secret never enters the ordinary `parameters` map (the agent substitutes every entry of that map into the script text and mirrors it as `BREEZE_PARAM_*`). It rides `payload.secretEnv[name]` → sealed to `payload.secretEnvEnvelope` by `encryptSensitivePayloadFields('script', …)` → opened at delivery → agent exports `BREEZE_VAR_<UPPER(name)>`.
3. **Fail loudly on an old agent** — enqueue gate AND claim-time gate on `devices.script_secret_env_version >= 1` (non-sticky capability, see `routes/agents/heartbeat.ts:519-521`). Never run a script with its credential env var unset.
4. **User-context runs cannot use secrets** (helper IPC carries no env). Server mirrors the agent's `runAsSupportsSecrets` (`agent/internal/heartbeat/handlers_script.go:246-257`): `system` and `elevated` allowed; `user` or any `targetSessionId` refused.
5. **Never put a resolved secret value** in: `script_executions.parameters`, `device_commands.result`, any error string, any log line, the digest material, or the AI tool's returned text. Error strings name parameter names and variable **keys** only.

---

## Current-state facts (verified 2026-08-22 against `56674b437`)

| What | Where |
|---|---|
| Parameter-definition union (4 arms, `unionFallback`) | `packages/shared/src/validators/scriptParameterDefinitions.ts:32-146` |
| Env-name collision refinement (`scriptParameterEnvSuffix`) | same file `:150-196` |
| `TENANT_VARIABLE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/`, `MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH = 4` | `packages/shared/src/validators/tenantVariables.ts:14-30` |
| Resolver: `lookupBoundSource` secret denial, `resolveSourcedParameters`, `describeParameterFailure` | `apps/api/src/services/sourcedParameters.ts:323, :357-442, :452-478` |
| `hasTenantVariableBoundParameters` (scans raw `source`), `scriptNeedsVariableScope` | `sourcedParameters.ts:222-250` |
| Dispatch: param resolution → execution insert → payload build/seal (`reservedCommandId`, "Inert until PR4c" comment) → `queueCommand` → immediate send | `apps/api/src/services/scriptDispatch.ts:198-241, :243-270, :307-345, :352-397` |
| `DispatchScriptResult` failure-code union | `scriptDispatch.ts:100-119` |
| `encryptSensitivePayloadFields('script')` turns `secretEnv` → `secretEnvEnvelope`, throws without ctx | `apps/api/src/services/sensitiveCommandPayload.ts:93-125` |
| `sealSecretEnv` throws when `getActiveSecretEncryptionKeyId()` is unset; `validateSecretEnv` rules (keys match tenant-key grammar, values 4..4096, ≤32 entries) | `apps/api/src/services/scriptSecretEnvelope.ts:68-145` |
| Claim batch chokepoint used by heartbeat main, watchdog and REST poll | `apps/api/src/services/commandDelivery.ts:43` `decryptClaimedCommandsForDelivery`; callers `routes/agents/heartbeat.ts:493, :1162`, `routes/agents/commands.ts:197` |
| Capability column + heartbeat write (non-sticky) | `apps/api/src/db/schema/devices.ts:157-164`; `routes/agents/heartbeat.ts:521` |
| Redaction already wired at both ingests ("Inert until PR4c" comments) | `routes/agentWs.ts:1693`, `routes/agents/commands.ts:310` via `services/commandSecretRedaction.ts` |
| Server-side terminal failure precedent (status/result/erasure + `propagateTimedOutDeviceCommand`) | `apps/api/src/jobs/staleCommandReaper.ts:246-283` |
| Digest: `referencedVariableKeys` only sees `tenantVariable` | `apps/api/src/services/actionIntents/runScriptSnapshot.ts:177-186` |
| Save-time secret check (content only) + bundle import | `apps/api/src/services/scriptBundle/index.ts:86-118`, `routes/scripts.ts:613-618, :802-808`, `scriptBundle/index.ts:500-507` |
| Software-deploy silent secret omission | `apps/api/src/services/softwareDeployment.ts:541-565` |
| Web: source `<select>`, `TenantVariableBindingField`, `TenantVariableMenu` (`disabled={v.isSecret}`) | `apps/web/src/components/scripts/ScriptForm.tsx:59-117, :812-841`, `TenantVariableMenu.tsx:110-131` |
| Web: `parameterBindingKey` switch, `runtimeParameters` | `apps/web/src/components/scripts/ScriptFormSchema.ts:109-148` |
| Web: run-modal bound rows use dynamic `suppliedBy.<source>` | `apps/web/src/components/scripts/ScriptParametersForm.tsx:136-158` |
| i18n: 8 locales × `scripts.json` (`scriptForm.parameterSources`, `scriptForm.parameterBinding`, `scriptForm.variables.secretUnavailable`, `scriptParametersForm.suppliedBy`) | `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/scripts.json`; coverage test `apps/web/src/lib/i18n/translationCoverage.test.ts` |

**Gap found while scoping:** the API never rejects a `tenantVariable` parameter bound to a secret at **save** time (only `content` is checked), although the web warning says "the save will be rejected". Task 6 closes it alongside the symmetric `tenantSecret`→non-secret check.

**Traps carried from earlier PRs:** no `sql.raw` in shared code (breaks drizzle mocks); run the FULL API suite, not slices; mutation-verify every new guard; `ipAllowlistMode.config.test.ts` fails in this worktree for lack of `.env` — known-environmental, do not inject env vars.

---

## File structure

**Create**
| File | Responsibility |
|---|---|
| `apps/api/src/services/scriptSecretDelivery.ts` | The activation gates: `runAsSupportsSecretEnv`, `loadScriptSecretEnvVersion`, `secretDeliveryPreflight` (enqueue), `failClaimedSecretCommandsForUnsupportedAgent` (claim). Messages module-local. |
| `apps/api/src/services/scriptSecretDelivery.test.ts` | Unit tests (drizzle mocks). |
| `apps/api/src/__tests__/integration/scriptSecretDelivery.integration.test.ts` | Real-Postgres proof: dispatch seals an envelope, the stored payload has no plaintext, `openSecretEnv` with the row's AAD recovers the value, and the claim gate fails the command on a downgraded agent. |

**Modify**
| File | Change |
|---|---|
| `packages/shared/src/validators/scriptParameterDefinitions.ts` (+ test) | Fifth arm `tenantSecret`; env-name helper for secrets. |
| `packages/shared/src/types/scripts.ts` (or wherever `ScriptParameter` lives — grep `variableKey`) | Widen the TS type if it is not inferred. |
| `apps/api/src/services/sourcedParameters.ts` (+ test) | `secretEnv` output; `tenantSecret` lookup; `notSecret` denial; predicate covers both variable-backed sources. |
| `apps/api/src/services/scriptDispatch.ts` (+ test) | Gates + `secretEnv` in payload; new failure codes; drop "inert" comment. |
| `apps/api/src/services/commandDelivery.ts` (+ test) | Claim-time gate before decrypt. |
| `apps/api/src/services/actionIntents/runScriptSnapshot.ts` (+ test) | `referencedVariableKeys` includes `tenantSecret`. |
| `apps/api/src/services/scriptBundle/index.ts` (+ test), `apps/api/src/routes/scripts.ts` (+ test) | Save-time parameter/secret mismatch 400s at create, update, import. |
| `apps/api/src/services/softwareDeployment.ts` (+ test) | Explicit per-device failure for a secret referenced in a template. |
| `apps/api/src/routes/agentWs.ts`, `apps/api/src/routes/agents/commands.ts` | Comment-only: redaction is live now. |
| `apps/web/src/components/scripts/{ScriptForm.tsx,ScriptFormSchema.ts,TenantVariableMenu.tsx,ScriptParametersForm.tsx,ScriptExecutionModal.tsx}` (+ tests) | Authoring arm, picker filtering, run-modal chip, runAs warning. |
| `apps/web/src/locales/*/scripts.json` (8) | New keys; refresh the stale `secretUnavailable` copy. |
| `apps/docs/…` tenant variables page (grep `BREEZE_VAR_` / "tenant variables") | Document the secret parameter, env name, agent floor, runAs restriction, redaction limits. |

---

### Task 1: Shared schema — the `tenantSecret` arm

**Files:** `packages/shared/src/validators/scriptParameterDefinitions.ts`, `…/scriptParameterDefinitions.test.ts`

- [ ] **Tests first** (RED):
  - `{name:'api_token', source:'tenantSecret', variableKey:'vendor_token'}` parses; `type` defaults to `'string'`; `required` is `true` after parse regardless of input.
  - `name` outside `TENANT_VARIABLE_KEY_PATTERN` is rejected **at `[i,'name']`** (e.g. `Api-Token`, `API_TOKEN`) — the secretEnv key grammar is the tenant-key grammar, so the wire name must already match it.
  - `defaultValue` present → rejected with a message saying a secret parameter cannot carry a default (a default would be a plaintext credential in the script definition).
  - `options` / `type:'select'` rejected.
  - `scriptSecretEnvName('api_token') === 'BREEZE_VAR_API_TOKEN'` (mirrors agent: `"BREEZE_VAR_" + strings.ToUpper(key)`, `agent/internal/executor/executor.go` PR4b env loop).
  - Collision refinement: a `tenantSecret` named `token` and a runtime parameter named `token` still fail as a duplicate name (the existing suffix rule already does this — add the assertion so nobody "fixes" it).
  - `canonicalizeScriptParameterDefinitions` output for a `tenantSecret` definition is stable and includes `source` and `variableKey`.
- [ ] **Implement:** add `'tenantSecret'` to `SCRIPT_PARAMETER_SOURCES` **last** (the order is the web `<select>` order). New arm:
  ```ts
  const tenantSecretParameterDefinitionSchema = z.object({
    name: z.string().regex(TENANT_VARIABLE_KEY_PATTERN, '…lowercase letters, digits and underscores…'),
    source: z.literal('tenantSecret'),
    variableKey: tenantVariableKeySchema,
    type: z.literal('string').default('string'),
    required: z.literal(true).default(true),
    defaultValue: z.undefined({ message: 'A secret parameter cannot carry a default value' }),
    options: z.undefined({ message: 'A secret parameter cannot declare options' }),
  });
  ```
  Export `scriptSecretEnvName(name)`. Update the arm docblock at `:25-31`.
- [ ] GREEN; `pnpm --filter @breeze/shared test`; `pnpm --filter @breeze/shared build` if the API consumes `dist`.
- [ ] Commit: `feat(shared): tenantSecret script-parameter arm (#3409 PR4c-2)`

### Task 2: Resolver — produce `secretEnv`, fail closed on a non-secret target

**Files:** `apps/api/src/services/sourcedParameters.ts`, `…/sourcedParameters.test.ts`

- [ ] **Tests first**:
  - `tenantSecret` bound to a secret variable → `ok`, `parameters` has **no** key for it, `secretEnv = {api_token: '<value>'}`, binding descriptor `{key, source:'tenantSecret', variableId, ownerScope, version}`.
  - Target exists but `isSecret:false` → `ok:false`, `code:'unresolved_parameters'`, message names param + variable key, contains the phrase `is not a secret`, and **does not contain the value**.
  - Target missing → `ok:false` (never falls to a default; there is none).
  - No `variables` map supplied → throws (programming error, same as `tenantVariable`).
  - Caller supplied a value for the secret param → it is dropped and reported in `ignoredParameters`; `secretEnv` still comes from the variable.
  - `tenantVariable` → secret target still denied (existing tests at `:268-345` stay green; keep them).
  - `hasTenantVariableBoundParameters([{source:'tenantSecret'}])` is `true`; `scriptNeedsVariableScope` likewise.
  - Existing assertion "names keys, never the value" extended to the new denial.
- [ ] **Implement:** `SourceLookup` gains `{kind:'secret'; …}` → split into `secretAsPlain` (existing denial) and a new `{kind:'secretValue', value, descriptor}` for the `tenantSecret` arm plus `{kind:'notSecret', variableKey}`. `ResolveSourcedParametersResult` ok-branch gains `secretEnv: Record<string,string>`. Update `describeParameterFailure` with the new bucket. Rename nothing public; widen the docblocks.
- [ ] GREEN, mutation-verify (make `isSecret` check return true for both → new test fails, nothing else). Commit: `feat(api): resolve tenantSecret parameters into secretEnv (#3409 PR4c-2)`

### Task 3: Delivery gates module

**Files:** create `apps/api/src/services/scriptSecretDelivery.ts` + `.test.ts`

- [ ] **Tests first**:
  - `runAsSupportsSecretEnv('system', undefined) === true`, `'elevated'` true, `'user'` false, `('system', 3)` false.
  - `secretDeliveryPreflight({deviceId, runAs, targetSessionId})` returns `{ok:false, code:'secrets_unsupported_run_as'}` for user; `{ok:false, code:'secret_delivery_unavailable'}` when `getActiveSecretEncryptionKeyId()` is null (mock `secretCrypto`); `{ok:false, code:'agent_upgrade_required'}` when the selected `scriptSecretEnvVersion` is 0 or the device row is gone; `{ok:true}` at 1. Order: runAs → server key → capability (cheapest/most-deterministic first, no query for the first two).
  - `failClaimedSecretCommandsForUnsupportedAgent(claimed)`: with no envelope-bearing command → returns input unchanged **and issues no query**; with an envelope-bearing `script` command and capability 0 → updates that row to `status:'failed'`, `result:{status:'failed', error:<agent upgrade message>, exitCode:1}`, spreads `terminalPayloadErasureSet()`, guarded `status='sent'`; calls the execution propagation helper; returns the siblings only. Capability 1 → untouched. Walk the bound params of the `.where` (see memory `vacuous_drizzle_where_clause_assertions`).
- [ ] **Implement.** Error messages (module constants, reuse in tests):
  - `SECRETS_RUN_AS_MESSAGE = 'This script uses secret variables, which require system-context execution; it is configured to run as a user and was not executed'`
  - `SECRET_DELIVERY_UNAVAILABLE_MESSAGE = 'Secret delivery is not configured on this server (no active secret-encryption key); script not executed'`
  - `AGENT_UPGRADE_REQUIRED_MESSAGE = 'Agent upgrade required: this script uses secret variables and the device agent does not support secure secret delivery; script not executed'`
  For propagation to `script_executions`, reuse `propagateTimedOutDeviceCommand` if its contract is "mark the linked execution failed with this error" (read `services/commandResultHandlers.ts` / wherever it lives); if its wording is timeout-specific, extract a neutral `propagateServerSideCommandFailure` and have the reaper call it — do not duplicate the body.
- [ ] Commit: `feat(api): secret-delivery preflight and claim-time agent gate (#3409 PR4c-2)`

### Task 4: Dispatch activation

**Files:** `apps/api/src/services/scriptDispatch.ts`, `…/scriptDispatch.test.ts`

- [ ] **Tests first** (existing `:660` "fails the device when a bound parameter targets a SECRET tenant variable" stays — it is the `tenantVariable` arm):
  - A `tenantSecret` binding on a capable device (`scriptSecretEnvVersion:1`, key id configured): the object passed to `encryptSensitivePayloadFields` contains `secretEnv:{api_token:'…'}` and `parameters` lacks `api_token`; the payload handed to `queueCommand` has `secretEnvEnvelope` (string) and **no** `secretEnv`; `script_executions.parameters` contains `$bindings` with `source:'tenantSecret'` and **no value** (assert the serialized insert does not contain the secret string anywhere).
  - `runAs:'user'` → `{ok:false, code:'secrets_unsupported_run_as'}`, **no** `script_executions` insert, no `queueCommand`.
  - capability 0 → `{ok:false, code:'agent_upgrade_required'}`, same no-orphan assertion.
  - key id unset → `{ok:false, code:'secret_delivery_unavailable'}`.
  - A script with no `tenantSecret` parameter **never** queries `script_secret_env_version` (hot-path regression guard — the preload trap from PR2).
  - `deliveryOutcome` unchanged semantics; immediate-send path still decrypts and sends the frame with `secretEnv` present and `secretEnvEnvelope` absent (`toAgentCommandFrame`).
- [ ] **Implement:** after `resolveSourcedParameters`, `const secretEnv = resolution.secretEnv`; if `Object.keys(secretEnv).length > 0` → `await secretDeliveryPreflight(...)` BEFORE the execution insert; add `...(hasSecrets ? { secretEnv } : {})` to the payload object; extend the `code` union with the three new codes and docblock them; replace the "Inert until PR4c" comment.
- [ ] Commit: `feat(api): dispatch tenantSecret parameters through the sealed envelope (#3409 PR4c-2)`

### Task 5: Claim-time gate wiring

**Files:** `apps/api/src/services/commandDelivery.ts`, `…/commandDelivery.test.ts`

- [ ] Test: `decryptClaimedCommandsForDelivery` calls `failClaimedSecretCommandsForUnsupportedAgent` first and only decrypts what it returns; a failed command is **not** released back to pending (it is terminal).
- [ ] Implement (one line + import). Confirm by reading `routes/agents/heartbeat.ts` that the device update carrying `scriptSecretEnvVersion` (`:521`) executes **before** `claimPendingCommandsForDevice` (`:889`) in the same request, so the gate's fresh select observes this beat's capability — cite the line numbers in the commit body.
- [ ] Note in the PR body (no code): `commandQueue.ts:685/:954` direct pushes are not gated because no producer enqueues a `script` command with an envelope through them — `scriptDispatch` is the only producer and gates at enqueue.
- [ ] Commit: `feat(api): re-check secret-delivery capability at claim time (#3409 PR4c-2)`

### Task 6: Save-time checks (create / update / bundle import)

**Files:** `apps/api/src/services/scriptBundle/index.ts` (+test), `apps/api/src/routes/scripts.ts` (+test)

- [ ] Tests: create/update with `parameters:[{source:'tenantVariable', variableKey:'s'}]` where `s` is secret → 400 `Parameter "p" binds secret variable "s" with source "From a variable"; use a secret parameter instead`; `tenantSecret` bound to a **non-secret** key → 400 `Parameter "p" is a secret parameter but variable "k" is not a secret`; unknown key → allowed (partner-wide scripts resolve per org later); bundle import pushes the per-entry error like the content check.
- [ ] Implement: refactor the lookup in `findSecretVariableReferences` into a private `lookupIsSecretByKey(scope, keys): Promise<Map<string, boolean>>`; add `findParameterSecretMismatches(scope, definitions)`; call at the three ingresses right after the content check.
- [ ] Commit: `fix(api): reject secret/plain parameter-binding mismatches at save time (#3409 PR4c-2)`

### Task 7: Digest + software deploy + comments

- [ ] `runScriptSnapshot.ts:181` → `parsed.data.source === 'tenantVariable' || parsed.data.source === 'tenantSecret'`; test in `runScriptSnapshot.test.ts` that a `tenantSecret` reference is pinned (state/variableId/version/isSecret) and that material contains no value. Run `effectDigestCoverage.contract.test.ts`.
- [ ] `softwareDeployment.ts:541-565`: compute the secret keys referenced by the templates; if any, fail those devices with `Software deployment templates cannot use secret variable(s) {{var.k}}` through the existing per-device failure channel (read how the `unresolved` branch records a `deploymentResults` row and mirror it). Test in `softwareDeployment.test.ts` next to `:517`.
- [ ] Replace the two "Inert until PR4c" comments at `agentWs.ts:1693` and `agents/commands.ts:310` and the one in `scriptDispatch.ts` with "live since PR4c-2".
- [ ] Commit: `feat(api): pin tenantSecret references; explicit deploy-template secret failure (#3409 PR4c-2)`

### Task 8: Web authoring + run surfaces

**Files:** `ScriptFormSchema.ts`, `ScriptForm.tsx`, `TenantVariableMenu.tsx`, `ScriptParametersForm.tsx`, `ScriptExecutionModal.tsx` (+ their tests), 8 × `locales/*/scripts.json`

- [ ] `ScriptFormSchema.ts`: `parameterBindingKey` handles `tenantSecret`; form-side validation mirrors Task 1 (lowercase name, no default) so the first feedback is inline, not an API 400. `runtimeParameters` already excludes it (non-runtime).
- [ ] `TenantVariableMenu`: replace `disabled={v.isSecret}` with a `selectable?: (v) => boolean` prop (default: `!v.isSecret`, preserving every existing caller); secondary line text comes from a `disabledReason?: (v) => string | undefined` prop with the old default.
- [ ] `ScriptForm.tsx`: `TenantVariableBindingField` gains `mode: 'plain' | 'secret'`. Secret mode: menu `selectable = v => v.isSecret`, non-secret rows show `scriptForm.parameterBinding.notSecretRow`; typed non-secret key shows warning `scriptForm.parameterBinding.notSecret`; under the field render the hint `scriptForm.parameterBinding.secretHint` with the interpolated env name from `scriptSecretEnvName(row.name)` (falls back to `BREEZE_VAR_…` while the name is blank). `handleParameterSourceChange` clears `variableKey` on both variable-backed arms. Tests next to `ScriptForm.test.tsx:457-514`.
- [ ] `ScriptParametersForm.tsx`: nothing structural; add `scriptParametersForm.suppliedBy.tenantSecret`. Test renders the chip for a `tenantSecret` param and never renders an input for it.
- [ ] `ScriptExecutionModal.tsx`: when the script has a `tenantSecret` parameter and `runAs === 'user'` is selected, show `scriptExecutionModal.secretsRequireSystem` inline (warning, not a block — the server fails the device with the same message). Test.
- [ ] i18n keys (en copy; translate the other 7 in their own voice, no machine-literal artifacts):
  - `scriptForm.parameterSources.tenantSecret`: "From a secret variable (environment variable)"
  - `scriptForm.parameterBinding.notSecret`: "\"{{key}}\" is not a secret. Choose a secret variable, or switch the source to \"From a variable\"."
  - `scriptForm.parameterBinding.notSecretRow`: "Not a secret — use \"From a variable\""
  - `scriptForm.parameterBinding.secretHint`: "Delivered only as the environment variable {{env}} — never written into the script. Requires system-context execution and an agent that supports secure secret delivery."
  - `scriptForm.variables.secretUnavailable` → "Secret — bind it through a parameter with source \"From a secret variable\"."
  - `scriptParametersForm.suppliedBy.tenantSecret`: "Supplied securely from secret variable {{key}} as an environment variable"
  - `scriptExecutionModal.secretsRequireSystem`: "This script uses secret variables, which are only delivered to system-context runs. Devices will fail with \"not executed\" under Run as user."
  Run `pnpm --filter @breeze/web test -- src/lib/i18n` and the touched component tests; `pnpm --filter @breeze/web exec astro check` if the form types changed.
- [ ] Commit: `feat(web): author and run scripts with secret-variable parameters (#3409 PR4c-2)`

### Task 9: Integration proof (real Postgres)

**File:** `apps/api/src/__tests__/integration/scriptSecretDelivery.integration.test.ts` (pattern: `tenantVariableResolution.integration.test.ts`, `effectDigestToctou.integration.test.ts`)

- [ ] Seed partner/org/device (`scriptSecretEnvVersion:1`), a secret variable (through `services/tenantVariables.ts` so it is encrypted the real way), a script with a `tenantSecret` parameter; set the active key id the way `scriptSecretEnvelope.test.ts` does.
- [ ] `dispatchScriptToDevice` → assert the stored `device_commands.payload` has `secretEnvEnvelope` starting `enc:v3:`, has no `secretEnv`, and `JSON.stringify(row)` does not contain the plaintext; `openSecretEnv(envelope, {commandId,deviceId})` returns `{api_token: value}`; `script_executions.parameters.$bindings[0].source === 'tenantSecret'`.
- [ ] Downgrade the device to `scriptSecretEnvVersion:0`, claim via `claimPendingCommandsForDevice`, run `decryptClaimedCommandsForDelivery` → returns `[]`; the command row is `failed` with the upgrade message and `payload` lacks the envelope (erased); the execution row is `failed`.
- [ ] Run: `pnpm --filter @breeze/api test:integration -- src/__tests__/integration/scriptSecretDelivery.integration.test.ts` (needs `DATABASE_URL` to a test DB — see `docker-compose.test.yml`; if a sibling session's test DB is in use, bring up your own via `pnpm --filter @breeze/api test:docker:up`).
- [ ] Commit: `test(api): secret delivery end-to-end against Postgres (#3409 PR4c-2)`

### Task 10: Docs, full verification, PR

- [ ] Docs: find the tenant-variables page under `apps/docs` (`grep -rl "tenant variable" apps/docs/src`) and add a "Secret variables in scripts" section: the parameter source, `BREEZE_VAR_<NAME>` (PowerShell `$env:BREEZE_VAR_NAME`, bash `$BREEZE_VAR_NAME`), no content substitution, system-context only, agent-capability floor (the first agent release carrying PR4b — check `git tag --contains 66e148fcf`-equivalent on main; if unreleased, say "agents from the release that ships this feature"), redaction scope and its honest limit (accidental-leak protection, not DLP: `env`/`printenv`/`bash -x` will print it, as will any transformation).
- [ ] Full suites: `pnpm --filter @breeze/shared test`, `pnpm --filter @breeze/api test` (full, not slices), `pnpm --filter @breeze/web test`, `pnpm --filter @breeze/api test -- src/services/actionIntents/effectDigestCoverage.contract.test.ts`, the new integration test, and `effectDigestToctou.integration.test.ts`. Typecheck via `pnpm --filter @breeze/api exec tsc --noEmit -p tsconfig.json` (watch the OOM note in memory) and `astro check` for web.
- [ ] No schema/migration change in this PR — verify with `git diff --stat origin/main...HEAD -- apps/api/migrations apps/api/src/db/schema` and report the (empty) result.
- [ ] Grep invariant: `grep -rn "secretEnv\b" apps/api/src --include=*.ts | grep -v test` — every producer is in `scriptDispatch.ts`/`sourcedParameters.ts`; every consumer opens through `scriptSecretEnvelope.ts`. Show it in the PR.
- [ ] Rebase onto current `origin/main` BEFORE opening; re-run touched slices.
- [ ] Open the PR against `main` (never stacked). Body: what activates, the declared-not-inferred rule, the three dispatch gates, claim gate, save-time fix, software-deploy change, release note ("secret tenant variables are now usable from scripts via a `From a secret variable` parameter; requires agent ≥ <version>; user-context runs are refused"), the `Inert` comments removed, and the test matrix. `Refs #3409` (do not close — the user decides). **Stop at the open PR.** Do not merge.

---

## Explicitly out of scope

| Item | Where |
|---|---|
| Secrets for `runAs: 'user'` (needs a helper IPC capability bump) | future issue |
| Site-scoped variables | deferred since PR1 |
| Better per-device messages for an *unreadable* variable at the five `resolveForOrg` callers | own issue (recorded in PR4c-1) |
| Automation parameter-capture UI, `deviceCustomField` picker | PR3 follow-ups |

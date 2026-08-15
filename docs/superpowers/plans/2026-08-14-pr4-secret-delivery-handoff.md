# Tenant Variables #3409 — PR4 Handoff

**Written:** 2026-08-14 · **Branch:** `ToddHebebrand/tenant-variables-pr4` (off main, **0 commits — nothing built yet**) · **Worktree:** `scripts-custom-variables`

Read this instead of re-running discovery. The file:line references below cost three explorer agents and a codex quorum to produce.

---

## 1. State of the initiative

| PR | What shipped | Merge |
|---|---|---|
| PR0 | `services/scriptDispatch.ts` extraction; all 5 dispatch sites became thin callers | #3418 + #3438 |
| PR1 | `tenant_variables` table, CRUD, `variables:read`/`variables:manage`, Settings → Variables UI | #3494 `da6a8efe9` |
| PR2 | `{{var.*}}` resolved per device at dispatch; per-device failure channel | #3495 `2e7ee0621` |
| PR3 | Sourced parameters (`source: runtime\|tenantVariable\|deviceCustomField\|builtin`) | #3533 `5ea1187eb` |
| **PR4a** | **Server-side machinery, inert — built. See `2026-08-14-pr4a-secret-envelope-server.md`.** | branch `ToddHebebrand/tenant-variables-pr4` |
| **PR4b / 4c** | **Agent, then activation. Designed, not built.** | — |

**PR4a as built** (7 commits, secrets still blocked everywhere):

- `services/scriptSecretEnvelope.ts` — seal/open one canonical envelope; AAD binds schema version + type + field + command id + device id; v3 required (throws rather than degrading to `enc:v1:`); strict post-decrypt validation.
- `sensitiveCommandPayload.ts` — `script` registered as an ENVELOPE type alongside the existing field-level mechanism. Missing context **throws**. `DeliverableCommand`/`ClaimedCommand` gained `deviceId`; `toAgentCommandFrame()` narrows back to `{id,type,payload}` at every send site so `deviceId` cannot leak onto the wire.
- `scriptDispatch.ts` — reserves the command UUID (`randomUUID`) before encryption and passes it to `queueCommand(…, { commandId })`, so the AAD can bind it.
- `services/exactSecretRedaction.ts` + `services/commandSecretRedaction.ts` — value-based redaction wired into BOTH ingest chokepoints, before any persistence; fail-closed to `[OUTPUT_REDACTED:VERIFICATION_FAILED]`. Empty fields stay empty.
- **All 11 terminal `device_commands` writers** now strip sensitive payload keys via `terminalPayloadErasureSet()` (jsonb key-subtraction, bound params) — this fixes §4.1 below. Guarded by `services/terminalPayloadErasure.coverage.test.ts`.
- `devices.script_secret_env_version` (migration `2026-08-22-…`), `securityCapabilities.scriptSecretEnvVersion`, non-sticky heartbeat write. **Stored only — no gate yet.**
- Secret values must be ≥ 4 characters (`MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH` in `@breeze/shared`), enforced at save AND re-checked in `services/tenantVariables.ts` for the `isSecret`-flip-without-`value` case the `.partial()` schema cannot see.

**Two traps hit while building it, worth knowing for 4b/4c:**

1. `sql.raw` broke every test that mocks `drizzle-orm` (the mock's `sql` has no `.raw`). Bound parameters work everywhere and are better anyway.
2. `script_secret_env_version` had to go in `reviewedIncluded`, not `included` — the name matches `SUSPICIOUS_NAME_PARTS`. **`tenant-export-policy.integration.test.ts` passed; only `tenantExportErasureRoundtrip` caught it**, because the name check runs when the plan is actually built. Run both.

**All four are unreleased.** Latest tags are `v0.105.x`; PR0–PR3 land together in **0.106.0**.

**Secrets are currently BLOCKED everywhere** — rejected at script save/import (400) and failed per-device at dispatch. That block is what PR4 lifts. Until then the system is safe by construction.

Prior plan docs, all in-repo: `2026-08-11-pr1-tenant-variables.md`, `2026-08-11-pr2-tenant-variable-resolution.md`, `2026-08-13-pr3-sourced-parameters.md`, `2026-08-13-tenant-variables-handoff.md`.

---

## 2. PR4 is split three ways — do not merge them

Settled by advisor quorum (Opus + codex gpt-5.6-sol xhigh, 2026-08-14). Ordering is **operational, not just review size**: the fleet needs time to upgrade between 4b and 4c.

| PR | Contents | Secrets on the wire? |
|---|---|---|
| **4a** | Envelope codec + AAD binding + v3 requirement; capability storage; exact-value server redactor; centralized terminal payload erasure | **No** — feature stays disabled |
| **4b** | Agent: decode/validate `secretEnv`, inject `BREEZE_VAR_*`, redact stdout/stderr/**error** on local + helper paths, block `runAs:'user'`, advertise capability | **No** — server still not activated |
| **4c** | Activation: unblock secrets at save/dispatch, enqueue **and claim** capability gates, digest pinning, release-time comparison | **Yes** |

Nothing secret leaves the server until encryption, erasure, redaction, capability negotiation and approval pinning are all deployed.

---

## 3. Settled design decisions

### 3.1 Envelope — one envelope, not per-value

Serialize the whole `secretEnv` map into one canonical JSON string and encrypt it as a **single top-level field**. Use distinct stored/wire names — `secretEnvEnvelope` (ciphertext string) → `secretEnv` (object) — so no field changes type between storage and wire.

- Per-value encryption additionally leaks variable **names**, **count**, and individual **value lengths**. One envelope leaks only "this command uses secrets" and approximate size.
- A single corrupt value must fail the whole script anyway (a partial credential set is dangerous), so per-value failure isolation buys nothing.
- **AAD must bind schema version + command type + field + command id + device id.** Today it is a global constant `'device_commands.payload'` (`sensitiveCommandPayload.ts:13`). This may require reserving the command UUID before encryption.
- **Require v3/AAD encryption for this feature.** `secretCrypto.ts:316-346` silently falls back to `enc:v1:` and *ignores AAD* when no key id is configured. That degradation was accepted for `tenant_variables` in PR1; it is **not** acceptable for a live secret on the wire.
- After decrypt: strictly validate object-only, approved key syntax, string-only values, count/size caps, no unexpected properties.

### 3.2 Redaction — exact-value, generic marker, atomic

- Marker is **`[REDACTED]`** — never one naming the variable key. Naming it confirms *which* credential was emitted, and output is readable by a wider audience (`scripts:read`) than the script author.
- **Values under 4 characters fail the device before execution.** Do not choose between destroying output and leaking: refuse to run. The validator currently accepts 1-char values (`packages/shared/src/validators/tenantVariables.ts:46-54`).
- Empty value ⇒ reject as unusable; never register an empty match.
- Duplicates ⇒ dedupe by value.
- Overlaps ⇒ find all exact matches against the **original** text, merge overlapping ranges, replace each merged range once. (Naive longest-first still rescans its own markers.)
- Apply to **stdout, stderr AND error**, on both the local and user-helper paths.
- Server-side: decrypt the envelope solely to build the redactor, redact **before** either `device_commands.result` or `script_executions` is written, then erase the payload. Keep the existing heuristic redaction *after* exact redaction.
- **If server-side envelope decryption fails after the agent already ran:** preserve status/exit code but replace all three output fields with `[OUTPUT_REDACTED:VERIFICATION_FAILED]`. Never persist unverifiable raw output.
- Document honestly: this is accidental-leak protection, **not DLP**. It cannot catch transformed, encoded, hashed, or character-by-character exfiltration.

### 3.3 Old agents — fail loudly, gate at enqueue *and* claim

An agent that ignores `secretEnv` runs the script with the credential env var **unset** — which can mean anonymous access, auth fallback, lockouts, or destructive operations against the wrong target. Never run without the secret.

- Gate on an explicit `scriptSecretEnvVersion: 1` capability, **not semver**. The repo's existing pattern: absent capabilities map to 0 and are written non-sticky so **downgrades are detected** (`routes/agents/schemas.ts:254-261`, `routes/agents/heartbeat.ts:469-476`; precedent `SecurityCapabilities{OutboundNetworkPolicyVersion}` at `agent/internal/heartbeat/heartbeat.go:128-134`).
- **Re-check at claim time**, not only enqueue — an offline queued command can be claimed after a downgrade.
- Unsupported device gets an explicit "agent upgrade required; script not executed".

### 3.4 Digest pinning — drift always invalidates approval

Pin, per device and per reference: variable key, effective variable id, version, `isSecret`, and an explicit **absent** sentinel. Sort deterministically. Also pin **canonicalized parameter definitions** — `effectDigest.ts:119-122` deliberately excludes them today, but PR3 made dispatch consume them.

At release, **fail** on any drift: rotated (version mismatch), deleted (even if that exposes a partner fallback), `isSecret` flipped **either** direction, or absent↔present.

> `isSecret` can change **without** a version bump (`services/tenantVariables.ts:324-336`) — so pinning version alone would miss it.

Distinguish *absent* from *unreadable/decrypt-failed*; unreadable must block approval and release.

**Never put a resolved secret value into the digest material** — it is a sha256 input. Pin a stable reference (id + version) instead. Resolve once at release, compare against approved metadata, and pass **that exact in-memory snapshot** into dispatch — a second query reopens the TOCTOU window.

---

## 4. Discovered facts — the expensive part

### 4.1 Live leak, independent of this initiative — **FIXED in PR4a**

> Kept as written because the table below is still the map of every terminal writer. All eleven now spread `terminalPayloadErasureSet()`; the "Nulled?" column describes the state BEFORE PR4a.


`encryption_rotate_key` already puts `password` and `currentRecoveryKey` into `device_commands.payload` (`sensitiveCommandPayload.ts:16`). **Only the REST ingest blanks them on terminal** (`routes/agents/commands.ts:319-326`). Verified: `hasSensitivePayload` appears **zero** times in `agentWs.ts`, `commandQueue.ts`, `staleCommandReaper.ts`.

10 of 11 terminal paths retain the payload:

| Site | Terminal state | Nulled? |
|---|---|---|
| `routes/agents/commands.ts:319-326` | completed/failed | **YES** |
| `routes/agentWs.ts:1710-1734` (WS ingest — dominant path) | completed/failed | NO |
| `services/commandQueue.ts:568-591` (sync-wait timeout) | failed/timeout | NO |
| `services/commandQueue.ts:1044-1054` (`submitCommandResult`) | completed/failed | NO |
| `jobs/staleCommandReaper.ts:245-258` (terminal state for every *undelivered* command) | failed | NO |
| `jobs/staleCommandReaper.ts:726-742` | cancelled | NO |
| `routes/scripts.ts:1231-1244` | cancelled | NO |
| `routes/software.ts:1565-1571` | cancelled | NO |
| `routes/admin/abuse.ts:153-156` | cancelled | NO |
| `routes/backup/verificationScheduled.ts:178-181` | failed | NO |
| `services/tenantOffboarding.ts:183`, `:299`, `:456` | cancelled | NO |

Encrypted at rest with AAD, so not plaintext — but retention is unbounded and `device_commands` is deliberately RLS-free/system-scoped. **Fix with one shared helper (e.g. `terminalCommandUpdateSet(type)`) applied at all 11 sites**, not 11 ad-hoc spreads.

Also: `commandQueue.ts:293-304` re-arms a **terminal** desktop-stream row back to `pending` — a resurrection path that must not replay an erased payload.

> Worth filing as its own issue; it is unrelated to tenant variables and stands on its own merits.

### 4.2 Server seams

- **The encrypt seam already exists as a deliberate no-op.** `scriptDispatch.ts:313` calls `encryptSensitivePayloadFields('script', {...})` with a comment naming PR4; there is no `'script'` entry in the registry, so it passes everything through today.
- `sensitiveCommandPayload.ts:29-35` encrypts **top-level strings only** (`typeof value === 'string'` guard, no traversal) — a nested map is silently stored plaintext. This is the gap `secretEnv` must not fall into.
- `decryptCommandForDelivery` (`:73-89`) is **fail-soft** — returns null + Sentry rather than throwing. Call sites: `commandQueue.ts:661`, `:932`; `scriptDispatch.ts:352`; `commandDelivery.ts:41-44` (from `routes/agents/commands.ts:192`, `routes/agents/heartbeat.ts:453`, `:1117`).
- **PR0's bypass is confirmed retired** — `scriptExecution.ts` has no direct send; everything funnels through `scriptDispatch.ts`.
- Redaction chokepoints (better than `buildStoredCommandResult`, which is duplicated): `routes/agentWs.ts:1540` — `redactAgentResultErrorFields` is deliberately the **first statement** of `processCommandResult` so the invariant holds on every exit path — and `routes/agents/commands.ts:296`. Then `services/commandResultHandlers.ts:356-367` writes `script_executions` stdout/stderr/errorMessage.
- Existing redaction is **name-based only** (`services/secretRedaction.ts:55-59`) — fires only when the secret sits next to a recognized key name. A bare echoed value survives it.
- Digest resolver: `services/actionIntents/effectDigest.ts:128-152`, `content` pinned at `:147`, hashing central at `:360`. Pin site `intentService.ts:400`; release `jobs/intentReleaseWorker.ts:380`/compare `:408`, and `services/aiAgentSdk.ts:1191`/`:1194`.

### 4.3 Agent seams (Go)

- **The substituted script is written to disk** — `executor.go:130` → `shell.go:102-117` (temp file, 0600). This is *why* env delivery matters: a substituted secret lands on the customer's filesystem.
- Decode: `heartbeat/handlers_script.go:26-43`; struct `executor.ScriptExecution` at `executor.go:33-41`.
- Substitution: `executor.go:120` → `shell.go:158-176` (replaces both `{{key}}` and `${{key}}`).
- Env build: `executor.go:329-346`, `BREEZE_PARAM_` at `:340`; applied `executor.go:182` via `procoutput.ApplyEnv`.
- **Three narrow edits for `secretEnv`:** add `SecretEnv map[string]string` to `ScriptExecution` (`executor.go:41`); decode after `handlers_script.go:43`; emit `BREEZE_VAR_<UPPER>` in `buildEnvironment` after the param loop. **Do not** pass it to `SubstituteParameters` (`:120`) or `validateScript` (`:123`).
- Reject agent-side keys not matching `[A-Za-z_][A-Za-z0-9_]*` so a malformed key can't inject a second env entry.
- **`result.Error` is unsanitized at 8 sites** (`executor.go:105,114,126,136,160,209,257,263`). `handlers_script.go:127-134` sanitizes stdout/stderr but copies `Error` raw; same asymmetry on the helper path (`handlers_script.go:274-277`, `userhelper/client.go:766-767` vs `:779`).
- Existing `executor.SanitizeOutput` (`security.go:199-241`) is **pattern-based** — won't catch a bare secret on its own line.
- `secmem.SecureString` (`agent/internal/secmem/secmem.go:14-100`) already redacts in `String()`/`MarshalJSON()` — the right precedent for holding values in memory.
- **`runAs:'user'` drops `Parameters` entirely today** — `userhelper/client.go:743-748` never reads `Parameters` or `RunAs`. Blocking secrets there in v1 is correct. Fixing it later needs a **user-helper binary** rollout, versioned separately (`HelperVersion`, `heartbeat.go:99`) — a second rollout axis.
- **Unknown payload fields are safe to send** (`map[string]any`, no `DisallowUnknownFields` anywhere in `agent/`) — an old agent ignores `secretEnv` without error. The failure mode is a **silent wrong run**, which is exactly why the capability gate is mandatory.
- No leak via telemetry: nothing in `agent/internal` logs `cmd.Env`, `buildEnvironment`, or the payload map. The real exposure is a script doing `env`/`printenv`/`Get-ChildItem Env:`/`bash -x`.

---

## 5. Also open

1. **0.106.0 release notes** — 8 items across PR1–PR3. The two that will generate support load fire on things nobody edited: `normalizeAutomationActions` re-validating **stored** automation actions at runtime (PR2), and required `runtime` parameters now enforced server-side, hitting automations that send `{}` (PR3). Both were already producing silently wrong runs, so they are fixes — but they read as regressions if unannounced.
2. **The FileVault retention leak (§4.1)** — fixed in PR4a, but still worth its own issue: it predates this initiative and stands on its own merits (and the fix should be release-noted independently of tenant variables).
3. **PR3 follow-ups** — automation parameter-capture UI (never existed, `AutomationForm.tsx:61-69` captures only `scriptId`); `aiToolsScripts` doesn't surface `ignoredParameters`; `deviceCustomField` binding is free-text, not a picker.
4. **MEMORY.md** is over the hook's 17.1KB target; needs section→topic-file consolidation, not entry deletion.
5. **Four-eyes adjacent, not PR4's job:** the web approvals inbox was never built (Plan 2 of the tier-3 split), and there is a `run_script` digest resolver unreachable on the supervised path.

---

## 6. Process notes that repeatedly paid off

- **Rebase onto current main *before* opening a PR**, not after CI is green. This caught a root-mounted-namespace break in PR1 that would have gone green on the PR and reddened main.
- **Run the full API suite, not just touched slices.** PR3's agents all passed their own runs; the full suite found 5 failures in a third file none of them had opened.
- **Mutation-verify every guard test.** PR2's preload tests would have passed with the gate wired to constant `false`. For each new guard: force it off, confirm the new tests fail *and nothing else does*, restore.
- **Don't pipe long test runs through `tail`** — you lose all progress and can't tell slow from wedged. And a backgrounded `sleep N && check` returns an instant snapshot, not a delayed one.
- **When local disagrees with CI, check out clean `origin/main`** before blaming your branch. `ipAllowlistMode.config.test.ts` fails locally on main too — pre-existing and environmental.
- **`codex exec` flags:** `--full-auto` and `-s read-only` are mutually exclusive; the invocation dies on the conflict. Use `-s read-only` alone, plus `< /dev/null` to avoid the stdin hang.
- Verify subagent claims directly — commit exists, tests really ran, change is on the right branch.

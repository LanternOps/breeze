# PR3 — Sourced Script Parameters (#3409)

**Branch:** `ToddHebebrand/tenant-variables-pr3` (off main) · **Stacked on:** nothing — PR1/PR2 are merged
**Depends on:** `tenant_variables` (PR1 #3494), `{{var.*}}` resolver + `scriptDispatch` chokepoint (PR2 #3495)

---

## 1. What this delivers

A script's parameter **definition** gains a `source` binding:

| source | Value comes from |
|---|---|
| `runtime` | the invoker at run time (today's behaviour — the default) |
| `tenantVariable` | a `tenant_variables` row, resolved per target device's org (org > partner) |
| `deviceCustomField` | the target device's `custom_fields` JSONB |
| `builtin` | org / site / device properties |

At dispatch, bound parameters are pre-filled **per target device** by the server. The run modal prompts only for `runtime` parameters. The same resolver feeds both consumers.

Secrets remain unusable in v1 — a `tenantVariable` binding to a secret is rejected at save and fails per device at dispatch. PR4 adds the out-of-band channel.

---

## 2. Settled design (advisor quorum: Opus + codex gpt-5.6-sol xhigh, 2026-08-13)

### 2.1 Precedence

**Bound parameter** (`source !== 'runtime'`):
```
resolved non-blank source value  →  definition default  →  missing
```
An invoker-supplied value is **not a candidate**. If it were, the binding would be a suggested default rather than an authoritative source.

**Runtime parameter:**
```
explicit invoker value  →  definition default  →  missing
```

`required` is evaluated **after** precedence, never before. For bound sources, `null`, absent, empty string, and **whitespace-only** all count as missing — matching the existing installer resolver's blank rule (`installerVariables.ts:91-95`).

### 2.2 Invoker override — ignored, not rejected

A caller supplying a value for a bound key has that value **ignored**; the binding wins. The response carries a structured `ignoredParameters: string[]`, and it is audited.

> **Why not 400.** `automationRuntime.ts:366` validates stored automation actions *without consulting the referenced script definition*, so an automation literally cannot pre-validate against a binding. A hard reject would convert a previously-valid stored automation into a delayed runtime failure the moment a script author flips a parameter to bound — with no authoring-time signal. The binding still wins authoritatively, so ignoring weakens nothing.

> **Digest integrity is preserved separately, not by rejecting.** Raw caller parameters and the server-built resolved map are kept in **separate trust domains**: dispatch produces a `ResolvedParameterSnapshot` (definition version, binding identity, tenant-variable version, final canonical strings). PR4's four-eyes digest pins *that snapshot* and dispatches from it. Raw caller input must never masquerade as a pinned snapshot.

**Known transition gap:** for automation consumers the warning has no UI surface today, so the ignore is effectively silent there. Mitigate by auditing it and projecting it onto execution history. Accepted for this PR; a strict mode belongs to a future versioned API.

### 2.3 Required / missing

Apply the default first, then:

| Case | Behaviour |
|---|---|
| Required, nothing resolved and no default | **Fail that device** — `script_executions` row `status:'failed'`, fan-out continues |
| Optional, nothing resolved and no default | **Omit the parameter** |
| Any | Never abort the whole fan-out because some devices lack a binding |

Failure code is **`unresolved_parameters`** — deliberately distinct from PR2's `unresolved_variables`, so parameter-binding failures are not conflated with content-token failures. Error messages carry **key names, never values**.

The existing aggregate contract is preserved: all devices failed ⇒ 422 (`routes/scripts.ts:931`, shipped in PR2).

### 2.4 Source flips to secret

- **Save / import:** a `tenantVariable` binding whose target is currently `is_secret` ⇒ **400**.
- **Dispatch:** re-check authoritatively; each affected device **fails**.

**A secret result is a policy denial, not "missing".** Do *not* fall back to the definition default, do *not* use an invoker value, do *not* omit. Any of those would silently bypass an operator's deliberate classification change.

*(PR4 note: a secret flip must also invalidate an already-pinned approval snapshot. "Dispatch the exact pinned snapshot" freezes values; it must not bypass a later security revocation.)*

### 2.5 Definition schema

Promote a single `scriptParameterDefinitionSchema` into `packages/shared/src/validators/` as a **discriminated union on `source`**, each arm requiring only its own binding field. This closes the `z.any()` gap at `routes/scripts.ts:235,253`.

Today the shape is mirrored in three places with no authority — `apps/web/src/components/scripts/ScriptFormSchema.ts:4-10`, `packages/shared/src/validators/ai.ts:88-94`, `apps/api/src/services/scriptBuilderTools.ts:174-180`. All three must import the shared schema.

**Collision detection** goes on the containing array via `superRefine`, normalizing **exactly as the agent does**: `name.toUpperCase().replaceAll('-','_')` (`agent/internal/executor/executor.go:339-341`). This rejects hyphen/underscore *and* case collisions.

> This is a live nondeterminism bug, not a hypothetical. `log-level` and `log_level` are distinct JS keys, both pass today's validation, both reach the agent, and both map to `BREEZE_PARAM_LOG_LEVEL`. `Cmd.Env` keeps the last entry and Go randomizes map iteration order — **so the winner varies between runs of the same script.** Uppercasing widens it: `logLevel`/`LOGLEVEL`/`loglevel` collide too. Nothing tests this today.

**`script.version` must increment when parameter definitions change.** Today only content changes bump it (`routes/scripts.ts:768`). PR4's digest pins definition version, so this gap must close here.

---

## 3. Prerequisites inside this PR

These are not optional cleanups — sourced parameters are incorrect or pathological without them.

### P1 — Extend the scope-preload gate beyond content

`hasVariableTokens(script.content)` currently gates scope loading at `scriptExecution.ts:169-170`, `automationRuntime.ts:902-903`, `aiToolsScripts.ts:295-296`. Sourced parameters live in `scripts.parameters`, **not** content — so without extending the gate, every bound parameter resolves against an empty scope and silently fails.

Add `scriptNeedsVariableScope(script)` = `hasVariableTokens(content) || hasTenantVariableBoundParameters(parameters)`.

> **Test-design warning:** PR2 hit exactly this trap — its three preload tests were written against token-free fixtures and would have passed with the gate wired to constant `false`. Every gate test here must be **mutation-verified**: forcing the gate false must fail the new tests and nothing else.

### P2 — Fix the automation N-connection trap *before* adding a second resolver

`automationRuntime.ts:902` loads the variable scope **per device per `run_script` action** (device loop at `:1812` with concurrency 5; second runner at `:2368`), where `scriptExecution.ts:169` loads once per fan-out. Adding a second per-device loader on top would compound it. Hoist to once per action set, keyed by the distinct org set.

### P3 — Widen the device projection

`DispatchScriptInput.device` is `Pick<…,'id'|'orgId'|'osType'|'status'|'agentId'>` (`scriptDispatch.ts:40`) — no `customFields`, `siteId`, or `hostname`, all of which `deviceCustomField` and `builtin` need.

- `scriptExecution.ts:99-102` already selects full device rows — no change needed.
- `automationRuntime.ts:1743-1754` uses a **narrow** projection, mirrored in `ActionExecutionContext.device` (`:797-810`) — both must widen.

### P4 — Resolved values must not enter `script_executions.parameters`

`scriptDispatch.ts:176` inserts `parameters` **raw** into the execution row, before canonicalization. Resolved bound values must **not** flow into that insert.

Per the issue's audit design, dispatch persists **bindings** `{key, source, variableId, ownerScope, version}` — *never values*. Execution history therefore records the caller-supplied runtime parameters plus a binding descriptor; the resolved values exist only in the command payload that reaches the agent. This is what keeps PR3 forward-compatible with PR4, where persisting a resolved secret would be exactly the leak the separate channel exists to prevent.

---

## 4. Where resolution happens

One chokepoint, inside `dispatchScriptToDevice` (`scriptDispatch.ts:87`), ordered:

```
decommission check (:90)
  → live status re-read if requireOnline (:106)
  → org-equality + OS check (:122)
  → parameters = input.parameters ?? {} (:135)
  → [PR2] content {{var.*}} substitution (:152-162)
  → [NEW] sourced-parameter resolution  ← here
  → script_executions insert (:167-179)   ← runtime params + binding descriptor only
  → payload build + canonicalizeScriptParameters (:241)
  → queueCommand
```

Resolution lands **before** the execution insert so a failing device leaves no orphan `pending` row — the same rule PR2 established for content substitution.

`{kind:'raw'}` (`execute_command`) is skipped: there is no declaring script, so there are no definitions to bind.

---

## 5. Reuse — do not reinvent

| Reuse verbatim | Build new |
|---|---|
| `loadTenantVariableScope` / `resolveForOrg` / `TenantVariableScope` (`tenantVariableResolution.ts:121,205`) | Parameter-level resolver — today's substitution is content-only |
| `runOutsideDbContext(() => withSystemDbAccessContext(...))` — **both** wrappers, in that order (`:127-128`) | Device custom-field lookup — no helper exists; `devices.customFields` is raw JSONB |
| Per-device fail-don't-abort pattern (`scriptExecution.ts:245-260`) | API-side **builtin registry** — only five hand-written `switch` arms exist (`installerVariables.ts:50-65`), with the sole tripwire web-side (`installerVariables.test.ts:9-19`). Needs a shared constant + reciprocal test |
| `canonicalizeScriptParameters` at `:241` — resolved values become `map[string]string` for free | Discriminated-union definition schema + array-level collision `superRefine` |
| Secret policy: never substitute textually (`tenantVariableResolution.ts:234-258`) | `ResolvedParameterSnapshot` type (PR4 digests it) |

---

## 6. UI

`ScriptParametersForm.tsx` is the **single shared renderer** for every run surface — so the "skip bound params" logic lands in one place.

- `ScriptFormSchema.ts:4-10` — add `source` (default `'runtime'`) + binding key; `addParameter()` (`ScriptForm.tsx:333-341`) must seed `source:'runtime'` so existing rows keep today's behaviour.
- `ScriptForm.tsx:632-670` — source `<select>` in the row; `defaultValue`/`required`/`options` become conditional; a key picker appears for bound sources. Reuse `ScriptVariablePicker`'s menu.
- `ScriptParametersForm.tsx:13-36,44,46-102` — `validateParameters` must not require a value for bound params; render them read-only with a "supplied by <source>" chip; the `length === 0` early return becomes "no runtime params".
- `ScriptExecutionModal.tsx:256-263` and `ScriptPickerModal.tsx:157-181,322-325` — visibility gate and default-seeding must count **runtime** params only.
- **i18n:** new keys in `en/scripts.json` must be added to all seven locales in the same commit — `en`, `pt-BR`, `es-419`, `fr-FR`, `fr-CA`, `de-DE`, `it-IT` — exact key-set equality is asserted (`localeParity.test.ts:338-345`).

Automation parameter capture (`AutomationForm.tsx:61-69,676-690` has **no** parameter UI today) is **out of scope** — noted as a follow-up.

---

## 7. Testing

**Unit** — new: definition schema (each union arm, collision `superRefine` incl. case collisions, key grammar), parameter resolver (precedence table, blank/whitespace, required vs optional, secret denial). Updated: `scriptDispatch`, `scriptExecution`, `automationRuntime`, `scripts` routes, `scriptBundle`, `ScriptForm`, `ScriptParametersForm`, `ScriptExecutionModal`, `ScriptPickerModal`, locale parity, `astro check`.

**Mutation-verify** (non-negotiable, per P1): disabling the extended preload gate must fail the new gate tests **and nothing else**. Same for the secret denial and the override-ignore path.

**Integration** — extend `tenantVariableResolution.integration.test.ts`: a bound parameter resolving org-over-partner; partner inheritance; no cross-partner leak; resolution working from inside an org-scoped `withDbAccessContext`; secret binding denied at dispatch.

**Contract suites** — no new tables and no migration, so RLS/cascade/export registries are unchanged. Still run `db:check-drift` (the `scripts.parameters` column gains a `$type<>()` annotation, which must not produce drift).

---

## 8. Release notes (0.106.0, alongside PR1/PR2's items)

1. **Script parameter definitions are now validated.** Previously `z.any()` — malformed definitions were stored unchecked. Existing scripts whose definitions don't match the schema will fail on next save.
2. **Duplicate parameter keys that collide as env vars are now rejected** (`log-level` vs `log_level` vs `logLevel`). Previously accepted, with a **nondeterministic** winner per run.
3. **A value supplied for a bound parameter is ignored**, reported in `ignoredParameters`, and audited.
4. **`script.version` now increments when parameter definitions change**, not only content.
5. **Required `runtime` parameters are now enforced server-side.** `required` was previously only checked in the browser (`ScriptParametersForm.validateParameters`) — the server had no definition schema at all, so it could not enforce it. Now a required runtime parameter with no caller value and no default fails that device.

   > This mainly bites **automations**, which have no parameter-capture UI and send `{}`. Such a run was *already* broken — the agent received no value, left `{{param}}` verbatim in the script, and never set `BREEZE_PARAM_*` — so this converts a silent wrong-result into a loud failure rather than breaking something that worked. Same class as PR2's parameter-strictness item, and it must be release-noted with it.

---

## 9. Out of scope

Automation parameter-capture UI · `BREEZE_VAR_*` / `secretEnv` secret delivery · redaction · effect-digest pinning (all PR4) · site-axis tenant variables · the `runAs:'user'` parameter outage (`userhelper/client.go:743`).

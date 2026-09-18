---
title: Partner API Execute Scope
status: draft
date: 2026-09-07
owner: Todd Hebebrand
area: api-platform
related:
  - docs/superpowers/specs/misc/2026-09-06-offline-work-queue-design.md
  - docs/superpowers/plans/2026-08-08-partner-api-provisioning-writes.md
  - docs/superpowers/plans/integrations/2026-07-13-breeze-partner-integration-api.md
  - docs/superpowers/specs/onboarding-signup/2026-09-07-zero-touch-onboarding-design.md
  - docs/superpowers/specs/installer-enrollment/2026-08-02-enrollment-idempotency-design.md
---

# Partner API Execute Scope

## 1. Summary

Two machine consumers need one partner-wide, unattended credential that can run a script on any
device across all of a partner's organizations and read the result: **(a) an ImmyBot dynamic
integration** (PowerShell-hosted framework — list clients = orgs, list agents = devices with an
online flag and stable id, run a script and poll stdout/stderr/exit code, a per-org agent install
token, optionally delete an offline agent) and **(b) a catalog hub service** that runs lab tests by
dispatching install/detect/uninstall steps to lab devices in a dedicated Breeze instance.

Both are served by adding an **execute surface to the existing Partner API**
(`partner_service_principals` + `X-API-Key: brz_sp_…`), not by widening the org-scoped `brz_…` API
keys, which already owns the right identity: one credential, partner-wide org discovery, partner RLS
scope, source-CIDR pinning, principal expiry, per-principal rate limits, per-request audit. The
org-key alternative is not merely worse but non-functional today — `scripts:execute` is defined but
enforced nowhere and the script routes accept JWT bearer only (F11).

## 2. Repo facts this design is built on (verified 2026-09-07)

| # | Fact | Evidence |
|---|---|---|
| F1/F2 | Partner API mounts at `/api/v1/partner-api`; auth `partnerApiAuthMiddleware`, scope check `requirePartnerApiScope(...)`. Its scope vocabulary is a frozen literal union with two groups (read, provisioning-write) — no execute scope exists. | `apps/api/src/index.ts:858`; `routes/partnerApi/index.ts`; `services/partnerServicePrincipalScopes.ts` |
| F4 | Non-GET requests run with **no ambient DB context** (the read path's held partner-RLS snapshot txn is skipped to avoid the export advisory-lock self-deadlock). Handlers open their own bounded context via `partnerScopedDbContext(principal)` → `scope:'partner'`, `accessibleOrgIds`, `accessiblePartnerIds:[partnerId]`. | `middleware/partnerApiAuth.ts`; `routes/partnerApi/provisioning.ts:200` |
| F3/F5 | **Every non-GET partner-API route must appear in an allowlist test or CI fails** (three entries today). Non-GET traffic is capped at `PARTNER_API_WRITE_RATE_LIMIT_PER_HOUR = 120` at `min(key.rateLimit, 120)`, keyed `partner_api_write_rate:<principalId>:<keyId>` — so the budget is **per key**, and a principal with N keys gets N× it. `writeSurface.test.ts` skips `GET` and `ALL`, so only non-GET routes need allowlisting. | `middleware/partnerApiAuth.ts`; `routes/partnerApi/writeSurface.test.ts` |
| F6 | `script_executions.script_id` is `NOT NULL REFERENCES scripts.id`; `triggered_by` and `cancelled_by` are `REFERENCES users.id`. The FK also means a `scripts` row referenced by any execution cannot be hard-deleted. | `db/schema/scripts.ts:158-176` |
| F7 | `dispatchScriptToDevice` has a `source: {kind:'raw'; content; language; provenance}` arm — but **raw dispatch writes no `script_executions` row** (only `saved` does; `executionId: string \| null`) and deliberately performs **no `{{var.*}}` substitution** (`variableScope` is consumed only when `source.kind === 'saved'`). Sole caller: `automationRuntime.ts:1506`. | `services/scriptDispatch.ts:55-57,95-99,194` |
| F8 | Offline queue W01 is merged: `OfflinePolicy = {kind:'reject'} \| {kind:'queue'; deliverWithinMs}`, `device_commands.deliver_by` + `submitted_org_id`, reaper two-clock split, flag `DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED`. W03/W04 are not. | `services/commandOfflinePolicy.ts:9`; migration `2026-10-13-100000-device-commands-deliver-by.sql` |
| F9 | **`assertDeviceExecuteAllowed` is NOT called on the script path.** It runs at *claim* time in `claimPendingCommandsForDevice` (cancels the row `trust_denied`), plus at enqueue on `routes/devices/commands.ts`, mobile, PAM. A probation-denied partner's script enqueue therefore succeeds and dies silently at heartbeat. | `services/commandClaimEligibility.ts:227`; grep of `scriptExecution.ts`/`scriptDispatch.ts`/`routes/scripts.ts` returns nothing |
| F10 | Human execute route `POST /api/v1/scripts/:id/execute`: `requirePermission(SCRIPTS_EXECUTE)` **+ `requireMfa()`**; body = `deviceIds` (1–500), `parameters` (64 KB cap), `triggerType`, `runAs` (`system\|user`; `elevated` already excluded), `targetSessionId` — **no timeout, no inline field**, though `DispatchScriptInput` accepts `timeoutSeconds`. Returns 201 with a `ScriptAdmissionResult`, not a result. Reads `GET /scripts/:id/executions`, `GET /scripts/executions/:id`; cancel `POST /scripts/executions/:id/cancel` (`{graceSeconds?: 0..30}`, MFA, `services/scriptCancellation.ts`, marks `cancelled` only on a proven stop). | `routes/scripts.ts:1136,1191,1279,1352`; `services/scriptRunRequest.ts:20-71` |
| F11 | Org-key scopes `scripts:execute`/`devices:execute` exist in `API_KEY_SCOPE_POLICIES` but **`scripts:execute` is never passed to `requireApiKeyScope`**. `apiKeyAuthMiddleware` is wired into exactly three routers (`devPush.ts:79`, `mcpServer.ts:219`, and `devices/customFieldValues.ts:102`, the last only for `devices:read`/`devices:write`), and `scriptRoutes.use('*', authMiddleware)` accepts JWT bearer only — an `X-API-Key` cannot reach the script routes at all. The only API-key path to execution today is the MCP `run_script` tool under the coarse `ai:execute` bucket. | `services/apiKeyScopes.ts:6,9,28-31`; `routes/scripts.ts:344`; `routes/mcpServer.ts:1056,1585`; `routes/devices/customFieldValues.ts:95-110` |
| F12 | Partner `GET /devices` exports serial/manufacturer/model/os/build/arch/tags/groups — but **no online status, no `lastSeenAt`, no `agentVersion`**. Liveness truth is `resolveLivenessStatus`, threshold `DEFAULT_OFFLINE_THRESHOLD_MINUTES = 5`; `devices.status` is corrected only eventually by `offlineDetector`. | `routes/partnerApi/devices.ts`; `services/deviceLiveness.ts:13` |
| F13 | Partner API mints an enrollment key (`POST /enrollment-keys`, raw key once) but **returns no download URL and no install command**. Installer machinery is human-API only: `GET /enrollment-keys/:id/installer/:platform`, `POST /:id/installer-link` (→ `{url, shortUrl, expiresAt, maxUsage, platform, childKeyId}`), `POST /:id/bootstrap-token`, public `GET /enrollment-keys/public-download/:platform?h=<handle>`. `installer-link` is gated by `requireMfa()` + `requireCapability('installer_distribute')`. | `routes/enrollmentKeys.ts:1401,1904,1989,2171,2553` |
| F14 | Idempotency precedent: header `X-Idempotency-Key` (1–128 printable ASCII), dedicated claim table `partner_enrollment_key_idempotency` with `(principal_id, idempotency_key)` unique, sha256 request fingerprint, claim-then-link in one transaction, 409 on body mismatch / in-flight race. | `routes/partnerApi/provisioning.ts:545-655,785-826` |
| F16 | Agent enforces a STRICT script-pattern validator; STRICT patterns are acknowledgeable **per saved script row** (`scripts.acknowledged_security_patterns`) and the acknowledged set rides the dispatch payload. BASIC patterns are never acknowledgeable. | migration `2026-10-13-110000-scripts-security-acknowledgement.sql` |
| F17 | Principals are created/rotated at `POST /api/v1/partner-service-principals` (+ `PATCH /:id`, `POST /:id/keys`, key rotate, `DELETE`), all `requireScope('partner','system')` + `ORGS_WRITE` + **`requireMfa()`** + `canManagePartnerWidePolicies`. `enrollment-keys:write` additionally requires a principal expiry and ≥1 source CIDR, enforced at grant time *and* re-checked per request. | `routes/partnerServicePrincipals.ts:128-142,230-297`; `provisioning.ts:560-568` |
| F18 | Script default offline policy is **queue**, TTL `DEVICE_COMMAND_QUEUE_TTL_HOURS` default **168 h**; `executeScriptOnDevices` passes no policy, so manual runs always queue. | `services/commandOfflinePolicy.ts:49,237,293` |
| F19 | Non-user actors are already handled: `scriptDispatch.ts` probes whether the actor id is a real `users` row, writes NULL to `triggered_by` when not, and stashes `{actorType:'ai_agent', actorId}` in the `parameters` jsonb under `EXECUTION_PARAMETER_ACTOR_KEY`. Hardcoded to `ai_agent`; no service-principal variant. `parameters` is `excludedOpen` in the export policy, so the sidecar is invisible to tenant export. Cancellation has its own copy, `resolveCancelledBy`, which degrades a non-user actor to NULL on `cancelled_by` **with no sidecar at all** — the actor survives only in the audit log. | `services/scriptDispatch.ts:404-424,707-723`; `services/scriptCancellation.ts:262-279,368` |
| F20 | **Inline content would persist in the clear.** `scriptDispatch.ts:518` puts `content` into `device_commands.payload` as a plain field. `sensitiveCommandPayload.ts` encrypts only named `SENSITIVE_PAYLOAD_FIELDS` (`encryption_rotate_key` alone) and the `secretEnv` → `secretEnvEnvelope` envelope for type `script`; `TERMINAL_PAYLOAD_STRIP_KEYS` is derived from exactly those, so `content` is neither encrypted at rest nor erased at terminal state in an unbounded-retention, RLS-free table. | `services/scriptDispatch.ts:505-525`; `services/sensitiveCommandPayload.ts:33-60` |
| F21 | **`requireCapability` is a silent no-op for a partner API principal.** It reads `c.get('auth')` and `return next()`s when `auth?.partnerId` is absent — partner API auth sets `partnerApiPrincipal`, never `auth`. | `services/partnerTrust.ts:313-316`; `middleware/partnerApiAuth.ts:353` |
| F22 | **`cancelScriptExecution` is authorization-free by design and escapes RLS.** `inDeliberateSystemContext` re-enters system scope, and the pre-read selects on `executionId` alone. Its own comment states every caller must apply the org/site gate first; the human route does exactly that, joining `devices` for `orgId`/`siteId` before calling. | `services/scriptCancellation.ts:73-85,304-310`; `routes/scripts.ts:1392-1400` |
| F15/F23 | Agent caps each stream at `MaxOutputSize = 1MB`, appending `[breeze: stdout truncated at 1MB]` and a `truncatedFields` array — but **the flags are then discarded**: `commandResultHandlers.ts` builds `executionValues` from status/exitCode/stdout/stderr/errorMessage/customFieldResult only, so `truncatedFields` is never persisted (`stdoutTruncated`/`stderrTruncated` exist solely as a route-local computation in `routes/automations.ts`). `stdout` is `redactSecretsFromOutput`-filtered before persistence (#2434). | `agent/internal/executor/executor.go:29,594-603`; `services/commandResultHandlers.ts:412-424`; `routes/automations.ts:435,496` |

## 3. Scopes

Add a third frozen group, `PARTNER_SERVICE_PRINCIPAL_EXECUTE_SCOPES`, to
`partnerServicePrincipalScopes.ts`: **`scripts:execute`** (run a saved script on one device),
**`scripts:execute:inline`** (caller-supplied content), **`executions:read`** (poll status / output),
**`devices:execute`** (reboot, agent uninstall).

1. Never in `DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES`. Opt-in per principal only.
2. `scripts:execute:inline` is **not** implied by `scripts:execute`; an inline route demands both
   (`requirePartnerApiScope(...)` is already an AND over its arguments).
3. **Grant boundary = MFA at grant time**, the argument `enrollment-keys:write` already uses: the call
   is machine-to-machine, so no human is in the request path. Extend
   `validateEnrollmentWriteRestrictions` into `validateRestrictedScopeGrants` requiring, for any execute
   scope, partner-admin (`canManagePartnerWidePolicies`) + a satisfied `requireMfa()` + a non-null
   `expiresAt` + ≥1 `sourceCidrs` — re-checked **per request** (F17), so a later `PATCH` clearing them
   cannot leave a live unrestricted execute credential.
4. **Trust gate — two layers, because the existing middleware does not fire here.** F21:
   `requireCapability` returns `next()` for any request lacking `auth.partnerId`, i.e. every partner
   API request. Wave 1 adds **`requirePartnerPrincipalCapability(cap)`** — the same
   `evaluateCapability`, reading `principal.partnerId` from `partnerApiPrincipal` — on the execute
   endpoints and on install-link minting (§8). Independently every execute route calls
   `assertDeviceExecuteAllowed(deviceId, commandType, null)` at enqueue → `403 partner_api_trust_denied`,
   closing F9. Neither alone suffices: the middleware is partner-wide but not device-aware, and the
   enqueue gate never runs on mint.

## 4. Endpoints

All under `/api/v1/partner-api`, all envelope-versioned (`schemaVersion: '1'`) like the export DTOs.
All four non-GET routes must be added to `PARTNER_API_NON_GET_ROUTE_ALLOWLIST` (F3).

### 4.1 `POST /devices/:deviceId/script-executions`

Scopes: `scripts:execute` (+ `scripts:execute:inline` when `inline` is present). `timeoutSeconds` is
new at the HTTP layer only — `DispatchScriptInput.timeoutSeconds` already exists (F10).

```jsonc
{ "script": { "id": "<uuid>" },   // XOR with `inline`
  "inline": { "content": "<=64KiB", "language": "powershell|bash|python|cmd" },
  "runAs": "system|user",         // 'elevated' rejected on this surface
  "timeoutSeconds": 1..3600, "parameters": { "<name>": "<value>" },
  "whenOffline": "reject" | "queue",        // default "reject"
  "deliverWithinMinutes": 1..10080 }        // only with whenOffline:"queue"
```

Device-centric on purpose (not the human API's script-centric `/scripts/:id/execute`): both consumers
hold a device id, want one target, and need one execution id back rather than an admission report.
`201 { schemaVersion, data: { executionId, deviceId, orgId, status, delivery, deliverBy, runAs,
ignoredParameters } }`, `delivery ∈ 'delivered'|'queued_offline'`. Errors: `403` (scope / org outside
the accessible set / trust denied / principal restrictions), `404` (device not in an accessible org —
never distinguish "other partner's device" from "does not exist"), `409 partner_api_device_offline`,
`422` (OS-incompatible, decommissioned, maintenance-suppressed, carrying the admission `reasonCode`),
`429`. `X-Idempotency-Key` follows F14 via a new `partner_script_execution_idempotency` table
mirroring `partner_enrollment_key_idempotency` column for column (`enrollment_key_id` →
`script_execution_id`); replay returns the original `executionId` with `idempotencyReplay: true`.

### 4.2 `GET /script-executions/:id`

Scope: `executions:read`. Returns status, `exitCode`, `startedAt`/`completedAt`, `errorMessage`,
`cancelState`, and `output: { stdout, stderr, truncated: {stdout, stderr}, bytes: {stdout, stderr} }`.

Cap **256 KiB per stream** on the API response (the agent already caps at 1 MiB). Over the cap, return
the **tail** — the useful half of a script log — plus `\n[breeze: truncated by partner API at 256KiB]`.

**`truncated` cannot be answered today (F15/F23):** the agent sends `truncatedFields` and
`commandResultHandlers.ts` drops it. Wave 1 must add `stdout_truncated`/`stderr_truncated` (boolean,
default false, export `included`) and populate them in `executionValues` **before** this field is
exposed — otherwise `truncated` is a fabricated value derived from our own 256 KiB cut, a different
fact. Both are reported, so a consumer can tell "we cut it" from "the agent cut it".

**Output is exempt from `exportSafety` secret scanning** — it guards *configuration definitions*,
while stdout is caller-requested runtime output tripping on any line containing "password". Make it an
explicit commented carve-out in `dtoSafety.test.ts`; the DTO stays `.strict()`.

### 4.3–4.5 List, cancel, device commands

- `GET /script-executions?deviceId=&since=&limit=&cursor=` — `executions:read`, `pagination.ts` keyset
  cursors, `since` on `created_at`. Output is **omitted** from list rows (id, status, timings,
  exitCode) — shipping 256 KiB × N is a footgun.
- `POST /script-executions/:id/cancel` — `scripts:execute`. **Hard rule: the route MUST resolve
  execution → device → org and assert that org is in `principal.accessibleOrgIds`, inside the partner
  DB context, BEFORE calling `cancelScriptExecution`.** Per F22 the service is authorization-free by
  contract — it re-enters system scope via `inDeliberateSystemContext` and pre-reads on `executionId`
  alone — so an unchecked id is a cross-partner cancel. Mirror the human route's scoped lookup
  (`routes/scripts.ts:1392-1400`, joining `devices` for `orgId`/`siteId`). A non-visible id returns
  **404**, never 403 (§4.1's "do not confirm existence" rule); otherwise `202` with the resulting
  `cancelState`, `409` if terminal — and since `cancelled` is set only on a proven stop, treat
  `cancelState:'unconfirmed'` as "possibly still running".
- `POST /devices/:deviceId/commands` — `devices:execute`, restricted to `reboot` and
  `agent_uninstall`, same trust gate and `whenOffline` contract. Not `shutdown` (a machine caller
  cannot judge that), not `device_remove` (tenancy deletion stays human + MFA).

## 5. Offline behaviour

`whenOffline` defaults to **`reject` for machine callers**, the opposite of the script path's own
default (F18: queue, 168 h) — both consumers are synchronous orchestrators, and a run landing three
days later is worse than a 409 they can retry.
- `reject` → `{kind:'reject'}` → `409 partner_api_device_offline`, carrying `lastSeenAt`.
- `queue` → `{kind:'queue', deliverWithinMs}`, capped by the `CommandTypes.SCRIPT` class TTL (7 d)
  but defaulting to **60 minutes** here; the response carries `deliverBy` and the reaper fails the
  row `not_delivered_before_deadline` past it. With `DEVICE_COMMAND_OFFLINE_QUEUE_ENABLED` off,
  `queue` returns `409 partner_api_offline_queue_disabled` rather than degrading to reject.

## 6. Inline execution — the load-bearing constraint

F6 + F7: `script_executions.script_id` is `NOT NULL` and the existing `raw` arm writes no execution
row, while ImmyBot's bootstrap is a one-shot base64 payload with no saved script — so inline is not
reachable by wiring the `raw` arm to a route.

**DECIDED: option D, "tracked raw execution."** Earlier drafts chose B (an ephemeral `scripts` row per
run); review killed it on three verified counts: F6's FK blocks hard-deleting a script any execution
references, so a reaper either orphans the FK or cannot run; soft-delete leaves customer content in
`scripts.content` indefinitely; and the `saved` arm activates `{{var.*}}` substitution the `raw` arm
does not (F7). A (content on the execution row) and C (no inline) are rejected too. D makes the row
*describe* an inline run without *storing* it:

- `script_executions.script_id` becomes **NULLABLE**; new columns `source`
  (`'saved'|'partner_api_inline'`, default `'saved'`), `inline_language`, `inline_sha256`,
  `inline_bytes` (size only).
- **Content is never written to `script_executions` or `scripts`.** It lives only in the command
  envelope: `sensitiveCommandPayload.ts` is extended so that for `source='partner_api_inline'` the
  `content` field is sealed exactly like `secretEnv` today — into the envelope mechanism and into
  `TERMINAL_PAYLOAD_STRIP_KEYS` — so it is encrypted at rest under the command+device AAD and erased
  at terminal state. That closes F20, a live gap for the whole raw path, not just ours.
- Dispatch keeps the **`raw` arm**, so `{{var.*}}` substitution stays off: document that an inline
  payload containing `{{var.something}}` reaches the device verbatim. No reaper, no ephemeral rows.

**Every reader must handle `script_id IS NULL`.** Found so far: the executions list/detail routes
(`routes/scripts.ts:1191,1279`) and their `scripts` join; `ExecutionHistory.tsx` /
`ScriptExecutionsPage.tsx` / `ExecutionDetails.tsx`; `scriptCancellation.ts`;
`reapStaleScriptExecutions`; the tenant export — each showing the inline label + sha256.

**Caps:** content ≤ 64 KiB (under the 100 KiB `bodyLimit`), language from the `script_language` enum,
`runAs` `system|user`; audit records the sha256, never the content. **STRICT-pattern acknowledgement
(F16) is unavailable to inline** — it is a per-saved-script column — so a STRICT-matching payload is
refused by the agent; Wave 1 surfaces that as `status:'failed'` naming the pattern, and the docs must
say so or integrators see an opaque failure on ordinary registry work.

## 7. Device listing additions (F12)

Minimal additive fields on the existing `GET /devices` record, no new endpoint:
`presence: { status: 'online'|'offline', lastSeenAt: iso|null }` and `agent: { version, id }`.
`presence.status` uses `resolveLivenessStatus(lastSeenAt, now)` (5-min threshold), **not**
`devices.status`, which also carries `maintenance`/`quarantined`/`updating`. New keys in a `.strict()`
envelope → `schemas.ts`, the DTO snapshot, and `exportSafety.classification.ts` change in one PR.

## 8. Per-org agent install (F13)

New `POST /organizations/:orgId/agent-install-links` (body `{ platform: 'windows'|'macos' }`). Scopes:
`enrollment-keys:write` (it mints a credential) **plus** `organizations:read`. Gated by
**`requirePartnerPrincipalCapability('installer_distribute')`**, not `requireCapability` — the latter
is a silent no-op here (F21), which would have made the trust gate look present while never firing.
Returns `data: { orgId, platform, downloadUrl (…/public-download/<platform>?h=<handle>), shortUrl,
command ("msiexec /i breeze-agent.msi /qn"), expiresAt, maxUsage }`.

Implementation wraps the existing child-key + download-handle machinery: extract the body of
`POST /:id/installer-link` into `services/installerLink.ts` and call it from both routes rather than
duplicating the TTL clamp, short-code allocation, and handle issuance. `POST` because it mints state —
`ISupportsTenantInstallToken` is getter-shaped on the ImmyBot side, but the PowerShell body can call
any verb, so the read/write split holds. Being non-GET it is covered by the write rate limiter and the
write-surface allowlist with no exception needed, and it charges **both** the per-principal and
per-partner mint buckets, the pair `POST /enrollment-keys` already charges (`provisioning.ts:686-705`)
— a partner admin can mint N principals, so per-principal alone is not a partner-level budget.

## 9. Security and tenancy

- **RLS / no cross-partner access by construction.** Execute handlers run in
  `withDbAccessContext(partnerScopedDbContext(principal), …)` per F4; the `script_executions` insert
  is policed by `breeze_has_org_access(org_id)`, which `breeze.accessible_org_ids` satisfies for
  exactly the partner's orgs, so cross-partner access fails **at the database**. `accessibleOrgIds`
  derives from `organizations.partner_id = principal.partnerId`, so another partner's device resolves
  to zero rows → `404`. Caveat: this covers rows the handler touches under RLS — it does **not** cover
  a service that deliberately leaves the context (F22), which is why the §4.3–4.5 cancel pre-check is
  a hard rule. `device_commands` stays system-scoped (agent WS path); `submitted_org_id` carries the org.
- **Rate limits.** Per F5 the general write ceiling is per **key**, so it is a floor, not the control.
  Execute additionally charges a new `rl:partner-script-execute:<principalId>` bucket (default
  **300/hour**, env `PARTNER_API_SCRIPT_EXECUTE_RATE_LIMIT`) **and** a per-partner bucket at 4× — both
  on every call, as `POST /enrollment-keys` already does, since a partner admin can mint N principals
  and N keys.
- **Audit.** `partner_api.script_execute`, `actorType:'api_key'`, `actorId: principal.keyId`,
  `resourceId: executionId`, details `{partnerId, principalId, deviceId, scriptId, source,
  inlineSha256, runAs, whenOffline, trustMode}` — never parameters, never content.
- **Actor attribution, dispatch and cancel.** F6 forces `triggered_by` NULL for a machine principal;
  F19's answer is a jsonb sidecar hardcoded to `ai_agent` on dispatch and **nothing at all on cancel**
  (`resolveCancelledBy` degrades to NULL, writes no sidecar). Promote both to columns rather than add
  a second `actorType` string: `actor_kind` (`'user'|'partner_service_principal'|'ai_agent'`) +
  `actor_id`, plus `cancelled_actor_kind` + `cancelled_actor_id` (bare uuids, no FK — they point across
  identity tables), backfilled `'user'` where the matching `*_by` is non-null. Columns win because
  `parameters` is `excludedOpen`, so a sidecar-only actor is invisible to tenant export — and cancel
  has no sidecar at all. Render "Partner API · &lt;principal&gt;" in `ExecutionHistory.tsx` /
  `ScriptExecutionsPage.tsx`, which show no actor column today. `trigger_type` gains `'api'`;
  `ALTER TYPE … ADD VALUE` needs its own migration file (`autoMigrate` wraps each file in a txn).

## 10. Data model and registration checklist

Every change below needs its CLAUDE.md cascade registrations in the **same PR**:

| Change | RLS shape | Registrations |
|---|---|---|
| `partner_script_execution_idempotency` (new) | Shape 1, direct `org_id` | `CORE_ORG_CASCADE_DELETE_ORDER`; `CORE_TENANT_EXPORT_POLICY`; auto-discovered by rls-coverage |
| `script_executions.script_id` → **NULLABLE** (option D) | unchanged | no list change, but **every reader must handle NULL** — see the reader inventory in §6 |
| `script_executions.source`, `.inline_language`, `.inline_sha256`, `.inline_bytes` | unchanged | `CORE_TENANT_EXPORT_POLICY`: all four `included` (sha256 is a digest, not a secret; no content column exists to classify) |
| `script_executions.actor_kind`, `.actor_id`, `.cancelled_actor_kind`, `.cancelled_actor_id`, `.stdout_truncated`, `.stderr_truncated` | unchanged | `CORE_TENANT_EXPORT_POLICY`, all six `included` |
| `trigger_type` += `'api'` | n/a | own migration file (§9) |
| **SQL scope allowlist** — forward-replace `public.breeze_valid_partner_service_principal_scopes` with the four execute scopes added, and extend the restricted-grant CHECK (currently `partner_service_principals_enrollment_key_write_restrictions_check`) to demand `expiresAt` + ≥1 CIDR for any execute scope too | n/a | `db/schema/partnerServicePrincipals.ts:50-58`; pattern: `migrations/2026-10-08-101600-enrollment-keys-scope.sql` |

**The scope migration is not optional:** `partnerServicePrincipalScopes.test.ts` parses the ARRAY from
whichever migration last replaced that function and asserts exact set equality with the TS union, so a
scope added in TypeScript alone reds that suite. Migrations must sort after the newest committed file (`ls apps/api/migrations/*.sql | sort | tail -1`
→ `2026-10-13-110000-scripts-security-acknowledgement.sql`): use e.g.
`2026-10-14-100000-partner-api-execute-scopes.sql` + `2026-10-14-100100-script-executions-inline.sql`,
never a `2026-09-…` prefix — shipped names run ahead of real time, and
`scripts/check-migration-naming.sh` (pre-commit + CI) rejects a file that does not sort last.

## 11. Testing

1. **Route tests, Drizzle mocks** (`routes/partnerApi/execute.test.ts`): scope AND-ing (`scripts:execute`
   alone 403s an inline body), script/inline XOR, 409 offline, `queue` yielding a `deliverBy`,
   idempotent replay returning the same `executionId`, truncation at the 256 KiB edge.
2. **Write-surface**: the four new non-GET routes are allowlisted; the canary still fails for a fifth.
3. **Integration, real Postgres** (`partnerApiExecute.integration.test.ts`): one principal executes
   across **two** member orgs; 404s on another partner's device; a forged `INSERT INTO
   script_executions` for that other org as `breeze_app` fails `42501`.
4. **Probation denial**: `enforce` + `trustState='probation'` → `403 partner_api_trust_denied` on script
   execution **and** on `POST /organizations/:id/agent-install-links`, the one
   `requirePartnerPrincipalCapability` guards and `requireCapability` would wave through (F21).
   `shadow` allows and records; positive control: a `trusted` partner, both requests, 201.
5. **Cross-partner cancel ⇒ 404**, asserting `cancelScriptExecution` was **never invoked** — a
   status-code-only assertion would pass even if the authorization-free service (F22) had run.
6. **Inline content never at rest**: at terminal state `device_commands.payload` holds no `content` key
   and no plaintext; no `scripts` row was created; mid-flight `content` is ciphertext only.
7. **Null `script_id` renders**: `source='partner_api_inline'` shows the inline label + `inline_sha256`
   in the executions list and detail UI, not a crash or blank name.
8. **Offline queue**: `queue` writes `deliver_by` within the cap and `submitted_org_id`; the reaper fails
   it `not_delivered_before_deadline`; with the flag off the same request 409s.
9. **DTO safety**: response schema `.strict()`, rejects an unreviewed key; the `exportSafety` exemption
   is asserted, not implicit. **Device listing**: an `updating` device seen a minute ago reports
   `presence.status='online'`.
10. **Scope contract**: `partnerServicePrincipalScopes.test.ts` passes (migration ARRAY ≡
    `PARTNER_SERVICE_PRINCIPAL_SCOPES`), plus an execute scope granted without `expiresAt`/CIDRs is
    rejected by the CHECK, not merely by the route.

## 12. Rollout

- **Wave 1 — scopes + endpoints.** Scope group + SQL scope migration + restricted-grant CHECK,
  `requirePartnerPrincipalCapability`, the four execute routes, `presence`/`agent` fields,
  `POST /organizations/:id/agent-install-links`, option-D inline columns + payload sealing, truncation
  flags, the actor columns + UI attribution, all of §11.
- **Wave 2 — ImmyBot script + docs.** Appendix A under `integrations/immybot/`, plus
  `reference/partner-api-execute.mdx`: scopes, MFA-at-grant, offline contract, caps, STRICT limits.

## 13. Decisions (all resolved)

1. **Inline model: option D, "tracked raw execution" (§6)** — REVERSES the earlier option-B choice on
   three verified defects (F6's FK blocks reaping, soft-delete retains content, the `saved` arm
   activates `{{var.*}}`); it also closes the pre-existing F20 plaintext gap. 2. **`whenOffline`
   defaults to `reject`** (§5). 3. **Install-link minting is `POST /organizations/:id/agent-install-links`** (§8).

## Appendix A — ImmyBot capability map

From immy.bot's "build your own integration" page (summarized, not executed) — **treat cmdlet
parameter names as unverified** until tested live. It documents no script-execution capability, so
run-script is called directly from the integration's own PowerShell.

| ImmyBot capability | Breeze endpoint |
|---|---|
| `ISupportsListingClients` | `GET /partner-api/organizations` (`organizations:read`) |
| `ISupportsListingAgents` | `GET /partner-api/devices` + new `presence`/`agent` fields (`devices:read`) |
| `ISupportsInventoryIdentification` | metascript matches on `hardwareIdentity.serialNumber` from the same export |
| `ISupportsTenantInstallToken` | `POST /partner-api/organizations/:id/agent-install-links` body `{platform:'windows'}` |
| run script / ephemeral-agent bootstrap | `POST /partner-api/devices/:id/script-executions` with `inline`, then poll `GET /partner-api/script-executions/:id` |
| agent deletion (offline agents) | `POST /partner-api/devices/:id/commands` `{type:'agent_uninstall'}` (`devices:execute`) |

```powershell
# Illustrative only — not a shipped script. Listing capabilities are the same shape over
# GET /organizations (New-IntegrationClient) and GET /devices (New-IntegrationAgent, mapping
# presence.status -> -IsOnline and agent.version -> -AgentVersion).
$Integration = New-DynamicIntegration -Init {
    param([Parameter(Mandatory)][string]$ApiEndpoint,
          [Parameter(Mandatory)][Security.SecureString]$ApiKey)
    $script:Base    = $ApiEndpoint.TrimEnd('/')
    $script:Headers = @{ 'X-API-Key' = (ConvertFrom-SecureString $ApiKey -AsPlainText) }
    function Invoke-Breeze($Method, $Path, $Body) {
        $a = @{ Method=$Method; Uri="$script:Base/api/v1/partner-api$Path"
                Headers=$script:Headers; ContentType='application/json' }
        if ($Body) { $a.Body = ($Body | ConvertTo-Json -Depth 6) }
        Invoke-RestMethod @a }
} -HealthCheck { (Invoke-Breeze GET '/organizations?limit=1') -ne $null }

$Integration | Add-DynamicIntegrationCapability -Interface ISupportsTenantInstallToken `
    -GetTenantInstallToken { param($ClientId)
        (Invoke-Breeze POST "/organizations/$ClientId/agent-install-links" @{ platform='windows' }).data.command }

# Ephemeral-agent bootstrap: inline payload, then poll to completion.
function Invoke-BreezeScript($DeviceId, $Content) {
    $run = Invoke-Breeze POST "/devices/$DeviceId/script-executions" @{
        inline = @{ content = $Content; language = 'powershell' }
        runAs = 'system'; timeoutSeconds = 900; whenOffline = 'reject' }
    do { Start-Sleep 5
         $r = (Invoke-Breeze GET "/script-executions/$($run.data.executionId)").data }
    while ($r.status -in @('pending','queued','running'))
    [pscustomobject]@{ ExitCode=$r.exitCode; Stdout=$r.output.stdout; Stderr=$r.output.stderr }
}
```

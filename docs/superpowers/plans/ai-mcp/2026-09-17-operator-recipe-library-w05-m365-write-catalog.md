---
tracking_issue: PENDING
---

# Operator Recipe Library — Wave M1: M365 Graph identity write catalog, verification probes, permission profile v2, consent UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eight new Microsoft 365 Graph write actions (`revoke_sessions`, `license.remove`, `license.assign`, `group.membership.remove`, `group.membership.add`, `intune.device.retire`, `user.create`, `user.mailbox.auto_reply`) are dispatchable end-to-end — from chat as ordinary Tier-3 four-eyes tools, and headlessly from the durable action-intents release worker — each with a typed read-side verification probe, a declared idempotency class, an app-role-aware refusal ladder, the `customer-graph-actions` permission profile bumped to v2 **once**, and a consent UX that tells the customer what v2 adds while v1 connections keep working for the two v1 actions.

**Architecture:** The wire contract stays schema-driven end to end. `packages/shared/src/m365/writeActions.ts` gains eight mutating arms plus one read-only *probe* arm on the same discriminated union, so the executor route (`POST /v1/execute-action`) and the internal-auth operation vocabulary are untouched. The actions executor's `MicrosoftGraphClient` gains `post` and `del` (it has only `readResource`/`readCollection`/`patch` today) and `executeGraphWriteAction` gains one `case` per action, each of which fails closed on a **pre-read** where the end state or the target's shape decides the answer (no license seat → `license_unavailable`; dynamic / role-assignable group → `unsupported_group_type`; already-not-a-member → `noop: true` with no DELETE). Verification runs on the READ side: seven of the eight probes are served by the `customer-graph-read` profile, which already holds every role they need, through a new org-keyed entry `executeM365ReadActionByOrg`; the eighth (auto-reply) cannot be — the read profile holds no `MailboxSettings.Read` — so it runs through the actions executor's probe arm. `services/m365ControlPlane/effectProbes.ts` exposes the single typed function the engine waves call, `probeM365Effect(actionId, args, ctx)`. `writeActionService` gains an app-role ladder that refuses a v2-only action on a v1 connection with the new typed code `consent_upgrade_required` (never `connection_not_ready`), and a `for-auth` entry so chat callers get the same ladder under their own RLS context. The web integrations card explains v2 in plain language, and a partner-scoped route lists every connection still on v1.

**Tech Stack:** TypeScript, zod (shared wire contracts), Hono (API + executor apps), Drizzle ORM, Vitest (unit + `vitest.integration.config.ts` against real Postgres), React + react-i18next (web).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-operator-recipe-library-design.md` — §7.1 (the eight actions, their Graph calls, app roles and classes), §7.2 (consent migration: one v2 bump, v1 keeps working, per-role readiness, partner view of v1 connections), §6.6 (probe → write → probe, idempotency classes, no executor-side dedup store), §4.1 (readiness inputs: `permission_manifest_version` against the profile version, `observed_grants` against required app roles), §10 row M1 (independent of E1–E4). Builds on `docs/superpowers/specs/integrations/2026-07-13-breeze-m365-control-plane-design.md` (§9.1 tiers, `m365.<domain>.<object>.<verb>` naming), `docs/superpowers/specs/integrations/2026-07-22-breeze-m365-customer-graph-actions-consent-design.md` (consent / re-consent path), `docs/superpowers/specs/ai-mcp/2026-07-19-m365-graph-actions-executor-design.md` (at-most-once, no dedup store).

**Feature tracking:** parent issue and wave sub-issue assigned by `register_feature` after all wave plans exist; branch `feature/<parent#>-operator-recipe-library/wave-<subissue#>`.

---

## Global Constraints

- **No database migration in this wave.** Every M1 change is code: the profile version and its required app roles live in `packages/shared/src/m365/profiles.ts`, and `m365_connections.permission_manifest_version` / `observed_grants` are existing columns written by the consent lifecycle. Therefore **no** `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`, `orgMergeRegistry.ts`, device/ticket org-move list, or `rls-coverage.integration.test.ts` edit applies. Do not invent one. If a later step appears to need a table, stop and report instead of adding a migration.
- **Rigor: high.** This is auth/consent/identity-destruction code. Every task is red-first: write the test, run it, *see it fail for the stated reason*, then implement, then run it green. A test that passes on first run is a defect in the test — fix the test before writing code.
- **Least privilege is a hard requirement (spec §7.1).** `GroupMember.ReadWrite.All`, never `Group.ReadWrite.All`. Intune **retire** only — `POST …/retire`. The executor must contain **no** `/wipe` path, and Task 3's test asserts the string `/wipe` appears nowhere in `apps/m365-graph-actions-executor/src/microsoft/writeActions.ts`.
- **App-role GUIDs are NOT to be invented.** For each new role, open Microsoft's published permissions reference (`https://learn.microsoft.com/en-us/graph/permissions-reference`), copy the application-permission id, and record the source URL in a code comment beside it. Task 4 gives candidate GUIDs marked `VERIFY` — each one must be checked against that page before the commit, and the comment updated to say it was verified. `Organization.Read.All` = `498476ce-e0fe-48b0-b801-37ba7e2685c6` is **already verified in-repo** (`packages/shared/src/m365/profiles.ts:159`, the `customer-graph-read` manifest) and may be copied as-is.
- **Registry sweep.** The complete set of places a new M365 write tool must be registered — established by `grep -rn 'm365_disable_user\|m365_reset_password' --include='*.ts' --include='*.tsx' .` and `grep -rn 'm365\.user\.disable' --include='*.ts' .` at planning time — is: `packages/shared/src/m365/writeActions.ts` (+`.test.ts`), `apps/m365-graph-actions-executor/src/microsoft/writeActions.ts` (+`.test.ts`), `apps/api/src/services/aiToolsM365.ts` (`m365ToolTiers` + handler), `apps/api/src/services/aiAgentSdkTools.ts` (`TOOL_TIERS` + `m365ToolDefinitions`), `apps/api/src/services/aiGuardrails.ts` (`TIER3_FOUR_EYES_TOOLS` + `TOOL_PERMISSIONS`), `apps/api/src/services/m365ToolsHeadless.ts` (`M365_HEADLESS_ACTIONS` + argument builder, parity test), `apps/api/src/services/actionIntents/secretBearingTools.ts` (`SECRET_BEARING_TOOLS`), `apps/api/src/services/actionIntents/resultSecrets.ts` (secret-bearing action ids), `apps/api/src/services/actionIntents/effectDigestCoverage.contract.test.ts` (`DELIBERATELY_UNPINNED`), `apps/api/src/services/aiAgentSdk.ts` (`M365_VERB` approval-card map), `apps/api/src/routes/approvals.ts` (`M365_MUTATION_TOOLS`), `apps/web/src/components/ai-risk/tierConfig.ts` (+ its parity test `apps/api/src/services/aiGuardrailsTierConfig.parity.test.ts`), and `apps/web/src/components/ai-risk/ApprovalHistoryFeed.tsx`. **Three files named in the brief need no list edit, only a comment refresh** — `apps/api/src/jobs/intentReleaseWorker.ts` (dispatch is generic through `isHeadlessM365Tool`, line 1284-1285; only the prose at 1183-1190 names the two tools), `apps/api/src/config/validate.ts:713` (a comment above `M365_GRAPH_ACTIONS_TOOLS_ENABLED`), and `apps/mobile/src/services/approvals.ts:36-37` (a doc comment on `customerTenant`). **`apps/api/src/services/aiAgents/agentToolCatalog.ts` must NOT be edited** — see Decision 2.
- **`packages/shared/src/m365/executorContracts.test.ts` needs no edit.** It covers `completeConsentRequestSchema` / `retestRequestSchema` / `executorFailureCodeSchema` only; the write-action contracts are pinned by `writeActions.test.ts`. Its `VERIFIED_RESULT.manifestVersion: 2` literal is the **read** profile's consent result shape and is unrelated to the actions profile bump. Verified by reading the file; do not "fix" it.
- **Tests:** file beside source. One file: `cd apps/api && npx vitest run src/path/file.test.ts` (never `pnpm --filter … test -- --run`; never a trailing-slash directory filter). Shared: `cd packages/shared && npx vitest run src/m365/writeActions.test.ts`. Executors: `cd apps/m365-graph-actions-executor && npx vitest run src/...`. Web: `cd apps/web && npx vitest run src/...`. Integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>` with a live stack (`pnpm test-stack up` at repo root; `pnpm test-stack down` when finished — nothing does this for you). Integration tests live **only** under `apps/api/src/__tests__/integration/`. A 0-test run is a stall, not green.
- **Typecheck:** `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`, plus `cd packages/shared && npx tsc --noEmit -p tsconfig.json` and the same in each executor app after touching it.
- **i18n:** every new web string needs a real translation in all eight locale directories — `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/integrations.json`. English copied into another locale is a failure.
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`); selected tab/row state uses `window.location.hash`, never a query param.
- **No secrets in logs, audit details or metrics.** `recordM365WriteActionEvent`'s `details` allowlist stays `{ actionType, outcome }`. The `m365.user.create` temporary password follows the `m365.user.reset_password` sealing path byte for byte.
- **Commits:** end every commit message with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Final task opens the PR with `Closes #<wave sub-issue>` and **STOPS** — never merge.

---

## Decisions recorded for the orchestrator

1. **The auto-reply probe runs on the ACTIONS executor, not the read executor.** `customer-graph-read` v3 (`profiles.ts:105-119`) holds no `MailboxSettings.Read`, so a read-side auto-reply probe would force a **second** re-consent on a second app registration — exactly what spec §7.2 ("v2 once, not once per action") forbids. The actions profile already needs `MailboxSettings.ReadWrite`, which subsumes the read. It therefore ships as a read-only arm on the write union (`m365.user.mailbox.auto_reply.state`) dispatched through the existing `/v1/execute-action` route. Consequences, all accepted and made explicit in code comments: it consumes the **write** budget, and it writes a `m365.customer_graph_actions.action_executed` audit row with `outcome: 'ok'`. The union member is exported as `M365_PROBE_ACTION_IDS`, kept **out of** `M365_WRITE_ACTION_IDS` and out of `M365WriteActionId`, so a probe can never be reached by a tool, an intent, or `M365_HEADLESS_ACTIONS` (whose value type is `M365WriteActionId`).
2. **The eight tools are session-only, exactly like `m365_disable_user`.** They go in `m365ToolTiers` (tier 3) and are declared in `m365ToolDefinitions()` with `makeSessionAwareHandler`; they are **not** registered into the shared `aiTools` map and therefore get **no** `agentToolCatalog.ts` `TOOL_CAPABILITY` entry and **no** `aiToolSchemasM365.ts` entry. This is forced by a real contract, not taste: `agentToolCatalog.contract.test.ts:20-46` asserts (a) `Object.keys(TOOL_CAPABILITY) === [...aiTools.keys()]` exactly and (b) every registered tool that is in `TOOL_TIERS` is agent-reachable, while `listAgentReachableTools()` (`agentToolCatalog.ts:365-374`) excludes everything in `m365ToolTiers` via `isSessionOnly`. Registry membership and `m365ToolTiers` membership are mutually exclusive by construction, and the headless parity test (`m365ToolsHeadless.test.ts:33-36`) pins `keys(M365_HEADLESS_ACTIONS) === tier-3 m365ToolTiers`. Being session-only costs the recipe nothing: the Operator coordinator mints action intents and the durable release worker dispatches them through `executeM365ToolHeadless` (spec §6.1 "reserve operation → mint or attach intent → dispatch via release worker"); the model never calls these tools.
3. **The handlers do not use the session.** Unlike the Delegant-backed `m365DisableUserHandler`, the new handlers take the org from `auth`/`input.orgId` and call the control-plane path (`executeM365WriteActionForAuth`). The `sessionId` parameter is accepted and ignored, so the `makeSessionAwareHandler` signature still fits. Delegant is not involved in any new action.
4. **The write budget is raised from 10/min · 100/day to 30/min · 300/day** (`writeActionBudget.ts:27-28`). One offboarding fans out ~9 M365 effects plus auto-reply probes inside a minute; at 10/min the recipe would rate-limit itself on its own first run.
5. **`consent_upgrade_required` refuses only on an authoritative observation.** The ladder refuses when `grantsVerifiedAt !== null` **and** a required role for the requested action is absent from `observed_grants`. When `grantsVerifiedAt === null` the connection has no authoritative grant observation and the call falls through to today's behaviour (attempt, and let Graph answer `graph_permission_missing`). Without that guard a never-reconciled v1 connection would start refusing `m365.user.disable`, which is precisely the "v1 keeps working" promise being broken.
6. **`unsupported_group_type` is decided by a pre-read inside the executor**, before any `DELETE`/`POST`. A group is unsupported when `groupTypes` contains `DynamicMembership` or `isAssignableToRole === true`. If the pre-read itself fails with `graph_permission_missing`, the action fails closed with that code and still issues no membership call. (`GroupMember.ReadWrite.All` is documented to allow listing groups and reading basic group properties — confirm in the lab run, Task 14; if it cannot read `isAssignableToRole`, the fix is a v3 bump adding `Group.Read.All`, filed as a follow-up, **not** a silent skip of the check.)
7. **`m365.user.license.assign` seat check is a pre-read of `/subscribedSkus`,** not a reaction to Graph's 400. Graph's "not enough licenses" surfaces as a generic `Request_BadRequest`, which is indistinguishable from a malformed body. Reading `prepaidUnits.enabled - consumedUnits <= 0` for each requested SKU and refusing with `license_unavailable` before the `POST` is deterministic, testable, and is what "fails closed on no available seat" means. This is why the actions profile needs `Organization.Read.All`.

---

## Exported surface other waves depend on

```ts
// packages/shared/src/m365/writeActions.ts
export const M365_WRITE_ACTION_IDS: readonly [...10 mutating ids];
export const M365_PROBE_ACTION_IDS: readonly ['m365.user.mailbox.auto_reply.state'];
export type M365WriteActionId   = typeof M365_WRITE_ACTION_IDS[number];
export type M365ProbeActionId   = typeof M365_PROBE_ACTION_IDS[number];
export type M365ExecutorActionId = M365WriteActionId | M365ProbeActionId;
export const M365_WRITE_ACTION_IDEMPOTENCY:
  Record<M365WriteActionId, 'idempotent' | 'idempotent_by_probe' | 'non_idempotent'>;
export const M365_WRITE_ACTION_REQUIRED_ROLES: Record<M365ExecutorActionId, readonly string[]>;

// apps/api/src/services/m365ControlPlane/effectProbes.ts
export type M365EffectProbeState = 'satisfied' | 'unsatisfied' | 'unknown';
export interface M365EffectProbeResult { state: M365EffectProbeState; observedAt: string; detail: string }
export interface M365EffectProbeContext { orgId: string; effectRequestedAt: Date; actorId?: string }
export function probeM365Effect(
  actionId: M365WriteActionId, args: M365WriteAction, ctx: M365EffectProbeContext,
): Promise<M365EffectProbeResult>;

// apps/api/src/services/m365ControlPlane/writeActionService.ts
export type M365WriteActionRefusalCode =
  'tools_disabled' | 'connection_not_ready' | 'consent_upgrade_required'
  | 'write_rate_limited' | 'executor_unavailable' | 'site_scope_denied' | 'org_context_required';
export function executeM365WriteActionForAuth(
  auth: AuthContext, action: M365WriteAction, inputOrgId?: string, auditRequest?: RequestLike,
): Promise<M365WriteActionServiceResult>;

// apps/api/src/services/m365ControlPlane/readActionService.ts
export function executeM365ReadActionByOrg(
  orgId: string, action: M365InteractiveReadAction, opts?: { actorId?: string },
): Promise<M365ReadActionServiceResult>;

// apps/api/src/services/m365ControlPlane/connectionService.ts
export function m365RoleReadiness(
  connection: Pick<M365ConnectionSnapshot, 'observedGrants' | 'grantsVerifiedAt' | 'permissionManifestVersion'>,
  profile: M365PermissionProfileManifest,
): Record<string, boolean>;
export function listStaleManifestConnectionsForPartner(
  profile: M365ConnectionProfile,
): Promise<StaleManifestConnection[]>;
```

---

### Task 1 — Graph client gains `post` and `del` on the actions executor

**Files**
- `apps/m365-graph-actions-executor/src/microsoft/graphClient.ts` (558 lines; `MicrosoftGraphClient` at :40-63 has `probeTenant`, `readResource`, `readCollection`, `patch` only; `patch`'s implementation is :526-556)
- `apps/m365-graph-actions-executor/src/microsoft/graphClient.test.ts`

**Interfaces**
- *Consumes:* `readBoundedBody`, `readFailure`, `graphUrl`, `failure`, `GraphClientError` (all already in the file).
- *Produces:*
  ```ts
  post(input: { accessToken: OpaqueAccessToken; path: string; body: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  del(input: { accessToken: OpaqueAccessToken; path: string }): Promise<void>;
  ```
  `post` returns the parsed JSON body when the response has one (Graph answers `201 Created` with the new user object for `POST /users`) and `null` on `204 No Content`. Named `del`, not `delete` — `delete` is a reserved word as a bare method name in some downstream mock object literals and reads badly at call sites.

**Steps**
- [ ] Add failing tests to `graphClient.test.ts`, mirroring the existing `patch` describe block:
  - `post` sends `method: 'POST'`, `content-type: application/json`, the serialized body, `redirect: 'error'`, and an `authorization: Bearer <token>` header.
  - `post` returns the parsed object on a 201 with a JSON body.
  - `post` returns `null` on a 204 with no body.
  - `post` maps 403 → `graph_permission_missing`, 404 → `graph_not_found`, 429 → `graph_throttled` with `retryAfterSeconds` from the `retry-after` header, other non-2xx → `graph_provider_rejected` (i.e. it goes through `readFailure`, exactly as `patch` does).
  - `post` maps an aborted request to `graph_request_timeout` and a thrown fetch to `graph_transport_failed`.
  - `post` rejects a path not starting with `/` with `graph_request_invalid`.
  - `del` sends `method: 'DELETE'` with no body, resolves on 204, and maps failures identically.
  - `del` treats **404 as a thrown `graph_not_found`** (the caller decides whether that is a no-op, not the transport).
- [ ] Run red: `cd apps/m365-graph-actions-executor && npx vitest run src/microsoft/graphClient.test.ts` — expect `post is not a function` / `del is not a function`.
- [ ] Extract the shared mutation body of `patch` into a local `async function mutate(method: 'PATCH' | 'POST' | 'DELETE', input, body?): Promise<string>` that returns the (bounded) response text, and re-implement `patch` on top of it so its behaviour is provably unchanged. Add `post` (parses the returned text as JSON when non-empty, else `null`) and `del` on top of the same helper. Keep the `configValid` / `accessToken` / `path.startsWith('/')` guard at the top of each public method.
- [ ] Add `post` and `del` to the `MicrosoftGraphClient` interface at :40-63.
- [ ] Run green: `cd apps/m365-graph-actions-executor && npx vitest run src/microsoft/graphClient.test.ts` (the pre-existing `patch` tests must still pass — that is the regression proof).
- [ ] `cd apps/m365-graph-actions-executor && npx tsc --noEmit -p tsconfig.json`
- [ ] Commit: `feat(m365-actions-executor): add post/del to the Graph client for the identity write catalog`

---

### Task 2 — Shared write-action contract: eight mutating arms, one probe arm, idempotency and required-role maps

**Files**
- `packages/shared/src/m365/writeActions.ts` (79 lines today)
- `packages/shared/src/m365/writeActions.test.ts`

**Interfaces**
- *Consumes:* nothing new.
- *Produces:* the exported surface listed above, plus the widened `m365WriteActionSchema` / `writeActionResultSchema` / `writeActionFailureCodeSchema`.

**Steps**
- [ ] Write the failing contract test first, in `packages/shared/src/m365/writeActions.test.ts`. Replace the existing `it('pins the action id list')` with:
  ```ts
  it('pins the mutating action id list', () => {
    expect([...M365_WRITE_ACTION_IDS]).toEqual([
      'm365.user.disable',
      'm365.user.reset_password',
      'm365.user.revoke_sessions',
      'm365.user.license.remove',
      'm365.user.license.assign',
      'm365.group.membership.remove',
      'm365.group.membership.add',
      'm365.intune.device.retire',
      'm365.user.create',
      'm365.user.mailbox.auto_reply',
    ]);
  });

  it('pins the probe action id list and keeps it disjoint from the write ids', () => {
    expect([...M365_PROBE_ACTION_IDS]).toEqual(['m365.user.mailbox.auto_reply.state']);
    for (const id of M365_PROBE_ACTION_IDS) {
      expect((M365_WRITE_ACTION_IDS as readonly string[]).includes(id)).toBe(false);
    }
  });

  it('classifies every mutating action for idempotency', () => {
    expect(M365_WRITE_ACTION_IDEMPOTENCY).toEqual({
      'm365.user.disable': 'idempotent',
      'm365.user.reset_password': 'non_idempotent',
      'm365.user.revoke_sessions': 'idempotent',
      'm365.user.license.remove': 'idempotent',
      'm365.user.license.assign': 'idempotent_by_probe',
      'm365.group.membership.remove': 'idempotent',
      'm365.group.membership.add': 'idempotent',
      'm365.intune.device.retire': 'idempotent',
      'm365.user.create': 'non_idempotent',
      'm365.user.mailbox.auto_reply': 'idempotent_by_probe',
    });
    expect(Object.keys(M365_WRITE_ACTION_IDEMPOTENCY).sort())
      .toEqual([...M365_WRITE_ACTION_IDS].sort());
  });

  it('names the app roles every executor action needs', () => {
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.disable']).toEqual(['User.ReadWrite.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.reset_password'])
      .toEqual(['User.ReadWrite.All', 'User-PasswordProfile.ReadWrite.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.license.assign'])
      .toEqual(['User.ReadWrite.All', 'Organization.Read.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.group.membership.remove'])
      .toEqual(['GroupMember.ReadWrite.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.intune.device.retire'])
      .toEqual(['DeviceManagementManagedDevices.PrivilegedOperations.All']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.mailbox.auto_reply'])
      .toEqual(['MailboxSettings.ReadWrite']);
    expect(M365_WRITE_ACTION_REQUIRED_ROLES['m365.user.mailbox.auto_reply.state'])
      .toEqual(['MailboxSettings.ReadWrite']);
    expect(Object.keys(M365_WRITE_ACTION_REQUIRED_ROLES).sort())
      .toEqual([...M365_WRITE_ACTION_IDS, ...M365_PROBE_ACTION_IDS].sort());
  });
  ```
  and add parse tests: every new arm accepts a minimal valid payload, rejects an extra key (`.strict()`), rejects a missing `reason` on each mutating arm, rejects a `skuIds` array of length 0 and of length 21, rejects a non-GUID `groupId`, rejects a `usageLocation` of `'USA'` (must be exactly two letters), rejects an `autoReply` arm whose `status` is `'scheduled'` but which omits `scheduledStartDateTime`, and — for the result schema — accepts one success body per arm and rejects `{ success: true, action: 'm365.user.create', userId: UUID }` without `temporaryPassword`.
- [ ] Run red: `cd packages/shared && npx vitest run src/m365/writeActions.test.ts`.
- [ ] Implement. Add these local schemas above `M365_WRITE_ACTION_IDS`:
  ```ts
  const skuIdsSchema = z.array(guidSchema).min(1).max(20);
  const displayTextSchema = z.string().min(1).max(256);
  // Exchange auto-reply bodies are HTML-capable and can be long; bounded so a
  // request can never exceed the executor's 16 KiB body cap (app.ts:18).
  const replyBodySchema = z.string().min(1).max(4000);
  const isoInstantSchema = z.string().datetime();
  // ISO 3166-1 alpha-2. Graph rejects anything else, and a license cannot be
  // assigned to a user with no usageLocation.
  const usageLocationSchema = z.string().regex(/^[A-Z]{2}$/);
  ```
- [ ] Replace the id list with the two exported lists and the derived types:
  ```ts
  export const M365_WRITE_ACTION_IDS = [
    'm365.user.disable',
    'm365.user.reset_password',
    'm365.user.revoke_sessions',
    'm365.user.license.remove',
    'm365.user.license.assign',
    'm365.group.membership.remove',
    'm365.group.membership.add',
    'm365.intune.device.retire',
    'm365.user.create',
    'm365.user.mailbox.auto_reply',
  ] as const;

  /**
   * Read-only arms carried on the SAME executor union and route as the writes.
   * Why they are not read-executor actions: the `customer-graph-read` profile
   * holds no MailboxSettings.Read, and adding it would force a SECOND customer
   * re-consent on a second app registration — which the consent migration
   * (spec §7.2) exists to avoid. Kept out of M365_WRITE_ACTION_IDS so a probe
   * id can never be an AI tool target, an action-intent action name, or a
   * value in M365_HEADLESS_ACTIONS.
   */
  export const M365_PROBE_ACTION_IDS = ['m365.user.mailbox.auto_reply.state'] as const;

  export type M365WriteActionId = typeof M365_WRITE_ACTION_IDS[number];
  export type M365ProbeActionId = typeof M365_PROBE_ACTION_IDS[number];
  export type M365ExecutorActionId = M365WriteActionId | M365ProbeActionId;
  ```
- [ ] Extend `m365WriteActionSchema` with these arms (keep the two existing arms first and unchanged):
  ```ts
    z.object({
      type: z.literal('m365.user.revoke_sessions'),
      userIdentifier: userIdOrUpnSchema,
      reason: reasonSchema,
    }).strict(),
    z.object({
      type: z.literal('m365.user.license.remove'),
      userIdentifier: userIdOrUpnSchema,
      skuIds: skuIdsSchema,
      reason: reasonSchema,
    }).strict(),
    z.object({
      type: z.literal('m365.user.license.assign'),
      userIdentifier: userIdOrUpnSchema,
      skuIds: skuIdsSchema,
      disabledPlanIds: z.array(guidSchema).max(50).optional(),
      reason: reasonSchema,
    }).strict(),
    z.object({
      type: z.literal('m365.group.membership.remove'),
      groupId: guidSchema,
      userIdentifier: userIdOrUpnSchema,
      reason: reasonSchema,
    }).strict(),
    z.object({
      type: z.literal('m365.group.membership.add'),
      groupId: guidSchema,
      userIdentifier: userIdOrUpnSchema,
      reason: reasonSchema,
    }).strict(),
    z.object({
      type: z.literal('m365.intune.device.retire'),
      // Intune managedDevice id. RETIRE only — full wipe is excluded from the
      // catalog by spec §7.1/D5 and has no arm here by design.
      managedDeviceId: guidSchema,
      reason: reasonSchema,
    }).strict(),
    z.object({
      type: z.literal('m365.user.create'),
      userPrincipalName: userIdOrUpnSchema,
      displayName: displayTextSchema,
      mailNickname: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
      usageLocation: usageLocationSchema,
      reason: reasonSchema,
    }).strict(),
    z.object({
      type: z.literal('m365.user.mailbox.auto_reply'),
      userIdentifier: userIdOrUpnSchema,
      status: z.enum(['disabled', 'alwaysEnabled', 'scheduled']),
      internalReplyMessage: replyBodySchema.optional(),
      externalReplyMessage: replyBodySchema.optional(),
      externalAudience: z.enum(['none', 'contactsOnly', 'all']).optional(),
      scheduledStartDateTime: isoInstantSchema.optional(),
      scheduledEndDateTime: isoInstantSchema.optional(),
      reason: reasonSchema,
    }).strict().refine(
      (value) => value.status !== 'scheduled'
        || (value.scheduledStartDateTime !== undefined && value.scheduledEndDateTime !== undefined),
      { message: 'scheduled auto-reply requires scheduledStartDateTime and scheduledEndDateTime' },
    ),
    z.object({
      type: z.literal('m365.user.mailbox.auto_reply.state'),
      userIdentifier: userIdOrUpnSchema,
    }).strict(),
  ```
  **Note for the implementer:** `z.discriminatedUnion` rejects a `ZodEffects` member, so the `.refine()`d auto-reply arm cannot sit inside the `discriminatedUnion` call. Build the union from the plain `.strict()` objects and apply the cross-field rule with a single `.superRefine` on the union instead:
  ```ts
  export const m365WriteActionSchema = z.discriminatedUnion('type', [ /* …plain arms… */ ])
    .superRefine((value, ctx) => {
      if (value.type === 'm365.user.mailbox.auto_reply'
        && value.status === 'scheduled'
        && (value.scheduledStartDateTime === undefined || value.scheduledEndDateTime === undefined)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scheduled auto-reply requires scheduledStartDateTime and scheduledEndDateTime',
        });
      }
    });
  ```
- [ ] Add the new failure codes to `writeActionFailureCodeSchema`, after `invalid_action`:
  ```ts
    // The target SKU has no free seat (prepaidUnits.enabled - consumedUnits <= 0),
    // determined by a /subscribedSkus pre-read — NO assignLicense call was made.
    'license_unavailable',
    // The group is dynamic-membership or role-assignable, so its members are not
    // directly editable. Determined by a group pre-read — NO members call was made.
    'unsupported_group_type',
    // The Intune managedDevice id does not resolve. Distinct from user_not_found
    // so a probe can tell "wrong device" from "wrong user".
    'device_not_found',
    // POST /users rejected the principal: the UPN is taken, or its domain is not
    // a verified domain on the tenant.
    'user_already_exists',
  ```
- [ ] Extend `writeActionResultSchema` with one success arm per new action (keep the failure arm last):
  ```ts
    z.object({ success: z.literal(true), action: z.literal('m365.user.revoke_sessions'), userId: guidSchema }).strict(),
    z.object({
      success: z.literal(true), action: z.literal('m365.user.license.remove'),
      userId: guidSchema, removedSkuIds: z.array(guidSchema), noop: z.boolean(),
    }).strict(),
    z.object({
      success: z.literal(true), action: z.literal('m365.user.license.assign'),
      userId: guidSchema, assignedSkuIds: z.array(guidSchema), noop: z.boolean(),
    }).strict(),
    z.object({
      success: z.literal(true), action: z.literal('m365.group.membership.remove'),
      userId: guidSchema, groupId: guidSchema, noop: z.boolean(),
    }).strict(),
    z.object({
      success: z.literal(true), action: z.literal('m365.group.membership.add'),
      userId: guidSchema, groupId: guidSchema, noop: z.boolean(),
    }).strict(),
    z.object({
      success: z.literal(true), action: z.literal('m365.intune.device.retire'),
      managedDeviceId: guidSchema,
    }).strict(),
    z.object({
      success: z.literal(true), action: z.literal('m365.user.create'),
      userId: guidSchema, userPrincipalName: z.string().min(3).max(320),
      temporaryPassword: z.string().min(1).max(256),
      forceChangeNextSignIn: z.literal(true),
    }).strict(),
    z.object({
      success: z.literal(true), action: z.literal('m365.user.mailbox.auto_reply'),
      userId: guidSchema, status: z.enum(['disabled', 'alwaysEnabled', 'scheduled']),
    }).strict(),
    z.object({
      success: z.literal(true), action: z.literal('m365.user.mailbox.auto_reply.state'),
      userId: guidSchema,
      status: z.enum(['disabled', 'alwaysEnabled', 'scheduled']),
      externalAudience: z.enum(['none', 'contactsOnly', 'all']),
      // Whether a message body is present at all — NEVER the body itself, which
      // may quote customer correspondence and has no business in an intent result.
      hasInternalReplyMessage: z.boolean(),
      hasExternalReplyMessage: z.boolean(),
      scheduledStartDateTime: z.string().datetime().nullable(),
      scheduledEndDateTime: z.string().datetime().nullable(),
    }).strict(),
  ```
- [ ] Add the two maps at the end of the file, each with a header comment citing spec §6.6 / §7.1:
  ```ts
  export const M365_WRITE_ACTION_IDEMPOTENCY: Record<M365WriteActionId, 'idempotent' | 'idempotent_by_probe' | 'non_idempotent'> = { /* as pinned by the test above */ };

  const GRAPH = 'https://learn.microsoft.com/en-us/graph/permissions-reference';
  /** App roles each executor action needs, by role VALUE (not GUID). Source: ${GRAPH}. */
  export const M365_WRITE_ACTION_REQUIRED_ROLES: Record<M365ExecutorActionId, readonly string[]> = {
    'm365.user.disable': ['User.ReadWrite.All'],
    'm365.user.reset_password': ['User.ReadWrite.All', 'User-PasswordProfile.ReadWrite.All'],
    'm365.user.revoke_sessions': ['User.ReadWrite.All'],
    'm365.user.license.remove': ['User.ReadWrite.All'],
    'm365.user.license.assign': ['User.ReadWrite.All', 'Organization.Read.All'],
    'm365.group.membership.remove': ['GroupMember.ReadWrite.All'],
    'm365.group.membership.add': ['GroupMember.ReadWrite.All'],
    'm365.intune.device.retire': ['DeviceManagementManagedDevices.PrivilegedOperations.All'],
    'm365.user.create': ['User.ReadWrite.All', 'User-PasswordProfile.ReadWrite.All'],
    'm365.user.mailbox.auto_reply': ['MailboxSettings.ReadWrite'],
    'm365.user.mailbox.auto_reply.state': ['MailboxSettings.ReadWrite'],
  };
  ```
  (`m365.user.create` needs the password role because `POST /users` carries a `passwordProfile`.)
- [ ] Run green: `cd packages/shared && npx vitest run src/m365/writeActions.test.ts`
- [ ] `cd packages/shared && npx tsc --noEmit -p tsconfig.json`. **Expect API/executor type errors elsewhere at this point** — `executeGraphWriteAction`'s `never` exhaustiveness check now fails, which is the intended red for Task 3. Do not patch them here.
- [ ] Commit: `feat(shared): M365 identity write catalog contract — 8 mutating actions, 1 probe arm, idempotency + role maps`

---

### Task 3 — Executor: implement the eight writes and the probe, with fail-closed pre-reads

**Files**
- `apps/m365-graph-actions-executor/src/microsoft/writeActions.ts` (100 lines today)
- `apps/m365-graph-actions-executor/src/microsoft/writeActions.test.ts`

**Interfaces**
- *Consumes:* `MicrosoftGraphClient.post/del/patch/readResource/readCollection` (Task 1), the widened `M365WriteAction` / `WriteActionResult` (Task 2), the existing `resolveUserId` and `mapGraphFailure`.
- *Produces:* `executeGraphWriteAction` handling every arm; a new exported `resolveUserIdentifier(identifier, ctx)` (the existing `resolveUserId` generalised to take a string, since several arms resolve a user that is not `action.userIdentifier`-shaped at the type level).

**Steps**
- [ ] Write the failing tests first in `writeActions.test.ts`, using the existing fake-graph-client style in that file. **Every one of these is a required test:**
  1. `revoke_sessions` resolves the user then `POST /users/{id}/revokeSignInSessions` with an empty body, and returns `{ success: true, action, userId }`.
  2. `license.remove` issues `POST /users/{id}/assignLicense` with `{ addLicenses: [], removeLicenses: [<skuIds>] }` and returns `removedSkuIds` equal to the requested ids, `noop: false`.
  3. `license.remove` **pre-reads** `/users/{id}?$select=id,assignedLicenses`; when none of the requested SKUs is assigned it returns `noop: true`, `removedSkuIds: []`, and **issues no POST** (assert the fake client recorded zero `post` calls).
  4. `license.assign` pre-reads `/subscribedSkus`; when the requested SKU has `prepaidUnits.enabled - consumedUnits <= 0` it returns `{ success: false, errorCode: 'license_unavailable' }` and **issues no POST**.
  5. `license.assign` pre-reads `/users/{id}?$select=id,assignedLicenses`; when the SKU is already assigned it returns `noop: true` and issues no POST (this is what makes it `idempotent_by_probe`).
  6. `license.assign` with a free seat issues `POST /users/{id}/assignLicense` with `{ addLicenses: [{ skuId, disabledPlans }], removeLicenses: [] }`.
  7. `group.membership.remove` pre-reads `/groups/{gid}?$select=id,groupTypes,isAssignableToRole`; a group whose `groupTypes` contains `'DynamicMembership'` returns `{ success: false, errorCode: 'unsupported_group_type' }` with **zero `del` calls**.
  8. Same for `isAssignableToRole: true`.
  9. `group.membership.remove` on a supported group where the member is absent (membership pre-read returns an empty collection) returns `{ success: true, …, noop: true }` with **zero `del` calls**.
  10. `group.membership.remove` on a present member issues `DELETE /groups/{gid}/members/{uid}/$ref` and returns `noop: false`.
  11. `group.membership.remove` where the `DELETE` itself throws `graph_not_found` returns `{ success: true, …, noop: true }` — a concurrent removal is the desired end state, not a failure.
  12. `group.membership.add` on a member who is already present returns `noop: true` with zero `post` calls; on an absent member it issues `POST /groups/{gid}/members/$ref` with body `{ '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/{uid}' }`.
  13. `group.membership.add` where the `POST` fails with a Graph `graph_provider_rejected` returns `{ success: false, errorCode: 'graph_error' }` (no silent success).
  14. `intune.device.retire` issues `POST /deviceManagement/managedDevices/{id}/retire` with an empty body; a 404 on that call maps to `device_not_found`, not `user_not_found`.
  15. `intune.device.retire` never constructs a `/wipe` path — assert `readFileSync(<writeActions.ts>, 'utf8').includes('/wipe') === false`.
  16. `user.create` issues `POST /users` with `accountEnabled: true`, `displayName`, `mailNickname`, `userPrincipalName`, `usageLocation`, and `passwordProfile: { forceChangePasswordNextSignIn: true, password: <generated> }`; returns `{ success: true, action, userId, userPrincipalName, temporaryPassword, forceChangeNextSignIn: true }` where `temporaryPassword` is 20 chars and is **not** any input value.
  17. `user.create` where the `POST` fails with a 400-class `graph_provider_rejected` returns `{ success: false, errorCode: 'user_already_exists' }`. (Rationale comment: `POST /users` has exactly two 400-class causes we can act on — a taken UPN and an unverified domain — and the request body is schema-validated before it leaves the API, so a 400 here is a principal conflict.)
  18. `user.create` does **no** pre-read and is never retried internally (assert exactly one `post` call on both the success and failure paths).
  19. `mailbox.auto_reply` issues `PATCH /users/{id}/mailboxSettings` with `{ automaticRepliesSetting: { status, externalAudience, internalReplyMessage, externalReplyMessage, scheduledStartDateTime: { dateTime, timeZone: 'UTC' }, scheduledEndDateTime: { … } } }`, omitting absent optional keys entirely.
  20. `mailbox.auto_reply.state` issues `readResource` on `/users/{id}/mailboxSettings` selecting `automaticRepliesSetting` and returns the projected probe result, with `hasInternalReplyMessage` / `hasExternalReplyMessage` booleans and **no message body** anywhere in the returned object (assert with `JSON.stringify(result).includes('<the fixture body text>') === false`).
  21. Every arm maps `GraphClientError('graph_throttled', 42)` to `{ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 42 }` (drive this as a table-driven loop over all ten action ids).
- [ ] Run red: `cd apps/m365-graph-actions-executor && npx vitest run src/microsoft/writeActions.test.ts`.
- [ ] Implement. Generalise the existing resolver and keep the old name as a thin wrapper so the two shipped arms are untouched:
  ```ts
  export async function resolveUserIdentifier(identifier: string, ctx: GraphWriteActionContext): Promise<string> {
    const resource = await ctx.graphClient.readResource({
      accessToken: ctx.accessToken,
      path: `/users/${encodeURIComponent(identifier)}`,
      select: ['id'],
    });
    const id = resource.id;
    if (typeof id !== 'string' || !id) throw new GraphClientError('graph_not_found');
    return id;
  }
  ```
- [ ] Add `mapGraphFailure` cases: `graph_license_required` → `graph_error` (the actions app never expects it), and add a second optional parameter `notFoundCode: WriteActionFailureCode = 'user_not_found'` so the Intune arm can pass `'device_not_found'`.
- [ ] Add one `case` per arm inside the existing `switch`. Keep the `default: { const exhaustive: never = action; … }` guard — it is the compile-time proof that every arm is handled.
- [ ] Add the three pre-read helpers above `executeGraphWriteAction`, each with a comment stating **why** it exists (spec §6.6 probe-before-write; fail closed):
  ```ts
  async function assignedSkuIds(userId: string, ctx: GraphWriteActionContext): Promise<Set<string>>;
  async function availableSeatSkuIds(skuIds: readonly string[], ctx: GraphWriteActionContext): Promise<Set<string>>;
  async function groupIsDirectlyEditable(groupId: string, ctx: GraphWriteActionContext): Promise<boolean>;
  async function isDirectMember(groupId: string, userId: string, ctx: GraphWriteActionContext): Promise<boolean>;
  ```
  `isDirectMember` uses `readCollection` on `/groups/{gid}/members` with `query: { '$select': 'id', '$filter': `id eq '${userId}'`, '$count': 'true' }`, `consistencyLevelEventual: true`, `maxItems: 1`, `maxPages: 1`. Record the Microsoft advanced-query doc URL (`https://learn.microsoft.com/en-us/graph/aad-advanced-queries`) in the comment. `userId` here is always a canonical GUID returned by `resolveUserIdentifier`, so splicing it into `$filter` is safe — say so in the comment, mirroring the note at `apps/m365-graph-read-executor/src/microsoft/readActions.ts:25-32`.
- [ ] Run green: `cd apps/m365-graph-actions-executor && npx vitest run src/microsoft/writeActions.test.ts && npx vitest run src/operations.test.ts src/app.test.ts`
- [ ] `cd apps/m365-graph-actions-executor && npx tsc --noEmit -p tsconfig.json`
- [ ] Commit: `feat(m365-actions-executor): implement the eight identity write actions and the auto-reply probe`

---

### Task 4 — `customer-graph-actions` profile v2 (one bump, all M1 roles)

**Files**
- `packages/shared/src/m365/profiles.ts` (:188-217 is the actions manifest)
- `packages/shared/src/m365/profiles.test.ts`
- `apps/m365-graph-actions-executor/src/microsoft/reconcile.test.ts`

**Interfaces**
- *Consumes:* nothing new. *Produces:* `M365_PERMISSION_PROFILES['customer-graph-actions'].version === 2` and five new `applicationPermissionAssignments`.

**Steps**
- [ ] Write the failing test in `profiles.test.ts`:
  ```ts
  it('customer-graph-actions is v2 and carries every M1 app role exactly once', () => {
    const profile = getM365PermissionProfile('customer-graph-actions');
    expect(profile.version).toBe(2);
    expect([...profile.applicationPermissions].sort()).toEqual([
      'DeviceManagementManagedDevices.PrivilegedOperations.All',
      'GroupMember.ReadWrite.All',
      'MailboxSettings.ReadWrite',
      'Organization.Read.All',
      'User-PasswordProfile.ReadWrite.All',
      'User.ReadWrite.All',
    ]);
    const assignments = profile.applicationPermissionAssignments ?? [];
    expect(assignments.map((g) => g.value).sort()).toEqual([...profile.applicationPermissions].sort());
    expect(new Set(assignments.map((g) => g.appRoleId)).size).toBe(assignments.length);
    for (const grant of assignments) {
      expect(grant.resourceApplicationId).toBe('00000003-0000-0000-c000-000000000000');
      expect(grant.appRoleId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('never requests Group.ReadWrite.All (least privilege, spec §7.1)', () => {
    expect(getM365PermissionProfile('customer-graph-actions').applicationPermissions)
      .not.toContain('Group.ReadWrite.All');
  });

  it('every role M365_WRITE_ACTION_REQUIRED_ROLES names is in the v2 manifest', () => {
    const held = new Set(getM365PermissionProfile('customer-graph-actions').applicationPermissions);
    for (const roles of Object.values(M365_WRITE_ACTION_REQUIRED_ROLES)) {
      for (const role of roles) expect(held.has(role)).toBe(true);
    }
  });

  it('reports every v1 connection as needing consent reconciliation', () => {
    expect(connectionNeedsConsentReconciliation('customer-graph-actions', 1)).toBe(true);
    expect(connectionNeedsConsentReconciliation('customer-graph-actions', 2)).toBe(false);
  });
  ```
- [ ] Run red: `cd packages/shared && npx vitest run src/m365/profiles.test.ts`.
- [ ] Implement: set `version: 2`, delete the roadmap comment block at :199-203, and write a v2 rationale comment in the style of the `customer-graph-read` v3 comment above it — naming Operator Recipe Library M1, saying the bump is **once for the whole identity catalog** so customers re-consent once, and stating the `GroupMember.ReadWrite.All` over `Group.ReadWrite.All` choice and the retire-only Intune choice.
- [ ] Add the five roles to `applicationPermissions` and the five assignments to `applicationPermissionAssignments`. **Before committing, open `https://learn.microsoft.com/en-us/graph/permissions-reference`, find each permission's application-permission id, and confirm or correct these candidates; then change the comment from `VERIFY` to `verified against <url> on <date>`:**
  ```ts
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    // VERIFY against https://learn.microsoft.com/en-us/graph/permissions-reference
    // (search "GroupMember.ReadWrite.All", Application id) before commit.
    appRoleId: '62a82d76-70ea-41e2-9197-370581804d09',
    value: 'GroupMember.ReadWrite.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    // VERIFY — https://learn.microsoft.com/en-us/graph/permissions-reference
    appRoleId: '5b07b0dd-2377-4e44-a38d-703f09a0dc3c',
    value: 'DeviceManagementManagedDevices.PrivilegedOperations.All',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    // VERIFY — https://learn.microsoft.com/en-us/graph/permissions-reference
    appRoleId: '6931bccd-447a-43d1-b442-00a195474933',
    value: 'MailboxSettings.ReadWrite',
  },
  {
    resourceApplicationId: MICROSOFT_GRAPH_RESOURCE_APPLICATION_ID,
    // Verified in-repo: identical GUID to the customer-graph-read manifest above.
    appRoleId: '498476ce-e0fe-48b0-b801-37ba7e2685c6',
    value: 'Organization.Read.All',
  },
  ```
  (`User.ReadWrite.All` and `User-PasswordProfile.ReadWrite.All` stay exactly as they are — do not touch their GUIDs.)
- [ ] Run green: `cd packages/shared && npx vitest run src/m365/profiles.test.ts src/m365/writeActions.test.ts`
- [ ] Add a reconcile test in `apps/m365-graph-actions-executor/src/microsoft/reconcile.test.ts`: an observation whose `observedGrants` are only the two v1 grants reconciles to `outcome: 'missing'` with `missingGrants` naming the four new roles and `manifestVersion: 2`. Run: `cd apps/m365-graph-actions-executor && npx vitest run src/microsoft/reconcile.test.ts`.
- [ ] Commit: `feat(shared): bump customer-graph-actions permission profile to v2 with the full M1 role set`

---

### Task 5 — Write-action service: role ladder, `consent_upgrade_required`, auth entry, budget

**Files**
- `apps/api/src/services/m365ControlPlane/writeActionService.ts` (193 lines)
- `apps/api/src/services/m365ControlPlane/writeActionService.test.ts`
- `apps/api/src/services/m365ControlPlane/connectionService.ts` (add `m365RoleReadiness` next to `deriveGrantHealth` at :140)
- `apps/api/src/services/m365ControlPlane/connectionService.test.ts`
- `apps/api/src/services/m365ControlPlane/writeActionMetrics.ts` (widen `M365WriteActionId` → `M365ExecutorActionId` at :16, :28, :56)
- `apps/api/src/services/m365ControlPlane/writeActionBudget.ts` (:27-28)
- `apps/api/src/services/m365ControlPlane/writeActionBudget.test.ts`

**Interfaces**
- *Consumes:* `M365_WRITE_ACTION_REQUIRED_ROLES` (Task 2), `M365_PERMISSION_PROFILES` (Task 4), `resolveWritableToolOrgId` (`services/aiTools.ts`), `dbAccessContextFromAuth` + `withDbAccessContext` (`middleware/auth`, `db`).
- *Produces:* `m365RoleReadiness`, `executeM365WriteActionForAuth`, the `consent_upgrade_required` refusal code.

**Steps**
- [ ] Write the failing tests first.

  In `connectionService.test.ts`:
  ```ts
  describe('m365RoleReadiness', () => {
    const v2 = getM365PermissionProfile('customer-graph-actions');

    it('reports true only for roles present in observed_grants', () => {
      const readiness = m365RoleReadiness({
        permissionManifestVersion: 1,
        grantsVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
        observedGrants: [
          { resourceApplicationId: GRAPH_APP, appRoleId: '204e0828-b5ca-4ad8-b9f3-f32a958e7cc4', value: 'User.ReadWrite.All' },
        ],
      }, v2);
      expect(readiness['User.ReadWrite.All']).toBe(true);
      expect(readiness['GroupMember.ReadWrite.All']).toBe(false);
    });

    it('is keyed by role VALUE and covers every role in the manifest', () => { /* keys === applicationPermissions */ });

    it('matches on appRoleId when the observed grant carries a null value', () => { /* value: null but the GUID matches -> true */ });

    it('reports every role false when there is no authoritative observation', () => {
      const readiness = m365RoleReadiness({ permissionManifestVersion: 2, grantsVerifiedAt: null, observedGrants: [] }, v2);
      expect(Object.values(readiness).every((ready) => ready === false)).toBe(true);
    });
  });
  ```

  In `writeActionService.test.ts` (it already mocks the executor client and `db`; follow the existing arrangement):
  ```ts
  it('refuses a v2-only action on a v1 connection with consent_upgrade_required, not connection_not_ready', async () => {
    // active connection, grantsVerifiedAt set, observed_grants = the two v1 roles
    const result = await executeM365WriteActionByOrg(ORG, {
      type: 'm365.group.membership.remove', groupId: GROUP, userIdentifier: 'a@b.com', reason: 'offboard',
    });
    expect(result).toMatchObject({ ok: false, code: 'consent_upgrade_required' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('still executes the two v1 actions on a v1 connection (re-consent is an upgrade, not an outage)', async () => {
    for (const action of [
      { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
      { type: 'm365.user.reset_password', userIdentifier: 'a@b.com', reason: 'x' },
    ] as const) {
      const result = await executeM365WriteActionByOrg(ORG, action);
      expect(result.ok).toBe(true);
    }
  });

  it('does NOT refuse when the connection has no authoritative grant observation', async () => {
    // grantsVerifiedAt: null, observed_grants: [] -> falls through to the executor
    const result = await executeM365WriteActionByOrg(ORG, { type: 'm365.group.membership.add', … });
    expect(executeWriteAction).toHaveBeenCalled();
  });

  it('audits a consent_upgrade_required refusal', async () => { /* recordM365WriteActionEvent called with outcome 'consent_upgrade_required' */ });

  it('executeM365WriteActionForAuth refuses a site-restricted session', async () => {
    const result = await executeM365WriteActionForAuth({ ...auth, allowedSiteIds: ['s1'] }, action);
    expect(result).toMatchObject({ ok: false, code: 'site_scope_denied' });
  });

  it('executeM365WriteActionForAuth refuses when no org can be resolved', async () => {
    expect(await executeM365WriteActionForAuth(partnerAuthWithNoOrg, action))
      .toMatchObject({ ok: false, code: 'org_context_required' });
  });

  it('executeM365WriteActionForAuth opens a db access context from the auth (never a system context)', async () => {
    await executeM365WriteActionForAuth(auth, action);
    expect(withDbAccessContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
  ```

  In `writeActionBudget.test.ts`: assert `M365_WRITE_ACTIONS_PER_MINUTE === 30` and `M365_WRITE_ACTIONS_PER_DAY === 300`, and that the 31st call in a minute is denied.
- [ ] Run red: `cd apps/api && npx vitest run src/services/m365ControlPlane/connectionService.test.ts src/services/m365ControlPlane/writeActionService.test.ts src/services/m365ControlPlane/writeActionBudget.test.ts`
- [ ] Implement `m365RoleReadiness` in `connectionService.ts`, directly beneath `deriveGrantHealth`:
  ```ts
  /**
   * Per-app-role readiness from `observed_grants` (spec §4.1, §7.2): the input
   * the recipe library uses to degrade an effect to a human-work step instead of
   * failing a whole task. Keyed by role VALUE so callers name roles the way the
   * manifest and Microsoft's consent screen do.
   *
   * `grantsVerifiedAt === null` means no authoritative observation exists, and
   * every role reports false. Callers must NOT turn that into a refusal on its
   * own — see the ladder in writeActionService.
   */
  export function m365RoleReadiness(
    connection: Pick<M365ConnectionSnapshot, 'observedGrants' | 'grantsVerifiedAt' | 'permissionManifestVersion'>,
    profile: M365PermissionProfileManifest,
  ): Record<string, boolean> {
    const authoritative = connection.grantsVerifiedAt !== null;
    const observedValues = new Set(connection.observedGrants.map((g) => g.value).filter((v): v is string => typeof v === 'string'));
    const observedRoleIds = new Set(connection.observedGrants.map((g) => canonicalGrantKey(g)));
    const readiness: Record<string, boolean> = {};
    for (const grant of profile.applicationPermissionAssignments ?? []) {
      readiness[grant.value] = authoritative
        && (observedValues.has(grant.value) || observedRoleIds.has(canonicalGrantKey(grant)));
    }
    return readiness;
  }
  ```
- [ ] In `writeActionService.ts`:
  - Add `'consent_upgrade_required'` to `M365WriteActionRefusalCode`, and widen it with `'site_scope_denied' | 'org_context_required'` for the auth entry.
  - Add the ladder step **between** the readiness check (line 119-130) and the budget check (132):
    ```ts
    // Spec §7.2: a v1 connection keeps working for the v1 actions; a v2-only
    // action refuses with its OWN code so the UI can offer re-consent instead
    // of telling the operator the tenant is disconnected. Only refuses on an
    // AUTHORITATIVE observation (grantsVerifiedAt set) — a never-reconciled
    // connection falls through and lets Graph answer, which is what keeps
    // every shipped v1 connection executing unchanged.
    if (ready.grantsVerifiedAt !== null) {
      const readiness = m365RoleReadiness(ready, getM365PermissionProfile(PROFILE));
      const missing = (M365_WRITE_ACTION_REQUIRED_ROLES[action.type] ?? [])
        .filter((role) => readiness[role] !== true);
      if (missing.length > 0) {
        recordM365WriteActionEvent(
          opts?.auditRequest ?? requestLikeFromSnapshot({}),
          { orgId, connectionId: ready.id, actionType: action.type, outcome: 'consent_upgrade_required', actorId: opts?.actorId },
        );
        return {
          ok: false,
          code: 'consent_upgrade_required',
          message: 'This Microsoft 365 action needs permissions the customer has not consented to yet. Re-consent Microsoft 365 for this organization.',
        };
      }
    }
    ```
  - Add `'consent_upgrade_required'` to `M365WriteActionOutcome` in `writeActionMetrics.ts` and widen the three `M365WriteActionId` occurrences there to `M365ExecutorActionId`.
  - Add `executeM365WriteActionForAuth`, which does the site/org/context work and then delegates to the existing function body:
    ```ts
    /**
     * Chat-path entry for the typed Graph write actions. Mirrors
     * readActionService.executeM365ReadAction's ladder (site scope -> org
     * resolution -> own RLS context) and then runs the same ladder as
     * executeM365WriteActionByOrg. Opening the context here — and never a
     * system context — is what keeps a chat write inside the caller's tenant.
     */
    export async function executeM365WriteActionForAuth(
      auth: AuthContext,
      action: M365WriteAction,
      inputOrgId?: string,
      auditRequest?: RequestLike,
    ): Promise<M365WriteActionServiceResult> {
      if (auth.allowedSiteIds) {
        return { ok: false, code: 'site_scope_denied', message: 'Microsoft 365 actions are not available to site-restricted sessions.' };
      }
      const resolved = resolveWritableToolOrgId(auth, inputOrgId);
      if (!resolved.orgId) {
        return { ok: false, code: 'org_context_required', message: resolved.error ?? 'Organization context required' };
      }
      return withDbAccessContext(
        dbAccessContextFromAuth(auth),
        () => executeM365WriteActionByOrg(resolved.orgId as string, action, {
          actorId: auth.user.id,
          ...(auditRequest ? { auditRequest } : {}),
        }),
      );
    }
    ```
  - Add `license_unavailable`, `unsupported_group_type`, `device_not_found`, `user_already_exists` to `FAILURE_MESSAGES` (the record is total over `WriteActionFailureCode`, so `tsc` fails without them):
    ```ts
    license_unavailable: 'No Microsoft 365 licence seat is available for the requested subscription.',
    unsupported_group_type: 'This group\'s membership is managed by Microsoft 365 (dynamic or role-assignable) and cannot be edited directly.',
    device_not_found: 'The target Intune managed device was not found.',
    user_already_exists: 'A Microsoft 365 user already exists with that sign-in name, or its domain is not verified on this tenant.',
    ```
- [ ] Raise the budget constants to `30` / `300` with a comment naming the offboarding fan-out (~9 effects plus probes in one minute) as the reason.
- [ ] Run green: the three test files above, then `cd apps/api && npx vitest run src/services/m365ControlPlane/`
- [ ] Commit: `feat(api): M365 write ladder gains a per-role consent check and an auth-scoped entry`

---

### Task 6 — Read-side probe surface: new read action and projection fields

**Files**
- `packages/shared/src/m365/readActions.ts` (:13-19 id list, :55-67 field map, :127-179 branches)
- `packages/shared/src/m365/readActions.test.ts`
- `apps/m365-graph-read-executor/src/microsoft/readActions.ts` (:84-262 switch)
- `apps/m365-graph-read-executor/src/microsoft/readActions.test.ts`

**Interfaces**
- *Consumes:* the read executor's `MicrosoftGraphClient` (`readCollection` already supports `consistencyLevelEventual`).
- *Produces:* read action id `m365.group.member.get`; `m365.user.get` also projects `signInSessionsValidFromDateTime`.

**Steps**
- [ ] Write the failing tests first.

  In `packages/shared/src/m365/readActions.test.ts`:
  - `M365_INTERACTIVE_READ_ACTION_IDS` contains `'m365.group.member.get'` (appended after `'m365.group.members.list'`).
  - `M365_READ_ACTION_FIELDS['m365.group.member.get']` equals `['id', 'displayName', 'userPrincipalName', 'mail']`.
  - `M365_READ_ACTION_FIELDS['m365.user.get']` contains `'signInSessionsValidFromDateTime'`.
  - The schema accepts `{ type: 'm365.group.member.get', groupId: GUID, userId: GUID }` and rejects a non-GUID `userId`, an extra key, and a missing `userId`.

  In `apps/m365-graph-read-executor/src/microsoft/readActions.test.ts`:
  - `m365.group.member.get` calls `readCollection` with `path: '/groups/<gid>/members'`, `query['$filter'] === "id eq '<uid>'"`, `query['$count'] === 'true'`, `consistencyLevelEventual: true`, `maxItems: 1`, `maxPages: 1`.
  - It returns `{ success: true, kind: 'collection', items: [], truncated: false }` when the member is absent, and a one-item collection when present.
  - `m365.user.get` selects `signInSessionsValidFromDateTime` (assert the `select` array passed to `readResource`).
- [ ] Run red: `cd packages/shared && npx vitest run src/m365/readActions.test.ts` and `cd apps/m365-graph-read-executor && npx vitest run src/microsoft/readActions.test.ts`.
- [ ] Implement in shared: append `'m365.group.member.get'` to `M365_INTERACTIVE_READ_ACTION_IDS`; add the field entry; add `'signInSessionsValidFromDateTime'` to the end of the `m365.user.get` field list with a comment — *"the only observable evidence that a session revoke landed: Graph exposes no 'sessions are gone' fact, only the instant before which tokens are invalid (spec §6.6)"*; add the branch:
  ```ts
  z.object({
    type: z.literal('m365.group.member.get'),
    groupId: guidSchema,
    // Always a canonical object id (never a UPN): a probe addresses the
    // immutable id the effect was dispatched against.
    userId: guidSchema,
  }).strict(),
  ```
- [ ] Implement in the read executor: a `case 'm365.group.member.get'` returning `projectedCollection(...)` exactly as described in the test. Keep the `never` exhaustiveness default.
- [ ] Run green: both test files, plus `cd apps/m365-graph-read-executor && npx vitest run src/ && npx tsc --noEmit -p tsconfig.json`, plus `cd packages/shared && npx vitest run src/m365/`.
- [ ] Commit: `feat(m365-read-executor): targeted group-membership read and revoke-sessions evidence field for effect probes`

---

### Task 7 — `executeM365ReadActionByOrg` (org-keyed read entry for probes)

**Files**
- `apps/api/src/services/m365ControlPlane/readActionService.ts` (add beside `executeM365ReadAction` at :336)
- `apps/api/src/services/m365ControlPlane/readActionService.test.ts`

**Interfaces**
- *Consumes:* `connectionExecutionSnapshot` (:124), `callGraphReadExecutor` (:217), `isM365GraphReadToolsEnabledForOrg`, `connectionNotReadyState`.
- *Produces:*
  ```ts
  export async function executeM365ReadActionByOrg(
    orgId: string,
    action: M365InteractiveReadAction,
    opts?: { actorId?: string },
  ): Promise<M365ReadActionServiceResult>;
  ```

**Steps**
- [ ] Failing tests in `readActionService.test.ts`:
  - refuses `tools_disabled` when the org flag is off, without touching the database;
  - refuses `connection_not_ready` when no `customer-graph-read` row exists;
  - loads the connection under the **ambient** context — assert `withDbAccessContext` is NOT called and `withSystemDbAccessContext` is NOT called (this mirrors `executeM365WriteActionByOrg`'s contract at `writeActionService.ts:74-97`, and is why a probe caller must already hold a context);
  - refuses a sync action id with `tools_disabled` (`isM365SyncActionId` guard);
  - on a ready connection, calls `callGraphReadExecutor` with `route: 'read'` and the passed `actorId`.
- [ ] Run red: `cd apps/api && npx vitest run src/services/m365ControlPlane/readActionService.test.ts`.
- [ ] Implement. Copy the body of `executeM365ReadAction` from the flag check onward, dropping the `auth`/site/org-resolution prologue and replacing the `withDbAccessContext(...)` wrapper with a bare `db.select()`, with this header comment:
  ```ts
  /**
   * Org-keyed read entry, for callers that already hold a db access context and
   * have no live auth — the Operator's effect probes (effectProbes.ts) and any
   * background verification. Mirrors writeActionService.executeM365WriteActionByOrg
   * exactly: the connection load runs under the AMBIENT context, never a system
   * context, because a contextless read is a denial rather than a bypass and a
   * system context would bypass RLS outright.
   */
  ```
- [ ] Run green; then `cd apps/api && npx vitest run src/services/m365ControlPlane/`
- [ ] Commit: `feat(api): org-keyed M365 Graph read entry for effect verification probes`

---

### Task 8 — `effectProbes.ts`: `probeM365Effect`

**Files**
- `apps/api/src/services/m365ControlPlane/effectProbes.ts` (new)
- `apps/api/src/services/m365ControlPlane/effectProbes.test.ts` (new)

**Interfaces**
- *Consumes:* `executeM365ReadActionByOrg` (Task 7), `executeM365WriteActionByOrg` (for the auto-reply probe arm only), `M365_WRITE_ACTION_IDEMPOTENCY`, `M365WriteAction`.
- *Produces:* `M365EffectProbeState`, `M365EffectProbeResult`, `M365EffectProbeContext`, `probeM365Effect` (signatures in "Exported surface" above).

**The eight criteria, verbatim — this table is the contract the engine waves read:**

| Action | Probe call | `satisfied` when | `unsatisfied` when | `unknown` when |
|---|---|---|---|---|
| `m365.user.revoke_sessions` | `m365.user.get` on `userIdentifier` | `signInSessionsValidFromDateTime` parses and is `>= ctx.effectRequestedAt` | it parses and is `< effectRequestedAt`, or is absent from the projection | any read refusal/failure |
| `m365.user.license.remove` | `m365.user.get` | none of `skuIds` appears in `assignedLicenses[].skuId` | any does | read failed, or `assignedLicenses` absent |
| `m365.user.license.assign` | `m365.user.get` | every `skuId` appears in `assignedLicenses[].skuId` | any is missing | as above |
| `m365.group.membership.remove` | `m365.group.member.get` | the collection is empty | the collection has an item | read failed |
| `m365.group.membership.add` | `m365.group.member.get` | the collection has an item | it is empty | read failed |
| `m365.intune.device.retire` | `m365.intune.device.get` | the read fails with `graph_not_found` — retire unenrols the device and Intune deletes the `managedDevice` record | the record is returned | any other failure |
| `m365.user.create` | `m365.user.get` on `userPrincipalName` | a resource with an `id` is returned | the read fails with `graph_not_found` | any other failure |
| `m365.user.mailbox.auto_reply` | `m365.user.mailbox.auto_reply.state` via `executeM365WriteActionByOrg` | returned `status` equals the requested `status` **and**, when the request set `externalAudience`, that matches too | either differs | the call refused or failed |

**Steps**
- [ ] Write `effectProbes.test.ts` first, mocking `./readActionService` and `./writeActionService`. Required cases:
  - one `satisfied` and one `unsatisfied` case per action id (16 assertions), driven from a table so adding an action id without a probe is a compile error (`Record<M365WriteActionId, ProbeCase>`);
  - **the honest-criterion test**: `revoke_sessions` with `signInSessionsValidFromDateTime` one second BEFORE `effectRequestedAt` is `unsatisfied`, and with the field absent is `unsatisfied`, never `satisfied`; and the returned `detail` contains the phrase `signInSessionsValidFromDateTime` so an operator reading the timeline sees what was actually observed;
  - `intune.device.retire` maps `graph_not_found` to `satisfied` and `graph_throttled` to `unknown`;
  - every read refusal code (`connection_not_ready`, `read_rate_limited`, `executor_unavailable`, `tools_disabled`) yields `unknown`, never `satisfied` — a probe that cannot observe must never claim success (spec §6.6);
  - `probeM365Effect('m365.user.disable', …)` — an action with no probe in the table — throws, rather than returning a default (there are ten write ids and eight probes; `m365.user.disable` and `m365.user.reset_password` are handled too, so in fact the table is total: add rows for them — `disable` probes `m365.user.get` and is `satisfied` when `accountEnabled === false`; `reset_password` has **no observable end state**, so it returns `unknown` with detail `'a password reset has no observable end state; verification is the operator receiving the credential'`);
  - `detail` is never longer than 500 characters and never contains a `temporaryPassword` value;
  - `observedAt` is an ISO-8601 instant produced from the injectable clock.
- [ ] Run red: `cd apps/api && npx vitest run src/services/m365ControlPlane/effectProbes.test.ts`.
- [ ] Implement. Keep it under 300 lines, one small function per action id, dispatched through a `Record<M365WriteActionId, ProbeFn>` so `tsc` fails the moment Task 2's id list grows again:
  ```ts
  type ProbeFn = (args: M365WriteAction, ctx: M365EffectProbeContext, now: () => Date) => Promise<M365EffectProbeResult>;
  const PROBES: Record<M365WriteActionId, ProbeFn> = { /* … */ };

  export async function probeM365Effect(
    actionId: M365WriteActionId,
    args: M365WriteAction,
    ctx: M365EffectProbeContext,
    now: () => Date = () => new Date(),
  ): Promise<M365EffectProbeResult> {
    if (args.type !== actionId) {
      throw new Error(`probeM365Effect: action id ${actionId} does not match args.type ${args.type}`);
    }
    return PROBES[actionId](args, ctx, now);
  }
  ```
  Add a file header stating: probes are **read-only**; a probe never mutates; `unknown` is the only answer when observation fails; and that `m365.user.mailbox.auto_reply` is the one probe that consumes the *write* budget and writes an `action_executed` audit row, with Decision 1's reason.
- [ ] Run green; then `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
- [ ] Commit: `feat(api): probeM365Effect — typed read-side verification for every M365 identity write`

---

### Task 9 — Register the eight tools across every registry

**Files (in edit order)**
1. `apps/api/src/services/aiToolsM365.ts` — `m365ToolTiers` (:46-52) and eight new handlers
2. `apps/api/src/services/aiAgentSdkTools.ts` — `TOOL_TIERS` (:325-331) and `m365ToolDefinitions` (:930-970)
3. `apps/api/src/services/aiGuardrails.ts` — `TIER3_FOUR_EYES_TOOLS` (:405-406) and `TOOL_PERMISSIONS` (:1197-1198)
4. `apps/api/src/services/m365ToolsHeadless.ts` — `M365_HEADLESS_ACTIONS` (:24-27) and a per-tool argument builder
5. `apps/api/src/services/actionIntents/secretBearingTools.ts` (:24-27)
6. `apps/api/src/services/actionIntents/resultSecrets.ts` (:32)
7. `apps/api/src/services/actionIntents/effectDigestCoverage.contract.test.ts` (:91)
8. `apps/api/src/services/aiAgentSdk.ts` — `M365_VERB` (:328-331)
9. `apps/api/src/routes/approvals.ts` — `M365_MUTATION_TOOLS` (:1484)
10. `apps/web/src/components/ai-risk/tierConfig.ts` and `apps/web/src/components/ai-risk/ApprovalHistoryFeed.tsx` (:32)
11. Comment-only: `apps/api/src/jobs/intentReleaseWorker.ts` (:1183-1190), `apps/api/src/config/validate.ts` (:713), `apps/mobile/src/services/approvals.ts` (:36-37), `apps/api/src/services/aiTools.ts` (:432)

**Tool-name ↔ action-id map (the single source both the tests and the code use):**

| Tool | Action id | Secret-bearing |
|---|---|---|
| `m365_revoke_sessions` | `m365.user.revoke_sessions` | no |
| `m365_remove_license` | `m365.user.license.remove` | no |
| `m365_assign_license` | `m365.user.license.assign` | no |
| `m365_remove_from_group` | `m365.group.membership.remove` | no |
| `m365_add_to_group` | `m365.group.membership.add` | no |
| `m365_retire_intune_device` | `m365.intune.device.retire` | no |
| `m365_create_user` | `m365.user.create` | **yes** |
| `m365_set_auto_reply` | `m365.user.mailbox.auto_reply` | no |

**Steps**
- [ ] Write the failing tests first:
  - `m365ToolsHeadless.test.ts`: the existing parity test (`keys(M365_HEADLESS_ACTIONS) === tier-3 m365ToolTiers`) already covers drift — add a case pinning the exact ten-entry map, and one per new tool asserting `executeM365ToolHeadless` builds the right typed action from captured arguments (e.g. `m365_remove_from_group` with `{ groupId, userIdentifier, reason }` reaches `executeM365WriteActionByOrg` with `{ type: 'm365.group.membership.remove', groupId, userIdentifier, reason }`), plus one case per tool asserting that **invalid captured arguments return a JSON error body and never call the service**.
  - `aiGuardrails.m365.test.ts`: each of the eight resolves `checkGuardrails(tool, {}).tier === 3` and `approvalScope === 'four_eyes'`, and `TOOL_PERMISSIONS[tool]` is `{ resource: 'm365', action: 'execute' }`.
  - `actionIntents/secretBearingTools.test.ts`: `isSecretBearingTool('m365_create_user') === true`, and `isSecretBearingTool('m365_revoke_sessions') === false`.
  - `aiToolsM365.test.ts`: a handler test per tool — a missing `reason` returns `missing_reason`; a service refusal is surfaced verbatim as an error string; `m365CreateUserHandler` returns a `SecretToolResult` whose `llmText` does **not** contain the temporary password and whose `secrets.temporaryPassword` does.
  - `aiAgentSdk.m365risk.test.ts`: `buildM365RiskSummary` returns a non-null string for each of the eight (i.e. `M365_VERB` has an entry).
  - `jobs/intentReleaseWorker.durable.contract.test.ts` and `actionIntents/effectDigestCoverage.contract.test.ts` will go red on their own once the tools exist — that is expected and is the point of step 7 below.
- [ ] Run red: `cd apps/api && npx vitest run src/services/m365ToolsHeadless.test.ts src/services/aiGuardrails.m365.test.ts src/services/aiToolsM365.test.ts src/services/actionIntents/secretBearingTools.test.ts`
- [ ] **(1)** In `aiToolsM365.ts`: add the eight to `m365ToolTiers` at tier 3 with a comment separating "Delegant-backed helpdesk writes" from "control-plane identity writes (Operator Recipe Library M1)". Add one handler per tool, all following this shape (they take `_sessionId` and ignore it — Decision 3):
  ```ts
  /** Control-plane identity writes (M1). Unlike the Delegant-backed helpdesk
   *  handlers above, these never resolve a session or a Delegant connection:
   *  the org comes from the caller's auth (or an explicit orgId) and the whole
   *  authz ladder lives in executeM365WriteActionForAuth. */
  async function runWrite(
    auth: AuthContext, input: Record<string, unknown>, action: M365WriteAction,
  ): Promise<string> {
    const result = await executeM365WriteActionForAuth(auth, action, inputOrgId(input));
    return result.ok
      ? JSON.stringify(result.result)
      : errorString(result.code, result.message);
  }

  export async function m365RevokeSessionsHandler(
    input: Record<string, unknown>, auth: AuthContext, _sessionId: string,
  ): Promise<string> {
    const reason = requireString(input, 'reason');
    if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
    const userIdentifier = requireString(input, 'userIdentifier');
    if (!userIdentifier) return errorString('missing_user', 'A user identifier (UPN or object id) is required.');
    const parsed = m365WriteActionSchema.safeParse({ type: 'm365.user.revoke_sessions', userIdentifier, reason });
    if (!parsed.success) return errorString('invalid_arguments', 'Invalid parameters for this Microsoft 365 action.');
    return runWrite(auth, input, parsed.data);
  }
  ```
  `m365CreateUserHandler` returns `SecretToolResult` instead, following `m365ResetPasswordHandler` (:245-288) exactly: the credential goes in `secrets.temporaryPassword` and **never** in `llmText`.
- [ ] **(2)** In `aiAgentSdkTools.ts`: add the eight to `TOOL_TIERS` at 3 beside the existing two; add eight `tool(...)` declarations inside `m365ToolDefinitions()` with `makeSessionAwareHandler`, each description ending in "Requires approval." and carrying the real zod shape, e.g.:
  ```ts
  tool(
    'm365_remove_from_group',
    'Remove a Microsoft 365 user from a group. Does not work on dynamic-membership or role-assignable groups, which Microsoft manages. Requires approval.',
    { groupId: z.string().uuid(), userIdentifier: z.string(), reason: z.string(), orgId: uuid.optional() },
    makeSessionAwareHandler('m365_remove_from_group', getAuth, getActiveSession, m365RemoveFromGroupHandler, onPreToolUse, onPostToolUse)
  ),
  ```
  `m365_set_auto_reply` takes `{ userIdentifier, status: z.enum(['disabled','alwaysEnabled','scheduled']), internalReplyMessage: z.string().optional(), externalReplyMessage: z.string().optional(), externalAudience: z.enum(['none','contactsOnly','all']).optional(), scheduledStartDateTime: z.string().optional(), scheduledEndDateTime: z.string().optional(), reason, orgId? }`; `m365_create_user` takes `{ userPrincipalName, displayName, mailNickname, usageLocation, reason, orgId? }`; `m365_retire_intune_device` takes `{ managedDeviceId: z.string().uuid(), reason, orgId? }` with a description saying explicitly **"Retires the device (removes company data and unenrols it). This is not a full wipe and Breeze cannot perform one."**
- [ ] **(3)** In `aiGuardrails.ts`: append the eight tool names to `TIER3_FOUR_EYES_TOOLS` right after `'m365_disable_user', 'm365_reset_password',` with a comment *"Identity / account control — M365 control-plane identity catalog (Operator Recipe Library M1, spec §7.1): all Tier 3, all four-eyes"*; add eight `{ resource: 'm365', action: 'execute' }` entries to `TOOL_PERMISSIONS` beside the existing pair.
- [ ] **(4)** In `m365ToolsHeadless.ts`: extend `M365_HEADLESS_ACTIONS` with the eight entries, and replace the hardcoded `{ type, userIdentifier, reason }` construction (:66-70) with a typed builder:
  ```ts
  /** Tool name -> the typed action body built from the intent's CAPTURED
   *  arguments. Every field is read explicitly; nothing is spread, so a stale
   *  or attacker-influenced extra key can never reach Graph (the schema is
   *  .strict(), which turns a spread into a parse failure instead). */
  function buildWriteAction(actionId: M365WriteActionId, input: Record<string, unknown>): unknown {
    switch (actionId) {
      case 'm365.user.disable':
      case 'm365.user.reset_password':
      case 'm365.user.revoke_sessions':
        return { type: actionId, userIdentifier: input.userIdentifier, reason: input.reason };
      case 'm365.user.license.remove':
        return { type: actionId, userIdentifier: input.userIdentifier, skuIds: input.skuIds, reason: input.reason };
      case 'm365.user.license.assign':
        return {
          type: actionId, userIdentifier: input.userIdentifier, skuIds: input.skuIds,
          ...(input.disabledPlanIds === undefined ? {} : { disabledPlanIds: input.disabledPlanIds }),
          reason: input.reason,
        };
      case 'm365.group.membership.remove':
      case 'm365.group.membership.add':
        return { type: actionId, groupId: input.groupId, userIdentifier: input.userIdentifier, reason: input.reason };
      case 'm365.intune.device.retire':
        return { type: actionId, managedDeviceId: input.managedDeviceId, reason: input.reason };
      case 'm365.user.create':
        return {
          type: actionId, userPrincipalName: input.userPrincipalName, displayName: input.displayName,
          mailNickname: input.mailNickname, usageLocation: input.usageLocation, reason: input.reason,
        };
      case 'm365.user.mailbox.auto_reply':
        return {
          type: actionId, userIdentifier: input.userIdentifier, status: input.status,
          ...(input.internalReplyMessage === undefined ? {} : { internalReplyMessage: input.internalReplyMessage }),
          ...(input.externalReplyMessage === undefined ? {} : { externalReplyMessage: input.externalReplyMessage }),
          ...(input.externalAudience === undefined ? {} : { externalAudience: input.externalAudience }),
          ...(input.scheduledStartDateTime === undefined ? {} : { scheduledStartDateTime: input.scheduledStartDateTime }),
          ...(input.scheduledEndDateTime === undefined ? {} : { scheduledEndDateTime: input.scheduledEndDateTime }),
          reason: input.reason,
        };
      default: {
        const exhaustive: never = actionId;
        throw new Error(`buildWriteAction: unhandled ${String(exhaustive)}`);
      }
    }
  }
  ```
  Add `'consent_upgrade_required'` to `CONNECTION_UNAVAILABLE_CODES` (:35-40) — nothing was dispatched to Graph, so it must fail closed as connection-unavailable rather than burn the intent as a terminal tool error, exactly like `connection_not_ready`. Add a test asserting this.
- [ ] **(5)** `SECRET_BEARING_TOOLS` gains `'m365_create_user'`.
- [ ] **(6)** In `resultSecrets.ts`, replace `const SECRET_BEARING_ACTION = 'm365.user.reset_password';` with
  ```ts
  const SECRET_BEARING_ACTIONS: ReadonlySet<string> = new Set([
    'm365.user.reset_password',
    // M1: POST /users carries a passwordProfile, so a created user's temporary
    // credential is sealed on exactly the same path as a reset.
    'm365.user.create',
  ]);
  ```
  and change the guard at :38 to `if (typeof result.action !== 'string' || !SECRET_BEARING_ACTIONS.has(result.action)) return result;`. Add a `resultSecrets.test.ts` case sealing an `m365.user.create` result.
- [ ] **(7)** In `effectDigestCoverage.contract.test.ts:91`, extend the `sharedReason([...])` list to all ten tool names and widen the reason text to *"the target is a Microsoft Graph user, group or Intune device object"*.
- [ ] **(8)** `M365_VERB` gains: `m365_revoke_sessions: 'Revoke all M365 sessions for'`, `m365_remove_license: 'Remove M365 licences from'`, `m365_assign_license: 'Assign M365 licences to'`, `m365_remove_from_group: 'Remove from M365 group'`, `m365_add_to_group: 'Add to M365 group'`, `m365_retire_intune_device: 'Retire Intune device for'`, `m365_create_user: 'Create M365 user'`, `m365_set_auto_reply: 'Set M365 auto-reply for'`. Update the doc comment above it (it says "the two M365 mutation tools").
- [ ] **(9)** `M365_MUTATION_TOOLS` becomes the ten-name set; update its comment likewise.
- [ ] **(10)** `tierConfig.ts`: add eight `ToolEntry` rows to the Tier 3 `tools` list under category `'Integrations'`, `name` exactly the bare tool name (the parity test parses it and runs `checkGuardrails`). `ApprovalHistoryFeed.tsx:32`: add the eight names to the M365 tool list there.
- [ ] **(11)** Refresh the four comments listed above so none of them still claims there are exactly two M365 mutation tools.
- [ ] Run green, in this order:
  ```
  cd apps/api && npx vitest run src/services/m365ToolsHeadless.test.ts src/services/aiToolsM365.test.ts src/services/aiGuardrails.m365.test.ts src/services/actionIntents/secretBearingTools.test.ts src/services/actionIntents/resultSecrets.test.ts
  cd apps/api && npx vitest run src/services/aiGuardrailsTierConfig.parity.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/actionIntents/effectDigestCoverage.contract.test.ts src/jobs/intentReleaseWorker.durable.contract.test.ts src/services/aiToolNames.test.ts
  cd apps/web && npx vitest run src/components/ai-risk/
  cd apps/mobile && npx vitest run src/screens/approvals/
  ```
  `agentToolCatalog.contract.test.ts` must stay green **without an edit to `agentToolCatalog.ts`** — if it goes red, the tools were registered into the shared `aiTools` map by mistake (Decision 2); fix the registration, not the test.
- [ ] `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
- [ ] Commit: `feat(api): register the eight M365 identity write tools across every guardrail, approval and headless registry`

---

### Task 10 — Consent migration proof: v1 keeps working, v2-only refuses with its own code

**Files**
- `apps/api/src/__tests__/integration/m365ConsentUpgradeLadder.integration.test.ts` (new)

**Interfaces** — *Consumes:* `executeM365WriteActionByOrg`, `connectionNeedsConsentReconciliation`, `m365RoleReadiness`, the integration test helpers already used by `apps/api/src/__tests__/integration/` (`withSystemDbAccessContext` seeding + `withDbAccessContext` execution). *Produces:* nothing.

**Steps**
- [ ] Write the failing integration test first. It must run against real Postgres (`vitest.integration.config.ts`) and must be placed in `apps/api/src/__tests__/integration/` — a file anywhere else runs zero tests. Cases:
  1. Seed org A with an `m365_connections` row: `profile = 'customer-graph-actions'`, `status = 'active'`, `permission_manifest_version = 1`, `grants_verified_at = now()`, `observed_grants` = the two v1 grants. Assert `connectionNeedsConsentReconciliation('customer-graph-actions', 1) === true`.
  2. Under org A's RLS context, `executeM365WriteActionByOrg(orgA, { type: 'm365.user.disable', … })` reaches the executor client (stubbed) — **v1 keeps working**.
  3. Same for `m365.user.reset_password`.
  4. `executeM365WriteActionByOrg(orgA, { type: 'm365.group.membership.remove', … })` returns `{ ok: false, code: 'consent_upgrade_required' }` and **never** `'connection_not_ready'`. Assert the code explicitly with `expect(result.code).toBe('consent_upgrade_required')` — a `not.toBe('connection_not_ready')` alone would pass on any other refusal.
  5. Seed org B with `permission_manifest_version = 2`, `grants_verified_at = now()`, `observed_grants` = all six v2 grants. All ten actions reach the executor.
  6. Seed org C with `grants_verified_at = null`. Every action reaches the executor (Decision 5 — no authoritative observation is not a refusal).
  7. `m365RoleReadiness` on org A's row reports `{ 'User.ReadWrite.All': true, 'GroupMember.ReadWrite.All': false, … }`.
  8. Cross-tenant: under org B's context, a read of org A's connection returns zero rows (RLS still holds through the new code path).
- [ ] Run red: `pnpm test-stack up` at the repo root, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/m365ConsentUpgradeLadder.integration.test.ts`.
- [ ] Fix whatever the red exposes in Task 5's ladder (no new production code should be needed if Task 5 is correct — if it is, that is the regression proof).
- [ ] Run green. Leave the stack up for Task 14; it is torn down there.
- [ ] Commit: `test(api): prove v1 M365 connections keep working and v2-only actions refuse with consent_upgrade_required`

---

### Task 11 — Web: the M365 actions card explains what v2 adds

**Files**
- `apps/web/src/components/integrations/M365CustomerGraphActionsCard.tsx` (661 lines)
- `apps/web/src/components/integrations/M365CustomerGraphActionsCard.test.tsx`
- `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/integrations.json`

**Interfaces** — *Consumes:* the existing `Envelope` (`connection.manifestVersion` vs `connection.currentManifestVersion` already distinguish v1 from v2; `profile.requiredGrants` already carries the v2 role list). *Produces:* no new API surface.

**Steps**
- [ ] Failing tests in `M365CustomerGraphActionsCard.test.tsx`:
  - when `connection.manifestVersion < connection.currentManifestVersion`, the card renders a `data-testid="m365-actions-upgrade-notice"` block, and the primary button reads the "Re-consent" label;
  - that block lists one plain-language purpose line per **new** role (the roles in `profile.requiredGrants` whose `value` is not one of the two v1 values), each with `data-testid="m365-actions-v2-purpose"`;
  - when `manifestVersion === currentManifestVersion` the notice is absent;
  - the purpose list renders a real translated sentence, not the raw role value (assert the rendered text does **not** equal `'GroupMember.ReadWrite.All'` and does contain the English purpose sentence);
  - a role in `requiredGrants` with no purpose key falls back to `m365CustomerGraphActions.v2.purpose.unknown` and still renders (no blank row).
- [ ] Run red: `cd apps/web && npx vitest run src/components/integrations/M365CustomerGraphActionsCard.test.tsx`
- [ ] Implement. Add above the component:
  ```ts
  const V1_ROLE_VALUES = new Set(['User.ReadWrite.All', 'User-PasswordProfile.ReadWrite.All']);
  /** Role value -> i18n key suffix. Role values contain dots, which i18next
   *  reads as key nesting, so they can never be used as keys directly. */
  const ROLE_PURPOSE_KEY: Record<string, string> = {
    'User.ReadWrite.All': 'userReadWrite',
    'User-PasswordProfile.ReadWrite.All': 'userPasswordProfile',
    'GroupMember.ReadWrite.All': 'groupMember',
    'DeviceManagementManagedDevices.PrivilegedOperations.All': 'intunePrivileged',
    'MailboxSettings.ReadWrite': 'mailboxSettings',
    'Organization.Read.All': 'organizationRead',
  };
  ```
  and render the notice between the `errorCopy` paragraph (:588-590) and the connection `<dl>` (:592), gated on `connection && connection.manifestVersion < connection.currentManifestVersion`.
- [ ] Add these keys under `m365CustomerGraphActions` in **`en/integrations.json`**, then real translations in the other seven:
  ```json
  "v2": {
    "title": "Re-consent needed for the identity actions",
    "intro": "This tenant consented to an earlier permission set. Re-consenting keeps everything that works today and adds the permissions below. Nothing changes for the customer until an administrator approves the new consent.",
    "keepsWorking": "Disabling a user and resetting a password keep working on the current consent.",
    "purpose": {
      "userReadWrite": "Read and update user accounts — used to disable sign-in, revoke sessions, change licences and create a new user.",
      "userPasswordProfile": "Set a user's password — used to issue a temporary password on a reset or a new account.",
      "groupMember": "Read groups and change who is in them — used to add and remove group memberships. It cannot create or delete a group.",
      "intunePrivileged": "Retire an Intune-managed device — removes company data and unenrols the device. Breeze never performs a full wipe.",
      "mailboxSettings": "Read and set mailbox settings — used to turn an automatic reply on or off and to confirm it took effect.",
      "organizationRead": "Read the tenant's subscription inventory — used to check a licence seat is free before assigning one.",
      "unknown": "Used by a Microsoft 365 action in Breeze."
    }
  }
  ```
  **de-DE** `v2.title`: "Erneute Zustimmung für die Identitätsaktionen erforderlich"; `intro`: "Dieser Tenant hat einem älteren Berechtigungssatz zugestimmt. Eine erneute Zustimmung behält alles bei, was heute funktioniert, und ergänzt die unten aufgeführten Berechtigungen. Für den Kunden ändert sich nichts, bis ein Administrator die neue Zustimmung erteilt."; `keepsWorking`: "Benutzer deaktivieren und Kennwort zurücksetzen funktionieren weiterhin mit der aktuellen Zustimmung."; `purpose.userReadWrite`: "Benutzerkonten lesen und ändern – zum Sperren der Anmeldung, Widerrufen von Sitzungen, Ändern von Lizenzen und Anlegen neuer Benutzer."; `purpose.userPasswordProfile`: "Kennwort eines Benutzers setzen – zum Ausstellen eines temporären Kennworts bei einer Zurücksetzung oder einem neuen Konto."; `purpose.groupMember`: "Gruppen lesen und deren Mitglieder ändern – zum Hinzufügen und Entfernen von Gruppenmitgliedschaften. Gruppen können damit weder erstellt noch gelöscht werden."; `purpose.intunePrivileged`: "Ein Intune-verwaltetes Gerät außer Betrieb nehmen – entfernt Firmendaten und hebt die Registrierung auf. Breeze führt niemals eine vollständige Löschung durch."; `purpose.mailboxSettings`: "Postfacheinstellungen lesen und setzen – zum Ein- und Ausschalten der automatischen Antwort und zur Bestätigung der Wirkung."; `purpose.organizationRead`: "Das Abonnementinventar des Tenants lesen – zur Prüfung freier Lizenzplätze vor der Zuweisung."; `purpose.unknown`: "Wird von einer Microsoft-365-Aktion in Breeze verwendet."
  **fr-FR** (and **fr-CA**, same text) `v2.title`: "Nouveau consentement requis pour les actions d'identité"; `intro`: "Ce locataire a consenti à un ensemble d'autorisations antérieur. Un nouveau consentement conserve tout ce qui fonctionne aujourd'hui et ajoute les autorisations ci-dessous. Rien ne change pour le client tant qu'un administrateur n'a pas approuvé le nouveau consentement."; `keepsWorking`: "Désactiver un utilisateur et réinitialiser un mot de passe continuent de fonctionner avec le consentement actuel."; `purpose.userReadWrite`: "Lire et modifier les comptes utilisateur — pour bloquer la connexion, révoquer les sessions, modifier les licences et créer un utilisateur."; `purpose.userPasswordProfile`: "Définir le mot de passe d'un utilisateur — pour émettre un mot de passe temporaire lors d'une réinitialisation ou d'un nouveau compte."; `purpose.groupMember`: "Lire les groupes et modifier leurs membres — pour ajouter et retirer des appartenances. Ne permet ni de créer ni de supprimer un groupe."; `purpose.intunePrivileged`: "Mettre hors service un appareil géré par Intune — supprime les données d'entreprise et annule l'inscription. Breeze n'effectue jamais d'effacement complet."; `purpose.mailboxSettings`: "Lire et définir les paramètres de boîte aux lettres — pour activer ou désactiver une réponse automatique et vérifier son effet."; `purpose.organizationRead`: "Lire l'inventaire des abonnements du locataire — pour vérifier qu'un poste de licence est libre avant l'attribution."; `purpose.unknown`: "Utilisé par une action Microsoft 365 dans Breeze."
  **es-419** `v2.title`: "Se necesita volver a dar consentimiento para las acciones de identidad"; `intro`: "Este inquilino dio su consentimiento a un conjunto de permisos anterior. Volver a dar consentimiento conserva todo lo que funciona hoy y agrega los permisos siguientes. Nada cambia para el cliente hasta que un administrador apruebe el nuevo consentimiento."; `keepsWorking`: "Deshabilitar un usuario y restablecer una contraseña siguen funcionando con el consentimiento actual."; `purpose.userReadWrite`: "Leer y actualizar cuentas de usuario: se usa para bloquear el inicio de sesión, revocar sesiones, cambiar licencias y crear un usuario."; `purpose.userPasswordProfile`: "Establecer la contraseña de un usuario: se usa para emitir una contraseña temporal en un restablecimiento o una cuenta nueva."; `purpose.groupMember`: "Leer grupos y cambiar quién pertenece a ellos: se usa para agregar y quitar membresías. No puede crear ni eliminar un grupo."; `purpose.intunePrivileged`: "Retirar un dispositivo administrado por Intune: elimina los datos de la empresa y cancela la inscripción. Breeze nunca realiza un borrado completo."; `purpose.mailboxSettings`: "Leer y establecer la configuración del buzón: se usa para activar o desactivar una respuesta automática y confirmar que se aplicó."; `purpose.organizationRead`: "Leer el inventario de suscripciones del inquilino: se usa para comprobar que hay un puesto de licencia libre antes de asignarlo."; `purpose.unknown`: "Lo usa una acción de Microsoft 365 en Breeze."
  **it-IT** `v2.title`: "È necessario un nuovo consenso per le azioni sulle identità"; `intro`: "Questo tenant ha acconsentito a un set di autorizzazioni precedente. Un nuovo consenso mantiene tutto ciò che funziona oggi e aggiunge le autorizzazioni elencate di seguito. Per il cliente non cambia nulla finché un amministratore non approva il nuovo consenso."; `keepsWorking`: "Disabilitare un utente e reimpostare una password continuano a funzionare con il consenso attuale."; `purpose.userReadWrite`: "Leggere e aggiornare gli account utente: serve per bloccare l'accesso, revocare le sessioni, modificare le licenze e creare un utente."; `purpose.userPasswordProfile`: "Impostare la password di un utente: serve per emettere una password temporanea in una reimpostazione o per un nuovo account."; `purpose.groupMember`: "Leggere i gruppi e modificarne i membri: serve per aggiungere e rimuovere le appartenenze. Non consente di creare o eliminare un gruppo."; `purpose.intunePrivileged`: "Ritirare un dispositivo gestito da Intune: rimuove i dati aziendali e annulla la registrazione. Breeze non esegue mai una cancellazione completa."; `purpose.mailboxSettings`: "Leggere e impostare le impostazioni della cassetta postale: serve per attivare o disattivare una risposta automatica e verificarne l'effetto."; `purpose.organizationRead`: "Leggere l'inventario delle sottoscrizioni del tenant: serve per verificare che una postazione di licenza sia libera prima di assegnarla."; `purpose.unknown`: "Usato da un'azione Microsoft 365 in Breeze."
  **pt-BR** `v2.title`: "É necessário consentir novamente para as ações de identidade"; `intro`: "Este locatário consentiu com um conjunto de permissões anterior. Consentir novamente mantém tudo o que funciona hoje e acrescenta as permissões abaixo. Nada muda para o cliente até que um administrador aprove o novo consentimento."; `keepsWorking`: "Desativar um usuário e redefinir uma senha continuam funcionando com o consentimento atual."; `purpose.userReadWrite`: "Ler e atualizar contas de usuário — usado para bloquear o login, revogar sessões, alterar licenças e criar um usuário."; `purpose.userPasswordProfile`: "Definir a senha de um usuário — usado para emitir uma senha temporária numa redefinição ou numa conta nova."; `purpose.groupMember`: "Ler grupos e alterar quem pertence a eles — usado para adicionar e remover associações. Não permite criar nem excluir um grupo."; `purpose.intunePrivileged`: "Desativar um dispositivo gerenciado pelo Intune — remove os dados da empresa e cancela o registro. O Breeze nunca faz uma limpeza completa."; `purpose.mailboxSettings`: "Ler e definir as configurações da caixa de correio — usado para ligar ou desligar uma resposta automática e confirmar o efeito."; `purpose.organizationRead`: "Ler o inventário de assinaturas do locatário — usado para verificar se há uma licença livre antes de atribuí-la."; `purpose.unknown`: "Usado por uma ação do Microsoft 365 no Breeze."
  **tr-TR** `v2.title`: "Kimlik işlemleri için yeniden onay gerekiyor"; `intro`: "Bu kiracı daha önceki bir izin kümesine onay verdi. Yeniden onay, bugün çalışan her şeyi korur ve aşağıdaki izinleri ekler. Bir yönetici yeni onayı vermeden müşteri için hiçbir şey değişmez."; `keepsWorking`: "Kullanıcıyı devre dışı bırakma ve parola sıfırlama mevcut onayla çalışmaya devam eder."; `purpose.userReadWrite`: "Kullanıcı hesaplarını okuma ve güncelleme — oturum açmayı engellemek, oturumları iptal etmek, lisansları değiştirmek ve yeni kullanıcı oluşturmak için kullanılır."; `purpose.userPasswordProfile`: "Kullanıcı parolası belirleme — sıfırlamada veya yeni hesapta geçici parola vermek için kullanılır."; `purpose.groupMember`: "Grupları okuma ve üyelerini değiştirme — grup üyeliği eklemek ve kaldırmak için kullanılır. Grup oluşturamaz veya silemez."; `purpose.intunePrivileged`: "Intune ile yönetilen bir cihazı hizmetten çıkarma — şirket verilerini kaldırır ve kaydı siler. Breeze hiçbir zaman tam silme yapmaz."; `purpose.mailboxSettings`: "Posta kutusu ayarlarını okuma ve yazma — otomatik yanıtı açıp kapatmak ve etkisini doğrulamak için kullanılır."; `purpose.organizationRead`: "Kiracının abonelik envanterini okuma — lisans ataması öncesinde boş yer olduğunu doğrulamak için kullanılır."; `purpose.unknown`: "Breeze'deki bir Microsoft 365 işlemi tarafından kullanılır."
- [ ] Run green: `cd apps/web && npx vitest run src/components/integrations/M365CustomerGraphActionsCard.test.tsx` and the locale coverage test (`cd apps/web && npx vitest run src/locales/`).
- [ ] Commit: `feat(web): explain what Microsoft 365 permission profile v2 adds on the actions card`

---

### Task 12 — Partner-level list of connections still on v1 (API)

**Files**
- `apps/api/src/services/m365ControlPlane/connectionService.ts` (add `listStaleManifestConnections` beside `listConnections` at :410)
- `apps/api/src/services/m365ControlPlane/writeActionConnectionService.ts` (re-export as `listStaleManifestCustomerGraphActionsConnections`)
- `apps/api/src/routes/m365CustomerGraphActions.ts`
- `apps/api/src/routes/m365CustomerGraphActions.test.ts`

**Interfaces**
- *Produces:*
  ```ts
  export interface StaleManifestConnection {
    id: string; orgId: string; orgName: string; displayName: string | null;
    tenantId: string | null; manifestVersion: number; currentManifestVersion: number;
    status: M365ConnectionStatus; lastVerifiedAt: string | null;
  }
  ```
  and route `GET /m365/customer-graph-actions/connections/stale-manifest` returning `{ currentManifestVersion: number; connections: StaleManifestConnection[] }`.

**Steps**
- [ ] Failing route tests in `m365CustomerGraphActions.test.ts`:
  - 401 unauthenticated; 403 without `organizations:read`;
  - a **partner-scoped** token gets 200 and only connections whose `permission_manifest_version < currentManifestVersion`;
  - an **organization-scoped** token gets 403 with a message saying the view is partner-scoped (there is nothing useful to show: an org token already sees its own card);
  - the route takes **no query parameters** — an unexpected one is a 400 (matching `parseOrganizationQuery`'s strictness at :156-167);
  - the response never carries `observed_grants`, `vault_ref`, `credential_version` or `client_id` (assert on the exact key set of a row).
- [ ] Run red: `cd apps/api && npx vitest run src/routes/m365CustomerGraphActions.test.ts`
- [ ] Implement `listStaleManifestConnections` in `connectionService.ts`. It runs under the caller's own RLS context (the route path's `withDbAccessContext` is opened by `authMiddleware`) — **never** a system context; a partner-scoped token passes `breeze_has_org_access` for every org under its partner, which is exactly the visibility this view wants, and RLS remains the boundary:
  ```ts
  async function listStaleManifestConnections(): Promise<StaleManifestConnection[]> {
    const rows = await db
      .select({
        id: m365Connections.id, orgId: m365Connections.orgId, orgName: organizations.name,
        displayName: m365Connections.displayName, tenantId: m365Connections.tenantId,
        manifestVersion: m365Connections.permissionManifestVersion,
        status: m365Connections.status, lastVerifiedAt: m365Connections.lastVerifiedAt,
      })
      .from(m365Connections)
      .innerJoin(organizations, eq(organizations.id, m365Connections.orgId))
      .where(and(
        eq(m365Connections.profile, profile),
        lt(m365Connections.permissionManifestVersion, deps.manifest.version),
      ))
      .orderBy(organizations.name)
      .limit(500);
    return rows.map((row) => ({ ...row, orgId: row.orgId as string, currentManifestVersion: deps.manifest.version, lastVerifiedAt: iso(row.lastVerifiedAt) }));
  }
  ```
  Add it to the returned service object and to the `ConnectionService` interface.
- [ ] Add the route in `m365CustomerGraphActions.ts`, above `GET /connections` so `:id`-style paths cannot shadow it:
  ```ts
  m365CustomerGraphActionsRoutes.get('/connections/stale-manifest', requireOrgsRead, async (c) => {
    if ([...new URL(c.req.url).searchParams.keys()].length > 0) {
      return c.json({ error: 'Invalid request' }, 400);
    }
    const auth = c.get('auth') as AuthContext;
    if (auth.scope !== 'partner') {
      return c.json({ error: 'This view is available to partner-scoped sessions.' }, 403);
    }
    const connections = await listStaleManifestCustomerGraphActionsConnections();
    return c.json({ currentManifestVersion: profileManifest.version, connections });
  });
  ```
- [ ] Run green: `cd apps/api && npx vitest run src/routes/m365CustomerGraphActions.test.ts src/services/m365ControlPlane/connectionService.test.ts`
- [ ] Commit: `feat(api): partner-scoped list of Microsoft 365 action connections still on permission profile v1`

---

### Task 13 — Web: partner re-consent table, and MOUNT it

**Files**
- `apps/web/src/components/integrations/M365ActionsStaleManifestTable.tsx` (new)
- `apps/web/src/components/integrations/M365ActionsStaleManifestTable.test.tsx` (new)
- `apps/web/src/components/integrations/IntegrationsPage.tsx` (the MOUNT — a previous wave shipped thirteen green components that were never wired into a page; this task is not done until the page test passes)
- `apps/web/src/components/integrations/IntegrationsPage.test.tsx`
- the eight `integrations.json` locale files

**Steps**
- [ ] Failing tests.

  `M365ActionsStaleManifestTable.test.tsx`:
  - renders nothing at all (not an empty card) when the fetch returns `connections: []`;
  - renders one row per connection with `data-testid="m365-stale-connection-row"`, showing org name, tenant display name and `Manifest version {{version}}`;
  - renders the loading skeleton, then the table;
  - on a 403 (organization-scoped session) renders nothing and logs no error toast — the view simply does not apply;
  - on a 500 renders an error region with `role="alert"`;
  - selecting a row writes `window.location.hash` and does not use a query param.

  `IntegrationsPage.test.tsx` (the mount proof):
  - with a partner-scoped session the page renders `data-testid="m365-stale-manifest-table"`;
  - with an organization-scoped session it does not.
- [ ] Run red: `cd apps/web && npx vitest run src/components/integrations/`
- [ ] Implement the component using the existing card's conventions: `fetchWithAuth`, a strict `parse*` validator for the response (copy the `hasExactKeys` / `parseGrants` pattern rather than trusting the body), `useTranslation("integrations")`, `formatDateTime`, `data-testid` on every queried node. It is read-only, so no `runAction` call is needed — say so in a comment so a reviewer does not flag the absence.
- [ ] Mount it in `IntegrationsPage.tsx` immediately after `<M365CustomerGraphActionsCard />`, gated on `getJwtClaims().scope === 'partner'`.
- [ ] Add locale keys `m365CustomerGraphActions.staleManifest.{title,description,empty,columnOrganization,columnTenant,columnVersion,columnLastVerified,loadFailed}` in all eight locales, with real translations (English: title "Organizations needing Microsoft 365 re-consent"; description "These customers are still on an earlier permission set. Open the organization to start re-consent."; loadFailed "The re-consent list could not be loaded.").
- [ ] Run green: `cd apps/web && npx vitest run src/components/integrations/ && npx vitest run src/locales/`
- [ ] Commit: `feat(web): partner view of Microsoft 365 connections still on permission profile v1`

---

### Task 14 — Full verification, lab gate, and PR

**Steps**
- [ ] Unit + contract suites, all of which must be green:
  ```
  cd packages/shared && npx vitest run src/m365/
  cd apps/m365-graph-actions-executor && npx vitest run src/
  cd apps/m365-graph-read-executor && npx vitest run src/
  cd apps/api && npx vitest run src/services/m365ControlPlane/ src/services/m365ToolsHeadless.test.ts src/services/aiToolsM365.test.ts src/services/aiGuardrails.m365.test.ts src/services/aiGuardrailsTierConfig.parity.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/actionIntents/ src/jobs/intentReleaseWorker.test.ts src/jobs/intentReleaseWorker.durable.contract.test.ts src/routes/m365CustomerGraphActions.test.ts src/routes/approvals.test.ts src/services/aiAgentSdk.m365risk.test.ts src/services/aiAgentSdkTools.sessionAware.test.ts src/services/aiToolNames.test.ts src/config/validate.test.ts
  cd apps/web && npx vitest run src/components/integrations/ src/components/ai-risk/ src/locales/
  cd apps/mobile && npx vitest run src/screens/approvals/
  ```
- [ ] Typecheck every package touched:
  ```
  cd packages/shared && npx tsc --noEmit -p tsconfig.json
  cd apps/m365-graph-actions-executor && npx tsc --noEmit -p tsconfig.json
  cd apps/m365-graph-read-executor && npx tsc --noEmit -p tsconfig.json
  cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
  cd apps/web && npx tsc --noEmit -p tsconfig.json
  ```
- [ ] Integration suites against the live stack (`pnpm test-stack up` at the repo root if it is down):
  ```
  cd apps/api && npx vitest run --config vitest.integration.config.ts \
    src/__tests__/integration/m365ConsentUpgradeLadder.integration.test.ts \
    src/__tests__/integration/intentReleaseWorkerM365Headless.integration.test.ts \
    src/__tests__/integration/secretBearingToolSeal.integration.test.ts \
    src/__tests__/integration/agentIntentLifecycle.integration.test.ts
  ```
  **The tenancy contract suites (`rls-coverage`, `tenantCascade`, `tenant-export-policy`, `orgLifecycleFoundations`) are NOT in this list on purpose: this wave adds no table and no column** (Global Constraints). Run `git diff --stat origin/main -- apps/api/migrations apps/api/src/db/schema` and confirm it is empty. **If it is not empty, stop — something went wrong and the four suites plus the registration lists are now mandatory.**
- [ ] `pnpm lint` at the repo root.
- [ ] `pnpm test-stack down` at the repo root. Report anything left running.
- [ ] Record the **lab gate** in the PR body as an explicit open item (do not attempt it from this session): against a real Microsoft 365 developer tenant on profile v2 —
  1. every one of the ten actions executes and its probe returns `satisfied`;
  2. re-running each `idempotent` action is a no-op by observation (`noop: true` or an unchanged post-probe);
  3. `m365.group.membership.remove` against a dynamic-membership group and against a role-assignable group both return `unsupported_group_type` **with no membership call in the tenant's audit log**;
  4. `m365.user.license.assign` against a fully-consumed SKU returns `license_unavailable` with no `assignLicense` call;
  5. `GroupMember.ReadWrite.All` alone is sufficient to read `groupTypes` and `isAssignableToRole` (Decision 6 — if not, file the `Group.Read.All` v3 follow-up);
  6. `m365.user.create`'s temporary password is revealable exactly once and appears in no log.
- [ ] Open the PR with `Closes #<wave sub-issue>` in the body, the decision list above, the verified app-role GUIDs and their source URL, and the lab gate as an unchecked checklist. **STOP. Do not merge.**

---

## Self-review

**Spec coverage.** §7.1 (the eight actions, their Graph calls and classes) → Tasks 2, 3, and the `M365_WRITE_ACTION_IDEMPOTENCY` map in Task 2. §7.1 app roles and least privilege → Task 4. §7.1's "each action touches, in one PR, …" registry list → Task 9. §7.2 (v2 once) → Task 4; (v1 keeps working) → Tasks 5 and 10; (settings card explains v2) → Task 11; (per-role readiness from `observed_grants`) → `m365RoleReadiness` in Task 5; (partner-level v1 list) → Tasks 12 and 13. §6.6 (probe → write → probe, no dedup store, `noop` by observation, `non_idempotent` never auto-retried) → Tasks 3, 6, 7, 8. §4.1 (readiness inputs) → `m365RoleReadiness` + `connectionNeedsConsentReconciliation` (Tasks 4, 5). §10 row M1 (independent of E1–E4) → nothing in this plan imports from `services/aiOperator/`.

**Placeholder scan.** No `TBD`, no `TODO`, no "similar to", no "add validation". The four app-role GUIDs carry an explicit `VERIFY`-before-commit instruction with the source URL, which is a deliberate verification step, not a placeholder — Task 4 will not pass its own tests with a malformed GUID and the lab gate catches a wrong-but-well-formed one.

**Identifier consistency.** `M365_WRITE_ACTION_IDS` / `M365_PROBE_ACTION_IDS` / `M365ExecutorActionId` / `M365_WRITE_ACTION_IDEMPOTENCY` / `M365_WRITE_ACTION_REQUIRED_ROLES` (Task 2) are consumed by name in Tasks 3, 4, 5, 8, 9. `m365RoleReadiness` (Task 5) is consumed in Tasks 5, 10, and its shape is what Task 11's card renders from `profile.requiredGrants`. `executeM365ReadActionByOrg` (Task 7) is consumed only by Task 8. `probeM365Effect` (Task 8) has no consumer inside this wave — it is the interface the R1 recipe wave calls, which is why Task 8's tests are the only proof it works and are written to be exhaustive over the id list. `executeM365WriteActionForAuth` (Task 5) is consumed only by Task 9's handlers. The tool-name ↔ action-id table in Task 9 is the single source for `M365_HEADLESS_ACTIONS`, `M365_VERB`, `M365_MUTATION_TOOLS`, `TIER3_FOUR_EYES_TOOLS`, `TOOL_PERMISSIONS`, `tierConfig.ts` and `ApprovalHistoryFeed.tsx`.

---
tracking_issue: LanternOps/breeze#5511
---

# Wave 02 — HP CMSL opt-in surface and delivery to the agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP switch on device-side HP warranty collection from the existing `warranty` config-policy feature link, with consent that only the server can write, an authorization gate that matches the software-install gate it stands in for, and delivery of the resolved flag all the way to the Go agent's config dispatcher — with **no collection code at all** (that is W03).

**Architecture:** The `warranty` feature link stays pure JSONB. It gains an `hpCmsl` block validated by a new shared schema; `consent` is refused on input and stamped by `addFeatureLink` / `updateFeatureLink` from an out-of-band actor argument the HTTP routes supply and the AI tool cannot. Authorization is an in-handler, feature-type-conditional gate (`devices.execute` + satisfied MFA) on every write whose result exposes a device to collection — create, update, revert-to-parent delete, assignment, and create-with-parent. The alert evaluator's private hierarchy resolver moves into a shared service so `buildWarrantyConfigUpdate` reads the same effective link instead of a second copy; the heartbeat carries it as `warranty_settings` and the agent dispatches it through a replaceable seam **above** the probe path's unconditional return.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL (RLS), zod 4, Vitest (API + web), React 19 islands, Go 1.x (`go test -race`), i18next JSON catalogs.

**Spec:** `docs/superpowers/specs/device-lifecycle/2026-09-10-hp-warranty-cmsl-design.md` — layers 1 and 2, plus the `WarrantyTab.tsx` half of layer 7. Its "Corrections after ground-truth verification" section supersedes the body. **Cross-wave contract:** contract B (feature #5511), decisions D1, D2, D3, D4, D5, D6, D7 (W02 half), D12.

**Depends on:** nothing. W01 (#5512) owns `warrantySync.ts`, entitlements and the lab probe; this wave touches none of them and can run in parallel. W03 (#5514) consumes this wave's `warranty_config.go` seam and the persisted agent flag.

## Global Constraints

Copied verbatim from contract B. A wave that believes one of these is wrong stops and reports rather than diverging.

- **D1 — the `hpCmsl` block.** Lives inside the existing `warranty` feature-link inline settings (pure jsonb — **no new table, no tenancy shape, no cascade or export registration, no migration**). Shape:
  ```ts
  export interface WarrantyHpCmslSettings {
    enabled: boolean;              // default false; SEPARATE from the existing `enabled`
    consent?: {                    // server-stamped ONLY — never read from the client
      acceptedByUserId: string;
      acceptedAt: string;          // ISO-8601, server clock
      eulaId: string;              // see D2
    };
  }
  ```
  The existing `{ enabled, warnDays, criticalDays }` keep their meaning: `enabled` there is **expiry alerting**, not collection. Do not overload it.
- **D2 — EULA identifier.** One exported constant, owner W02: `export const HP_CMSL_EULA_ID = 'hp-cmsl-eula-2026-04-01';` Changing HP's terms means a NEW id and re-consent. The id is compared, never parsed; consent recorded against a different id does not satisfy the current id.
- **D3 — consent is server-stamped, and a forged payload is refused.** A client-supplied `consent` object is **refused with a coded 400**, not silently stripped — dropping it would let a UI believe consent was recorded.
- **D4 — authorization gates on POST-WRITE state, evaluated in-handler.** Do NOT add `warranty` to `MFA_GATED_FEATURE_TYPES` wholesale — that forces MFA on pure alert-threshold edits, which install nothing. A write whose **resulting** `hpCmsl.enabled` is `true` requires `devices.execute` AND satisfied MFA. A write that leaves it `false` (including turning it off) keeps today's `devices.write`. Disabling is the fail-safe direction: audited, not gated. The gate covers create, update, AND any assignment/inheritance transition that newly exposes a device to an `hpCmsl.enabled` link. Building blocks — use these, invent nothing: `hasPermission(userPerms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)` (`apps/api/src/services/permissions.ts:210`; constant `packages/shared/src/constants/permissions.ts:24`); `hasSatisfiedMfa(auth)` (`apps/api/src/middleware/auth.ts:915`); MFA refusal shape from `requireMfa()`: `c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)` — a coded body, NOT an `HTTPException`.
- **D5 — inheritance: nearest link wins, whole link, no deep merge.** Do NOT introduce a deep merge for `warranty`. The consequence is real and must be surfaced, not hidden: a nearer policy carrying only alert thresholds **replaces** an inherited link and drops its `hpCmsl` block, revoking collection. Surface it in the authoring UI and cover it with a test asserting the drop is what happens.
- **D6 — agent config key.** Wire shape exactly: `{ "warranty_settings": { "hp_cmsl_enabled": true } }`. Server: add `warrantySettings` to the function-local `PolicyConfigUpdates` (`heartbeat.ts:1921-1926`), build it inside the existing shared `withSystemDbAccessContext` (`:1934`) with its own try/catch mirroring `:1977-1982`, and map it in the wire assembly (`:1993-2004`). Agent: dispatch in `applyConfigUpdate` (`heartbeat.go:2851`) **above line 2918** — below it the probe path's unconditional `return` at `:2928-2930` makes the key unreachable on any heartbeat without probes. Check snake_case first at the outer level; accept both cases for the inner field. Both spellings must be covered by a test. **Revocation contract, copied from `buildPatchSourceConfigUpdate` (`helpers.ts:2852-2859`):** a **successfully resolved absent policy** returns the block with the feature `false`; a **resolver error** OMITS the block entirely so a transient failure never revokes.
- **D7 (W02 half) — agent source layout.** `agent/internal/heartbeat/warranty_config.go`: a package-level func var for the platform call plus an unexported `func (h *Heartbeat) applyWarrantyConfig(raw any)`. **Both lowercase** — the point is that the dispatch + payload parse is unit-testable on a non-Windows runner.
- **D12 — the missing inline-only guard arm.** Add `warranty` to the inline-only guard list at `configurationPolicy.ts:2656-2662`, with a red-first test.
- **Scoped test runs.** API: `cd apps/api && npx vitest run <path>`. Web: `cd apps/web && npx vitest run <path>`. Shared: `cd packages/shared && npx vitest run <path>`. Go: `cd agent && go test -race ./internal/heartbeat/...`. **Never** `pnpm --filter <pkg> test -- --run <path>` — pnpm forwards the literal `--` and vitest runs the entire suite in watch mode. Vitest's path filter is a plain substring match, not a glob.
- **No migration in this wave.** Contract D13 assigns the only expected migration slot to W04. If this wave discovers it needs one, it takes the next free slot (`ls apps/api/migrations/*.sql | sort | tail -1`) and says so in its PR — it does NOT reuse W04's.
- **Out of scope, do not touch:** `apps/api/src/services/warrantySync.ts` and `apps/api/src/services/customFields/import/warrantyTarget.ts` (W01), `agent/internal/collectors/hp_warranty_*.go` and any collection/scheduling code (W03), `builtinDeploymentPackages.ts` / `INTEGRATION_PROVIDERS` / `useEdrReadiness.ts` (W04), `hpProvider.ts` deletion and `DeviceWarrantyCard.tsx` (W05).

## 0. Ground truth

Every citation below was re-opened in this worktree (`/Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing`) on 2026-09-10 and quoted from the file, not copied from the spec or the contract. **Three contract line numbers are wrong; they are called out inline.**

### Config policy — service

- `apps/api/src/services/configurationPolicy.ts:1062-1068` — `decomposeInlineSettings`, verbatim:
  ```ts
      case 'warranty':
      case 'helper':
      case 'pam':
      case 'vulnerability':
      case 'device_lifecycle':
        // Pure JSONB — no normalized table needed
        break;
  ```
  The two sibling switches are at `:1171-1177` (`deleteNormalizedRows`) and `:1416-1422` (`assembleInlineSettings`, which returns `null` for warranty). Confirmed: no normalized table, so `listFeatureLinks` returns the raw feature-link JSONB for warranty.
- `apps/api/src/services/configurationPolicy.ts:1090-1111` — `assertDecomposableInlineSettings` has arms for `alert_rule`, `event_log`, `monitoring`, `remote_access`, `onedrive_helper` and a bare `default: break;`. **`warranty` is absent** — confirmed. It is called from exactly one place, `:1639`, inside `updateFeatureLink`.
- `apps/api/src/services/configurationPolicy.ts:1474-1495` — `addFeatureLink`'s per-feature validation, verbatim:
  ```ts
  export async function addFeatureLink(
    configPolicyId: string,
    featureType: ConfigFeatureType,
    featurePolicyId?: string | null,
    inlineSettings?: unknown
  ) {
    if (inlineSettings !== undefined && inlineSettings !== null) {
      inlineSettings = configFeatureInlineSettingsSchema.parse(inlineSettings);
    }

    if (featureType === 'pam' && inlineSettings !== undefined && inlineSettings !== null) {
      pamInlineSettingsSchema.parse(inlineSettings);
    }

    if (featureType === 'vulnerability' && inlineSettings !== undefined && inlineSettings !== null) {
      vulnerabilityInlineSettingsSchema.parse(inlineSettings);
    }

    if (featureType === 'device_lifecycle' && inlineSettings !== undefined && inlineSettings !== null) {
      inlineSettings = deviceLifecycleInlineSettingsSchema.parse(inlineSettings);
    }
  ```
  The reserved-key scan therefore runs FIRST on every path, which is why the existing `configurationPolicy.test.ts:104` warranty case (`rejects marker injection before add transaction`) stays green when a warranty arm is appended after it.
- `apps/api/src/services/configurationPolicy.ts:1562-1594` — `updateFeatureLink(linkId, updates, configPolicyId?)`; it reads `existing` inside the transaction at `:1577-1582` (`const [existing] = await tx.select().from(configPolicyFeatureLinks)...`), so the previously stored `inlineSettings` is already in hand — no extra query is needed to preserve a recorded consent.
- `apps/api/src/services/configurationPolicy.ts:2656-2662` — the inline-only guard, verbatim, with its own comment at `:2663-2669`:
  ```ts
    if (
      featureType === 'monitoring' ||
      featureType === 'event_log' ||
      featureType === 'onedrive_helper' ||
      featureType === 'vulnerability' ||
      featureType === 'device_lifecycle'
    ) {
      // These have no policy table — they require inlineSettings.
      //
      // Being absent from this list is NOT a harmless omission: the fall-through
      // below accepts any id that happens to name a configuration policy in the
      // same org (whole-policy linking), so the write proceeds and the
      // `config_policy_feature_links_reference_integrity` trigger rejects it —
      // a 500 where the caller should have got a 400 naming the mistake.
  ```
  Contract line numbers confirmed exactly.
- `apps/api/src/services/configurationPolicy.ts:503-509` — `getParentLinkFeatureTypes(parentId)` returns `string[]` of feature types only; it cannot answer "does the parent enable collection", which is why Task 5 adds a sibling function.
- `apps/api/src/services/configurationPolicy.ts:359-431` — `getConfigPolicy` returns `{ ...policy, featureLinks, parentPolicy, childPolicies }`, where `featureLinks` is `listFeatureLinks(id)` (`:377`) and `parentPolicy.featureLinks` is `listFeatureLinks(parent.id)` (`:408`). Both carry `inlineSettings`. The delete and assignment gates therefore need **no extra query**.
- `apps/api/src/services/configurationPolicy.ts:1697-1701` — `listFeatureLinks` selects the whole row (`db.select().from(configPolicyFeatureLinks)`), so `link.inlineSettings` is the stored JSONB.
- `apps/api/src/services/configurationPolicy.ts:2400-2408` — `FEATURE_TABLE_MAP` is an empty object literal with an explanatory comment. `:2417-2430` — `PARTNER_LINKABLE_FEATURE_TYPES` does not contain `warranty`. Both correct as-is; this wave changes neither.

### Config policy — routes

- `apps/api/src/routes/configurationPolicies/featureLinks.ts:47-48`:
  ```ts
  const requireConfigPolicyRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);
  const requireConfigPolicyWrite = requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
  ```
- `apps/api/src/routes/configurationPolicies/featureLinks.ts:91` — `export const MFA_GATED_FEATURE_TYPES: ReadonlySet<string> = new Set(['patch', 'maintenance']);` Confirmed.
- In-handler MFA checks, verbatim: `:145-147`
  ```ts
      if (MFA_GATED_FEATURE_TYPES.has(data.featureType) && !hasSatisfiedMfa(auth)) {
        return c.json({ error: 'MFA required' }, 403);
      }
  ```
  `:340-341` is the same shape keyed on `existingLink.featureType`; `:519-526` is the delete gate:
  ```ts
      const parentUnresolved = !!policy.parentPolicyId && !policy.parentPolicy;
      const parentHasSameType = !!policy.parentPolicy?.featureLinks?.some(
        (l: { featureType: string }) => l.featureType === existingLink.featureType,
      );
      const revertRestoresParentWindow = existingLink.featureType === 'maintenance'
        && (parentUnresolved || parentHasSameType);
      if ((existingLink.featureType === 'patch' || revertRestoresParentWindow) && !hasSatisfiedMfa(auth)) {
        return c.json({ error: 'MFA required' }, 403);
      }
  ```
  This is the precedent Task 5's revert-to-parent arm mirrors, including its **fail-closed** `parentUnresolved` clause.
- `apps/api/src/routes/configurationPolicies/index.ts:12` — `configPolicyRoutes.use('*', authMiddleware);` so `auth` is always set. `apps/api/src/middleware/auth.ts:874` — `requirePermission` ends with `c.set('permissions', userPerms);`, so `c.get('permissions')` is populated for every handler behind `requireConfigPolicyWrite`. The gate still treats a missing value as denied (fail closed).
- `apps/api/src/routes/configurationPolicies/assignments.ts:65-158` — `POST /:id/assignments`. It reads `const policy = await getConfigPolicy(id, auth);` at `:76`, and there is **no MFA or execute check anywhere in the file** — confirmed by `grep -n hasSatisfiedMfa apps/api/src/routes/configurationPolicies/assignments.ts` returning nothing. This is the assignment transition D4 requires and it is currently ungated.
- `apps/api/src/routes/configurationPolicies/crud.ts:76-83` — the create-with-parent inheritance gate, verbatim:
  ```ts
      // MFA follows EFFECTIVENESS, not the verb (#5080). Creating a child of a
      // parent that carries a patch or maintenance link makes that link effective
      // on the new policy immediately — the same capability the direct
      // POST /:id/features gate protects, reached through a second door.
      // Session-claim strength (hasSatisfiedMfa), matching the adjacent gates.
      if (data.parentPolicyId) {
        const parentTypes = await getParentLinkFeatureTypes(data.parentPolicyId);
        if (parentTypes.some((t) => MFA_GATED_FEATURE_TYPES.has(t)) && !hasSatisfiedMfa(auth)) {
          return c.json({ error: 'MFA required' }, 403);
        }
      }
  ```
  `grep -n parentPolicyId apps/api/src/routes/configurationPolicies/crud.ts` returns `:78`, `:79`, `:123`, `:192` only — **`parentPolicyId` is settable at CREATE time and never on PATCH**, which bounds the inheritance surface to this one handler.
- `apps/api/src/middleware/auth.ts:885-909` — `requireMfa()`; its refusal body is `return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);` at `:904`. **Contract correction:** the contract cites `:885-908`; the function actually closes at `:909`. Immaterial, recorded for honesty. `:915` — `export function hasSatisfiedMfa(auth: Pick<AuthContext, 'token'>): boolean {` — confirmed exactly.
- `apps/api/src/services/permissions.ts:210` — `export function hasPermission(userPerms: UserPermissions, resource: string, action: string): boolean` — confirmed. `packages/shared/src/constants/permissions.ts:24` — `DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },` — confirmed.
- `apps/api/src/routes/software.ts:1774` — the established in-handler shape for reading resolved permissions: `c.get('permissions') as UserPermissions | undefined`.

### Shared validators

- `packages/shared/src/validators/index.ts:595-604` — verbatim:
  ```ts
  export const configFeatureInlineSettingsSchema = z
    .record(z.string(), z.unknown())
    .superRefine((settings, ctx) => {
      if (containsConfigPolicyReservedKey(settings)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Reserved configuration feature material is not allowed',
        });
      }
    });
  ```
  Its only rule is the reserved-key scan. Confirmed: warranty inline settings receive no shape validation today on any path.
- `packages/shared/src/validators/index.ts:632-639` — `addFeatureLinkSchema` already lists `'warranty'` in its `featureType` enum, and types `inlineSettings` as `configFeatureInlineSettingsSchema.optional()`. So the reserved-key 400 fires at `zValidator` time, before any handler code — this is why the existing `featureLinks.test.ts:311` warranty case stays green.
- `packages/shared/src/validators/index.ts:624-628` — `deviceLifecycleInlineSettingsSchema` is `z.object({...}).strict()`; its doc comment states the house rule this wave follows: "`.strict()` so an unknown key is rejected rather than persisted-and-echoed as if it took effect."
- `packages/shared/package.json:29` — `"zod": "^4.4.3"`. `apps/api/src/routes/agents/schemas.ts:406,489,616,875` use `z.string().datetime()`, so that spelling (not `z.iso.datetime()`) is the repo convention.
- `packages/shared/src/validators/remoteAccessInlineSettings.ts` exists as a standalone per-feature validator module re-exported from the barrel (`index.ts:22`, `export * from './remoteAccessInlineSettings';`) — the precedent for this wave's new file.
- `packages/shared/src/index.ts` is `export * from './types'; export * from './constants'; export * from './validators'; export * from './utils'; export * from './m365';`. `apps/web/tsconfig.json:7-8` and `apps/web/vitest.config.ts:18-22` alias **only** `@breeze/shared` and `@breeze/shared/reportPdf` — the web layer therefore must import new symbols from the ROOT barrel, not from `@breeze/shared/validators`.

### AI tool path (why the service backstop is load-bearing)

- `apps/api/src/services/aiToolsConfigPolicy.ts:71-75` — verbatim:
  ```ts
  const VALIDATED_INLINE_SETTINGS: Record<string, { schema: { safeParse: (raw: unknown) => any }; normalize: boolean }> = {
    onedrive_helper: { schema: onedriveHelperInlineSettingsSchema, normalize: true },
    alert_rule: { schema: alertRuleInlineSettingsSchema, normalize: true },
    monitoring: { schema: monitoringInlineSettingsSchema, normalize: false },
  };
  ```
  `warranty` is absent, and `:936-942` calls `addFeatureLink(...)` directly. `manage_policy_feature_link` is Tier 2 (auto-executes, audit only, no human approval — see the comment at `:88-90`). So an assistant can today write any warranty JSONB it likes. A route-only consent stamp would be forgeable through this door; the stamp must live in the service and take its actor out-of-band.
- `apps/api/src/services/aiAgentSdkTools.ts:250` — `manage_policy_feature_link: 2,` — confirmed, the base tier really is 2.
- `apps/api/src/services/aiGuardrails.ts:533-543` — `isInputAwareTier3`, verbatim:
  ```ts
  export function isInputAwareTier3(
    toolName: string,
    action: string | undefined,
    input: Record<string, unknown>,
  ): boolean {
    return (
      toolName === 'manage_policy_feature_link' &&
      (action === 'add' || action === 'update') &&
      input.featureType === 'maintenance'
    );
  }
  ```
  It escalates **only** on `featureType === 'maintenance'`. A warranty link carrying `hpCmsl.enabled: true` therefore auto-executes at Tier 2 with no approval, no MFA and no `devices.execute` — straight around D4. Its two call sites are `:570` (`resolveApprovalScope`, which returns `'supervised'` for the escalated pair) and `:1426` (`checkGuardrails`, after the Tier-1 read downgrade at `:1413-1421` and before the static Tier-3/Tier-2 tables).
- `apps/api/src/services/aiGuardrails.ts:508-512` — the `TIER3_INPUT_AWARE_ACTIONS` entry comment ("only the INPUT says which it is, so it cannot be classified by (tool, action) in the static tables"); `:507-514` — the set already contains `'manage_policy_feature_link:add'` and `':update'`, so **no set membership changes** and the `approvalScope.contract.test.ts` "classified in exactly one static table" invariant is already satisfied for both pairs.
- `apps/api/src/services/aiGuardrails.ts:570-578` — the scope rationale, verbatim: "`supervised` matches the #3552/835f7eb3d policy-prerequisite escalations and manage_configuration_policy's own create/update/delete — authoring policy configuration, not an externally binding act."
- `apps/api/src/services/aiGuardrails.ts:523-531` — the doc comment's two warnings: the strict `=== 'maintenance'` comparison, and "for `update`, **featureType is not a required input**". That second fact is decisive: a warranty escalation keyed on `featureType` alone would miss every `update`, so the predicate must read the settings CONTENT.
- `apps/api/src/services/aiGuardrails.ts:2327-2330` — the approval description for this tool: `` parts.push(`${action?.toUpperCase()} ${String(input.featureType ?? 'feature')} link`) `` — an `update` with no `featureType` renders "UPDATE feature link", which tells an approver nothing about HP software being installed.
- `apps/api/src/services/aiGuardrails.imports.contract.test.ts:11-17` — the only import rule on this file is "does not import `./aiToolSchemas` or `getToolDefinitions`" (they pull Drizzle enum objects into partially-mocked suites). A value import from `@breeze/shared/validators` is a pure-zod leaf and does not trip it.
- Existing escalation coverage: `apps/api/src/services/aiGuardrails.test.ts:1202-1270` (seven cases, including the read-not-escalated and non-string-featureType controls) and `apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts:380-395` (both-branches). `apps/api/src/routes/mcpServer.approvalGate.test.ts:440-500` exercises the same escalation end-to-end through the MCP transport.

### Warranty resolution

- `apps/api/src/services/warrantyAlertEvaluator.ts:58` — `async function resolveWarrantySettings(deviceId: string): Promise<WarrantyAlertSettings> {` — **not exported**, closes at `:186`. Contract's `:58-186` confirmed.
- **Contract correction:** the contract cites the level-priority sort at `:158-172` and `DISABLED_SETTINGS` at `:156`. Actual lines: `if (rows.length === 0) return DISABLED_SETTINGS;` is **`:160`**; `const levelPriority: Record<string, number> = {` is **`:163`**; `rows.sort((a, b) => {` is **`:171`**; the projection is `:178-185`, verbatim:
  ```ts
    const inline = rows[0]!.inlineSettings as Partial<WarrantyAlertSettings> | null;
    if (!inline) return DEFAULT_SETTINGS;

    return {
      enabled: inline.enabled ?? DEFAULT_SETTINGS.enabled,
      warnDays: inline.warnDays ?? DEFAULT_SETTINGS.warnDays,
      criticalDays: inline.criticalDays ?? DEFAULT_SETTINGS.criticalDays,
    };
  ```
  Ranking is `device: 5, device_group: 4, site: 3, organization: 2, partner: 1` (`:164-170`), then `b.priority - a.priority` (`:175`).
- `apps/api/src/services/warrantyAlertEvaluator.ts:25-48` — `interface WarrantyAlertSettings { enabled; warnDays; criticalDays }`, `DEFAULT_SETTINGS` = `{true, 90, 30}` (`:36-40`), `DISABLED_SETTINGS` = `{false, 90, 30}` (`:44-48`).
- `apps/api/src/services/warrantyAlertEvaluator.ts:130-158` — the query joins `configPolicyEffectiveFeatureLinks` → `configurationPolicies` → `configPolicyAssignments`, filtered by `eq(configPolicyEffectiveFeatureLinks.featureType, 'warranty')`, `eq(configurationPolicies.status, 'active')`, `policyOwnershipCondition({ orgId: device.orgId, partnerId: org?.partnerId ?? null })` and `or(...targetConditions)`. The polymorphic per-level target conditions are `:112-129`. The file is 423 lines.

### Heartbeat — server

- `apps/api/src/routes/agents/helpers.ts:2841-2850` — `PatchSourceSettings`; `:2852-2859` — the revocation contract comment, verbatim:
  ```ts
  /**
   * Resolves the patch feature link for the device and surfaces the
   * sole-source-enforcement flag for the heartbeat config push. A device with no
   * patch policy assigned resolves to `false`, which the agent treats as "revert
   * any prior Breeze enforcement" — so removing the policy cleanly reverts the
   * endpoint. The caller (heartbeat) omits the block entirely on a resolver error
   * so a transient failure never triggers an unintended revert.
   */
  ```
  `:2860-2863` — the function:
  ```ts
  export async function buildPatchSourceConfigUpdate(deviceId: string): Promise<PatchSourceSettings> {
    const patch = await resolvePatchConfigForDevice(deviceId);
    return { exclusiveWindowsUpdate: patch?.exclusiveWindowsUpdate ?? false };
  }
  ```
  All three contract citations confirmed exactly. `helpers.ts` is 3116 lines.
- `apps/api/src/routes/agents/heartbeat.ts:1921-1926` — verbatim:
  ```ts
    type PolicyConfigUpdates = {
      eventLogSettings: Record<string, unknown> | null;
      monitoringSettings: Record<string, unknown> | null;
      pamSettings: { uacInterceptionEnabled: boolean } | null;
      patchSourceSettings: { exclusiveWindowsUpdate: boolean } | null;
    };
  ```
  Function-local, not exported — confirmed. `:1927-1932` is the all-null initialiser; `:1934` is `policyConfigs = await withSystemDbAccessContext(async (): Promise<PolicyConfigUpdates> => {`; `:1976-1982` is the patch-source builder + catch:
  ```ts
        // #1872: sole-patch-source enforcement. Omit the block on a resolver error so
        // a transient failure never reverts an endpoint already under enforcement;
        // a successful resolve with no patch policy returns false → agent reverts.
        try {
          patchSourceSettings = await buildPatchSourceConfigUpdate(scoped.deviceId);
        } catch (err) {
          console.error(`[agents] failed to build patch_source config update for ${agentId}:`, err);
          captureException(err);
        }
  ```
  `:1984` is the `return { eventLogSettings, monitoringSettings, pamSettings, patchSourceSettings };`. The wire assembly is `:1993-2005`:
  ```ts
    const { eventLogSettings, monitoringSettings, pamSettings, patchSourceSettings } = policyConfigs;

    const policyConfigUpdate: Record<string, unknown> = {};
    if (eventLogSettings) {
      policyConfigUpdate.event_log_settings = eventLogSettings;
    }
    if (monitoringSettings) {
      policyConfigUpdate.monitoring_settings = monitoringSettings;
    }
    if (patchSourceSettings) {
      policyConfigUpdate.patch_source_settings = patchSourceSettings;
    }
    const hasPolicyConfigUpdate = Object.keys(policyConfigUpdate).length > 0;
  ```
  Note `pamSettings` is deliberately NOT merged here (it ships as a top-level `uacInterceptionEnabled` at `:2047`). `:2007-2015` merges `policyConfigUpdate` into the response `configUpdate`. The import block is `:21-38`, with `buildPatchSourceConfigUpdate` at `:31`.

### Heartbeat — agent

- `agent/internal/heartbeat/heartbeat.go:2851` — `func (h *Heartbeat) applyConfigUpdate(update map[string]any) {`. Confirmed. Outer keys check snake_case first at `:2857`, `:2867`, `:2879`, `:2889`, `:2901`, `:2910` — all six confirmed by direct line count.
- `agent/internal/heartbeat/heartbeat.go:2909-2916` — the LAST non-probe key, verbatim:
  ```go
  	// Apply onedrive_helper_settings if present (Phase 2). No-op on non-Windows.
  	odRaw, hasOD := update["onedrive_helper_settings"]
  	if !hasOD {
  		odRaw, hasOD = update["onedriveHelperSettings"]
  	}
  	if hasOD {
  		h.applyOneDriveHelperConfig(odRaw)
  	}
  ```
  `:2918` starts the probe path and `:2928-2930` is its unconditional bail:
  ```go
  	registryRaw, hasRegistry := update["policy_registry_state_probes"]
  	...
  	if !hasRegistry && !hasConfig {
  		return
  	}
  ```
  **The new dispatch goes immediately after `:2916`, before `:2918`.** Confirmed by reading, exactly as the contract states.
- `agent/internal/heartbeat/patch_source.go` — the whole file is 57 lines. `:7-12`:
  ```go
  // applyWinUpdate is the seam to the (Windows-only) enforcement. A package var so
  // tests can capture the resolved enforce bool on any platform — the dispatch +
  // payload-parse path is where a key-name regression would silently disable the
  // whole feature, so it must be unit-tested even though the registry I/O cannot
  // run on the CI agent.
  var applyWinUpdate = winupdate.Apply
  ```
  `:18` `func (h *Heartbeat) applyPatchSourceConfig(raw any) {`; `:19-23` the `map[string]any` type assertion with a warn-and-return; `:25-33` the dual-key parse, **camelCase first**:
  ```go
  	// The API may send either snake_case or camelCase.
  	v, present := m["exclusiveWindowsUpdate"]
  	if !present {
  		v, present = m["exclusive_windows_update"]
  	}
  	if !present {
  		log.Warn("patch_source_settings received without exclusiveWindowsUpdate field")
  		return
  	}
  ```
  Neither symbol is exported. Confirmed.
- `agent/internal/heartbeat/patch_source_test.go:1-77` — the table-driven seam test, capturing through `orig := applyWinUpdate; t.Cleanup(func() { applyWinUpdate = orig })` and driving the whole path via `h := &Heartbeat{config: config.Default()}; h.applyConfigUpdate(tt.update)`. Six cases including both key spellings, a non-object payload and an absent block. This is the template Task 10 copies.
- `agent/internal/heartbeat/heartbeat.go:2809-2848` — `applyRequireManifestSigningKeyIDConfig`, the closest precedent for a **persisted control-plane boolean**: read current under `h.mu`, decide, write `h.config.X` under `h.mu`, then `config.SetAndPersist("require_manifest_signing_key_id", val)` with a `log.Warn` on failure. `:4008-4012` — `func (h *Heartbeat) requireManifestSigningKeyID() bool { h.mu.Lock(); defer h.mu.Unlock(); return h.config.RequireManifestSigningKeyID }` — the mutex-guarded accessor pattern W03 will need.
- `agent/internal/config/config.go:207` — `RequireManifestSigningKeyID bool \`mapstructure:"require_manifest_signing_key_id" yaml:"require_manifest_signing_key_id"\`` — the field-declaration shape. `:596` — `func SetAndPersist(key string, value any) error`. `:707-727` — `saveToLocked` sets each key explicitly (`viper.Set("require_manifest_signing_key_id", cfg.RequireManifestSigningKeyID)` at `:726`), so a new persisted field must be added there too or `SaveTo` silently drops it. `:327-...` — `Default()` does not initialise `RequireManifestSigningKeyID`; a zero-value `false` default needs no entry.

### Web

- `apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.tsx:9-18` — verbatim:
  ```tsx
  type WarrantySettings = {
    enabled: boolean;
    warnDays: number;
    criticalDays: number;
  };
  const defaults: WarrantySettings = {
    enabled: true,
    warnDays: 90,
    criticalDays: 30,
  };
  ```
  `:30-42` seeds state from `existingLink ?? parentLink` and re-syncs in a `useEffect`. `:49-53` and `:63-67` are the save/override payloads, both hardcoding `featurePolicyId: null` with the `#5080` comment. The file is 180 lines and uses `i18n.t("policies:configurationPolicies.featureTabs.warrantyTab.<key>")` for every string.
- `apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.ts:34` — `if (payload.inlineSettings) body.inlineSettings = payload.inlineSettings;` — the tab's settings object is sent **verbatim**. Since the tab reads `consent` back out of the saved link for display, it MUST strip it before saving or every subsequent save trips D3's coded 400.
- `apps/web/src/components/configurationPolicies/featureTabs/types.ts:20-27` — `FeatureLink` carries `inlineSettings: Record<string, unknown> | null`. `:37-53` — `FeatureTabProps` supplies `existingLink`, `parentLink`, `linkedPolicyId`.
- `apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.test.tsx:1-50` — the existing suite mocks `./useFeatureLink` and finds the Save button by role+text. `DeviceLifecycleTab.test.tsx:29-52` adds the `link()` and `savedSettings()` helpers this wave reuses, and `DeviceLifecycleTab.tsx:159-166` shows the `data-testid` + `role="switch"` + `aria-checked` convention for a toggle.
- `apps/web/src/components/configurationPolicies/featureTabs/structuralValues.test.ts:9-22` — `WarrantyTab.tsx` is already in the guarded file list; the guard forbids `update(i18n.t(`, `value: i18n.t(`, and `.x === i18n.t(` patterns. Task 12's code uses machine keys throughout and does not trip it.
- `apps/web/src/locales/` contains `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`. `apps/web/src/locales/en/policies.json:1168-1179` is the existing `warrantyTab` block (7 real keys plus three stray machine-value keys `enabled`/`warnDays`/`criticalDays`).
- `apps/web/src/lib/i18n/localeParity.test.ts:457-461` — ``it(`${locale} matches en namespace files and keys exactly`)`` asserts key-set equality, so **every new `en` key must be added to all seven other locales**. `:465-477` asserts interpolation tokens are preserved. `:513-524` asserts `protectedNames` occurrence counts match per key; the list at `:100-190` includes `'IP'`, `'API'`, `'MSP'`, `'RMM'`, `'PowerShell'`, `'Windows'`, `'winget'` — so a translated string must contain `IP` exactly as often as the English one.
- `apps/web/src/lib/i18n/translationCoverage.test.ts:764-778` — ``it(`${locale} does not exceed reviewed namespace duplicate baselines`)``: an exact-English copy in a translated catalog counts against a hard per-namespace baseline. **New keys must be genuinely translated, not copied.**
- `apps/web/src/lib/i18n/terminologyQuality.test.ts:40-49` — the forbidden-pattern lists (`pt-BR`: `/\bvoce\b/i`, `/\besta ativa\b/i`, `/\bcomecar\b/i`, `teste de fumaça`; `fr-*`: `/\bpostuler\b/i`, `/\bsubventions?\b/i`, `test de fumée`, `oscilloire`; `de-DE`: `/\bHauptschalter\b/i`, `/\bKernschalter\b/i`; `it-IT`: `/\bpotrài\b/i`). Task 11's strings avoid all of them.
- `apps/web/src/lib/i18n/keyUsage.test.ts:336` — `it('every literal t() key resolves in en')`. The check runs key→catalog only; a catalog key with no consumer yet is fine, so the catalogs can land before the tab.

### Existing tests that constrain this wave

- `apps/api/src/routes/configurationPolicies/featureLinks.test.ts:44-56` — the harness: `mfaState` hoisted, `vi.mock('../../middleware/auth', ...)` exporting `hasSatisfiedMfa: vi.fn(() => mfaState.satisfied)` and pass-through `requirePermission`. `:73-83` — `buildApp()` sets only `c.set('auth', makeAuth())`; it does **not** set `permissions`, so Task 5's tests must add it.
- `apps/api/src/routes/configurationPolicies/featureLinks.test.ts:308-326` — the reserved-material case that includes `'warranty'`; it asserts a 400 and that the body contains neither `__breezePatchInlineMirror` nor `attacker-value`. It passes through `zValidator`, ahead of any new warranty branch.
- `apps/api/src/services/configurationPolicy.test.ts:102-113` — the service-level twin, calling `addFeatureLink('policy-1', 'warranty', null, { nested: { __breezePatchInlineMirror: ... } })` and expecting `/reserved/i` before `db.transaction` is touched.
- `apps/api/src/services/configurationPolicy.deviceLifecycle.test.ts:1-57` — the exact template for D12's red-first test, including the db double that returns a MATCHING config-policy row so a removed guard fails on the assertion rather than a TypeError.
- `apps/api/src/routes/agents/helpers.patchSource.test.ts:1-129` — the module-mock preamble a new `helpers.warranty.test.ts` copies verbatim (`vi.mock('../../db', ...)`, `vi.mock('../../db/schema', ...)` and eleven service mocks) so `helpers.ts` imports without a DB or Redis.
- `apps/api/src/routes/agents/heartbeat.test.ts:167-176` — the `vi.mock('./helpers', ...)` factory; `:3114-3143` — the two patch-source wiring cases (delivered when true, omitted when the builder rejects) that Task 9's tests mirror.

## File structure

- **Create** `packages/shared/src/constants/hpCmsl.ts` — `HP_CMSL_EULA_ID` (D2). Leaf module, no imports.
- **Modify** `packages/shared/src/constants/index.ts` — re-export it.
- **Create** `packages/shared/src/validators/warrantyInlineSettings.ts` — the client schema (consent forbidden), the stored schema (consent allowed and required when enabled), and three predicates. The single source of truth for what an `hpCmsl` block means.
- **Create** `packages/shared/src/validators/warrantyInlineSettings.test.ts`.
- **Modify** `packages/shared/src/validators/index.ts` — re-export it.
- **Modify** `apps/api/src/services/configurationPolicy.ts` — warranty arm in `addFeatureLink`/`updateFeatureLink` with the out-of-band consent stamp; `WarrantyConsentError`; `parentPolicyEnablesHpCmslCollection`; `warranty` added to the inline-only guard list.
- **Create** `apps/api/src/services/configurationPolicy.warranty.test.ts` — service-level consent tests.
- **Create** `apps/api/src/services/configurationPolicy.warrantyGuard.test.ts` — D12's red-first guard test.
- **Create** `apps/api/src/routes/configurationPolicies/hpCmslGate.ts` + `hpCmslGate.test.ts` — the shared `devices.execute` + MFA decision, used from five call sites.
- **Modify** `apps/api/src/routes/configurationPolicies/featureLinks.ts` — coded consent refusal, warranty schema parse, the gate on create/update/revert-delete, actor passed to the service.
- **Modify** `apps/api/src/routes/configurationPolicies/assignments.ts` — the gate on assignment.
- **Modify** `apps/api/src/routes/configurationPolicies/crud.ts` — the gate on create-with-parent.
- **Modify** `apps/api/src/routes/configurationPolicies/featureLinks.test.ts` — new describes for consent + gate.
- **Create** `apps/api/src/routes/configurationPolicies/assignments.hpCmsl.test.ts`.
- **Modify** `apps/api/src/services/aiToolsConfigPolicy.ts` — register the warranty schema so an assistant gets a descriptive refusal.
- **Modify** `apps/api/src/services/aiGuardrails.ts` — `isInputAwareTier3` gains a second, content-keyed arm so an hpCmsl-enabling feature-link write escalates to Tier 3 (`supervised`); the approval description names it.
- **Modify** `apps/api/src/services/aiGuardrails.test.ts` and `apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts` — both-directions coverage plus the unchanged-maintenance control.
- **Create** `apps/api/src/services/warrantyPolicyResolution.ts` + `warrantyPolicyResolution.test.ts` — the hierarchy resolver lifted out of the alert evaluator, now shared.
- **Modify** `apps/api/src/services/warrantyAlertEvaluator.ts` — `resolveWarrantySettings` becomes a projection over the shared resolver.
- **Modify** `apps/api/src/routes/agents/helpers.ts` — `buildWarrantyConfigUpdate`.
- **Create** `apps/api/src/routes/agents/helpers.warranty.test.ts`.
- **Modify** `apps/api/src/routes/agents/heartbeat.ts` — `warrantySettings` through `PolicyConfigUpdates`, the shared system context, and the wire assembly.
- **Modify** `apps/api/src/routes/agents/heartbeat.test.ts` — delivery + omit-on-error cases.
- **Modify** `agent/internal/config/config.go` — `HPWarrantyCollectionEnabled` field + `saveToLocked` entry.
- **Create** `agent/internal/heartbeat/warranty_config.go` + `warranty_config_test.go` — the seam, the parse, and the accessor W03 reads.
- **Modify** `agent/internal/heartbeat/heartbeat.go` — dispatch above `:2918`.
- **Modify** `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/policies.json` — six new `warrantyTab` keys.
- **Modify** `apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.tsx` — the checkbox, consent copy, read-only acceptance, inheritance warning, consent-stripping save payload.
- **Modify** `apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.test.tsx`.

---

### Task 1: Shared contract — EULA id, warranty inline-settings schemas, and the three predicates

**Files:**
- Create: `packages/shared/src/constants/hpCmsl.ts`
- Modify: `packages/shared/src/constants/index.ts` (add one `export * from` line)
- Create: `packages/shared/src/validators/warrantyInlineSettings.ts`
- Modify: `packages/shared/src/validators/index.ts` (add one `export * from` line)
- Test: `packages/shared/src/validators/warrantyInlineSettings.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces, all reachable from `@breeze/shared` (root barrel — the only path the web layer's alias resolves) and from `@breeze/shared/validators` / `@breeze/shared/constants`:
  - `HP_CMSL_EULA_ID: 'hp-cmsl-eula-2026-04-01'`
  - `warrantyHpCmslConsentSchema`, `WarrantyHpCmslConsent`
  - `warrantyHpCmslRequestBlockSchema` (no `consent` key — `.strict()` rejects one)
  - `warrantyHpCmslStoredBlockSchema` (`consent` optional)
  - `warrantyInlineSettingsSchema` — **client-facing**; `WarrantyInlineSettings`
  - `storedWarrantyInlineSettingsSchema` — **server/stored**; `StoredWarrantyInlineSettings`
  - `clientSuppliedWarrantyHpCmslConsent(inlineSettings: unknown): boolean`
  - `warrantyHpCmslRequested(inlineSettings: unknown): boolean`
  - `warrantyHpCmslCollectionEffective(inlineSettings: unknown): boolean`
  - `readRecordedWarrantyHpCmslConsent(inlineSettings: unknown): WarrantyHpCmslConsent | null`

**Why two predicates, not one** (this is the subtlety that decides whether the gate works): `warrantyHpCmslRequested` answers *"is this author asking for collection?"* and is evaluated on a payload **before** the server stamps consent, so it must NOT require consent. `warrantyHpCmslCollectionEffective` answers *"does this stored link actually deliver collection?"* and requires a consent matching the CURRENT `HP_CMSL_EULA_ID` — it is what the agent-delivery builder and the inheritance/assignment gates read. Collapsing them into one predicate makes the create gate a no-op (consent is never present at gate time) or makes delivery ignore a superseded EULA. Keep both.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/validators/warrantyInlineSettings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  HP_CMSL_EULA_ID,
  clientSuppliedWarrantyHpCmslConsent,
  storedWarrantyInlineSettingsSchema,
  warrantyHpCmslCollectionEffective,
  warrantyHpCmslRequested,
  warrantyInlineSettingsSchema,
} from './warrantyInlineSettings';

const CONSENT = {
  acceptedByUserId: 'user-1',
  acceptedAt: '2026-09-10T12:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};

describe('warrantyInlineSettingsSchema (client-facing)', () => {
  it('accepts the legacy three-field alerting shape unchanged', () => {
    const parsed = warrantyInlineSettingsSchema.safeParse({
      enabled: true,
      warnDays: 90,
      criticalDays: 30,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an hpCmsl block with only `enabled`', () => {
    const parsed = warrantyInlineSettingsSchema.safeParse({
      enabled: true,
      warnDays: 90,
      criticalDays: 30,
      hpCmsl: { enabled: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('REFUSES a client-supplied consent object (D3 — never silently stripped)', () => {
    const parsed = warrantyInlineSettingsSchema.safeParse({
      hpCmsl: { enabled: true, consent: CONSENT },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an unknown top-level key rather than persisting it', () => {
    expect(warrantyInlineSettingsSchema.safeParse({ hpCsml: { enabled: true } }).success).toBe(false);
  });

  it('refuses an hpCmsl block with no `enabled`', () => {
    expect(warrantyInlineSettingsSchema.safeParse({ hpCmsl: {} }).success).toBe(false);
  });
});

describe('storedWarrantyInlineSettingsSchema (server/stored)', () => {
  it('accepts a stamped consent', () => {
    const parsed = storedWarrantyInlineSettingsSchema.safeParse({
      hpCmsl: { enabled: true, consent: CONSENT },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a consent with a non-ISO acceptedAt', () => {
    const parsed = storedWarrantyInlineSettingsSchema.safeParse({
      hpCmsl: { enabled: true, consent: { ...CONSENT, acceptedAt: 'yesterday' } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('clientSuppliedWarrantyHpCmslConsent', () => {
  it('is true when the key is present at all, even undefined-valued', () => {
    expect(clientSuppliedWarrantyHpCmslConsent({ hpCmsl: { enabled: true, consent: undefined } })).toBe(true);
    expect(clientSuppliedWarrantyHpCmslConsent({ hpCmsl: { enabled: true, consent: null } })).toBe(true);
  });

  it('is false for a clean payload and for non-objects', () => {
    expect(clientSuppliedWarrantyHpCmslConsent({ hpCmsl: { enabled: true } })).toBe(false);
    expect(clientSuppliedWarrantyHpCmslConsent({ enabled: true })).toBe(false);
    expect(clientSuppliedWarrantyHpCmslConsent(null)).toBe(false);
    expect(clientSuppliedWarrantyHpCmslConsent('nope')).toBe(false);
  });
});

describe('warrantyHpCmslRequested (pre-stamp gate input)', () => {
  it('is true for an enable request that carries no consent yet', () => {
    expect(warrantyHpCmslRequested({ hpCmsl: { enabled: true } })).toBe(true);
  });

  it('is false for an explicit disable, an absent block, and junk', () => {
    expect(warrantyHpCmslRequested({ hpCmsl: { enabled: false } })).toBe(false);
    expect(warrantyHpCmslRequested({ enabled: true, warnDays: 90 })).toBe(false);
    expect(warrantyHpCmslRequested({ hpCmsl: 'yes' })).toBe(false);
    expect(warrantyHpCmslRequested(undefined)).toBe(false);
  });
});

describe('warrantyHpCmslCollectionEffective (delivery + inheritance gates)', () => {
  it('is true only for enabled + consent against the current EULA id', () => {
    expect(warrantyHpCmslCollectionEffective({ hpCmsl: { enabled: true, consent: CONSENT } })).toBe(true);
  });

  it('is false when consent is missing entirely', () => {
    expect(warrantyHpCmslCollectionEffective({ hpCmsl: { enabled: true } })).toBe(false);
  });

  it('is false when consent names a superseded EULA id (D2 — re-consent required)', () => {
    expect(
      warrantyHpCmslCollectionEffective({
        hpCmsl: { enabled: true, consent: { ...CONSENT, eulaId: 'hp-cmsl-eula-2020-01-01' } },
      }),
    ).toBe(false);
  });

  it('is false for a disabled block that still carries consent', () => {
    expect(warrantyHpCmslCollectionEffective({ hpCmsl: { enabled: false, consent: CONSENT } })).toBe(false);
  });

  it('is false for a malformed block — fail safe, never collect on a blob we cannot read', () => {
    expect(warrantyHpCmslCollectionEffective({ hpCmsl: { enabled: true, consent: CONSENT, extra: 1 } })).toBe(false);
    expect(warrantyHpCmslCollectionEffective(null)).toBe(false);
  });

  it('ignores unrelated alert-threshold junk on the same object', () => {
    // The block predicates parse the hpCmsl SUB-BLOCK only, deliberately: a
    // stray or out-of-range warnDays must not silently switch collection off.
    expect(
      warrantyHpCmslCollectionEffective({ warnDays: 99999, hpCmsl: { enabled: true, consent: CONSENT } }),
    ).toBe(true);
  });
});

describe('readRecordedWarrantyHpCmslConsent', () => {
  it('returns the acceptance verbatim, superseded or not', () => {
    expect(readRecordedWarrantyHpCmslConsent({ hpCmsl: { enabled: true, consent: CONSENT } })).toEqual(CONSENT);
    const old = { ...CONSENT, eulaId: 'hp-cmsl-eula-2020-01-01' };
    expect(readRecordedWarrantyHpCmslConsent({ hpCmsl: { enabled: true, consent: old } })).toEqual(old);
  });

  it('returns null when there is no acceptance or the block is unreadable', () => {
    expect(readRecordedWarrantyHpCmslConsent({ hpCmsl: { enabled: true } })).toBeNull();
    expect(readRecordedWarrantyHpCmslConsent({ enabled: true })).toBeNull();
    expect(readRecordedWarrantyHpCmslConsent({ hpCmsl: { enabled: true, extra: 1 } })).toBeNull();
    expect(readRecordedWarrantyHpCmslConsent(undefined)).toBeNull();
  });
});
```

Add `readRecordedWarrantyHpCmslConsent` to the import list at the top of that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && npx vitest run src/validators/warrantyInlineSettings.test.ts`
Expected: FAIL — `Failed to resolve import "./warrantyInlineSettings"`.

- [ ] **Step 3: Write the constant**

Create `packages/shared/src/constants/hpCmsl.ts`:

```ts
/**
 * Identifier for the HP Client Management Script Library (CMSL) licence a
 * partner accepts when they switch on device-side HP warranty collection
 * (feature #5511, contract D2).
 *
 * The id is COMPARED, never parsed. When HP changes its terms this constant
 * takes a NEW value: consent recorded against the old id no longer satisfies
 * the current one, so the config-policy author has to accept again — and the
 * agent stops collecting until they do. That is deliberate. An acceptance is
 * an acceptance of specific terms or it is not an acceptance at all.
 *
 * The date is the release date of the CMSL package whose licence text was
 * read (HP.HPCMSL 1.8.6, 2026-04-01), not the date this file was written.
 */
export const HP_CMSL_EULA_ID = 'hp-cmsl-eula-2026-04-01';
```

Append to `packages/shared/src/constants/index.ts`, directly under the `agentFileTransfer` re-export:

```ts
// HP CMSL licence identifier — the thing a warranty feature link's recorded
// consent is compared against (#5511 D2). Leaf module, no imports.
export * from './hpCmsl';
```

- [ ] **Step 4: Write the schemas and predicates**

Create `packages/shared/src/validators/warrantyInlineSettings.ts`:

```ts
import { z } from 'zod';
import { HP_CMSL_EULA_ID } from '../constants/hpCmsl';

/**
 * `warranty` feature-link inline settings (#5511 W02, contract D1).
 *
 * Pure JSONB on `config_policy_feature_links` — no normalized table, no new
 * tenancy shape, no migration. Two schemas, deliberately:
 *
 *  - `warrantyInlineSettingsSchema` is what a CLIENT may send. `consent` is
 *    not in the shape, and `.strict()` therefore REFUSES it rather than
 *    stripping it (D3): silently dropping a consent object would let a UI
 *    believe an acceptance had been recorded when none was.
 *  - `storedWarrantyInlineSettingsSchema` is what may be PERSISTED. Only the
 *    server produces a value that satisfies it, because only the server writes
 *    `consent` — see addFeatureLink/updateFeatureLink in the API's
 *    configurationPolicy service, which take the accepting user out of band
 *    rather than from the payload.
 *
 * The pre-existing `enabled` field means EXPIRY ALERTING. `hpCmsl.enabled`
 * means DEVICE-SIDE COLLECTION. They are independent; do not overload either.
 */
export const warrantyHpCmslConsentSchema = z
  .object({
    /** The authenticated user who accepted, stamped server-side. */
    acceptedByUserId: z.string().min(1).max(64),
    /** ISO-8601, server clock. Never a client-supplied time. */
    acceptedAt: z.string().datetime(),
    /** Compared against HP_CMSL_EULA_ID; never parsed. */
    eulaId: z.string().min(1).max(64),
  })
  .strict();

export type WarrantyHpCmslConsent = z.infer<typeof warrantyHpCmslConsentSchema>;

/** What a client may send for the hpCmsl block: the flag, and nothing else. */
export const warrantyHpCmslRequestBlockSchema = z
  .object({ enabled: z.boolean() })
  .strict();

/** What may be stored: the flag plus a server-stamped acceptance. */
export const warrantyHpCmslStoredBlockSchema = z
  .object({
    enabled: z.boolean(),
    consent: warrantyHpCmslConsentSchema.optional(),
  })
  .strict();

// The alerting half, unchanged in meaning since #1320. Bounds are wide on
// purpose (1..3650, matching device_lifecycle's retention window) — a WRITE
// that fails to parse discards the whole blob, so a legacy row with an odd
// threshold must still be re-savable after an unrelated edit.
const warrantyAlertFields = {
  enabled: z.boolean().optional(),
  warnDays: z.number().int().min(1).max(3650).optional(),
  criticalDays: z.number().int().min(1).max(3650).optional(),
};

export const warrantyInlineSettingsSchema = z
  .object({
    ...warrantyAlertFields,
    hpCmsl: warrantyHpCmslRequestBlockSchema.optional(),
  })
  .strict();

export type WarrantyInlineSettings = z.infer<typeof warrantyInlineSettingsSchema>;

export const storedWarrantyInlineSettingsSchema = z
  .object({
    ...warrantyAlertFields,
    hpCmsl: warrantyHpCmslStoredBlockSchema.optional(),
  })
  .strict();

export type StoredWarrantyInlineSettings = z.infer<typeof storedWarrantyInlineSettingsSchema>;

function readHpCmslBlock(inlineSettings: unknown): unknown {
  if (!inlineSettings || typeof inlineSettings !== 'object' || Array.isArray(inlineSettings)) {
    return undefined;
  }
  return (inlineSettings as Record<string, unknown>).hpCmsl;
}

/**
 * True when the caller put a `consent` KEY on the hpCmsl block at all —
 * including `consent: null` or `consent: undefined`. Presence is what matters:
 * the point of D3 is that a client learns its consent was refused, so the
 * refusal must not depend on the value being well-formed.
 */
export function clientSuppliedWarrantyHpCmslConsent(inlineSettings: unknown): boolean {
  const block = readHpCmslBlock(inlineSettings);
  if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
  return 'consent' in (block as Record<string, unknown>);
}

/**
 * "Is this author ASKING for device-side collection?" — the input to the
 * write-time authorization gate (D4), evaluated on a payload that has not been
 * consent-stamped yet. Deliberately does NOT require consent.
 */
export function warrantyHpCmslRequested(inlineSettings: unknown): boolean {
  const parsed = warrantyHpCmslStoredBlockSchema.safeParse(readHpCmslBlock(inlineSettings));
  return parsed.success && parsed.data.enabled === true;
}

/**
 * "Does this STORED link actually deliver collection?" — the input to the
 * agent-config builder and to the inheritance/assignment gates. Requires a
 * consent recorded against the CURRENT HP_CMSL_EULA_ID, so a superseded
 * acceptance turns collection off rather than riding on stale terms (D2).
 *
 * Parses the hpCmsl SUB-BLOCK, not the whole settings object: an unrelated
 * out-of-range alert threshold must not silently disable collection.
 * A block it cannot read at all yields `false` — fail safe.
 */
export function warrantyHpCmslCollectionEffective(inlineSettings: unknown): boolean {
  const parsed = warrantyHpCmslStoredBlockSchema.safeParse(readHpCmslBlock(inlineSettings));
  if (!parsed.success) return false;
  return parsed.data.enabled === true && parsed.data.consent?.eulaId === HP_CMSL_EULA_ID;
}

/**
 * The acceptance recorded on a stored blob, VERBATIM — including one that
 * names a superseded EULA id. Two consumers need exactly that: the API carries
 * a still-current acceptance across an unrelated threshold edit rather than
 * churning `acceptedAt`, and the authoring UI has to be able to say "these
 * terms changed since <user> accepted on <date>" instead of silently showing
 * nothing. Compare `eulaId` at the call site; this reader does not judge.
 */
export function readRecordedWarrantyHpCmslConsent(inlineSettings: unknown): WarrantyHpCmslConsent | null {
  const parsed = warrantyHpCmslStoredBlockSchema.safeParse(readHpCmslBlock(inlineSettings));
  return parsed.success ? (parsed.data.consent ?? null) : null;
}
```

Append to `packages/shared/src/validators/index.ts`, next to the other per-feature validator re-exports (after `export * from './remoteAccessInlineSettings';`):

```ts
export * from './warrantyInlineSettings';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/shared && npx vitest run src/validators/warrantyInlineSettings.test.ts`
Expected: PASS, 1 file.

Then confirm nothing else in the package regressed (the barrel now re-exports new symbols):
Run: `cd packages/shared && npx vitest run src/validators/index` and `cd packages/shared && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/constants/hpCmsl.ts packages/shared/src/constants/index.ts packages/shared/src/validators/warrantyInlineSettings.ts packages/shared/src/validators/warrantyInlineSettings.test.ts packages/shared/src/validators/index.ts
git commit -m "feat(shared): HP CMSL EULA id + warranty inline-settings schemas with unforgeable consent (#5511 W02 D1/D2/D3)"
```

---

### Task 2: Service — warranty validation and the out-of-band consent stamp

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` (import block `:48-57`; new symbols after the `PartnerWideWriteDeniedError`-style error declarations; warranty arm in `addFeatureLink` after `:1492-1494`; warranty arm in `updateFeatureLink` after `:1592-1594`; both signatures gain a trailing `consentActor` parameter)
- Modify: `apps/api/src/services/aiToolsConfigPolicy.ts:71-75` (register the client schema)
- Test: `apps/api/src/services/configurationPolicy.warranty.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `warrantyInlineSettingsSchema`, `warrantyHpCmslStoredBlockSchema`, `warrantyHpCmslCollectionEffective`, `readRecordedWarrantyHpCmslConsent`, `HP_CMSL_EULA_ID`, `WarrantyHpCmslConsent`.
- Produces:
  - `export class WarrantyConsentError extends Error` with `readonly code = 'warranty_hp_cmsl_consent_required'`
  - `export type WarrantyConsentActor = { userId: string } | null | undefined`
  - `export function resolveWarrantyInlineSettingsForWrite(incoming: unknown, stored: unknown, actor: WarrantyConsentActor): unknown`
  - `addFeatureLink(configPolicyId, featureType, featurePolicyId?, inlineSettings?, consentActor?: WarrantyConsentActor)`
  - `updateFeatureLink(linkId, updates, configPolicyId?, consentActor?: WarrantyConsentActor)`

**Why the actor is a separate parameter and not a payload field.** `manage_policy_feature_link` is a Tier-2 AI tool that auto-executes with audit only and calls `addFeatureLink` directly (`aiToolsConfigPolicy.ts:936-942`), and `warranty` is absent from its `VALIDATED_INLINE_SETTINGS`. If consent were readable from `inlineSettings` anywhere, an assistant could fabricate an acceptance; if the HTTP route stamped it and then handed the stamped object to a service that accepts consent, the same object shape would be reachable from the AI tool. Taking the accepting user out of band makes a valid stored blob producible *only* by a caller that has an authenticated user, and the schema in Task 1 makes it unrepresentable in a payload. A caller with no actor may still edit thresholds on an already-consented link — that is not an escalation, collection was already on — but may never turn collection on.

**This makes the AI path inert, not gated.** An assistant can still persist `hpCmsl.enabled: true` with no consent, which delivers `false` to the agent but renders as ON in the UI. Task 6 closes that door properly by escalating the write to Tier 3. Both layers stay: this one is the fail-safe that holds even if the guardrail predicate is later loosened.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/configurationPolicy.warranty.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class extends Error {},
  resolveOwnedAutomationReferences: vi.fn(),
}));
vi.mock('./automationRuntime', () => ({
  normalizeAutomationActions: vi.fn((a: unknown) => a),
  resolveAutomationReferencesForOwner: vi.fn(),
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { HP_CMSL_EULA_ID } from '@breeze/shared/validators';
import {
  WarrantyConsentError,
  addFeatureLink,
  resolveWarrantyInlineSettingsForWrite,
} from './configurationPolicy';
import { db } from '../db';

const ACTOR = { userId: 'user-1' };
const CURRENT_CONSENT = {
  acceptedByUserId: 'user-9',
  acceptedAt: '2026-01-01T00:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};

describe('resolveWarrantyInlineSettingsForWrite', () => {
  it('passes the legacy alerting-only shape through untouched', () => {
    const out = resolveWarrantyInlineSettingsForWrite(
      { enabled: true, warnDays: 90, criticalDays: 30 },
      null,
      ACTOR,
    );
    expect(out).toEqual({ enabled: true, warnDays: 90, criticalDays: 30 });
  });

  it('throws on a client-supplied consent rather than stripping it (D3)', () => {
    expect(() =>
      resolveWarrantyInlineSettingsForWrite(
        { hpCmsl: { enabled: true, consent: CURRENT_CONSENT } },
        null,
        ACTOR,
      ),
    ).toThrow();
  });

  it('stamps consent server-side when collection is switched on', () => {
    const before = Date.now();
    const out = resolveWarrantyInlineSettingsForWrite({ hpCmsl: { enabled: true } }, null, ACTOR) as any;
    expect(out.hpCmsl.enabled).toBe(true);
    expect(out.hpCmsl.consent.acceptedByUserId).toBe('user-1');
    expect(out.hpCmsl.consent.eulaId).toBe(HP_CMSL_EULA_ID);
    expect(Date.parse(out.hpCmsl.consent.acceptedAt)).toBeGreaterThanOrEqual(before);
  });

  it('refuses to enable collection for a caller with no authenticated actor (the AI-tool door)', () => {
    expect(() =>
      resolveWarrantyInlineSettingsForWrite({ hpCmsl: { enabled: true } }, null, null),
    ).toThrow(WarrantyConsentError);
  });

  it('carries a still-current acceptance across an unrelated threshold edit without re-attributing it', () => {
    const stored = { warnDays: 90, hpCmsl: { enabled: true, consent: CURRENT_CONSENT } };
    const out = resolveWarrantyInlineSettingsForWrite(
      { warnDays: 45, hpCmsl: { enabled: true } },
      stored,
      ACTOR,
    ) as any;
    expect(out.warnDays).toBe(45);
    expect(out.hpCmsl.consent).toEqual(CURRENT_CONSENT);
  });

  it('lets an actor-less caller edit thresholds on an already-consented link', () => {
    const stored = { hpCmsl: { enabled: true, consent: CURRENT_CONSENT } };
    const out = resolveWarrantyInlineSettingsForWrite(
      { warnDays: 45, hpCmsl: { enabled: true } },
      stored,
      null,
    ) as any;
    expect(out.hpCmsl.consent).toEqual(CURRENT_CONSENT);
  });

  it('re-stamps when the recorded acceptance names a superseded EULA id (D2)', () => {
    const stored = { hpCmsl: { enabled: true, consent: { ...CURRENT_CONSENT, eulaId: 'hp-cmsl-eula-2020-01-01' } } };
    const out = resolveWarrantyInlineSettingsForWrite({ hpCmsl: { enabled: true } }, stored, ACTOR) as any;
    expect(out.hpCmsl.consent.acceptedByUserId).toBe('user-1');
    expect(out.hpCmsl.consent.eulaId).toBe(HP_CMSL_EULA_ID);
  });

  it('drops the recorded consent when collection is switched off, so re-enabling re-consents', () => {
    const stored = { hpCmsl: { enabled: true, consent: CURRENT_CONSENT } };
    const out = resolveWarrantyInlineSettingsForWrite({ hpCmsl: { enabled: false } }, stored, ACTOR) as any;
    expect(out.hpCmsl).toEqual({ enabled: false });
  });

  it('leaves undefined/null settings alone (a featurePolicyId-only update)', () => {
    expect(resolveWarrantyInlineSettingsForWrite(undefined, null, ACTOR)).toBeUndefined();
    expect(resolveWarrantyInlineSettingsForWrite(null, null, ACTOR)).toBeNull();
  });
});

describe('addFeatureLink warranty backstop', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses an actor-less enable before opening a transaction', async () => {
    await expect(
      addFeatureLink('policy-1', 'warranty', null, { hpCmsl: { enabled: true } }),
    ).rejects.toThrow(WarrantyConsentError);
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('refuses a forged consent before opening a transaction', async () => {
    await expect(
      addFeatureLink('policy-1', 'warranty', null, { hpCmsl: { enabled: true, consent: CURRENT_CONSENT } }, { userId: 'user-1' }),
    ).rejects.toThrow();
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });
});
```

**Note on coverage split:** `updateFeatureLink` reads the stored row inside its own transaction, so its behaviour is exercised through `resolveWarrantyInlineSettingsForWrite` above (which is where all of the logic lives) plus the route-level tests in Task 3. Do not add a bespoke `db.transaction` double for it — the existing suite's chain helpers do not model `tx.select().from().where().limit()` followed by `tx.update()`, and a half-modelled double proves less than the pure-function cases do.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/configurationPolicy.warranty.test.ts`
Expected: FAIL — `resolveWarrantyInlineSettingsForWrite` and `WarrantyConsentError` are not exported from `./configurationPolicy`.

- [ ] **Step 3: Add the imports and the new symbols**

In `apps/api/src/services/configurationPolicy.ts`, extend the `@breeze/shared/validators` import block (`:48-57`) to:

```ts
import {
  alertRuleInlineSettingsSchema,
  backupExcludePatternsSchema,
  configFeatureInlineSettingsSchema,
  deviceLifecycleInlineSettingsSchema,
  eventLogInlineSettingsSchema,
  monitoringInlineSettingsSchema,
  onedriveHelperInlineSettingsSchema,
  remoteAccessInlineSettingsSchema as remoteAccessCapabilitySettingsSchema,
  warrantyInlineSettingsSchema,
  warrantyHpCmslCollectionEffective,
  readRecordedWarrantyHpCmslConsent,
  HP_CMSL_EULA_ID,
  type WarrantyHpCmslConsent,
} from '@breeze/shared/validators';
```

Add, immediately above `export async function addFeatureLink(` (`:1474`):

```ts
/**
 * Raised when a caller asks to enable HP CMSL warranty collection but cannot
 * record an acceptance of HP's licence (#5511 W02, contract D3).
 *
 * Its own class, mirroring AutomationReferenceAuthorizationError, so the HTTP
 * routes and the AI tool can map it to a 400 with a useful message instead of
 * letting a bare Error reach the global onError handler as a 500.
 */
export class WarrantyConsentError extends Error {
  readonly code = 'warranty_hp_cmsl_consent_required' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WarrantyConsentError';
  }
}

/**
 * The authenticated user on whose behalf a warranty consent may be stamped.
 * Supplied OUT OF BAND by the HTTP routes — never read from the payload, and
 * never available to `manage_policy_feature_link`, which is why an assistant
 * cannot switch collection on. `null`/`undefined` means "this caller cannot
 * accept a licence".
 */
export type WarrantyConsentActor = { userId: string } | null | undefined;

/**
 * Validates a warranty inline-settings payload and returns the value to store.
 *
 * Contract, in order:
 *  1. `warrantyInlineSettingsSchema` has no `consent` key and is `.strict()`,
 *     so a client-supplied acceptance THROWS here rather than being stripped
 *     (D3). The HTTP routes catch this earlier and return a coded 400; this
 *     parse is the backstop for every other caller.
 *  2. Not enabling collection (absent block, or `enabled: false`) stores the
 *     parsed value as-is. Any previously recorded acceptance goes with the old
 *     block: re-enabling later re-consents rather than silently reusing an
 *     acceptance by a user who may have left the partner.
 *  3. Enabling with a still-current acceptance already on the row carries that
 *     acceptance forward verbatim, so an unrelated threshold edit does not
 *     churn `acceptedAt` or re-attribute who accepted.
 *  4. Enabling with no acceptance — or one naming a superseded EULA id (D2) —
 *     stamps a fresh one from `actor` and the SERVER clock, or throws when
 *     there is no actor.
 *
 * Exported for direct unit testing: this function is the whole of the consent
 * rule, and it is the thing worth pinning.
 */
export function resolveWarrantyInlineSettingsForWrite(
  incoming: unknown,
  stored: unknown,
  actor: WarrantyConsentActor,
): unknown {
  if (incoming === undefined || incoming === null) return incoming;

  const parsed = warrantyInlineSettingsSchema.parse(incoming);
  if (parsed.hpCmsl?.enabled !== true) return parsed;

  if (warrantyHpCmslCollectionEffective(stored)) {
    const carried = readRecordedWarrantyHpCmslConsent(stored) as WarrantyHpCmslConsent;
    return { ...parsed, hpCmsl: { enabled: true, consent: carried } };
  }

  if (!actor?.userId) {
    throw new WarrantyConsentError(
      'Enabling HP CMSL warranty collection records an acceptance of HP\'s licence, which requires an authenticated user. This caller cannot record one.',
    );
  }

  return {
    ...parsed,
    hpCmsl: {
      enabled: true,
      consent: {
        acceptedByUserId: actor.userId,
        acceptedAt: new Date().toISOString(),
        eulaId: HP_CMSL_EULA_ID,
      },
    },
  };
}
```

- [ ] **Step 4: Wire it into both write paths**

In `addFeatureLink`, change the signature and add the warranty arm after the `device_lifecycle` arm (`:1492-1494`):

```ts
export async function addFeatureLink(
  configPolicyId: string,
  featureType: ConfigFeatureType,
  featurePolicyId?: string | null,
  inlineSettings?: unknown,
  consentActor?: WarrantyConsentActor
) {
```

```ts
  // #5511 W02: warranty gains an hpCmsl block whose consent only the server may
  // write. There is no stored row yet on this path, so `stored` is null and an
  // enable always stamps fresh.
  if (featureType === 'warranty' && inlineSettings !== undefined && inlineSettings !== null) {
    inlineSettings = resolveWarrantyInlineSettingsForWrite(inlineSettings, null, consentActor);
  }
```

In `updateFeatureLink`, change the signature:

```ts
export async function updateFeatureLink(
  linkId: string,
  updates: { featurePolicyId?: string | null; inlineSettings?: unknown },
  configPolicyId?: string,
  consentActor?: WarrantyConsentActor
) {
```

and add the warranty arm inside the transaction, immediately after the `device_lifecycle` arm (`:1592-1594`) — it must come after `existing` is read, because the carry-forward rule needs the stored blob:

```ts
    // #5511 W02: same consent rule as addFeatureLink, but with the row's
    // current settings in hand so a still-current acceptance survives an
    // unrelated edit. REPLACE semantics (not merge, contract D5): settings sent
    // without an hpCmsl block drop it, which revokes collection.
    if (existing.featureType === 'warranty' && updates.inlineSettings !== undefined && updates.inlineSettings !== null) {
      updates.inlineSettings = resolveWarrantyInlineSettingsForWrite(
        updates.inlineSettings,
        existing.inlineSettings,
        consentActor,
      );
    }
```

- [ ] **Step 5: Register the schema on the AI-tool surface**

In `apps/api/src/services/aiToolsConfigPolicy.ts`, extend `VALIDATED_INLINE_SETTINGS` (`:71-75`) so an assistant gets a field-level message instead of a bare service throw. Import `warrantyInlineSettingsSchema` from `@breeze/shared/validators` alongside the existing schema imports.

```ts
const VALIDATED_INLINE_SETTINGS: Record<string, { schema: { safeParse: (raw: unknown) => any }; normalize: boolean }> = {
  onedrive_helper: { schema: onedriveHelperInlineSettingsSchema, normalize: true },
  alert_rule: { schema: alertRuleInlineSettingsSchema, normalize: true },
  monitoring: { schema: monitoringInlineSettingsSchema, normalize: false },
  // #5511 W02: the CLIENT schema, so an assistant that invents an hpCmsl
  // consent object is told which field is wrong. It still cannot ENABLE
  // collection — addFeatureLink refuses without an authenticated actor, and
  // this Tier-2 tool has none.
  warranty: { schema: warrantyInlineSettingsSchema, normalize: false },
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/configurationPolicy.warranty.test.ts`
Expected: PASS.

Regression check on the suites that already exercise these two functions and the AI tool (all must stay green — the reserved-key scan still runs first, and both new parameters are optional):
Run: `cd apps/api && npx vitest run src/services/configurationPolicy.test.ts src/services/configurationPolicy.backupExcludes.test.ts src/services/aiToolsConfigPolicy.test.ts src/services/aiToolsConfigPolicy.siteScope.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.warranty.test.ts apps/api/src/services/aiToolsConfigPolicy.ts
git commit -m "feat(api): warranty inline-settings validation with a server-stamped, out-of-band HP CMSL consent (#5511 W02 D3)"
```

---

### Task 3: HTTP routes — coded consent refusal, warranty schema parse, actor hand-off

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts` (shared-validator import `:6-13`; service import `:19-33`; POST warranty block after the `device_lifecycle` block at `:206-214`; POST `addFeatureLink` call `:277-282` and its catch `:283-289`; PATCH warranty block after the `device_lifecycle` arm at `:400-409`; PATCH `updateFeatureLink` call `:461` and its catch `:462-468`)
- Test: `apps/api/src/routes/configurationPolicies/featureLinks.test.ts` (add one `describe`)

**Interfaces:**
- Consumes: Task 1's `warrantyInlineSettingsSchema` and `clientSuppliedWarrantyHpCmslConsent`; Task 2's `WarrantyConsentError` and the fifth/fourth `consentActor` parameters.
- Produces: the coded body `{ error: string; code: 'WARRANTY_CONSENT_NOT_CLIENT_SETTABLE' }` at HTTP 400, which Task 12's UI must never trigger.

**Ordering matters.** The consent refusal runs before the schema parse. Both are 400s, but `.strict()` would report a generic `Unrecognized key: "consent"` with no `code`, and D3 exists so a client can *tell* that its consent was refused. Same shape as the `alert_rule` ordering already in this file (`:240-247`), where the specific offline-duration message deliberately wins over the enum/range message.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/configurationPolicies/featureLinks.test.ts`, inside the top-level `describe('featureLinks routes', ...)`:

```ts
  // ============================================================
  // #5511 W02 — warranty hpCmsl block, server-stamped consent (D3)
  // ============================================================

  describe('warranty inlineSettings validation and consent', () => {
    const CONSENT = {
      acceptedByUserId: 'attacker',
      acceptedAt: '2020-01-01T00:00:00.000Z',
      eulaId: 'hp-cmsl-eula-2026-04-01',
    };

    beforeEach(() => {
      getConfigPolicyMock.mockResolvedValue({
        ...STUB_POLICY,
        featureLinks: [{ id: LINK_ID, featureType: 'warranty', inlineSettings: {} }],
      });
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID });
      updateFeatureLinkMock.mockResolvedValue({ id: LINK_ID });
    });

    it('POST refuses a client-supplied consent with a coded 400 and never calls the service', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'warranty',
          inlineSettings: { hpCmsl: { enabled: true, consent: CONSENT } },
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'WARRANTY_CONSENT_NOT_CLIENT_SETTABLE' });
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('PATCH refuses a client-supplied consent with the same coded 400', async () => {
      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inlineSettings: { hpCmsl: { enabled: true, consent: CONSENT } } }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'WARRANTY_CONSENT_NOT_CLIENT_SETTABLE' });
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('POST rejects an unknown warranty key instead of persisting it', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'warranty', inlineSettings: { hpCsml: { enabled: true } } }),
      });

      expect(res.status).toBe(400);
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('POST passes the authenticated user to the service as the consent actor', async () => {
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'warranty',
          inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30, hpCmsl: { enabled: true } },
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalledWith(
        POLICY_ID,
        'warranty',
        undefined,
        { enabled: true, warnDays: 90, criticalDays: 30, hpCmsl: { enabled: true } },
        { userId: 'user-1' },
      );
    });

    it('PATCH passes the authenticated user to the service as the consent actor', async () => {
      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inlineSettings: { hpCmsl: { enabled: false } } }),
      });

      expect(res.status).toBe(200);
      expect(updateFeatureLinkMock).toHaveBeenCalledWith(
        LINK_ID,
        expect.objectContaining({ inlineSettings: { hpCmsl: { enabled: false } } }),
        POLICY_ID,
        { userId: 'user-1' },
      );
    });

    it('maps a WarrantyConsentError from the service to a 400, not a 500', async () => {
      const { WarrantyConsentError } = await import('../../services/configurationPolicy');
      addFeatureLinkMock.mockRejectedValueOnce(new WarrantyConsentError('nope'));

      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: true } } }),
      });

      expect(res.status).toBe(400);
    });
  });
```

**Note:** these cases run with the file's default `mfaState.satisfied = true`. Task 5 adds the `devices.execute` gate ahead of the service call, so once that lands this `describe` also needs `permissions` seeded — Task 5's step 5 says exactly what to add and this `describe` is one of the places it applies.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/configurationPolicies/featureLinks.test.ts`
Expected: FAIL — the coded cases return 201/200 (the payload sails through today), and the actor assertions fail with a 4-argument call.

- [ ] **Step 3: Extend the imports**

`apps/api/src/routes/configurationPolicies/featureLinks.ts` — shared validators (`:6-13`):

```ts
import {
  alertRuleInlineSettingsSchema,
  backupInlineSettingsSchema,
  backupProfileLinkedInlineSettingsSchema,
  clientSuppliedWarrantyHpCmslConsent,
  monitoringInlineSettingsSchema,
  onedriveHelperInlineSettingsSchema,
  patchInlineSettingsSchema,
  warrantyInlineSettingsSchema,
} from '@breeze/shared/validators';
```

and add `WarrantyConsentError,` to the `'../../services/configurationPolicy'` import list (`:19-33`).

- [ ] **Step 4: Add the POST branch and hand over the actor**

Insert after the `device_lifecycle` block (which ends at `:214`):

```ts
    // #5511 W02 (contract D3): the consent refusal runs FIRST and on its own so
    // a client that supplied one gets a coded, actionable 400. Letting the
    // strict schema report it would produce a bare "Unrecognized key" with no
    // `code`, and silently stripping it would let a UI believe an acceptance
    // had been recorded when none was.
    if (data.featureType === 'warranty' && data.inlineSettings) {
      if (clientSuppliedWarrantyHpCmslConsent(data.inlineSettings)) {
        return c.json(
          {
            error: 'HP CMSL consent is recorded by the server from your authenticated session. Remove hpCmsl.consent from the request and send it again.',
            code: 'WARRANTY_CONSENT_NOT_CLIENT_SETTABLE',
          },
          400
        );
      }
      const parsed = warrantyInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          zodValidationErrorBody('Invalid warranty settings', parsed.error),
          400
        );
      }
      data.inlineSettings = parsed.data;
    }
```

Change the `addFeatureLink` call (`:277-282`) to pass the actor, and extend its catch (`:283-289`):

```ts
    let link;
    try {
      link = await addFeatureLink(
        id,
        data.featureType,
        data.featurePolicyId,
        data.inlineSettings,
        { userId: auth.user.id }
      );
    } catch (error) {
      if (error instanceof AutomationReferenceAuthorizationError) {
        return c.json({ error: 'Unknown or unauthorized automation reference' }, 400);
      }
      if (error instanceof WarrantyConsentError) {
        return c.json({ error: error.message, code: 'WARRANTY_CONSENT_NOT_CLIENT_SETTABLE' }, 400);
      }
      throw error;
    }
```

- [ ] **Step 5: Add the PATCH branch and hand over the actor**

Insert inside the `if (data.inlineSettings) {` block, after the `device_lifecycle` arm (`:400-409`):

```ts
      if (existingLink.featureType === 'warranty') {
        // Same ordering and reasoning as the POST route above (#5511 W02, D3).
        if (clientSuppliedWarrantyHpCmslConsent(data.inlineSettings)) {
          return c.json(
            {
              error: 'HP CMSL consent is recorded by the server from your authenticated session. Remove hpCmsl.consent from the request and send it again.',
              code: 'WARRANTY_CONSENT_NOT_CLIENT_SETTABLE',
            },
            400
          );
        }
        const parsed = warrantyInlineSettingsSchema.safeParse(data.inlineSettings);
        if (!parsed.success) {
          return c.json(
            zodValidationErrorBody('Invalid warranty settings', parsed.error),
            400
          );
        }
        data.inlineSettings = parsed.data;
      }
```

Change the `updateFeatureLink` call and its catch (`:459-468`):

```ts
    let updated;
    try {
      updated = await updateFeatureLink(linkId, data, id, { userId: auth.user.id });
    } catch (error) {
      if (error instanceof AutomationReferenceAuthorizationError) {
        return c.json({ error: 'Unknown or unauthorized automation reference' }, 400);
      }
      if (error instanceof WarrantyConsentError) {
        return c.json({ error: error.message, code: 'WARRANTY_CONSENT_NOT_CLIENT_SETTABLE' }, 400);
      }
      throw error;
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/configurationPolicies/featureLinks.test.ts src/routes/configurationPolicies/featureLinks.remoteAccess.test.ts src/routes/configurationPolicies/featureLinks.siteScope.test.ts`
Expected: PASS, 3 files. (Listing the siblings explicitly — a bare `src/routes/configurationPolicies/featureLinks` substring filter would also pull them in, but naming them is what makes the run auditable.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/routes/configurationPolicies/featureLinks.test.ts
git commit -m "feat(api): refuse client-supplied HP CMSL consent with a coded 400 and stamp it from the session (#5511 W02 D3)"
```

---

### Task 4: D12 — the missing inline-only guard arm for `warranty`

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts:2656-2662`
- Test: `apps/api/src/services/configurationPolicy.warrantyGuard.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `validateFeaturePolicyExists('warranty', <any id>, owner)` now returns `{ valid: false, error: 'warranty feature type does not support featurePolicyId; use inlineSettings instead' }`.

**What is broken today:** `warranty` is inline-only (no policy table — `configurationPolicy.ts:1062-1068`, `:1416-1422`) but is absent from the guard list, so a `featurePolicyId` falls through to the generic whole-policy-linking lookup at `:2699-2704`. That lookup succeeds for any id naming a configuration policy in the same org, the write proceeds, and the `config_policy_feature_links_reference_integrity` trigger rejects it — a 500 where the caller should have got a 400 naming the mistake. The code's own comment at `:2663-2669` describes exactly this. The UI never sends one (`WarrantyTab.tsx:51,65` hardcode `featurePolicyId: null`), so this is API surface only; verified by reading, not reproduced at runtime.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/configurationPolicy.warrantyGuard.test.ts` (modelled on `configurationPolicy.deviceLifecycle.test.ts`, including the deliberately-permissive db double):

```ts
import { describe, it, expect, vi } from 'vitest';

// `warranty` is inline-only, so a correct implementation never reaches the
// database at all. The db double deliberately returns a MATCHING
// configuration-policy row for the whole-policy-linking lookup: that is the
// exact shape that makes a stray featurePolicyId pass validation and then blow
// up as a 500 on the `config_policy_feature_links_reference_integrity`
// trigger. With the guard removed this mock lets the fall-through succeed
// rather than crash, so the test fails on the assertion instead of on an
// incidental TypeError.
vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 'cfg-policy-1' }],
        }),
      }),
    }),
  },
  withDbAccessContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn(),
}));

import { validateFeaturePolicyExists } from './configurationPolicy';

describe('warranty feature type is inline-only (#5511 W02, contract D12)', () => {
  it('rejects a featurePolicyId with a 400-shaped result instead of letting the DB trigger 500', async () => {
    const res = await validateFeaturePolicyExists('warranty', 'cfg-policy-1', {
      orgId: 'org-1',
      partnerId: null,
    });

    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/does not support featurePolicyId/);
  });

  it('rejects it for a partner-wide policy too', async () => {
    const res = await validateFeaturePolicyExists('warranty', 'cfg-policy-1', {
      orgId: null,
      partnerId: 'partner-1',
    });

    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/does not support featurePolicyId/);
  });

  it('accepts inline-only (no featurePolicyId)', async () => {
    const res = await validateFeaturePolicyExists('warranty', null, {
      orgId: 'org-1',
      partnerId: null,
    });

    expect(res.valid).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/configurationPolicy.warrantyGuard.test.ts`
Expected: FAIL on the first two cases — `res.valid` is `true`, because the fall-through found the mocked config-policy row. (The third case passes already; that is the control proving the mock is not simply denying everything.)

- [ ] **Step 3: Add `warranty` to the guard list**

`apps/api/src/services/configurationPolicy.ts:2656-2662` becomes:

```ts
  if (
    featureType === 'monitoring' ||
    featureType === 'event_log' ||
    featureType === 'onedrive_helper' ||
    featureType === 'vulnerability' ||
    featureType === 'device_lifecycle' ||
    featureType === 'warranty'
  ) {
```

Leave the comment block at `:2663-2669` untouched — it already explains why the omission mattered.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/configurationPolicy.warrantyGuard.test.ts src/services/configurationPolicy.deviceLifecycle.test.ts src/services/configurationPolicy.onedrive.test.ts`
Expected: PASS, 3 files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.warrantyGuard.test.ts
git commit -m "fix(api): warranty is inline-only — 400 on a stray featurePolicyId instead of a trigger 500 (#5511 W02 D12)"
```

---

### Task 5: The authorization gate — `devices.execute` + MFA on every transition that exposes a device to collection

**Files:**
- Create: `apps/api/src/routes/configurationPolicies/hpCmslGate.ts`
- Create: `apps/api/src/routes/configurationPolicies/hpCmslGate.test.ts`
- Modify: `apps/api/src/services/configurationPolicy.ts` (new `parentPolicyEnablesHpCmslCollection`, next to `getParentLinkFeatureTypes` at `:503-509`)
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts` (POST after `:145-147`; PATCH after `:340-341`; DELETE at `:519-526`)
- Modify: `apps/api/src/routes/configurationPolicies/assignments.ts` (POST `/:id/assignments`, after the site-authorization check at `:121-124`)
- Modify: `apps/api/src/routes/configurationPolicies/crud.ts` (POST `/`, inside the `if (data.parentPolicyId)` block at `:78-83`)
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.test.ts`
- Create: `apps/api/src/routes/configurationPolicies/assignments.hpCmsl.test.ts`

**Interfaces:**
- Consumes: Task 1's `warrantyHpCmslRequested` and `warrantyHpCmslCollectionEffective`.
- Produces:
  - `export type HpCmslGateResult = { allowed: true } | { allowed: false; body: { error: string; code: string } }`
  - `export function checkHpCmslWriteAllowed(auth: AuthContext, perms: UserPermissions | undefined): HpCmslGateResult`
  - `export function warrantyLinkEnablesCollection(links: ReadonlyArray<{ featureType: string; inlineSettings?: unknown }> | undefined | null): boolean`
  - `export async function parentPolicyEnablesHpCmslCollection(parentId: string): Promise<boolean>` (from `configurationPolicy.ts`)

**The five transitions, and why each one is here.** D4 says the gate covers "create, update, AND any assignment/inheritance transition that newly exposes a device to an `hpCmsl.enabled` link". Enumerated against this codebase, that is exactly five doors, and they split into two kinds:

| # | Door | Predicate | Kind |
|---|---|---|---|
| 1 | `POST /:id/features` with `warranty` | `warrantyHpCmslRequested(data.inlineSettings)` | request (pre-stamp) |
| 2 | `PATCH /:id/features/:linkId` on a `warranty` link | `warrantyHpCmslRequested(data.inlineSettings)` | request (pre-stamp) |
| 3 | `DELETE /:id/features/:linkId` on a `warranty` link whose parent policy carries a collecting warranty link | `warrantyHpCmslCollectionEffective(parent link)` | stored |
| 4 | `POST /:id/assignments` for a policy whose effective warranty link collects | `warrantyHpCmslCollectionEffective(own link, else parent's)` | stored |
| 5 | `POST /` with `parentPolicyId` naming a policy whose warranty link collects | `warrantyHpCmslCollectionEffective(parent link)` | stored |

Doors 1-2 use the **request** predicate because consent has not been stamped yet at gate time — using the consent-qualified one there makes the gate a permanent no-op, which is the single easiest way to ship this feature ungated. Doors 3-5 read **stored** rows, where a consent is always present on anything written through door 1 or 2, and where a superseded EULA id means collection is already off — so exposing a device to it is not an escalation and needs no gate.

Door 3 is the direct analogue of the maintenance `revertRestoresParentWindow` rule already at `:519-526`, including its **fail-closed** `parentUnresolved` clause: `parentPolicyId` set but `parentPolicy` null means the parent was invisible to this read, which is an anomaly, and treating "can't tell" as "no parent" would silently drop the requirement.

Door 5 is bounded by the schema: `grep -n parentPolicyId apps/api/src/routes/configurationPolicies/crud.ts` shows `parentPolicyId` is accepted on CREATE only and never on PATCH, so there is no re-parenting door to cover.

**Not gated, on purpose:** `DELETE /:id/assignments/:aid` and any write whose result is `hpCmsl.enabled: false`. Both move in the revoking direction — the fail-safe one — and are audited by the existing `writeRouteAudit` calls. This mirrors the reasoning already written into `MFA_GATED_FEATURE_TYPES`' doc comment: "REMOVAL IS MOSTLY NOT GATED".

**There is a sixth door, and it is not an HTTP route.** `manage_policy_feature_link` reaches `addFeatureLink` / `updateFeatureLink` directly, at Tier 2, without traversing any handler in this task. It is closed in **Task 6**, at the guardrails layer, because that is the only place an AI tool call is classified. Do not try to solve it here — there is no `auth`/`permissions` context on that path to gate against.

- [ ] **Step 1: Write the failing test for the gate helper**

Create `apps/api/src/routes/configurationPolicies/hpCmslGate.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

const { mfaState } = vi.hoisted(() => ({ mfaState: { satisfied: true } }));

vi.mock('../../middleware/auth', () => ({
  hasSatisfiedMfa: vi.fn(() => mfaState.satisfied),
}));

import { checkHpCmslWriteAllowed, warrantyLinkEnablesCollection } from './hpCmslGate';
import { HP_CMSL_EULA_ID } from '@breeze/shared/validators';

const CONSENT = {
  acceptedByUserId: 'user-1',
  acceptedAt: '2026-09-10T00:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};

const auth = { token: { mfa: true } } as any;
const perms = (grants: Array<{ resource: string; action: string }>) =>
  ({ permissions: grants } as any);

const EXECUTE = [{ resource: 'devices', action: 'execute' }];
const WRITE_ONLY = [{ resource: 'devices', action: 'write' }];

describe('checkHpCmslWriteAllowed', () => {
  it('allows a caller with devices.execute and satisfied MFA', () => {
    mfaState.satisfied = true;
    expect(checkHpCmslWriteAllowed(auth, perms(EXECUTE))).toEqual({ allowed: true });
  });

  it('denies devices.write-only with a coded body, not an MFA message', () => {
    mfaState.satisfied = true;
    const res = checkHpCmslWriteAllowed(auth, perms(WRITE_ONLY));
    expect(res.allowed).toBe(false);
    expect(res).toMatchObject({ body: { code: 'HP_CMSL_EXECUTE_REQUIRED' } });
  });

  it('denies an execute-capable caller who has not satisfied MFA, with the MFA_REQUIRED code', () => {
    mfaState.satisfied = false;
    const res = checkHpCmslWriteAllowed(auth, perms(EXECUTE));
    expect(res.allowed).toBe(false);
    expect(res).toMatchObject({ body: { error: 'MFA required', code: 'MFA_REQUIRED' } });
  });

  it('fails closed when permissions were never resolved', () => {
    mfaState.satisfied = true;
    expect(checkHpCmslWriteAllowed(auth, undefined).allowed).toBe(false);
  });
});

describe('warrantyLinkEnablesCollection', () => {
  it('is true for a warranty link with a current consent', () => {
    expect(
      warrantyLinkEnablesCollection([
        { featureType: 'patch', inlineSettings: {} },
        { featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: true, consent: CONSENT } } },
      ]),
    ).toBe(true);
  });

  it('is false with no warranty link, a disabled block, or no links at all', () => {
    expect(warrantyLinkEnablesCollection([{ featureType: 'patch', inlineSettings: {} }])).toBe(false);
    expect(
      warrantyLinkEnablesCollection([{ featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: false } } }]),
    ).toBe(false);
    expect(warrantyLinkEnablesCollection([])).toBe(false);
    expect(warrantyLinkEnablesCollection(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/configurationPolicies/hpCmslGate.test.ts`
Expected: FAIL — `Failed to resolve import "./hpCmslGate"`.

- [ ] **Step 3: Write the gate helper**

Create `apps/api/src/routes/configurationPolicies/hpCmslGate.ts`:

```ts
import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import { warrantyHpCmslCollectionEffective } from '@breeze/shared/validators';

/**
 * Authorization for the config-policy writes that switch on — or newly expose a
 * device to — device-side HP CMSL warranty collection (#5511 W02, contract D4).
 *
 * Enabling collection causes HP's ~100 MB CMSL module to be installed on every
 * HP endpoint the policy reaches. Creating a software deployment requires
 * `devices.execute` PLUS satisfied MFA (`routes/software.ts`), so a
 * `devices.write` route that causes the same install would be a
 * privilege-escalation path around that gate.
 *
 * `warranty` is deliberately NOT added to MFA_GATED_FEATURE_TYPES: that set is
 * keyed on feature TYPE and would force MFA on a pure alert-threshold edit,
 * which installs nothing. This gate is keyed on the RESULT of the write, and
 * follows the in-handler, feature-type-conditional pattern the maintenance
 * gates in featureLinks.ts already established.
 *
 * Turning collection OFF is not gated. That is the fail-safe direction, and it
 * is audited like every other feature-link write.
 */
export type HpCmslGateResult =
  | { allowed: true }
  | { allowed: false; body: { error: string; code: string } };

export function checkHpCmslWriteAllowed(
  auth: AuthContext,
  perms: UserPermissions | undefined,
): HpCmslGateResult {
  // Fail closed. Every route behind requireConfigPolicyWrite has permissions
  // resolved by requirePermission (middleware/auth.ts:874), so `undefined` here
  // means the middleware chain changed shape — deny rather than infer consent.
  if (
    !perms
    || !hasPermission(perms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)
  ) {
    return {
      allowed: false,
      body: {
        error:
          'Enabling HP warranty collection installs HP software on the devices this policy reaches, so it requires the devices:execute permission — the same permission a software deployment requires.',
        code: 'HP_CMSL_EXECUTE_REQUIRED',
      },
    };
  }

  // Session-claim strength, matching the adjacent patch/maintenance gates. The
  // body shape is requireMfa()'s (middleware/auth.ts:904) so callers can branch
  // on `code` exactly as they already do for every other MFA refusal.
  if (!hasSatisfiedMfa(auth)) {
    return { allowed: false, body: { error: 'MFA required', code: 'MFA_REQUIRED' } };
  }

  return { allowed: true };
}

/**
 * True when a policy's OWN feature links contain a warranty link that actually
 * delivers collection (enabled AND consented against the current EULA id).
 *
 * Takes the links array `getConfigPolicy` already returns — for the policy
 * itself or for its `parentPolicy` — so the gates need no extra query.
 */
export function warrantyLinkEnablesCollection(
  links: ReadonlyArray<{ featureType: string; inlineSettings?: unknown }> | undefined | null,
): boolean {
  if (!links) return false;
  const warranty = links.find((l) => l.featureType === 'warranty');
  return warrantyHpCmslCollectionEffective(warranty?.inlineSettings);
}
```

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `cd apps/api && npx vitest run src/routes/configurationPolicies/hpCmslGate.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

In `apps/api/src/routes/configurationPolicies/featureLinks.test.ts`, first make permissions controllable. Extend the hoisted state and `buildApp`:

```ts
const { mfaState, permState } = vi.hoisted(() => ({
  mfaState: { satisfied: true },
  // Default to the strongest grant so every pre-existing case in this file
  // keeps its current meaning; the hpCmsl cases narrow it per test.
  permState: { permissions: { permissions: [{ resource: '*', action: '*' }] } as any },
}));
```

```ts
function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', makeAuth());
    c.set('permissions', permState.permissions);
    await next();
  });
  app.route('/', featureLinkRoutes);
  return app;
}
```

and reset it in the top-level `beforeEach` alongside `mfaState.satisfied = true`:

```ts
    permState.permissions = { permissions: [{ resource: '*', action: '*' }] } as any;
```

Then append this `describe` inside `describe('featureLinks routes', ...)`:

```ts
  // ============================================================
  // #5511 W02 — the hpCmsl authorization gate (contract D4)
  // ============================================================

  describe('hpCmsl authorization gate', () => {
    const CONSENT = {
      acceptedByUserId: 'user-1',
      acceptedAt: '2026-09-10T00:00:00.000Z',
      eulaId: 'hp-cmsl-eula-2026-04-01',
    };
    const WRITE_ONLY = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    const EXECUTE = { permissions: [{ resource: 'devices', action: 'execute' }] } as any;

    const collectingLink = (id: string) => ({
      id,
      featureType: 'warranty',
      inlineSettings: { hpCmsl: { enabled: true, consent: CONSENT } },
    });

    beforeEach(() => {
      addFeatureLinkMock.mockResolvedValue({ id: LINK_ID });
      updateFeatureLinkMock.mockResolvedValue({ id: LINK_ID });
      removeFeatureLinkMock.mockResolvedValue({ id: LINK_ID, featureType: 'warranty' });
      getConfigPolicyMock.mockResolvedValue(STUB_POLICY);
    });

    it('POST enabling collection is refused for devices.write-only', async () => {
      permState.permissions = WRITE_ONLY;
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: true } } }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'HP_CMSL_EXECUTE_REQUIRED' });
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('POST enabling collection is refused when MFA is not satisfied', async () => {
      permState.permissions = EXECUTE;
      mfaState.satisfied = false;
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: true } } }),
      });

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
      expect(addFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('POST of alert thresholds only is NOT gated — devices.write still suffices', async () => {
      permState.permissions = WRITE_ONLY;
      const res = await app.request(`/${POLICY_ID}/features`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          featureType: 'warranty',
          inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 },
        }),
      });

      expect(res.status).toBe(201);
      expect(addFeatureLinkMock).toHaveBeenCalled();
    });

    it('PATCH turning collection OFF is NOT gated (fail-safe direction)', async () => {
      permState.permissions = WRITE_ONLY;
      getConfigPolicyMock.mockResolvedValue({ ...STUB_POLICY, featureLinks: [collectingLink(LINK_ID)] });

      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inlineSettings: { hpCmsl: { enabled: false } } }),
      });

      expect(res.status).toBe(200);
      expect(updateFeatureLinkMock).toHaveBeenCalled();
    });

    it('PATCH turning collection ON is gated', async () => {
      permState.permissions = WRITE_ONLY;
      getConfigPolicyMock.mockResolvedValue({
        ...STUB_POLICY,
        featureLinks: [{ id: LINK_ID, featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: false } } }],
      });

      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inlineSettings: { hpCmsl: { enabled: true } } }),
      });

      expect(res.status).toBe(403);
      expect(updateFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('DELETE of a warranty link that REVERTS to a collecting parent is gated (inheritance transition)', async () => {
      permState.permissions = WRITE_ONLY;
      getConfigPolicyMock.mockResolvedValue({
        ...STUB_POLICY,
        parentPolicyId: PARENT_POLICY_ID,
        parentPolicy: { id: PARENT_POLICY_ID, featureLinks: [collectingLink('parent-link')] },
        featureLinks: [{ id: LINK_ID, featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: false } } }],
      });

      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(403);
      expect(removeFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('DELETE fails CLOSED when the parent row could not be resolved', async () => {
      permState.permissions = WRITE_ONLY;
      getConfigPolicyMock.mockResolvedValue({
        ...STUB_POLICY,
        parentPolicyId: PARENT_POLICY_ID,
        parentPolicy: null,
        featureLinks: [{ id: LINK_ID, featureType: 'warranty', inlineSettings: {} }],
      });

      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(403);
      expect(removeFeatureLinkMock).not.toHaveBeenCalled();
    });

    it('DELETE of a warranty link with no parent link is NOT gated — it only revokes', async () => {
      permState.permissions = WRITE_ONLY;
      getConfigPolicyMock.mockResolvedValue({
        ...STUB_POLICY,
        featureLinks: [collectingLink(LINK_ID)],
      });

      const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(removeFeatureLinkMock).toHaveBeenCalled();
    });
  });
```

- [ ] **Step 6: Run the route tests to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/configurationPolicies/featureLinks.test.ts`
Expected: FAIL — the four gated cases return 201/200/200 instead of 403.

- [ ] **Step 7: Wire the gate into featureLinks.ts**

Add to the imports:

```ts
import { warrantyHpCmslRequested } from '@breeze/shared/validators';
import type { UserPermissions } from '../../services/permissions';
import { checkHpCmslWriteAllowed, warrantyLinkEnablesCollection } from './hpCmslGate';
```

POST — insert immediately after the existing MFA check (`:145-147`):

```ts
    // #5511 W02 (contract D4): enabling device-side HP warranty collection
    // installs HP software on every HP endpoint this policy reaches, so it
    // carries the deployment gate — devices.execute AND satisfied MFA — rather
    // than the plain devices.write every other feature-link write needs.
    // Keyed on the RESULT of the write, not the feature type: an alert-threshold
    // edit installs nothing and stays ungated.
    if (data.featureType === 'warranty' && warrantyHpCmslRequested(data.inlineSettings)) {
      const gate = checkHpCmslWriteAllowed(auth, c.get('permissions') as UserPermissions | undefined);
      if (!gate.allowed) return c.json(gate.body, 403);
    }
```

PATCH — insert immediately after the existing MFA check (`:340-341`):

```ts
    // Same gate as the POST route (#5511 W02, D4). `data.inlineSettings` is the
    // whole replacement blob (warranty updates are replace, not merge — D5), so
    // the request predicate reads the post-write state directly.
    if (existingLink.featureType === 'warranty' && warrantyHpCmslRequested(data.inlineSettings)) {
      const gate = checkHpCmslWriteAllowed(auth, c.get('permissions') as UserPermissions | undefined);
      if (!gate.allowed) return c.json(gate.body, 403);
    }
```

DELETE — extend the block at `:519-526`. `parentUnresolved` and `parentHasSameType` already exist; add the warranty arm beside `revertRestoresParentWindow` and gate it separately, because its refusal is the coded execute/MFA body rather than the bare `MFA required`:

```ts
    const parentUnresolved = !!policy.parentPolicyId && !policy.parentPolicy;
    const parentHasSameType = !!policy.parentPolicy?.featureLinks?.some(
      (l: { featureType: string }) => l.featureType === existingLink.featureType,
    );
    const revertRestoresParentWindow = existingLink.featureType === 'maintenance'
      && (parentUnresolved || parentHasSameType);
    if ((existingLink.featureType === 'patch' || revertRestoresParentWindow) && !hasSatisfiedMfa(auth)) {
      return c.json({ error: 'MFA required' }, 403);
    }

    // #5511 W02 (contract D4/D5): deleting a warranty link is normally a pure
    // revocation and stays ungated — but with a parent that COLLECTS, this
    // delete does not end collection, it reverts to the parent's link and
    // starts it. Same premise-stops-holding shape as maintenance above. Fails
    // CLOSED on an unresolvable parent for the same reason.
    const revertStartsHpCmslCollection = existingLink.featureType === 'warranty'
      && (parentUnresolved || warrantyLinkEnablesCollection(policy.parentPolicy?.featureLinks));
    if (revertStartsHpCmslCollection) {
      const gate = checkHpCmslWriteAllowed(auth, c.get('permissions') as UserPermissions | undefined);
      if (!gate.allowed) return c.json(gate.body, 403);
    }
```

- [ ] **Step 8: Add the service helper for the create-with-parent door**

In `apps/api/src/services/configurationPolicy.ts`, immediately after `getParentLinkFeatureTypes` (`:509`):

```ts
/**
 * True when the named parent policy carries a warranty link that actually
 * delivers HP CMSL collection (#5511 W02, contract D4).
 *
 * Its own function rather than a widening of getParentLinkFeatureTypes, which
 * returns feature TYPES only: the warranty gate is keyed on a value inside the
 * link's JSONB, not on the presence of a link.
 *
 * One level is all that is needed — a parent must itself be a root policy
 * (`parent_policy_id IS NULL`, see listEligibleParentPolicies), so there is no
 * grandparent to walk.
 */
export async function parentPolicyEnablesHpCmslCollection(parentId: string): Promise<boolean> {
  const [row] = await db
    .select({ inlineSettings: configPolicyFeatureLinks.inlineSettings })
    .from(configPolicyFeatureLinks)
    .where(
      and(
        eq(configPolicyFeatureLinks.configPolicyId, parentId),
        eq(configPolicyFeatureLinks.featureType, 'warranty')
      )
    )
    .limit(1);
  return warrantyHpCmslCollectionEffective(row?.inlineSettings);
}
```

- [ ] **Step 9: Wire the assignment and create-with-parent doors**

`apps/api/src/routes/configurationPolicies/assignments.ts` — add the imports:

```ts
import type { UserPermissions } from '../../services/permissions';
import { checkHpCmslWriteAllowed, warrantyLinkEnablesCollection } from './hpCmslGate';
```

and insert after the site-authorization check (`:121-124`), before `assignPolicy`:

```ts
    // #5511 W02 (contract D4): an assignment is how a policy that already
    // enables HP CMSL collection REACHES devices. Assigning one is therefore
    // the same capability as authoring it, reached through a second door — the
    // shape crud.ts already uses for a patch/maintenance parent. The effective
    // warranty link is the policy's own, else the one it inherits.
    const assignmentStartsHpCmslCollection =
      warrantyLinkEnablesCollection(policy.featureLinks)
      || (!policy.featureLinks?.some((l: { featureType: string }) => l.featureType === 'warranty')
        && warrantyLinkEnablesCollection(policy.parentPolicy?.featureLinks));
    if (assignmentStartsHpCmslCollection) {
      const gate = checkHpCmslWriteAllowed(auth, c.get('permissions') as UserPermissions | undefined);
      if (!gate.allowed) return c.json(gate.body, 403);
    }
```

`apps/api/src/routes/configurationPolicies/crud.ts` — add `parentPolicyEnablesHpCmslCollection` to the `'../../services/configurationPolicy'` import, plus:

```ts
import type { UserPermissions } from '../../services/permissions';
import { checkHpCmslWriteAllowed } from './hpCmslGate';
```

and extend the existing parent block (`:78-83`):

```ts
    if (data.parentPolicyId) {
      const parentTypes = await getParentLinkFeatureTypes(data.parentPolicyId);
      if (parentTypes.some((t) => MFA_GATED_FEATURE_TYPES.has(t)) && !hasSatisfiedMfa(auth)) {
        return c.json({ error: 'MFA required' }, 403);
      }
      // #5511 W02 (contract D4): the same "MFA follows effectiveness" argument,
      // for a parent that collects HP warranty data. Inheriting it makes the
      // collection effective on the new policy immediately, so the create
      // carries the deployment gate too.
      if (parentTypes.includes('warranty') && await parentPolicyEnablesHpCmslCollection(data.parentPolicyId)) {
        const gate = checkHpCmslWriteAllowed(auth, c.get('permissions') as UserPermissions | undefined);
        if (!gate.allowed) return c.json(gate.body, 403);
      }
    }
```

- [ ] **Step 10: Write the assignment-door test**

Create `apps/api/src/routes/configurationPolicies/assignments.hpCmsl.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  getConfigPolicyMock,
  assignPolicyMock,
  validateAssignmentTargetMock,
  authorizeAssignmentTargetMock,
  mfaState,
  permState,
} = vi.hoisted(() => ({
  getConfigPolicyMock: vi.fn(),
  assignPolicyMock: vi.fn(),
  validateAssignmentTargetMock: vi.fn(),
  authorizeAssignmentTargetMock: vi.fn(),
  mfaState: { satisfied: true },
  permState: { permissions: { permissions: [{ resource: '*', action: '*' }] } as any },
}));

vi.mock('../../services/configurationPolicy', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../services/configurationPolicy')>();
  return {
    ...original,
    getConfigPolicy: getConfigPolicyMock,
    assignPolicy: assignPolicyMock,
    unassignPolicy: vi.fn(),
    listAssignments: vi.fn(),
    listAssignmentsForTarget: vi.fn(),
    validateAssignmentTarget: validateAssignmentTargetMock,
    authorizeAssignmentTarget: authorizeAssignmentTargetMock,
    getAssignment: vi.fn(),
  };
});
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/remoteAccessPolicy', () => ({ invalidateRemoteAccessCache: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  hasSatisfiedMfa: vi.fn(() => mfaState.satisfied),
}));

import { assignmentRoutes } from './assignments';
import { HP_CMSL_EULA_ID } from '@breeze/shared/validators';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = '44444444-4444-4444-4444-444444444444';

const CONSENT = {
  acceptedByUserId: 'user-1',
  acceptedAt: '2026-09-10T00:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};
const COLLECTING_LINK = {
  id: 'link-1',
  featureType: 'warranty',
  inlineSettings: { hpCmsl: { enabled: true, consent: CONSENT } },
};

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      user: { id: 'user-1' },
      token: { scope: 'organization' },
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (o: string) => o === ORG_ID,
    });
    c.set('permissions', permState.permissions);
    await next();
  });
  app.route('/', assignmentRoutes);
  return app;
}

function assign() {
  return buildApp().request(`/${POLICY_ID}/assignments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level: 'device', targetId: DEVICE_ID }),
  });
}

describe('POST /:id/assignments — hpCmsl gate (#5511 W02 D4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaState.satisfied = true;
    permState.permissions = { permissions: [{ resource: '*', action: '*' }] } as any;
    validateAssignmentTargetMock.mockResolvedValue({ valid: true });
    authorizeAssignmentTargetMock.mockResolvedValue({ valid: true });
    assignPolicyMock.mockResolvedValue({ id: 'assignment-1' });
  });

  it('refuses a devices.write-only caller assigning a policy that collects', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      featureLinks: [COLLECTING_LINK], parentPolicy: null,
    });

    const res = await assign();

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'HP_CMSL_EXECUTE_REQUIRED' });
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('refuses when the collecting link is INHERITED from the parent', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      featureLinks: [],
      parentPolicy: { id: 'parent', featureLinks: [COLLECTING_LINK] },
    });

    const res = await assign();

    expect(res.status).toBe(403);
    expect(assignPolicyMock).not.toHaveBeenCalled();
  });

  it('does NOT refuse when the policy overrides the parent with collection off', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      featureLinks: [{ id: 'own', featureType: 'warranty', inlineSettings: { hpCmsl: { enabled: false } } }],
      parentPolicy: { id: 'parent', featureLinks: [COLLECTING_LINK] },
    });

    const res = await assign();

    expect(res.status).toBe(201);
    expect(assignPolicyMock).toHaveBeenCalled();
  });

  it('does not gate an ordinary assignment of a policy with no warranty link', async () => {
    permState.permissions = { permissions: [{ resource: 'devices', action: 'write' }] } as any;
    getConfigPolicyMock.mockResolvedValue({
      id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P',
      featureLinks: [{ id: 'p', featureType: 'patch', inlineSettings: {} }],
      parentPolicy: null,
    });

    const res = await assign();

    expect(res.status).toBe(201);
  });
});
```

That third case is also the executable statement of D5's override semantics at the assignment door: a nearer link with collection off REPLACES the inherited one, so no device is exposed and no gate applies.

- [ ] **Step 11: Run everything and verify green**

Run: `cd apps/api && npx vitest run src/routes/configurationPolicies/hpCmslGate.test.ts src/routes/configurationPolicies/featureLinks.test.ts src/routes/configurationPolicies/assignments.hpCmsl.test.ts src/routes/configurationPolicies/assignments.test.ts src/routes/configurationPolicies/crud.test.ts src/routes/configurationPolicies/crud.siteScope.test.ts`
Expected: PASS, 6 files. `assignments.test.ts` and `crud.test.ts` are listed because both routes gained a branch; both must stay green with their existing (unseeded) contexts, which they do because their policies carry no collecting warranty link.

Then typecheck: `cd apps/api && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/routes/configurationPolicies/hpCmslGate.ts apps/api/src/routes/configurationPolicies/hpCmslGate.test.ts apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/routes/configurationPolicies/featureLinks.test.ts apps/api/src/routes/configurationPolicies/assignments.ts apps/api/src/routes/configurationPolicies/assignments.hpCmsl.test.ts apps/api/src/routes/configurationPolicies/crud.ts apps/api/src/services/configurationPolicy.ts
git commit -m "feat(api): gate every transition that exposes a device to HP CMSL collection on devices.execute + MFA (#5511 W02 D4)"
```

---

### Task 6: Close the AI door — escalate an hpCmsl-enabling feature-link write to Tier 3

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts` (imports `:13-23`; the `TIER3_INPUT_AWARE_ACTIONS` comment `:508-513`; the `isInputAwareTier3` doc comment `:517-532` and body `:533-543`; `resolveApprovalScope`'s override comment `:570-578`; `buildApprovalDescription`'s feature-link case `:2327-2330`)
- Modify: `apps/api/src/services/aiGuardrails.test.ts` (new `describe` beside the maintenance one at `:1202-1270`)
- Modify: `apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts` (extend the both-branches case at `:380-395`)

**Interfaces:**
- Consumes: Task 1's `warrantyHpCmslRequested`.
- Produces: no new exports. `isInputAwareTier3` keeps its signature and gains a second escalation arm; `TIER3_INPUT_AWARE_ACTIONS` is unchanged (both pairs are already members), so the approval-scope contract test's "classified in exactly one static table" invariant needs no new exemption.

**Why inert is not the same as gated.** Task 2 makes the AI path *harmless*: with no `consentActor` the service refuses to stamp, so no consent is recorded, and Task 8's delivery predicate requires a consent against the current EULA id — collection never turns on. That fail-safe stays. But it is not a gate, and two things are still wrong without this task:

1. **The AI can still flip the stored flag.** `hpCmsl.enabled: true` with no consent is a persistable blob (the stored schema allows an absent consent — that is what makes "disabled" and "legacy" representable). The WarrantyTab would then render collection as ON while the agent is delivered `false`. A UI that says a customer's endpoints are being collected from when they are not is its own dishonesty, independent of the security question.
2. **The gate is one refactor away from bypassable.** D4 is enforced in five HTTP handlers. `manage_policy_feature_link` reaches `addFeatureLink` without passing through any of them (`aiToolsConfigPolicy.ts:936-942`), at Tier 2 — auto-execute, audit only. The moment anyone gives the AI tool an actor, or relaxes the consent rule, the door is open for real. Guardrails is where that door is closed.

This mirrors Feature A's W05 treatment of `autoInstall`: both features gate the act of causing software installation the same way, at the same layer.

**Predicate on CONTENT, not on `featureType`.** `isInputAwareTier3`'s own doc comment (`:523-531`) records that for `update`, `featureType` is **not a required input** — the maintenance arm gets away with it because the handler's principal check is its belt. A warranty escalation keyed on `featureType === 'warranty'` would therefore miss every `update`, which is precisely the write that turns collection on for an existing link. The same comment warns the other way too: the `add`/`update` action guard exists so a read carrying a stray argument is not escalated into an approval the MCP transport then denies. Both constraints are satisfied by keeping the action guard and reading `input.inlineSettings`.

Escalating on content alone is deliberately slightly over-broad: `inlineSettings: { hpCmsl: { enabled: true } }` sent with `featureType: 'patch'` also escalates, even though the write would 400. Requiring approval for a doomed call is the conservative direction and costs nothing; requiring the right `featureType` on an input that need not carry one is how the arm would silently miss.

**Scope is `supervised`, not `four_eyes`.** Per the rationale already written at `:570-578`: this is authoring policy configuration, not an externally binding act, and it matches `manage_configuration_policy`'s own create/update/delete. Note that `manage_policy_feature_link` is in neither whole-tool scope set and `add`/`update` are in neither `*_ACTIONS` scope table, so **without** the existing override an escalated pair falls to the per-tool `four_eyes` fail-safe at the bottom of `resolveApprovalScope` — the override is mandatory, not stylistic. It already covers both pairs, so this task changes the tier predicate only, never the scope resolution.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/aiGuardrails.test.ts`, immediately after the existing `describe('manage_policy_feature_link maintenance escalation (RMM-QA-176 D9)', ...)` block (ends `:1270`):

```ts
// ─── #5511 W02: manage_policy_feature_link HP CMSL escalation ────────────────

describe('manage_policy_feature_link hpCmsl escalation (#5511 W02, contract D4)', () => {
  const enabling = { hpCmsl: { enabled: true } };
  const thresholdsOnly = { enabled: true, warnDays: 90, criticalDays: 30 };

  it('escalates add of a warranty link that enables HP collection to tier 3, supervised', () => {
    const check = checkGuardrails('manage_policy_feature_link', {
      action: 'add', configPolicyId: 'p1', featureType: 'warranty', inlineSettings: enabling,
    });
    expect(check.tier).toBe(3);
    expect(check.requiresApproval).toBe(true);
    expect(check.approvalScope).toBe('supervised');
  });

  it('escalates update WITHOUT a featureType — the input that turns collection on for an existing link', () => {
    // featureType is not a required input on `update`, so an escalation keyed
    // on it would miss exactly this call. Predicating on the settings content
    // is what makes the arm reachable at all.
    const check = checkGuardrails('manage_policy_feature_link', {
      action: 'update', configPolicyId: 'p1', featureLinkId: 'l1', inlineSettings: enabling,
    });
    expect(check.tier).toBe(3);
    expect(check.approvalScope).toBe('supervised');
  });

  it('leaves an alert-threshold-only warranty link at the tool base tier 2 — it installs nothing', () => {
    for (const action of ['add', 'update'] as const) {
      const check = checkGuardrails('manage_policy_feature_link', {
        action, configPolicyId: 'p1', featureLinkId: 'l1', featureType: 'warranty', inlineSettings: thresholdsOnly,
      });
      expect(check.tier, `${action} of thresholds-only must not escalate`).toBe(2);
      expect(check.requiresApproval).toBe(false);
    }
  });

  it('leaves an explicit DISABLE at tier 2 — turning collection off is the fail-safe direction', () => {
    const check = checkGuardrails('manage_policy_feature_link', {
      action: 'update', configPolicyId: 'p1', featureLinkId: 'l1', inlineSettings: { hpCmsl: { enabled: false } },
    });
    expect(check.tier).toBe(2);
    expect(check.requiresApproval).toBe(false);
  });

  it('leaves a warranty link with no inlineSettings at all at tier 2', () => {
    const check = checkGuardrails('manage_policy_feature_link', {
      action: 'add', configPolicyId: 'p1', featureType: 'warranty',
    });
    expect(check.tier).toBe(2);
  });

  it('is never triggered by a READ carrying the same settings', () => {
    // Same protection as the maintenance arm's own read control: the action
    // guard, not ordering, is what keeps `list` out of an approval the MCP
    // transport would then deny outright.
    const check = checkGuardrails('manage_policy_feature_link', {
      action: 'list', configPolicyId: 'p1', inlineSettings: enabling,
    });
    expect(check.tier).toBe(2);
    expect(check.requiresApproval).toBe(false);
  });

  it('fails safe on a malformed hpCmsl block rather than escalating on junk', () => {
    // warrantyHpCmslRequested parses the sub-block strictly, so a
    // non-conforming shape is not "enabled". The WRITE refuses it anyway
    // (Task 3's 400), so the base tier is the right answer here.
    for (const inlineSettings of [
      { hpCmsl: 'true' },
      { hpCmsl: { enabled: 'true' } },
      { hpCmsl: [] },
    ]) {
      const check = checkGuardrails('manage_policy_feature_link', {
        action: 'add', configPolicyId: 'p1', featureType: 'warranty', inlineSettings,
      });
      expect(check.tier).toBe(2);
    }
  });

  it('names HP CMSL in the approval description so an approver knows software gets installed', () => {
    const check = checkGuardrails('manage_policy_feature_link', {
      action: 'update', configPolicyId: 'p1', featureLinkId: 'l1', inlineSettings: enabling,
    });
    expect(check.description).toContain('HP CMSL');
  });

  it('leaves the maintenance escalation exactly as it was', () => {
    // The control for this whole task: adding an arm must not disturb the
    // existing one, in either direction.
    const maintenance = checkGuardrails('manage_policy_feature_link', {
      action: 'add', configPolicyId: 'p1', featureType: 'maintenance',
    });
    expect(maintenance.tier).toBe(3);
    expect(maintenance.approvalScope).toBe('supervised');
    expect(maintenance.description).toContain('maintenance');

    const patch = checkGuardrails('manage_policy_feature_link', {
      action: 'add', configPolicyId: 'p1', featureType: 'patch',
    });
    expect(patch.tier).toBe(2);
  });
});
```

And extend `apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts`, immediately after the existing `manage_policy_feature_link resolves supervised for maintenance on both add and update` case (`:380-386`):

```ts
  it('manage_policy_feature_link resolves supervised for an hpCmsl-enabling write on both add and update (#5511 W02)', () => {
    const enabling = { inlineSettings: { hpCmsl: { enabled: true } } };
    expect(resolveApprovalScope('manage_policy_feature_link', 'add', enabling)).toBe('supervised');
    expect(resolveApprovalScope('manage_policy_feature_link', 'update', enabling)).toBe('supervised');
    // ...and the escalation is what routes it there. Without the tier arm the
    // pair is in NEITHER static scope table and would reach the per-tool
    // four_eyes fail-safe, so this assertion is load-bearing, not decorative.
    expect(isInputAwareTier3('manage_policy_feature_link', 'add', enabling)).toBe(true);
    expect(isInputAwareTier3('manage_policy_feature_link', 'update', enabling)).toBe(true);
  });

  it('checkGuardrails surfaces the hpCmsl escalation on both branches (#5511 W02)', () => {
    const enabling = checkGuardrails('manage_policy_feature_link', {
      action: 'add', inlineSettings: { hpCmsl: { enabled: true } },
    });
    expect(enabling.tier).toBe(3);
    expect(enabling.approvalScope).toBe('supervised');

    const thresholds = checkGuardrails('manage_policy_feature_link', {
      action: 'add', featureType: 'warranty', inlineSettings: { warnDays: 90 },
    });
    expect(thresholds.tier).toBe(2);
    expect(thresholds.approvalScope).toBeUndefined();
  });
```

Add `isInputAwareTier3` to that file's import from `./aiGuardrails` if it is not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiGuardrails.test.ts src/services/aiGuardrails.approvalScope.contract.test.ts`
Expected: FAIL — every escalation case reports `tier: 2` / `approvalScope: undefined`, and the description case reports the bare `UPDATE feature link on config policy p1...`. The tier-2 cases (thresholds-only, disable, read, malformed) pass already; they are the controls that prove the new arm stayed narrow, and they must still pass at the end.

- [ ] **Step 3: Extend the predicate**

Add the import to `apps/api/src/services/aiGuardrails.ts` (with the other service imports, `:15-23`):

```ts
import { warrantyHpCmslRequested } from '@breeze/shared/validators';
```

(`aiGuardrails.imports.contract.test.ts:11-17` forbids only `./aiToolSchemas` and `getToolDefinitions`; the shared validators barrel is pure zod and pulls in no Drizzle schema objects, so it does not reintroduce the #5054 partial-mock breakage.)

Replace the `isInputAwareTier3` doc comment and body (`:517-543`) with:

```ts
/**
 * True when a (tool, action, input) triple escalates to Tier 3 on argument
 * CONTENT. Exported so checkGuardrails, resolveApprovalScope and the tests all
 * ask the SAME question — a second copy of this predicate is how a tier and
 * its scope drift apart.
 *
 * Two arms, both on manage_policy_feature_link's add/update:
 *
 *  - `featureType === 'maintenance'` (RMM-QA-176 D9). Strict `===`: a
 *    non-string featureType stays at the base tier, which is safe here because
 *    the handler writes exactly the featureType it was given, so a value that
 *    is not the literal 'maintenance' cannot create a maintenance link either.
 *    The handler's own principal check (D9.3) is the belt to this brace for
 *    `update`, where featureType is not a required input.
 *
 *  - an inlineSettings payload that would leave HP CMSL warranty collection
 *    ON (#5511 W02, contract D4). Enabling it installs HP's CMSL module on
 *    every HP endpoint the policy reaches, which is a software deployment —
 *    gated behind devices.execute + MFA on the HTTP routes, and this tool
 *    reaches addFeatureLink without passing through any of them. Keyed on the
 *    SETTINGS CONTENT rather than on featureType precisely because featureType
 *    is not a required input on `update`, which is the call that turns
 *    collection on for an existing link. A warranty link carrying only alert
 *    thresholds installs nothing and deliberately stays at the base tier.
 *
 * The action guard is not decoration: without it a read (`list`) carrying a
 * stray featureType or inlineSettings argument would be escalated into an
 * approval that the MCP transport then denies outright.
 */
export function isInputAwareTier3(
  toolName: string,
  action: string | undefined,
  input: Record<string, unknown>,
): boolean {
  if (toolName !== 'manage_policy_feature_link') return false;
  if (action !== 'add' && action !== 'update') return false;
  return (
    input.featureType === 'maintenance'
    || warrantyHpCmslRequested(input.inlineSettings)
  );
}
```

Extend the `TIER3_INPUT_AWARE_ACTIONS` comment (`:508-513`) so the set's own note stays true:

```ts
  // RMM-QA-176 D9: a 'maintenance' feature link is the canonical
  // monitoring-suppression source, so authoring one is a different class of
  // act from authoring any other link — but only the INPUT says which it is,
  // so it cannot be classified by (tool, action) in the static tables.
  // #5511 W02: same reasoning for a warranty link that switches on device-side
  // HP CMSL collection — the pair is unchanged, the predicate gained an arm.
  'manage_policy_feature_link:add',
  'manage_policy_feature_link:update',
```

Extend the `resolveApprovalScope` override comment (`:570-578`) with one line, leaving the rest as-is:

```ts
    // `supervised` matches the #3552/835f7eb3d policy-prerequisite
    // escalations and manage_configuration_policy's own create/update/delete —
    // authoring policy configuration, not an externally binding act. The
    // #5511 hpCmsl arm resolves here too, for the same reason.
```

- [ ] **Step 4: Name it in the approval description**

Replace `buildApprovalDescription`'s feature-link case (`:2327-2330`):

```ts
    case 'manage_policy_feature_link':
      parts.push(`${action?.toUpperCase()} ${String(input.featureType ?? 'feature')} link`);
      parts.push(`on config policy ${(input.configPolicyId as string)?.slice(0, 8) ?? 'unknown'}...`);
      // #5511 W02: an `update` need not carry featureType, so without this an
      // approver sees "UPDATE feature link" for a change that installs HP
      // software on every HP endpoint the policy reaches. Say what it does.
      if (warrantyHpCmslRequested(input.inlineSettings)) {
        parts.push('— enables HP CMSL warranty collection (installs HP software on HP devices)');
      }
      break;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiGuardrails.test.ts src/services/aiGuardrails.approvalScope.contract.test.ts`
Expected: PASS, 2 files.

Then the rest of the guardrails contract family and the transport-level suite, all of which read this predicate or this file's import surface:
Run: `cd apps/api && npx vitest run src/services/aiGuardrails.imports.contract.test.ts src/services/aiGuardrails.readonly.contract.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts src/services/aiGuardrails.enforcementArming.contract.test.ts src/services/aiGuardrailsTierConfig.parity.test.ts src/services/aiGuardrailsAiDocs.parity.test.ts src/routes/mcpServer.approvalGate.test.ts`
Expected: PASS, 7 files. `mcpServer.approvalGate.test.ts:440-500` is the one that would notice if the maintenance escalation changed shape end-to-end.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiGuardrails.test.ts apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts
git commit -m "feat(api): escalate an hpCmsl-enabling feature-link write to Tier 3 supervised (#5511 W02 D4)"
```

---

### Task 7: Share the effective-warranty resolution instead of writing a second resolver

**Files:**
- Create: `apps/api/src/services/warrantyPolicyResolution.ts`
- Create: `apps/api/src/services/warrantyPolicyResolution.test.ts`
- Modify: `apps/api/src/services/warrantyAlertEvaluator.ts` (replace the body of `resolveWarrantySettings`, `:58-186`, with a projection; drop the imports it no longer uses)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export async function resolveEffectiveWarrantyInlineSettings(deviceId: string): Promise<unknown | undefined>` — the winning link's `inlineSettings` (which may itself be `null`), or `undefined` when **no** active warranty link resolves for the device. Throws on a DB error; callers decide what that means.

**Why a new module rather than exporting from the evaluator.** `warrantyAlertEvaluator.ts` imports `alertService`, `eventBus` and the alert schema; making `routes/agents/helpers.ts` (the heartbeat path) import it would drag that whole graph into every heartbeat for one boolean. A leaf module that both consumers import keeps one resolver — which is what contract D6 asks for — without that coupling, and leaves the evaluator's behaviour byte-for-byte unchanged.

**Behaviour that must not change.** The resolver's ranking is `device 5 > device_group 4 > site 3 > organization 2 > partner 1`, then descending assignment `priority`, then `rows[0].inlineSettings` — a WHOLE link, no deep merge (contract D5). `DISABLED_SETTINGS` on no rows and `DEFAULT_SETTINGS` on a null blob stay in the evaluator, where they belong; the shared resolver reports absence as `undefined` and does not invent defaults.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/warrantyPolicyResolution.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectQueue } = vi.hoisted(() => ({ selectQueue: [] as unknown[][] }));

// db.select() is consumed FIFO: device row, org row, group rows, then the
// effective-links join. Each chain resolves when awaited.
function chainable(rows: unknown[]) {
  const obj: any = {};
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) obj[m] = () => obj;
  obj.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
  return obj;
}

vi.mock('../db', () => ({
  db: { select: vi.fn(() => chainable(selectQueue.shift() ?? [])) },
}));
vi.mock('../db/schema', () => ({
  devices: {}, organizations: {}, deviceGroupMemberships: {},
  configPolicyAssignments: {}, configurationPolicies: {},
  configPolicyEffectiveFeatureLinks: {},
}));
vi.mock('./configPolicyOwnership', () => ({ policyOwnershipCondition: vi.fn(() => undefined) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { resolveEffectiveWarrantyInlineSettings } from './warrantyPolicyResolution';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';

function seed(linkRows: unknown[]) {
  selectQueue.length = 0;
  selectQueue.push([{ orgId: 'org-1', siteId: 'site-1' }]);   // device
  selectQueue.push([{ partnerId: 'partner-1' }]);              // org
  selectQueue.push([]);                                        // group memberships
  selectQueue.push(linkRows);                                  // effective links
}

describe('resolveEffectiveWarrantyInlineSettings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when the device does not resolve at all', async () => {
    selectQueue.length = 0;
    selectQueue.push([]);
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toBeUndefined();
  });

  it('returns undefined when no active warranty link is assigned', async () => {
    seed([]);
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toBeUndefined();
  });

  it('returns the nearest level\'s WHOLE inlineSettings, not a merge (contract D5)', async () => {
    seed([
      { inlineSettings: { enabled: true, warnDays: 90, hpCmsl: { enabled: true } }, level: 'organization', priority: 0 },
      { inlineSettings: { warnDays: 14 }, level: 'device', priority: 0 },
    ]);

    // The device-level link carries no hpCmsl block, so the org-level one is
    // DROPPED wholesale. This is the inheritance footgun the UI has to surface.
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toEqual({ warnDays: 14 });
  });

  it('breaks a same-level tie on descending assignment priority', async () => {
    seed([
      { inlineSettings: { warnDays: 1 }, level: 'site', priority: 0 },
      { inlineSettings: { warnDays: 2 }, level: 'site', priority: 5 },
    ]);
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toEqual({ warnDays: 2 });
  });

  it('ranks partner below organization', async () => {
    seed([
      { inlineSettings: { warnDays: 7 }, level: 'partner', priority: 99 },
      { inlineSettings: { warnDays: 8 }, level: 'organization', priority: 0 },
    ]);
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toEqual({ warnDays: 8 });
  });

  it('distinguishes a resolved-but-null blob from no policy at all', async () => {
    seed([{ inlineSettings: null, level: 'organization', priority: 0 }]);
    await expect(resolveEffectiveWarrantyInlineSettings(DEVICE_ID)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/warrantyPolicyResolution.test.ts`
Expected: FAIL — `Failed to resolve import "./warrantyPolicyResolution"`.

- [ ] **Step 3: Write the shared resolver**

Create `apps/api/src/services/warrantyPolicyResolution.ts` — this is `warrantyAlertEvaluator.ts:58-177` lifted verbatim, with the three-field projection removed from the end:

```ts
/**
 * Effective warranty feature link for a device.
 *
 * Lifted out of warrantyAlertEvaluator's private resolveWarrantySettings so the
 * heartbeat's HP CMSL delivery reads the SAME link the expiry alerting reads
 * (#5511 W02, contract D6). A second resolver would drift: this one already
 * carries two hard-won corrections (#3963's polymorphic per-level target
 * matching and #2930's dual-axis ownership predicate) that a fresh copy would
 * not have.
 *
 * A leaf module on purpose — importing the alert evaluator from
 * routes/agents/helpers.ts would pull alertService and the event bus into every
 * heartbeat for one boolean.
 */
import { db } from '../db';
import {
  devices,
  configPolicyEffectiveFeatureLinks,
  configPolicyAssignments,
  configurationPolicies,
  deviceGroupMemberships,
  organizations,
} from '../db/schema';
import { eq, and, inArray, or, type SQL } from 'drizzle-orm';
import { policyOwnershipCondition } from './configPolicyOwnership';
import { captureException } from './sentry';

// device > device_group > site > organization > partner. Closest wins.
const LEVEL_PRIORITY: Record<string, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
};

/**
 * The WHOLE inlineSettings blob of the warranty feature link in effect for a
 * device, or `undefined` when no active warranty policy resolves.
 *
 * `undefined` (no policy) and `null` (a policy whose blob is null) are
 * different answers and callers treat them differently — warranty alerting
 * falls back to DISABLED_SETTINGS for the first and DEFAULT_SETTINGS for the
 * second. Do not collapse them.
 *
 * Selection is a whole link, never a deep merge (contract D5): a nearer policy
 * carrying only alert thresholds REPLACES an inherited link and drops its
 * hpCmsl block, revoking collection.
 *
 * Throws on a database error. The heartbeat caller depends on that: an error
 * must omit the config block entirely rather than resolve to "off".
 */
export async function resolveEffectiveWarrantyInlineSettings(deviceId: string): Promise<unknown | undefined> {
  const [device] = await db
    .select({ orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return undefined;

  // The device org's partner. Needed twice below: a `level='partner'` assignment
  // targets `partners.id`, and a partner-wide policy carries `org_id NULL`.
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);

  // Not reachable by the schema: `devices.org_id` is NOT NULL with an FK to
  // `organizations.id`, and `organizations.partner_id` is itself NOT NULL. So an
  // empty result means the invariant broke (org deleted mid-evaluation, or a
  // caller whose context cannot see its own device's org). Say it out loud —
  // falling through quietly would resolve in exactly the org-only way #3963
  // exists to fix, just one join upstream, and be indistinguishable from
  // "correctly found no policy". Resolution continues so the feature degrades
  // rather than throwing.
  if (!org) {
    console.error(
      `[warranty] org ${device.orgId} for device ${deviceId} did not resolve; partner-wide warranty policies cannot apply to this evaluation`
    );
    captureException(
      new Error(`warranty: organizations row missing for device org ${device.orgId}`)
    );
  }

  const groupRows = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const groupIds = groupRows.map((r) => r.groupId);

  // `config_policy_assignments.targetId` is POLYMORPHIC — its referent depends
  // on `level` ('device' → devices.id, 'device_group' → device_groups.id,
  // 'site' → sites.id, 'organization' → organizations.id, 'partner' →
  // **partners.id**). So every id is matched against its OWN level rather than
  // thrown into one `inArray` bag; that bag had no partner id in it at all,
  // which is why a partner-level warranty assignment could never match (#3963).
  const targetConditions: SQL[] = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, deviceId))!,
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, device.orgId))!,
  ];
  if (groupIds.length > 0) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, groupIds))!
    );
  }
  if (device.siteId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, device.siteId))!
    );
  }
  if (org?.partnerId) {
    targetConditions.push(
      and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, org.partnerId))!
    );
  }

  const rows = await db
    .select({
      inlineSettings: configPolicyEffectiveFeatureLinks.inlineSettings,
      level: configPolicyAssignments.level,
      priority: configPolicyAssignments.priority,
    })
    .from(configPolicyEffectiveFeatureLinks)
    .innerJoin(
      configurationPolicies,
      eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id)
    )
    .innerJoin(
      configPolicyAssignments,
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id)
    )
    .where(
      and(
        eq(configPolicyEffectiveFeatureLinks.featureType, 'warranty'),
        eq(configurationPolicies.status, 'active'),
        // Ownership axis, distinct from the assignment axis above: a
        // partner-wide policy is `org_id NULL` + `partner_id` set (#1724), so a
        // resolver must admit both shapes (#2930).
        policyOwnershipCondition({ orgId: device.orgId, partnerId: org?.partnerId ?? null }),
        or(...targetConditions)
      )
    );

  if (rows.length === 0) return undefined;

  rows.sort((a, b) => {
    const la = LEVEL_PRIORITY[a.level] ?? 0;
    const lb = LEVEL_PRIORITY[b.level] ?? 0;
    if (la !== lb) return lb - la; // higher level priority wins
    return b.priority - a.priority; // higher priority number wins
  });

  return rows[0]!.inlineSettings;
}
```

- [ ] **Step 4: Reduce the alert evaluator to a projection**

In `apps/api/src/services/warrantyAlertEvaluator.ts`, replace the whole of `resolveWarrantySettings` (`:50-186`, i.e. its doc comment through its closing brace) with:

```ts
/**
 * Resolve warranty ALERT thresholds for a device from configuration policies.
 *
 * The hierarchy resolution itself lives in warrantyPolicyResolution.ts and is
 * shared with the heartbeat's HP CMSL delivery (#5511 W02, D6) — a second copy
 * would drift from this one's #3963 and #2930 fixes.
 *
 * Warranty alerting is opt-in: if no active warranty config policy is assigned
 * to the device (directly or via group/site/org/partner), this returns
 * DISABLED_SETTINGS so no alert fires (#1320). A policy that resolves with a
 * null blob is a different case and keeps the per-link DEFAULT_SETTINGS.
 */
async function resolveWarrantySettings(deviceId: string): Promise<WarrantyAlertSettings> {
  const inlineSettings = await resolveEffectiveWarrantyInlineSettings(deviceId);
  if (inlineSettings === undefined) return DISABLED_SETTINGS;

  const inline = inlineSettings as Partial<WarrantyAlertSettings> | null;
  if (!inline) return DEFAULT_SETTINGS;

  return {
    enabled: inline.enabled ?? DEFAULT_SETTINGS.enabled,
    warnDays: inline.warnDays ?? DEFAULT_SETTINGS.warnDays,
    criticalDays: inline.criticalDays ?? DEFAULT_SETTINGS.criticalDays,
  };
}
```

Add the import:

```ts
import { resolveEffectiveWarrantyInlineSettings } from './warrantyPolicyResolution';
```

Then delete the now-unused imports from this file. After the replacement, `configPolicyEffectiveFeatureLinks`, `configPolicyAssignments`, `configurationPolicies`, `deviceGroupMemberships` and `organizations` are no longer referenced from `../db/schema` (keep `deviceWarranty`, `devices`, `alerts`), `inArray`/`or`/`type SQL` are no longer referenced from `drizzle-orm`, and `policyOwnershipCondition` is no longer used. **Let `tsc --noEmit` and `pnpm lint` tell you exactly which — do not delete an import this task did not orphan.**

- [ ] **Step 5: Run the tests to verify green**

Run: `cd apps/api && npx vitest run src/services/warrantyPolicyResolution.test.ts`
Expected: PASS.

Run the evaluator's own suites — behaviour must be unchanged:
Run: `cd apps/api && npx vitest run src/services/warrantyAlertEvaluator`
Expected: PASS. Check the reported file count and confirm it is non-zero; a substring filter that matches nothing reports "No test files found", which is not a pass.

Run: `cd apps/api && npx tsc --noEmit`
Expected: clean (this is what proves the orphaned imports were removed).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/warrantyPolicyResolution.ts apps/api/src/services/warrantyPolicyResolution.test.ts apps/api/src/services/warrantyAlertEvaluator.ts
git commit -m "refactor(api): share effective-warranty-link resolution between alerting and agent delivery (#5511 W02 D6)"
```

---

### Task 8: `buildWarrantyConfigUpdate` — the delivery builder and its revocation contract

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (new section immediately after `buildPatchSourceConfigUpdate`, i.e. after `:2863`)
- Test: `apps/api/src/routes/agents/helpers.warranty.test.ts` (new)

**Interfaces:**
- Consumes: Task 7's `resolveEffectiveWarrantyInlineSettings`; Task 1's `warrantyHpCmslCollectionEffective`.
- Produces:
  - `export interface WarrantySettings { hpCmslEnabled: boolean }`
  - `export async function buildWarrantyConfigUpdate(deviceId: string): Promise<WarrantySettings>`

**The revocation contract, copied verbatim from `buildPatchSourceConfigUpdate` (`helpers.ts:2852-2859`):** a successfully resolved *absent* policy returns `false` — the agent stops HP activity, so unassigning a policy cleanly reverts the endpoint. A resolver **error** must propagate, so the heartbeat's try/catch omits the block entirely and a transient database failure never revokes a whole fleet. These are different states; conflating them is how a fleet silently turns a feature off. Do not add a `try/catch` here.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/agents/helpers.warranty.test.ts`. The module-mock preamble is `helpers.patchSource.test.ts:22-86` verbatim, plus a mock for the new resolver:

```ts
/**
 * Tests for buildWarrantyConfigUpdate (#5511 W02) — the heartbeat helper that
 * surfaces device-side HP CMSL collection to the agent.
 *
 * resolveEffectiveWarrantyInlineSettings is mocked directly (its hierarchy
 * resolution is covered by warrantyPolicyResolution.test.ts), so this file pins
 * only the mapping the heartbeat relies on:
 *   - no warranty policy resolved (undefined) → { hpCmslEnabled: false }
 *     (the revoke-on-unassign contract)
 *   - resolved but not consented → false (never collect without an acceptance)
 *   - resolver THROWS → rethrow, so the heartbeat omits the block
 *
 * The load-time module mocks mirror helpers.patchSource.test.ts so helpers.ts
 * imports cleanly without a real DB/Redis.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveEffectiveWarrantyInlineSettingsMock } = vi.hoisted(() => ({
  resolveEffectiveWarrantyInlineSettingsMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  devices: {}, organizations: {}, deviceGroupMemberships: {},
  configPolicyAssignments: {}, configurationPolicies: {}, configPolicyFeatureLinks: {},
  pamOrgConfig: {}, softwarePolicies: {}, softwareComplianceStatus: {},
  deviceCommands: { $inferSelect: {} }, deviceDisks: {}, deviceFilesystemSnapshots: {},
  automationPolicies: {}, cisBaselines: {}, cisBaselineResults: {}, cisRemediationActions: {},
  securityStatus: {}, securityThreats: {}, securityScans: {},
  sensitiveDataFindings: {}, sensitiveDataScans: {}, sites: {}, users: {}, deviceGroups: {},
  configPolicyMonitoringSettings: {}, configPolicyMonitoringWatches: {},
  configPolicyEventLogSettings: {},
}));

vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('../../services/cisHardening', () => ({ parseCisCollectorOutput: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/cloudflareMtls', () => ({ CloudflareMtlsService: vi.fn() }));
vi.mock('../../services/softwarePolicyService', () => ({ recordSoftwarePolicyAudit: vi.fn() }));
vi.mock('../../services/featureConfigResolver', () => ({ resolvePatchConfigForDevice: vi.fn() }));
vi.mock('../../services/warrantyPolicyResolution', () => ({
  resolveEffectiveWarrantyInlineSettings: resolveEffectiveWarrantyInlineSettingsMock,
}));
vi.mock('../../services/filesystemAnalysis', () => ({
  getFilesystemScanState: vi.fn(),
  mergeFilesystemAnalysisPayload: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(),
  readCheckpointPendingDirectories: vi.fn(),
  readHotDirectories: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  upsertFilesystemScanState: vi.fn(),
}));
vi.mock('../metrics', () => ({
  recordSoftwareRemediationDecision: vi.fn(),
  recordSensitiveDataFinding: vi.fn(),
  recordSensitiveDataRemediationDecision: vi.fn(),
}));
vi.mock('../../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('./policyProbeSafety', () => ({ isAllowedPolicyConfigProbe: vi.fn(() => true) }));

import { HP_CMSL_EULA_ID } from '@breeze/shared/validators';
import { buildWarrantyConfigUpdate } from './helpers';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const CONSENT = {
  acceptedByUserId: 'user-1',
  acceptedAt: '2026-09-10T00:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};

describe('buildWarrantyConfigUpdate (#5511 W02)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns hpCmslEnabled:false when no warranty policy resolves (revoke-on-unassign)', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue(undefined);
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: false });
  });

  it('returns true for a link that is enabled and consented against the current EULA id', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue({
      enabled: true, warnDays: 90, criticalDays: 30,
      hpCmsl: { enabled: true, consent: CONSENT },
    });
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: true });
  });

  it('returns false for an alerting-only link (the inheritance drop, contract D5)', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue({ enabled: true, warnDays: 14 });
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: false });
  });

  it('returns false when the block is enabled but carries no acceptance', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue({ hpCmsl: { enabled: true } });
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: false });
  });

  it('returns false when the acceptance names a superseded EULA id (contract D2)', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue({
      hpCmsl: { enabled: true, consent: { ...CONSENT, eulaId: 'hp-cmsl-eula-2020-01-01' } },
    });
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: false });
  });

  it('returns false for a resolved-but-null blob', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockResolvedValue(null);
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).resolves.toEqual({ hpCmslEnabled: false });
  });

  it('RETHROWS a resolver error rather than reporting false (no unintended revocation)', async () => {
    resolveEffectiveWarrantyInlineSettingsMock.mockRejectedValue(new Error('boom'));
    await expect(buildWarrantyConfigUpdate(DEVICE_ID)).rejects.toThrow('boom');
  });
});
```

That last case is the one that matters: it is the executable difference between "no policy" and "could not tell", and it is what stops a database blip from switching a fleet off.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/agents/helpers.warranty.test.ts`
Expected: FAIL — `buildWarrantyConfigUpdate` is not exported from `./helpers`.

- [ ] **Step 3: Write the builder**

Add to `apps/api/src/routes/agents/helpers.ts`, immediately after `buildPatchSourceConfigUpdate` ends (`:2863`):

```ts
// ============================================
// HP CMSL Warranty Collection Config (#5511 W02)
// ============================================

export interface WarrantySettings {
  /**
   * When true the (Windows-only) agent may collect HP warranty data on the
   * device via HP's CMSL. False explicitly tells the agent to stop — so
   * unassigning the policy, or a nearer policy replacing the link without an
   * hpCmsl block, cleanly revokes collection.
   */
  hpCmslEnabled: boolean;
}

/**
 * Resolves the warranty feature link for the device and surfaces the HP CMSL
 * collection flag for the heartbeat config push. A device with no warranty
 * policy assigned resolves to `false`, which the agent treats as "stop
 * collecting". The caller (heartbeat) omits the block entirely on a resolver
 * error so a transient failure never revokes collection fleet-wide — which is
 * why this function deliberately does NOT catch.
 *
 * `warrantyHpCmslCollectionEffective` additionally requires an acceptance
 * recorded against the CURRENT HP_CMSL_EULA_ID: an enabled block with no
 * consent, or one naming superseded terms, delivers `false` (contract D2/D3).
 * Collection never runs on an acceptance we cannot point at.
 */
export async function buildWarrantyConfigUpdate(deviceId: string): Promise<WarrantySettings> {
  const inlineSettings = await resolveEffectiveWarrantyInlineSettings(deviceId);
  return { hpCmslEnabled: warrantyHpCmslCollectionEffective(inlineSettings) };
}
```

Add the two imports near the existing `resolvePatchConfigForDevice` import (`:56`):

```ts
import { resolveEffectiveWarrantyInlineSettings } from '../../services/warrantyPolicyResolution';
import { warrantyHpCmslCollectionEffective } from '@breeze/shared/validators';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/agents/helpers.warranty.test.ts src/routes/agents/helpers.patchSource.test.ts`
Expected: PASS, 2 files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/helpers.warranty.test.ts
git commit -m "feat(api): buildWarrantyConfigUpdate with patch_source's revocation contract (#5511 W02 D6)"
```

---

### Task 9: Heartbeat wiring — `warranty_settings` on the wire

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (import list `:21-38`; `PolicyConfigUpdates` `:1921-1926`; initialiser `:1927-1932`; locals + builder inside the shared context `:1935-1984`; wire assembly `:1993-2005`)
- Modify: `apps/api/src/routes/agents/heartbeat.test.ts` (`vi.mock('./helpers')` factory `:167-176`; two new cases beside the patch-source pair at `:3114-3143`)

**Interfaces:**
- Consumes: Task 8's `buildWarrantyConfigUpdate` and `WarrantySettings`.
- Produces: the wire block `configUpdate.warranty_settings = { hp_cmsl_enabled: boolean }`, consumed by Task 10's agent dispatch.

**The camelCase→snake_case hop is deliberate.** The TypeScript type stays `{ hpCmslEnabled: boolean }`, matching `PatchSourceSettings` and every other builder in this file; the wire assembly at `:1993-2005` is already where camelCase names become snake_case keys, so the inner field is converted there too. That produces exactly contract D6's `{ "warranty_settings": { "hp_cmsl_enabled": true } }` without an ugly snake_case TypeScript interface. The agent accepts both spellings anyway (Task 10), and both are tested there.

**Do not add a second `withSystemDbAccessContext`.** All four builders share one on purpose — the comment at `:1906-1911` says why: four separate system transactions would cost four connection acquisitions per heartbeat against a 25-connection production ceiling for no isolation gain. The new builder goes inside the existing one with its own try/catch.

- [ ] **Step 1: Write the failing test**

In `apps/api/src/routes/agents/heartbeat.test.ts`, add to the `vi.mock('./helpers', ...)` factory (`:167-176`), next to `buildPatchSourceConfigUpdate`:

```ts
  // Default OFF, mirroring buildPatchSourceConfigUpdate: every heartbeat test
  // that does not care about warranty still exercises the delivery merge rather
  // than the builder-throws path.
  buildWarrantyConfigUpdate: vi.fn(async () => ({ hpCmslEnabled: false })),
```

Then add these two cases immediately after the `omits patch_source_settings when the patch resolver throws` case (`:3143`):

```ts
  it('includes warranty_settings in configUpdate when HP CMSL collection is enabled (#5511 W02)', async () => {
    const { buildWarrantyConfigUpdate } = await import('./helpers');
    vi.mocked(buildWarrantyConfigUpdate).mockResolvedValueOnce({ hpCmslEnabled: true });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    // Snake_case INSIDE the block too — contract D6 pins the wire shape.
    expect(configUpdate?.warranty_settings).toEqual({ hp_cmsl_enabled: true });
  });

  it('delivers warranty_settings false when no warranty policy resolves (revoke-on-unassign)', async () => {
    const { buildWarrantyConfigUpdate } = await import('./helpers');
    vi.mocked(buildWarrantyConfigUpdate).mockResolvedValueOnce({ hpCmslEnabled: false });

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.warranty_settings).toEqual({ hp_cmsl_enabled: false });
  });

  it('omits warranty_settings entirely when the warranty resolver throws (no unintended revocation)', async () => {
    const { buildWarrantyConfigUpdate } = await import('./helpers');
    vi.mocked(buildWarrantyConfigUpdate).mockRejectedValueOnce(new Error('boom'));

    const resp = await buildApp().request('/agents/device-1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(minimalHeartbeatBody),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    const configUpdate = body.configUpdate as Record<string, unknown> | null;
    expect(configUpdate?.warranty_settings).toBeUndefined();
  });
```

The middle case is not redundant with the third: `false` and *absent* are different instructions to the agent, and only asserting both proves the builder's two failure modes did not collapse into one.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts`
Expected: FAIL — `configUpdate?.warranty_settings` is `undefined` in the first two cases (nothing builds or merges it yet). The third case passes vacuously today; that is expected, and it becomes meaningful once the block exists.

- [ ] **Step 3: Import the builder**

Add `buildWarrantyConfigUpdate,` to the `'./helpers'` import block (`:21-38`), directly after `buildPatchSourceConfigUpdate,` (`:31`).

- [ ] **Step 4: Extend `PolicyConfigUpdates` and its initialiser**

`:1921-1932` becomes:

```ts
  type PolicyConfigUpdates = {
    eventLogSettings: Record<string, unknown> | null;
    monitoringSettings: Record<string, unknown> | null;
    pamSettings: { uacInterceptionEnabled: boolean } | null;
    patchSourceSettings: { exclusiveWindowsUpdate: boolean } | null;
    warrantySettings: { hpCmslEnabled: boolean } | null;
  };
  let policyConfigs: PolicyConfigUpdates = {
    eventLogSettings: null,
    monitoringSettings: null,
    pamSettings: null,
    patchSourceSettings: null,
    warrantySettings: null,
  };
```

- [ ] **Step 5: Build it inside the existing shared system context**

Add the local beside the other four (`:1935-1938`):

```ts
      let warrantySettings: { hpCmslEnabled: boolean } | null = null;
```

and the builder immediately after the patch-source block (`:1982`), before the `return`:

```ts
      // #5511 W02: device-side HP CMSL warranty collection. Same shape and same
      // reason as patch_source above — omit the block on a resolver error so a
      // transient failure never stops collection on a consented fleet; a
      // successful resolve with no warranty policy (or a nearer policy that
      // replaced the link without an hpCmsl block, contract D5) returns false
      // → the agent stops.
      try {
        warrantySettings = await buildWarrantyConfigUpdate(scoped.deviceId);
      } catch (err) {
        console.error(`[agents] failed to build warranty config update for ${agentId}:`, err);
        captureException(err);
      }
```

and extend the return (`:1984`):

```ts
      return { eventLogSettings, monitoringSettings, pamSettings, patchSourceSettings, warrantySettings };
```

- [ ] **Step 6: Merge it into the wire payload**

`:1993` and `:2003-2004` become:

```ts
  const { eventLogSettings, monitoringSettings, pamSettings, patchSourceSettings, warrantySettings } = policyConfigs;
```

```ts
  if (patchSourceSettings) {
    policyConfigUpdate.patch_source_settings = patchSourceSettings;
  }
  // Snake_case inside the block as well as outside (contract D6): this
  // assembly is where camelCase resolver output becomes wire keys, and the
  // agent's inner parse accepts either spelling.
  if (warrantySettings) {
    policyConfigUpdate.warranty_settings = { hp_cmsl_enabled: warrantySettings.hpCmslEnabled };
  }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/agents/heartbeat.test.ts`
Expected: PASS. Note the file is ~5,500 lines and holds the delivery-merge cases for four other features; all must stay green.

Run: `cd apps/api && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts
git commit -m "feat(api): deliver warranty_settings.hp_cmsl_enabled on the heartbeat config update (#5511 W02 D6)"
```

---

### Task 10: Agent — the `warranty_config.go` seam and the dispatch that must sit above line 2918

**Files:**
- Modify: `agent/internal/config/config.go` (new field beside `RequireManifestSigningKeyID` at `:207`; new `viper.Set` in `saveToLocked` beside `:726`)
- Create: `agent/internal/heartbeat/warranty_config.go`
- Create: `agent/internal/heartbeat/warranty_config_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` (dispatch inserted after `:2916`, before `:2918`)

**Interfaces:**
- Consumes: the wire block `warranty_settings` from Task 9.
- Produces, all unexported (contract D7) and all consumed by W03:
  - `var persistWarrantyCollectionEnabled = setWarrantyCollectionEnabled` — the package-level func var tests swap
  - `func (h *Heartbeat) applyWarrantyConfig(raw any)`
  - `func (h *Heartbeat) hpWarrantyCollectionEnabled() bool` — the mutex-guarded accessor W03's collector reads
  - `config.Config.HPWarrantyCollectionEnabled bool` (`mapstructure:"hp_warranty_collection_enabled"`)

**THE TRAP, stated plainly.** `applyConfigUpdate` (`heartbeat.go:2851`) has two halves. Everything from `:2918` is the policy-probe path, and it hits an **unconditional `return`** at `:2928-2930` when neither probe key is present — which is most heartbeats. A `warranty_settings` check added below that line compiles, passes review, and is silently unreachable in production. **The dispatch goes immediately after the onedrive block closes at `:2916` and before `registryRaw` at `:2918`.** This is the single easiest way to ship a feature that never fires, and the test in step 1 is what proves it did not happen: it drives `h.applyConfigUpdate` with an update that contains **no probe keys**, so a misplaced dispatch fails the test rather than shipping.

**Why the seam exists at all.** `patch_source.go:7-11` records the reason for its own: the dispatch + payload-parse path is where a key-name regression silently disables a whole feature, and it must be unit-tested even though the platform I/O cannot run on a CI runner. Here the platform I/O is `config.SetAndPersist`, which writes `agent.yaml` through viper and fails on a runner with no config file — so the var is the persistence call, and the test captures the resolved bool without touching disk.

- [ ] **Step 1: Write the failing test**

Create `agent/internal/heartbeat/warranty_config_test.go`:

```go
package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestApplyWarrantyConfig_DispatchAndParse pins the two things that silently
// break this feature: the key names, and WHERE the dispatch sits inside
// applyConfigUpdate. Every case below is driven through applyConfigUpdate with
// an update carrying NO policy-probe keys — the probe path returns
// unconditionally when none are present, so a dispatch added below it would
// fail here instead of shipping unreachable.
func TestApplyWarrantyConfig_DispatchAndParse(t *testing.T) {
	tests := []struct {
		name        string
		start       bool
		update      map[string]any
		wantCalled  bool
		wantEnabled bool
		wantMemory  bool
	}{
		{
			name:        "snake_case block + snake_case field, true (the wire shape the API sends)",
			update:      map[string]any{"warranty_settings": map[string]any{"hp_cmsl_enabled": true}},
			wantCalled:  true,
			wantEnabled: true,
			wantMemory:  true,
		},
		{
			name:        "camelCase block + camelCase field, true",
			update:      map[string]any{"warrantySettings": map[string]any{"hpCmslEnabled": true}},
			wantCalled:  true,
			wantEnabled: true,
			wantMemory:  true,
		},
		{
			name:        "revocation: true → false persists and clears memory",
			start:       true,
			update:      map[string]any{"warranty_settings": map[string]any{"hp_cmsl_enabled": false}},
			wantCalled:  true,
			wantEnabled: false,
			wantMemory:  false,
		},
		{
			name:       "unchanged value does not rewrite agent.yaml",
			start:      true,
			update:     map[string]any{"warranty_settings": map[string]any{"hp_cmsl_enabled": true}},
			wantCalled: false,
			wantMemory: true,
		},
		{
			name:       "missing field → no-op",
			update:     map[string]any{"warranty_settings": map[string]any{}},
			wantCalled: false,
		},
		{
			name:       "non-boolean field → no-op",
			update:     map[string]any{"warranty_settings": map[string]any{"hp_cmsl_enabled": "yes"}},
			wantCalled: false,
		},
		{
			name:       "non-object payload → no-op",
			update:     map[string]any{"warranty_settings": "enabled"},
			wantCalled: false,
		},
		{
			name:       "block absent entirely → no-op",
			update:     map[string]any{"event_log_settings": map[string]any{}},
			wantCalled: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig := persistWarrantyCollectionEnabled
			t.Cleanup(func() { persistWarrantyCollectionEnabled = orig })
			var got *bool
			persistWarrantyCollectionEnabled = func(enabled bool) error {
				e := enabled
				got = &e
				return nil
			}

			cfg := config.Default()
			cfg.HPWarrantyCollectionEnabled = tt.start
			h := &Heartbeat{config: cfg}
			h.applyConfigUpdate(tt.update)

			if tt.wantCalled {
				if got == nil {
					t.Fatalf("persistence was not invoked; expected it with enabled=%v", tt.wantEnabled)
				}
				if *got != tt.wantEnabled {
					t.Errorf("persisted enabled = %v, want %v", *got, tt.wantEnabled)
				}
			} else if got != nil {
				t.Errorf("persistence was invoked (enabled=%v) but the payload should have been a no-op", *got)
			}

			if tt.wantCalled || tt.start {
				if h.hpWarrantyCollectionEnabled() != tt.wantMemory {
					t.Errorf("in-memory flag = %v, want %v", h.hpWarrantyCollectionEnabled(), tt.wantMemory)
				}
			}
		})
	}
}

// A persistence failure must not leave the in-memory flag disagreeing with what
// the control plane just said: the agent keeps applying the pushed value for
// this process and re-persists on the next heartbeat that changes it.
func TestApplyWarrantyConfig_PersistFailureKeepsInMemoryValue(t *testing.T) {
	orig := persistWarrantyCollectionEnabled
	t.Cleanup(func() { persistWarrantyCollectionEnabled = orig })
	persistWarrantyCollectionEnabled = func(bool) error { return errPersistStub }

	h := &Heartbeat{config: config.Default()}
	h.applyConfigUpdate(map[string]any{"warranty_settings": map[string]any{"hp_cmsl_enabled": true}})

	if !h.hpWarrantyCollectionEnabled() {
		t.Fatal("in-memory flag was not set after a persistence failure")
	}
}
```

Add the stub error at the bottom of the test file:

```go
type persistStubError struct{}

func (persistStubError) Error() string { return "stub persist failure" }

var errPersistStub = persistStubError{}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/heartbeat/... -run TestApplyWarrantyConfig`
Expected: FAIL to COMPILE — `undefined: persistWarrantyCollectionEnabled`, `h.hpWarrantyCollectionEnabled undefined`, `cfg.HPWarrantyCollectionEnabled undefined`.

- [ ] **Step 3: Add the config field**

`agent/internal/config/config.go` — add after `RequireManifestSigningKeyID` (`:207`):

```go
	// HPWarrantyCollectionEnabled is the control-plane switch for device-side
	// HP warranty collection via HP's CMSL (#5511). Pushed on the heartbeat as
	// warranty_settings.hp_cmsl_enabled and persisted so the setting survives a
	// restart; the collector reads it through
	// Heartbeat.hpWarrantyCollectionEnabled().
	//
	// Default false. Collection installs and runs HP software on the endpoint
	// and is opt-in per configuration policy, so an agent that has never been
	// told anything must do nothing.
	HPWarrantyCollectionEnabled bool `mapstructure:"hp_warranty_collection_enabled" yaml:"hp_warranty_collection_enabled"`
```

and add to `saveToLocked` after `:726`:

```go
	viper.Set("hp_warranty_collection_enabled", cfg.HPWarrantyCollectionEnabled)
```

`Default()` needs no entry — the zero value is the intended default, exactly as for `RequireManifestSigningKeyID`.

- [ ] **Step 4: Write the seam**

Create `agent/internal/heartbeat/warranty_config.go`:

```go
package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/config"
)

// warrantyCollectionConfigKey is the agent.yaml key the pushed flag persists to.
const warrantyCollectionConfigKey = "hp_warranty_collection_enabled"

// persistWarrantyCollectionEnabled is the seam to the on-disk write. A package
// var so tests can capture the resolved bool on any platform without a config
// file present — the dispatch + payload-parse path is where a key-name
// regression would silently disable the whole feature, so it must be
// unit-tested even though viper.WriteConfig cannot run on the CI agent.
var persistWarrantyCollectionEnabled = setWarrantyCollectionEnabled

func setWarrantyCollectionEnabled(enabled bool) error {
	return config.SetAndPersist(warrantyCollectionConfigKey, enabled)
}

// applyWarrantyConfig handles the warranty_settings block from the heartbeat
// config update (#5511 W02). True permits device-side HP warranty collection
// via HP's CMSL; false stops it — which is what a device with no warranty
// policy, or one whose nearest policy dropped the hpCmsl block, receives. The
// server omits the block entirely when it could not resolve, so an absent key
// means "no change", never "off".
//
// The API sends snake_case inside the block; camelCase is accepted first here
// to match patch_source.go's parse, and both spellings are covered by tests.
func (h *Heartbeat) applyWarrantyConfig(raw any) {
	m, ok := raw.(map[string]any)
	if !ok {
		log.Warn("ignoring invalid warranty_settings payload: not an object")
		return
	}

	v, present := m["hpCmslEnabled"]
	if !present {
		v, present = m["hp_cmsl_enabled"]
	}
	if !present {
		log.Warn("warranty_settings received without hpCmslEnabled field")
		return
	}
	enabled, ok := v.(bool)
	if !ok {
		log.Warn("ignoring warranty_settings: hpCmslEnabled is not a boolean")
		return
	}

	h.mu.Lock()
	changed := h.config.HPWarrantyCollectionEnabled != enabled
	h.config.HPWarrantyCollectionEnabled = enabled
	h.mu.Unlock()

	// The in-memory value is what the collector reads, so it is always updated.
	// Only a CHANGE is written to disk: this runs on every heartbeat, and
	// rewriting agent.yaml each minute would be pointless churn.
	if !changed {
		return
	}

	if err := persistWarrantyCollectionEnabled(enabled); err != nil {
		// Keep the in-memory value. The control plane's instruction still
		// applies for this process and is re-persisted the next time it
		// changes; reverting here would ignore a live instruction because a
		// file write failed.
		log.Warn("failed to persist hp_warranty_collection_enabled", "error", err.Error())
		return
	}
	if enabled {
		log.Info("HP CMSL warranty collection enabled by control plane")
	} else {
		log.Info("HP CMSL warranty collection disabled by control plane")
	}
}

// hpWarrantyCollectionEnabled reads the flag under h.mu. The (W03) collector
// calls this rather than reading h.config directly, so a value pushed mid-run
// takes effect on the next collection with no restart.
func (h *Heartbeat) hpWarrantyCollectionEnabled() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.config.HPWarrantyCollectionEnabled
}
```

- [ ] **Step 5: Add the dispatch ABOVE the probe path**

In `agent/internal/heartbeat/heartbeat.go`, insert between the onedrive block's closing brace (`:2916`) and `registryRaw` (`:2918`):

```go
	// Apply warranty_settings if present (#5511 W02): permit or stop device-side
	// HP CMSL warranty collection. No-op on non-Windows.
	//
	// THIS MUST STAY ABOVE THE POLICY-PROBE BLOCK BELOW. That block returns
	// unconditionally when neither probe key is present, which is most
	// heartbeats — a key dispatched after it is silently unreachable in
	// production with nothing in the logs to show for it.
	warRaw, hasWar := update["warranty_settings"]
	if !hasWar {
		warRaw, hasWar = update["warrantySettings"]
	}
	if hasWar {
		h.applyWarrantyConfig(warRaw)
	}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/heartbeat/... -run TestApplyWarrantyConfig`
Expected: PASS.

Then the whole packages, since `config.Config` and `applyConfigUpdate` are widely used:
Run: `cd agent && go test -race ./internal/heartbeat/... ./internal/config/...`
Expected: PASS.

Run: `cd agent && go build ./...`
Expected: clean.

- [ ] **Step 7: Prove the placement, not just the parse**

Temporarily move the new dispatch block to sit **after** the `if !hasRegistry && !hasConfig { return }` at `:2928-2930`, re-run `cd agent && go test -race ./internal/heartbeat/... -run TestApplyWarrantyConfig`, and confirm every `wantCalled: true` case FAILS. Then move it back and re-run to confirm PASS.

This is the one control worth spending two minutes on: it is the difference between a test that pins the key names and a test that pins the key names *and* the reachability. Do not skip it and do not commit the moved version.

- [ ] **Step 8: Commit**

```bash
git add agent/internal/config/config.go agent/internal/heartbeat/warranty_config.go agent/internal/heartbeat/warranty_config_test.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): dispatch warranty_settings above the probe path through a testable seam (#5511 W02 D6/D7)"
```

---

### Task 11: Locale catalogs — six new `warrantyTab` keys in all eight locales

**Files:** Modify `apps/web/src/locales/<locale>/policies.json` for `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`.

**Interfaces:**
- Consumes: nothing.
- Produces six keys under `configurationPolicies.featureTabs.warrantyTab`, consumed by Task 12:
  `collectHpWarrantyFromTheDevice`, `hpCmslConsentExplainer`, `hpCmslNoAcceptanceRecordedYet`, `hpCmslAcceptedByOn` (interpolates `{{user}}` and `{{date}}`), `hpCmslTermsChangedSaveAgain`, `hpCmslInheritanceReplacesTheWholeLink`.

**Why this is its own task, and why English cannot simply be copied.** Three separate guards apply. `localeParity.test.ts:457-461` requires the key SET to match `en` exactly in every locale, so all eight files change together or CI is red. `translationCoverage.test.ts:764-778` counts exact-English duplicates per namespace against a hard baseline, so pasting the English string into the seven translated catalogs fails. `localeParity.test.ts:513-524` requires each `protectedNames` entry to occur the same number of times in the translation as in English — `IP` is on that list and appears exactly once in the explainer, so **every translation must contain `IP` exactly once**. `terminologyQuality.test.ts:40-49`'s forbidden patterns are avoided throughout (no bare `voce`, `comecar`, `esta ativa`; no `postuler`, `subventions`; no `Hauptschalter`; no `potrài`).

`keyUsage.test.ts:336` checks key→catalog only, so landing the catalogs before the component is fine and keeps this task independently reviewable.

- [ ] **Step 1: Run the guards first, to see them green before the change**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/terminologyQuality.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS, 4 files. This is the baseline; if any of these is already red on your branch, fix that first — you will not be able to read your own result otherwise.

- [ ] **Step 2: Add the six keys to `en` only, and watch parity go red**

In `apps/web/src/locales/en/policies.json`, add a comma after the `"criticalDays"` entry (`:1178`) and insert before the closing brace of `warrantyTab` (`:1179`):

```json
        "collectHpWarrantyFromTheDevice": "Collect HP warranty from the device",
        "hpCmslConsentExplainer": "HP warranty data is read on the device using HP's Client Management Script Library. Ticking this box accepts HP's licence on this customer's behalf, and HP may collect technical information from the device, including its IP address. Left unticked, HP devices keep whatever warranty status they already have.",
        "hpCmslNoAcceptanceRecordedYet": "No acceptance recorded yet. Saving with this box ticked records your user and the server time.",
        "hpCmslAcceptedByOn": "Accepted by {{user}} on {{date}}",
        "hpCmslTermsChangedSaveAgain": "HP has changed its licence terms since this acceptance. Save again to re-accept.",
        "hpCmslInheritanceReplacesTheWholeLink": "This policy replaces the inherited warranty settings as a whole, with no field-by-field merge. Saving it with device collection switched off stops HP warranty collection on every device this policy reaches."
```

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts`
Expected: FAIL — seven `<locale> matches en namespace files and keys exactly` cases, each naming the six missing keys. That failure is the point: it is the mechanism that stops a half-translated feature shipping.

- [ ] **Step 3: Add the translations**

`de-DE`:

```json
        "collectHpWarrantyFromTheDevice": "HP-Garantiedaten auf dem Gerät erfassen",
        "hpCmslConsentExplainer": "HP-Garantiedaten werden auf dem Gerät mit der Client Management Script Library von HP gelesen. Mit diesem Kontrollkästchen akzeptieren Sie die HP-Lizenz im Namen dieses Kunden, und HP darf technische Informationen vom Gerät erfassen, einschließlich der IP-Adresse. Bleibt es leer, behalten HP-Geräte den Garantiestatus, den sie bereits haben.",
        "hpCmslNoAcceptanceRecordedYet": "Noch keine Zustimmung erfasst. Beim Speichern mit gesetztem Kontrollkästchen werden Ihr Benutzer und die Serverzeit erfasst.",
        "hpCmslAcceptedByOn": "Akzeptiert von {{user}} am {{date}}",
        "hpCmslTermsChangedSaveAgain": "HP hat seine Lizenzbedingungen seit dieser Zustimmung geändert. Speichern Sie erneut, um erneut zuzustimmen.",
        "hpCmslInheritanceReplacesTheWholeLink": "Diese Richtlinie ersetzt die geerbten Garantieeinstellungen vollständig, ohne feldweise Zusammenführung. Wird sie mit deaktivierter Erfassung gespeichert, endet die HP-Garantieerfassung auf jedem Gerät, das diese Richtlinie erreicht."
```

`es-419`:

```json
        "collectHpWarrantyFromTheDevice": "Recopilar la garantía HP desde el dispositivo",
        "hpCmslConsentExplainer": "Los datos de garantía de HP se leen en el dispositivo con la Client Management Script Library de HP. Al marcar esta casilla acepta la licencia de HP en nombre de este cliente, y HP puede recopilar información técnica del dispositivo, incluida su dirección IP. Si la deja sin marcar, los dispositivos HP conservan el estado de garantía que ya tienen.",
        "hpCmslNoAcceptanceRecordedYet": "Aún no hay aceptación registrada. Al guardar con esta casilla marcada se registran su usuario y la hora del servidor.",
        "hpCmslAcceptedByOn": "Aceptado por {{user}} el {{date}}",
        "hpCmslTermsChangedSaveAgain": "HP cambió sus términos de licencia desde esta aceptación. Guarde de nuevo para volver a aceptar.",
        "hpCmslInheritanceReplacesTheWholeLink": "Esta política reemplaza por completo la configuración de garantía heredada, sin combinación campo por campo. Si la guarda con la recopilación en el dispositivo desactivada, se detiene la recopilación de garantía HP en todos los dispositivos que alcanza."
```

`fr-FR`:

```json
        "collectHpWarrantyFromTheDevice": "Collecter la garantie HP depuis l'appareil",
        "hpCmslConsentExplainer": "Les données de garantie HP sont lues sur l'appareil à l'aide de la Client Management Script Library de HP. Cocher cette case accepte la licence HP au nom de ce client, et HP peut collecter des informations techniques depuis l'appareil, y compris son adresse IP. Laissée décochée, les appareils HP conservent l'état de garantie qu'ils possèdent déjà.",
        "hpCmslNoAcceptanceRecordedYet": "Aucune acceptation enregistrée pour l'instant. L'enregistrement avec cette case cochée consigne votre utilisateur et l'heure du serveur.",
        "hpCmslAcceptedByOn": "Accepté par {{user}} le {{date}}",
        "hpCmslTermsChangedSaveAgain": "HP a modifié ses conditions de licence depuis cette acceptation. Enregistrez de nouveau pour accepter à nouveau.",
        "hpCmslInheritanceReplacesTheWholeLink": "Cette stratégie remplace entièrement les paramètres de garantie hérités, sans fusion champ par champ. L'enregistrer avec la collecte sur l'appareil désactivée arrête la collecte de garantie HP sur tous les appareils qu'elle atteint."
```

`fr-CA` (same terminology, Canadian phrasing on the first and third entries):

```json
        "collectHpWarrantyFromTheDevice": "Recueillir la garantie HP à partir de l'appareil",
        "hpCmslConsentExplainer": "Les données de garantie HP sont lues sur l'appareil à l'aide de la Client Management Script Library de HP. Cocher cette case accepte la licence HP au nom de ce client, et HP peut collecter des informations techniques depuis l'appareil, y compris son adresse IP. Laissée décochée, les appareils HP conservent l'état de garantie qu'ils possèdent déjà.",
        "hpCmslNoAcceptanceRecordedYet": "Aucune acceptation n'est enregistrée pour le moment. L'enregistrement avec cette case cochée consigne votre utilisateur et l'heure du serveur.",
        "hpCmslAcceptedByOn": "Accepté par {{user}} le {{date}}",
        "hpCmslTermsChangedSaveAgain": "HP a modifié ses conditions de licence depuis cette acceptation. Enregistrez de nouveau pour accepter à nouveau.",
        "hpCmslInheritanceReplacesTheWholeLink": "Cette stratégie remplace entièrement les paramètres de garantie hérités, sans fusion champ par champ. L'enregistrer avec la collecte sur l'appareil désactivée arrête la collecte de garantie HP sur tous les appareils qu'elle atteint."
```

`it-IT`:

```json
        "collectHpWarrantyFromTheDevice": "Raccogli la garanzia HP dal dispositivo",
        "hpCmslConsentExplainer": "I dati di garanzia HP vengono letti sul dispositivo tramite la Client Management Script Library di HP. Selezionando questa casella si accetta la licenza HP per conto di questo cliente e HP può raccogliere informazioni tecniche dal dispositivo, incluso il suo indirizzo IP. Se resta deselezionata, i dispositivi HP mantengono lo stato di garanzia che hanno già.",
        "hpCmslNoAcceptanceRecordedYet": "Nessuna accettazione registrata finora. Salvando con questa casella selezionata vengono registrati il tuo utente e l'ora del server.",
        "hpCmslAcceptedByOn": "Accettato da {{user}} il {{date}}",
        "hpCmslTermsChangedSaveAgain": "HP ha modificato le condizioni di licenza dopo questa accettazione. Salva di nuovo per accettare nuovamente.",
        "hpCmslInheritanceReplacesTheWholeLink": "Questo criterio sostituisce per intero le impostazioni di garanzia ereditate, senza alcuna unione campo per campo. Salvandolo con la raccolta sul dispositivo disattivata si interrompe la raccolta della garanzia HP su ogni dispositivo che raggiunge."
```

`pt-BR`:

```json
        "collectHpWarrantyFromTheDevice": "Coletar a garantia HP do dispositivo",
        "hpCmslConsentExplainer": "Os dados de garantia da HP são lidos no dispositivo com a Client Management Script Library da HP. Marcar esta caixa aceita a licença da HP em nome deste cliente, e a HP pode coletar informações técnicas do dispositivo, incluindo o endereço IP. Se ficar desmarcada, os dispositivos HP mantêm o status de garantia que já possuem.",
        "hpCmslNoAcceptanceRecordedYet": "Nenhuma aceitação registrada até agora. Ao salvar com esta caixa marcada, seu usuário e o horário do servidor são registrados.",
        "hpCmslAcceptedByOn": "Aceito por {{user}} em {{date}}",
        "hpCmslTermsChangedSaveAgain": "A HP alterou os termos de licença desde esta aceitação. Salve novamente para aceitar de novo.",
        "hpCmslInheritanceReplacesTheWholeLink": "Esta política substitui por completo as configurações de garantia herdadas, sem mesclagem campo a campo. Salvá-la com a coleta no dispositivo desativada interrompe a coleta de garantia HP em todos os dispositivos que ela alcança."
```

`tr-TR`:

```json
        "collectHpWarrantyFromTheDevice": "HP garantisini cihazdan topla",
        "hpCmslConsentExplainer": "HP garanti verileri, HP'nin Client Management Script Library aracı kullanılarak cihaz üzerinde okunur. Bu kutuyu işaretlemek HP lisansını bu müşteri adına kabul eder ve HP, IP adresi dahil olmak üzere cihazdan teknik bilgi toplayabilir. İşaretlenmezse HP cihazları mevcut garanti durumlarını korur.",
        "hpCmslNoAcceptanceRecordedYet": "Henüz kayıtlı bir kabul yok. Bu kutu işaretliyken kaydettiğinizde kullanıcınız ve sunucu saati kaydedilir.",
        "hpCmslAcceptedByOn": "{{date}} tarihinde {{user}} tarafından kabul edildi",
        "hpCmslTermsChangedSaveAgain": "HP, bu kabulden bu yana lisans koşullarını değiştirdi. Yeniden kabul etmek için tekrar kaydedin.",
        "hpCmslInheritanceReplacesTheWholeLink": "Bu ilke, devralınan garanti ayarlarının tamamını değiştirir; alan alan birleştirme yoktur. Cihaz üzerinde toplama kapalıyken kaydedilmesi, bu ilkenin ulaştığı her cihazda HP garanti toplamayı durdurur."
```

Note the `tr-TR` `hpCmslAcceptedByOn` puts `{{date}}` before `{{user}}` — Turkish word order. The parity check compares interpolation tokens as a SORTED set (`localeParity.test.ts:38-41`), so re-ordering is allowed and dropping one is not.

- [ ] **Step 4: Run every i18n guard to verify green**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/terminologyQuality.test.ts src/lib/i18n/extractionQuality.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS, 5 files.

If `localeParity` reports a `preserves source-aligned technical literals and names` failure, it will name the key and the literal: count the occurrences of that literal in the English string and match it exactly in the translation. `IP` is the one to expect.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/locales/en/policies.json apps/web/src/locales/de-DE/policies.json apps/web/src/locales/es-419/policies.json apps/web/src/locales/fr-CA/policies.json apps/web/src/locales/fr-FR/policies.json apps/web/src/locales/it-IT/policies.json apps/web/src/locales/pt-BR/policies.json apps/web/src/locales/tr-TR/policies.json
git commit -m "i18n(web): HP CMSL consent and inheritance copy for the warranty policy tab (#5511 W02)"
```

---

### Task 12: WarrantyTab — the opt-in checkbox, the consent copy, the recorded acceptance, and the inheritance warning

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.tsx` (whole file)
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.test.tsx`

**Interfaces:**
- Consumes: Task 11's six locale keys; Task 1's `HP_CMSL_EULA_ID`, `readRecordedWarrantyHpCmslConsent`, `warrantyHpCmslCollectionEffective` — imported from the **root** `@breeze/shared` barrel, because `apps/web/tsconfig.json:7-8` and `apps/web/vitest.config.ts:18-22` alias only `@breeze/shared` and `@breeze/shared/reportPdf`.
- Produces: `data-testid` hooks `warranty-tab-hp-cmsl-toggle`, `warranty-tab-hp-cmsl-consent`, `warranty-tab-hp-cmsl-acceptance`, `warranty-tab-hp-cmsl-superseded`, `warranty-tab-inheritance-warning`.

**Two things this component must get right or the feature breaks.**

1. **It must never send `consent` back.** `useFeatureLink.ts:34` posts `payload.inlineSettings` verbatim, and the tab reads the recorded consent out of the saved link in order to display it. Echoing it on the next save trips Task 3's coded 400 on *every* subsequent edit. The fix is structural, not a `delete`: local state holds a flat `hpCmslEnabled` boolean and the save payload REBUILDS `{ hpCmsl: { enabled } }`, so there is no code path on which a consent object can reach the request body.
2. **It must surface the inheritance drop (contract D5).** Policy resolution picks a whole link. A child policy carrying only alert thresholds replaces an inherited link and drops its `hpCmsl` block, silently revoking collection on every device it reaches. The warning below is the only place a technician can learn that before pressing Save.

- [ ] **Step 1: Write the failing test**

Replace `apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WarrantyTab from './WarrantyTab';
import { HP_CMSL_EULA_ID } from '@breeze/shared';

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network.
const saveMock = vi.fn(async () => ({ id: 'link-1' }));
const removeMock = vi.fn(async () => true);

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import type { FeatureLink, FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

const CONSENT = {
  acceptedByUserId: 'user-7',
  acceptedAt: '2026-09-10T12:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};

function link(id: string, inlineSettings: Record<string, unknown>): FeatureLink {
  return { id, featureType: 'warranty', featurePolicyId: null, inlineSettings };
}

function clickSave() {
  const button = screen
    .getAllByRole('button')
    .find((b) => /^save/i.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;
  fireEvent.click(button);
}

function savedSettings(): Record<string, any> {
  const call = saveMock.mock.calls[0] as unknown as [unknown, { inlineSettings: Record<string, any> }];
  return call[1].inlineSettings;
}

describe('WarrantyTab', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  // #5080: `featurePolicyId` means a standalone entity id (update ring, backup
  // profile, ...) — Warranty is inline settings, so it must never carry the
  // parent CONFIG policy's own id.
  it('sends featurePolicyId: null even when a parent config policy is linked', () => {
    render(<WarrantyTab {...baseProps} linkedPolicyId="parent-1" />);
    clickSave();

    expect(saveMock).toHaveBeenCalled();
    const call = saveMock.mock.calls[0] as unknown as [unknown, { featurePolicyId: string | null }];
    expect(call[1].featurePolicyId).toBeNull();
  });

  it('defaults HP collection to off and says so in the payload', () => {
    render(<WarrantyTab {...baseProps} />);
    clickSave();

    expect(savedSettings().hpCmsl).toEqual({ enabled: false });
  });

  it('sends hpCmsl.enabled true once the box is ticked', () => {
    render(<WarrantyTab {...baseProps} />);
    fireEvent.click(screen.getByTestId('warranty-tab-hp-cmsl-toggle'));
    clickSave();

    expect(savedSettings().hpCmsl).toEqual({ enabled: true });
  });

  it('NEVER echoes a recorded consent back to the server (#5511 D3)', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-1', { enabled: true, warnDays: 90, criticalDays: 30, hpCmsl: { enabled: true, consent: CONSENT } })}
      />,
    );
    clickSave();

    expect(savedSettings().hpCmsl).toEqual({ enabled: true });
    expect(JSON.stringify(savedSettings())).not.toContain('consent');
  });

  it('renders the consent explainer and, once recorded, who accepted', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-1', { hpCmsl: { enabled: true, consent: CONSENT } })}
      />,
    );

    expect(screen.getByTestId('warranty-tab-hp-cmsl-consent')).toBeTruthy();
    expect(screen.getByTestId('warranty-tab-hp-cmsl-acceptance').textContent).toContain('user-7');
    expect(screen.queryByTestId('warranty-tab-hp-cmsl-superseded')).toBeNull();
  });

  it('flags an acceptance recorded against superseded terms (#5511 D2)', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-1', {
          hpCmsl: { enabled: true, consent: { ...CONSENT, eulaId: 'hp-cmsl-eula-2020-01-01' } },
        })}
      />,
    );

    expect(screen.getByTestId('warranty-tab-hp-cmsl-superseded')).toBeTruthy();
  });

  it('warns that overriding a collecting parent DROPS collection, and proves the drop (#5511 D5)', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-child', { enabled: true, warnDays: 14, criticalDays: 7 })}
        parentLink={link('link-parent', { hpCmsl: { enabled: true, consent: CONSENT } })}
      />,
    );

    // The child link carries no hpCmsl block, so the tab shows collection OFF
    // and warns. Saving writes `false` — the inherited block is NOT merged in.
    expect(screen.getByTestId('warranty-tab-inheritance-warning')).toBeTruthy();
    clickSave();
    expect(savedSettings().hpCmsl).toEqual({ enabled: false });
  });

  it('does not warn when the child keeps collection on', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-child', { hpCmsl: { enabled: true, consent: CONSENT } })}
        parentLink={link('link-parent', { hpCmsl: { enabled: true, consent: CONSENT } })}
      />,
    );

    expect(screen.queryByTestId('warranty-tab-inheritance-warning')).toBeNull();
  });

  it('does not warn when the parent does not collect', () => {
    render(
      <WarrantyTab
        {...baseProps}
        existingLink={link('link-child', { warnDays: 14 })}
        parentLink={link('link-parent', { enabled: true, warnDays: 90 })}
      />,
    );

    expect(screen.queryByTestId('warranty-tab-inheritance-warning')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/WarrantyTab.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="warranty-tab-hp-cmsl-toggle"]`, and `savedSettings().hpCmsl` is `undefined`.

- [ ] **Step 3: Rewrite the component**

Replace `apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.tsx` with:

```tsx
import { useState, useEffect } from "react";
import { ShieldCheck } from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { formatDateTime } from "@/lib/dateTimeFormat";
import {
  HP_CMSL_EULA_ID,
  readRecordedWarrantyHpCmslConsent,
  warrantyHpCmslCollectionEffective,
} from "@breeze/shared";

/**
 * `warranty` inline settings (#1320 alerting, #5511 W02 HP CMSL collection).
 *
 * `enabled` is EXPIRY ALERTING. `hpCmslEnabled` is DEVICE-SIDE COLLECTION.
 * They are independent switches and neither implies the other.
 *
 * State holds the HP flag FLAT even though it is stored nested, so that the
 * save payload has to rebuild `{ hpCmsl: { enabled } }` from scratch. That is
 * deliberate: the server refuses a client-supplied `hpCmsl.consent` with a
 * coded 400 and stamps its own from the authenticated session, and this tab
 * reads that consent back in order to display it. With a nested settings
 * object the read value would ride along on the next save and break every edit
 * after the first; with a flat flag there is no path on which it can.
 */
type WarrantySettings = {
  enabled: boolean;
  warnDays: number;
  criticalDays: number;
  hpCmslEnabled: boolean;
};

const defaults: WarrantySettings = {
  enabled: true,
  warnDays: 90,
  criticalDays: 30,
  hpCmslEnabled: false,
};

function readSettings(
  inlineSettings: Record<string, unknown> | null | undefined,
): Partial<WarrantySettings> {
  if (!inlineSettings) return {};
  const out: Partial<WarrantySettings> = {};
  if (typeof inlineSettings.enabled === "boolean") out.enabled = inlineSettings.enabled;
  if (typeof inlineSettings.warnDays === "number") out.warnDays = inlineSettings.warnDays;
  if (typeof inlineSettings.criticalDays === "number") out.criticalDays = inlineSettings.criticalDays;
  const hpCmsl = inlineSettings.hpCmsl as { enabled?: unknown } | null | undefined;
  out.hpCmslEnabled = !!hpCmsl && hpCmsl.enabled === true;
  return out;
}

function toInlineSettings(settings: WarrantySettings) {
  return {
    enabled: settings.enabled,
    warnDays: settings.warnDays,
    criticalDays: settings.criticalDays,
    // `consent` is deliberately absent — see the type doc above.
    hpCmsl: { enabled: settings.hpCmslEnabled },
  };
}

export default function WarrantyTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
  parentLink,
}: FeatureTabProps) {
  useTranslation("policies");
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const [settings, setSettings] = useState<WarrantySettings>(() => ({
    ...defaults,
    ...readSettings(effectiveLink?.inlineSettings),
  }));
  useEffect(() => {
    const link = existingLink ?? parentLink;
    setSettings((prev) => ({ ...prev, ...readSettings(link?.inlineSettings) }));
  }, [existingLink, parentLink]);

  const update = <K extends keyof WarrantySettings>(
    key: K,
    value: WarrantySettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));

  const handleSave = async () => {
    clearError();
    const result = await save(existingLink?.id ?? null, {
      featureType: "warranty",
      featurePolicyId: null, // #5080: inline settings — never stamp the parent CONFIG policy's own id here
      inlineSettings: toInlineSettings(settings),
    });
    if (result) onLinkChanged(result, "warranty");
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "warranty");
  };
  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: "warranty",
      featurePolicyId: null, // #5080: inline settings — never stamp the parent CONFIG policy's own id here
      inlineSettings: toInlineSettings(settings),
    });
    if (result) onLinkChanged(result, "warranty");
  };
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "warranty");
  };

  // The acceptance shown is the one on the link being edited — or, while this
  // tab is still showing inherited state, the parent's. Both are real answers
  // to "who accepted HP's licence for the policy in force here".
  const recordedConsent = readRecordedWarrantyHpCmslConsent(effectiveLink?.inlineSettings);
  const consentSuperseded = !!recordedConsent && recordedConsent.eulaId !== HP_CMSL_EULA_ID;

  // Contract D5: resolution picks a WHOLE link, never a field-by-field merge.
  // A child policy that does not collect REPLACES a collecting parent and
  // revokes collection on every device it reaches. Say so before Save.
  const parentCollects = warrantyHpCmslCollectionEffective(parentLink?.inlineSettings);
  const showsInheritanceWarning = parentCollects && !settings.hpCmslEnabled;

  const meta = FEATURE_META.warranty;
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<ShieldCheck className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={saving}
      error={error}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={
        !isInherited && !!linkedPolicyId && !!existingLink
          ? handleRevert
          : undefined
      }
    >
      <div className="space-y-6">
        {/* Opt-in clarification: warranty alerting only happens when this feature is
            assigned and enabled (#1320). */}
        <p className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.warrantyTab.warrantyAlertingIsOptInDevicesWith",
          )}
        </p>

        {/* Enable toggle */}
        <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
          <div>
            <p className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.warrantyTab.enableWarrantyExpiryAlerts",
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.warrantyTab.generateAlertsWhenFixedTermDeviceWarranties",
              )}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            data-testid="warranty-tab-alerts-toggle"
            onClick={() => update("enabled", !settings.enabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${settings.enabled ? "bg-emerald-500/80" : "bg-muted"}`}
          >
            <span
              className={`inline-block h-5 w-5 rounded-full bg-white transition ${settings.enabled ? "translate-x-5" : "translate-x-1"}`}
            />
          </button>
        </div>

        {settings.enabled && (
          <div className="grid gap-6 sm:grid-cols-2">
            <div>
              <label className="text-sm font-medium">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.warrantyTab.warningThresholdDays",
                )}
              </label>
              <input
                type="number"
                min={1}
                max={365}
                value={settings.warnDays}
                onChange={(e) =>
                  update("warnDays", Number(e.target.value) || 90)
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.warrantyTab.generateAWarningAlertWhenWarrantyExpires",
                )}
              </p>
            </div>

            <div>
              <label className="text-sm font-medium">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.warrantyTab.criticalThresholdDays",
                )}
              </label>
              <input
                type="number"
                min={1}
                max={365}
                value={settings.criticalDays}
                onChange={(e) =>
                  update("criticalDays", Number(e.target.value) || 30)
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.warrantyTab.generateACriticalAlertWhenWarrantyExpires",
                )}
              </p>
            </div>
          </div>
        )}

        {/* HP CMSL device-side collection (#5511 W02) */}
        <div className="space-y-3 rounded-md border bg-background px-4 py-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.warrantyTab.collectHpWarrantyFromTheDevice",
              )}
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={settings.hpCmslEnabled}
              data-testid="warranty-tab-hp-cmsl-toggle"
              onClick={() => update("hpCmslEnabled", !settings.hpCmslEnabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${settings.hpCmslEnabled ? "bg-emerald-500/80" : "bg-muted"}`}
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white transition ${settings.hpCmslEnabled ? "translate-x-5" : "translate-x-1"}`}
              />
            </button>
          </div>

          <p
            data-testid="warranty-tab-hp-cmsl-consent"
            className="text-xs text-muted-foreground"
          >
            {i18n.t(
              "policies:configurationPolicies.featureTabs.warrantyTab.hpCmslConsentExplainer",
            )}
          </p>

          {recordedConsent ? (
            <p
              data-testid="warranty-tab-hp-cmsl-acceptance"
              className="text-xs text-muted-foreground"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.warrantyTab.hpCmslAcceptedByOn",
                {
                  user: recordedConsent.acceptedByUserId,
                  date: formatDateTime(recordedConsent.acceptedAt),
                },
              )}
            </p>
          ) : (
            <p
              data-testid="warranty-tab-hp-cmsl-no-acceptance"
              className="text-xs text-muted-foreground"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.warrantyTab.hpCmslNoAcceptanceRecordedYet",
              )}
            </p>
          )}

          {consentSuperseded && (
            <p
              data-testid="warranty-tab-hp-cmsl-superseded"
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
            >
              {i18n.t(
                "policies:configurationPolicies.featureTabs.warrantyTab.hpCmslTermsChangedSaveAgain",
              )}
            </p>
          )}
        </div>

        {showsInheritanceWarning && (
          <p
            data-testid="warranty-tab-inheritance-warning"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs"
          >
            {i18n.t(
              "policies:configurationPolicies.featureTabs.warrantyTab.hpCmslInheritanceReplacesTheWholeLink",
            )}
          </p>
        )}
      </div>
    </FeatureTabShell>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/WarrantyTab.test.tsx`
Expected: PASS.

Then the guards that read this file's source and the tab registry:
Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/structuralValues.test.ts src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS, 4 files. `structuralValues` already lists `WarrantyTab.tsx`; the new code compares machine values (`settings.hpCmslEnabled`) and never a translated string, so it stays clean.

Run: `cd apps/web && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.tsx apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.test.tsx
git commit -m "feat(web): HP CMSL opt-in, consent copy, recorded acceptance and inheritance warning on the warranty tab (#5511 W02)"
```

---

## Final verification before opening the PR

- [ ] **API unit suite** — `cd apps/api && npx vitest run src/services/configurationPolicy src/services/warrantyPolicyResolution src/services/warrantyAlertEvaluator src/services/aiGuardrails src/services/aiToolsConfigPolicy src/routes/configurationPolicies src/routes/agents/helpers src/routes/agents/heartbeat.test.ts src/routes/mcpServer.approvalGate.test.ts`. Check the reported FILE COUNT is what you expect; vitest's filter is a plain substring match, so a typo yields "No test files found", which reads like success in a scroll-back. `src/services/aiGuardrails` is a bare substring and pulls in the whole contract family plus `aiGuardrailsTierConfig.parity` / `aiGuardrailsAiDocs.parity` — that is intended here.
- [ ] **Full API + web + shared suites** — `pnpm --filter @breeze/api test --run`, `pnpm --filter @breeze/web test --run`, `pnpm --filter @breeze/shared test --run`. Note the absent `--` before `--run`: with it, pnpm forwards the literal token, vitest swallows `--run` as a positional filter, and the entire suite runs in watch mode.
- [ ] **Go** — `cd agent && go test -race ./...` and `cd agent && go build ./...`.
- [ ] **Typecheck + lint** — `cd apps/api && npx tsc --noEmit`, `cd apps/web && npx tsc --noEmit`, `cd packages/shared && npx tsc --noEmit`, `pnpm lint`.
- [ ] **Integration suites: not needed, and say so in the PR.** This wave adds no table, no column, no migration and no RLS policy, so `rls-coverage`, `tenantCascade`, `tenant-export-policy` and the erasure round-trip are all unaffected. Contract D1 is explicit that the `hpCmsl` block is pure jsonb on an existing feature link. **If a reviewer asks "which cascade list did you touch?", the answer is "none, and here is why" — not "I forgot".**
- [ ] **Merge `main` before trusting a green branch.** PR CI tests the merge commit; a locally-green branch on a stale base proves nothing.
- [ ] **PR body** must carry `Closes #5513` so the wave sub-issue auto-closes, and should state: no migration; no cascade/export registration; the five gated HTTP transitions, the sixth (AI) door closed at the guardrails layer, and the two deliberately ungated ones; and that W03 consumes `hpWarrantyCollectionEnabled()` plus the `persistWarrantyCollectionEnabled` seam.

## Self-review

**Spec coverage.** Spec layer 1 (`hpCmsl` block, server-stamped consent, authorization matching the deployment gate, the inheritance footgun) → Tasks 1, 2, 3, 5, 6, 12. Spec layer 2 (`buildWarrantyConfigUpdate`, `PolicyConfigUpdates`, `applyConfigUpdate` dispatch, the new `warranty_config.go`, the copied revocation contract) → Tasks 7, 8, 9, 10. Spec layer 7's `WarrantyTab.tsx` bullet → Tasks 11, 12. Contract D12 → Task 4. Layers 3-6 and the rest of layer 7 belong to W01/W03/W04/W05 and are listed under Global Constraints as out of scope. The spec's "Corrections" section is honoured throughout: the dispatch is above `:2918`, neither Go symbol is exported, and `patch_source.go`'s camelCase-first inner parse is mirrored.

**D4 coverage is now complete, and that is the change this revision makes.** The first draft enumerated five HTTP doors and made the AI door merely *inert* (no actor → no consent → delivery `false`). Inert is not gated: an assistant could still flip the stored flag, leaving the UI claiming collection was on while nothing was delivered, and the gate one refactor away from a real bypass. Task 6 closes it at the guardrails layer, where an AI tool call is actually classified. Both layers are kept deliberately — Task 2's consent rule is the fail-safe that survives a future loosening of the guardrail predicate, and Task 6 is the gate. Task 5 now names the sixth door and points at Task 6 rather than pretending five was the whole set.

**Placeholder scan.** Every code step carries complete, runnable code — TypeScript, Go, JSX, JSON and shell alike. The only prose-only steps are Task 10 step 7 (a deliberate move-it-and-watch-it-fail control) and Task 7 step 4's instruction to let `tsc` name the orphaned imports rather than guessing at a list that will drift.

**Type consistency.** `WarrantySettings` in `helpers.ts` is `{ hpCmslEnabled: boolean }` in Task 8, referenced by exactly that name in Task 9's `PolicyConfigUpdates` and mapped to the wire's `hp_cmsl_enabled` in one place. The web component's local `WarrantySettings` is a different, file-local type in a different package — same name, no collision, and its `hpCmslEnabled` field name matches deliberately. `resolveEffectiveWarrantyInlineSettings` is spelled identically in Tasks 7, 8 and Task 8's mock path. `persistWarrantyCollectionEnabled` is spelled identically in the Go source and its test. `isInputAwareTier3` keeps its exact existing signature `(toolName, action, input)` in Task 6, so its two call sites (`aiGuardrails.ts:570`, `:1426`) and the contract test need no change beyond the new cases.

**One predicate, three consumers, one meaning.** `warrantyHpCmslRequested` — "is this author asking for collection?" — is now read by the HTTP gate (Task 5), the guardrails escalation (Task 6) and the approval description (Task 6). That is deliberate: the tier a call is assigned, the permission it demands, and the sentence an approver reads must all be answering the same question, or one of them drifts. `warrantyHpCmslCollectionEffective` stays reserved for stored rows (delivery, inheritance/assignment gates) — Task 5's table is the reference if a later reader is tempted to unify them.

**Known risk left in place.** `consent.acceptedByUserId` renders as a raw user id in the tab, because contract D1 fixes the consent shape to three fields and this wave may not widen it. Resolving an id to a name needs either a stamped display name (a contract change) or a user lookup on the policy page (new API surface). Both are follow-ups, not W02 work — flag it in the PR.

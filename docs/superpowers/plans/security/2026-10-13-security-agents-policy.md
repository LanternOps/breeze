---
status: draft-for-review
issue: LanternOps/breeze#6960
prerequisite: [6958]
spec: docs/superpowers/specs/security/2026-10-12-security-agents-policy-spec.md
---

# Security Agents Config-Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP tick Huntress / SentinelOne / Control D / NextDNS in a (partner-wide) configuration policy and have every in-scope device get the agent with the right per-customer keys, kept running, and visibly accounted for.

**Architecture:** A new `security_agents` config feature type holds only non-secret desired state inline. Saving the link generates a *managed* `software_policies` row (`managed_by_link_id`) that reuses the existing software deployment/compliance/remediation pipeline. Managed policies get their own resolution dimension (`resolveSecurityAgentsLinkForDevice`) so they are never shadowed by a customer-authored `software_policy` link. A readiness preflight turns unmapped orgs into `not_applicable` instead of failed deployments; a persisted `security_agent_device_status` table tracks coverage and drives alerts.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only) + hand-written SQL migrations, BullMQ workers, Astro + React islands, Vitest.

**Spec:** `docs/superpowers/specs/security/2026-10-12-security-agents-policy-spec.md` (PR #8504). Executors read both.

## Decided (from spec)

The spec's nine Open Decisions are resolved with the spec's recommendation. They are inputs to this plan, not open questions:

1. **Vendor order:** Huntress, then SentinelOne, then DNS vendors, in waves.
2. **Secrets** stay in the existing integration/mapping tables read via `decryptForColumn`; DNS enrollment values are non-secret tenant variables. The `{{var.*}}` secret rejection stays.
3. **Presence:** software-policy `service_running` is the enforcement signal; `mgmtdetect` is reconciliation/conflict input only.
4. **EDR framework:** consume the framework's `installer` capability; do not widen `integrationProvider`/the `software_catalog.integration_provider` CHECK to non-EDR vendors. No parallel vendor registry for EDR providers.
5. **Persist** `security_agent_device_status`.
6. **Closest-wins within `security_agents` is whole-link replace** (UI warns when a closer link omits a vendor).
7. **Enabling** a vendor whose catalog row is missing is blocked (deep link); an individual unmapped org shows `not_applicable`.
8. **Resolution** branches in `resolveDeviceIdsForSoftwarePolicy` on `managed_by_link_id`; no hidden auxiliary `software_policy` link.
9. **#6958 owns** the periodic `service_running` evaluation bridge (agent state to compliance violations).

## Global Constraints

- `security_agents` is appended to `config_feature_type` (not reusing `security`); its migration is separate from any migration that uses the value.
- `inline_settings` shape is exactly `{ version: 1, agents: [{ vendor: 'huntress'|'sentinelone'|'controld'|'nextdns', enabled: boolean, platforms?: ('windows'|'macos'|'linux')[] }] }`; never keys, tokens or provisioning codes.
- `featurePolicyId` on a `security_agents` link is always NULL; the generated policy is found via `software_policies.managed_by_link_id`.
- Generated policy: `mode='allowlist'`, `rules.allowUnknown=true`, `enforceMode=true`, `remediationOptions.autoInstall=true`, `autoUninstall=false`. Uninstall is never implicit.
- `managed_by_link_id` FK is `ON DELETE CASCADE` (not SET NULL).
- Writing requires `devices.write` + MFA (`featureLinks.ts`), `devices.execute` (install-arming, `softwarePolicyAuthorization.ts`), and `canManagePartnerWidePolicies` for partner-wide policies.
- Readiness is evaluated against the **device's org** and **that org's partner's** integration, never the policy owner's.
- Migrations: `apps/api/migrations/2026-12-25-2NNNNN-<slug>.sql`, starting at `-200000-`. Idempotent, no inner `BEGIN;`/`COMMIT;`, row-count reporting on any cleanup statement, `SELECT set_config('breeze.scope','system',true);` before any write, never edit shipped migrations. Newest committed at plan time: `2026-12-25-110000-caller-verification-link-tier.sql`. **Task 0 of every wave re-checks** `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail` and moves up if anything newer landed.
- Public repo hygiene: fixtures use placeholders (`<org-key>`, `<acct-key>`); no customer names, hostnames or IPs.
- Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` and check the exit code directly (never pipe to `tail`). Same for `apps/web` when touched.
- API tests: `cd apps/api && npx vitest run <files>` (no `--` before flags). Web: `cd apps/web && npx vitest run <files>`.

## Review Focus

Failure modes the spec implies but no obvious task covers; each is pinned by a test in the owning task.

1. **Child-org device of a partner-wide link with an org-scoped agent read.** Agent/heartbeat paths run in org-scoped RLS context and cannot see partner-owned managed policies. Pinned in W2 Task 2.3 (system context in the worker).
2. **Opt-out child link** (a closer `security_agents` link with `agents: []`) must cancel queued installs. Pinned in W2 Task 2.4.
3. **Two vendors, one not ready:** attempt counters/cooldowns are per `(policy, device)`, so a not-ready vendor must not burn the ready vendor's retries. Pinned in W2 Task 2.2.
4. **Deleting the owning config policy** while status rows and deployments reference the generated policy. Pinned in W1 Task 1.2 / W3 Task 3.1.
5. **Org move/merge of a device with status rows** (`device_id` + denormalized `org_id`). Pinned in W3 Task 3.1 registrations.

---

## Wave map

| Wave | PR (off `main`) | Ships | If the next wave never ships |
|---|---|---|---|
| **P (prerequisite, not a wave of this plan)** | #6958 PRs | `service_running` rule type, pre/post-install scripts, macOS/Linux args, Control D / NextDNS catalog entries, and the periodic agent-to-compliance bridge (Decision 9) | n/a. Gates W5 and Huntress/S1 stopped-service violations only |
| **W1** | `feature/6960-security-agents/wave-1` | Enum value, `managed_by_link_id` column, vendor registry (no vendor enableable yet), link validation + auth gate, resolver dimension, 409 read-only guards, shared constants, config-policy parity | Inert: type exists and validates, but the API refuses to enable any vendor (`vendor_not_enableable`). Nothing is installed. Safe to leave. |
| **W2** | `.../wave-2` | Lab gate, readiness preflight, generator, compliance/remediation changes, Huntress enableable, authoring tab | Huntress policy works end to end; unmapped orgs correctly get no deployment, but the not-applicable reason is only in logs; no coverage UI, no alerts |
| **W3** | `.../wave-3` | `security_agent_device_status`, reconciliation job, alerts, EDR summary + device panel | Complete Huntress product, S1/DNS missing |
| **W4** | `.../wave-4` | SentinelOne (binary-upload gate, exhaustive resolver) | Huntress only |
| **W5** | `.../wave-5` | Control D / NextDNS registry entries (needs **P**), presence wiring for all vendors | Huntress + S1 without stopped-service violations |

Cut vs the suggested outline: authoring tab moved from W3 into W2 (Huntress is not usable by an MSP without a way to enable it; coverage panels stay in W3). The `service_running` bridge is not a wave here: Decision 9 gives it to #6958.

Waves are sequential PRs against `main`, each started after the previous merges, so normal CI runs. If a wave must be stacked on an unmerged predecessor (base is not `main`), no CI runs: dispatch `gh workflow run CI --ref <branch>` before merge. Cascade/export/merge suites run only under **Integration Tests**, never Test API.

---

## File Structure

| File | Wave | Action | Responsibility |
|---|---|---|---|
| `apps/api/migrations/2026-12-25-200000-security-agents-feature-type.sql` | W1 | Create | `ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'security_agents'` only |
| `apps/api/migrations/2026-12-25-200100-software-policies-managed-by-link.sql` | W1 | Create | `software_policies.managed_by_link_id` + partial index |
| `apps/api/migrations/2026-12-25-200200-security-agent-device-status.sql` | W3 | Create | Status table, RLS, indexes |
| `apps/api/src/db/schema/configurationPolicies.ts` | W1 | Modify | Append `'security_agents'` to the drizzle enum list (same position as the SQL `ADD VALUE`) |
| `apps/api/src/db/schema/softwarePolicies.ts` | W1 | Modify | `managedByLinkId` column |
| `apps/api/src/db/schema/securityAgents.ts` | W3 | Create | `securityAgentDeviceStatus` |
| `packages/shared/src/constants/configFeatureTypes.ts` | W1 | Modify | Feature list + trust tier `execution_gated` |
| `packages/shared/src/validators/securityAgents.ts` | W1 | Create | Zod for `inline_settings` |
| `apps/api/src/services/securityAgents/securityAgentVendors.ts` | W1 | Create | Code-level vendor registry |
| `apps/api/src/services/securityAgents/installerReadiness.ts` | W2 | Create | `checkInstallerReadiness` |
| `apps/api/src/services/securityAgents/managedPolicyGenerator.ts` | W2 | Create | link to generated software policy sync |
| `apps/api/src/services/securityAgents/coverageReconciler.ts` | W3 | Create | Device view vs vendor view |
| `apps/api/src/jobs/securityAgentCoverageWorker.ts` | W3 | Create | BullMQ fan-out partner to org |
| `apps/api/src/services/edrInstallerResolver.ts` | W2/W4 | Modify (consume) | Exhaustive provider switch; readiness reuses its lookups, no decrypt |
| `apps/api/src/services/featureConfigResolver.ts` | W1 | Modify | `resolveSecurityAgentsLinkForDevice`; branch in `resolveDeviceIdsForSoftwarePolicy` |
| `apps/api/src/services/configurationPolicy.ts` | W1 | Modify | `PARTNER_LINKABLE_FEATURE_TYPES`, effective-config surface |
| `apps/api/src/services/policyBaselineDefaults.ts` | W1 | Modify | `NOT_ENFORCED` |
| `apps/api/src/routes/configurationPolicies/featureLinks.ts` | W1/W2 | Modify | Validate inline settings; auth gate; call generator |
| `apps/api/src/routes/softwarePolicies.ts` | W1 | Modify | 409 on PATCH/DELETE/manual remediation of managed rows |
| `apps/api/src/services/aiToolsPolicyPrereqs.ts` | W1 | Modify | Same 409 guard on the AI tool's direct policy updater |
| `apps/api/src/jobs/softwareComplianceWorker.ts` | W2 | Modify | Readiness-aware violations and attempt accounting |
| `apps/api/src/jobs/softwareRemediationWorker.ts` | W2 | Modify | Re-resolve at dispatch |
| `apps/api/src/services/softwarePolicyInstallRemediation.ts` | W2 | Modify | Second-line readiness check before attempt increment |
| `apps/api/src/services/tenantCascade.ts`, `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`, `routes/devices/core.ts` | W1 (export col), W3 (table) | Modify | Registrations (see each wave) |
| `apps/web/src/components/configurationPolicies/featureTabs/SecurityAgentsTab.tsx` | W2 | Create | Authoring tab on `FeatureTabShell` |
| `apps/web/src/components/configurationPolicies/featureTabs/types.ts`, `ConfigPolicyDetailPage.tsx` | W2 | Modify | Tab registration |
| `apps/web/src/locales/<all 7>/*.json` | W2/W3 | Modify | New keys in every locale (`apps/web/src/lib/i18n/localeParity.test.ts`) |

**Framework reuse (no parallel vendor registry).** *Consumed unchanged:* `services/edrProviders/registry.ts` (`listEdrProviders()`) and `EdrCapabilities.installer` (`edrProviders/types.ts`), `services/softwareDeployment.ts` (`createSoftwareDeployment`), `softwarePolicyInstallRemediation.ts` (`createPolicyOwnedInstallDeployment`), `builtinDeploymentPackages.ts` (`ensureBuiltinPackage`), `huntress_*`/`s1_*`/`edr_endpoints` tables. *Extended:* `edrInstallerResolver.ts` (exhaustive switch; today everything non-Huntress falls into the S1 branch), compliance/remediation workers. *New:* `securityAgents/securityAgentVendors.ts` holds only what the EDR registry cannot: DNS (`tenant_var`) vendors, platform support, and presence descriptors. For EDR-framework providers it enumerates `listEdrProviders().filter(a => a.capabilities.installer !== 'none')` (not v1).

**Software deployment seams (exact).** Generated `software_policies` row owned on the config policy's axis; `software_policies.managed_by_link_id`; install via `createPolicyOwnedInstallDeployment` to `createSoftwareDeployment`; keys substituted by `resolveEdrInstaller` at dispatch; device set from `resolveDeviceIdsForSoftwarePolicy`.

**Config-policy linkage** (per the `configuration-policy` skill): inline-settings pattern (few toggles), feature link row in `config_policy_feature_links`, effective-config via `config_policy_effective_feature_links` view consumers, resolution dimension per spec 2.2, partner-linkable per epic #2135.

**AI tools:** none new. The spec requires no AI tool surface; the only AI touch is the guard in `aiToolsPolicyPrereqs.ts` preventing the existing policy-update tool from mutating a managed row. (Per-tool disclosure of gaps is deliberately not tabulated here.)

---

## Wave 1: schema, registry, resolution, guards

Goal: land everything structural while nothing can be enabled. Branch from fresh `origin/main`.

### Task 1.0: Slot check and baseline
- [ ] `git fetch origin && git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -5`; rename the two W1 files upward if anything beats `2026-12-25-110000`.
- [ ] `pnpm install`; `cd packages/shared && npx vitest run src/constants/configFeatureTypes.test.ts` passes on a clean tree (record the baseline).

### Task 1.1: Feature type registration (shared + enum)

**Files:** Create `apps/api/migrations/2026-12-25-200000-security-agents-feature-type.sql`; modify `apps/api/src/db/schema/configurationPolicies.ts` (enum list near line 63), `packages/shared/src/constants/configFeatureTypes.ts` (list ~33, trust tiers ~140), `apps/api/src/services/policyBaselineDefaults.ts` (`NOT_ENFORCED`), and the exhaustive web records that break typecheck once the union grows: `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` (icon map ~114; placeholder icon only, the tab is W2), `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx` (~120 metadata record), `featureTabs/types.ts`. Tests: shared `configFeatureTypes.test.ts` (trust tier symbol is `CONFIG_POLICY_FEATURE_TRUST_TIER`, ~115), API `policyBaselineDefaults.test.ts` (enum parity ~109), web `featureTypeParity.test.ts`.

**Interfaces:** Produces `'security_agents'` in `ConfigFeatureType`; trust tier `execution_gated`.

- [ ] **Step 1 (red):** add `'security_agents'` to the expected lists and `expect(CONFIG_POLICY_FEATURE_TRUST_TIER.security_agents).toBe('execution_gated')` in shared `configFeatureTypes.test.ts`. Run `cd packages/shared && npx vitest run src/constants/configFeatureTypes.test.ts` and `cd apps/api && npx vitest run src/services/policyBaselineDefaults.test.ts`; expect FAIL (unknown member / enum parity).
- [ ] **Step 2:** write the migration (its own file; `ADD VALUE` cannot share a transaction with use of the value):
```sql
-- security_agents feature type (#6960). Own migration: the new value cannot be
-- used in the transaction that adds it. No rows are written.
ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'security_agents';
```
- [ ] **Step 3:** append to the drizzle enum list in the same relative position (appended, like `time_sync`/`workload_inventory`), shared constants, trust tier, `NOT_ENFORCED`.
- [ ] **Step 4:** rerun parity test, expect PASS; `pnpm db:check-drift` with `DATABASE_URL` set against a migrated DB.
- [ ] **Step 5:** commit `feat(security-agents): register security_agents feature type (#6960)`.

### Task 1.2: `managed_by_link_id` column and registrations

**Files:** Create `.../2026-12-25-200100-software-policies-managed-by-link.sql`; modify `db/schema/softwarePolicies.ts`, `services/tenantExportPolicyRegistry.ts` (`software_policies` entry).

- [ ] **Step 1 (red):** extend the export-policy coverage test so `software_policies.managed_by_link_id` must be classified. Run the tenant export policy test (`git ls-files | grep -i "tenantExportPolicy.*test"`) with `npx vitest run <file>`; expect FAIL once the schema column exists, so add the schema column first (Step 2), then run.
- [ ] **Step 2:**
```sql
SELECT set_config('breeze.scope','system',true);
ALTER TABLE software_policies
  ADD COLUMN IF NOT EXISTS managed_by_link_id uuid
  REFERENCES config_policy_feature_links(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS software_policies_managed_by_link_idx
  ON software_policies (managed_by_link_id) WHERE managed_by_link_id IS NOT NULL;
```
No data write, so no row-count statement is needed; the scope election stays as a harmless guard. CASCADE, not SET NULL: deleting a config policy cascades links directly, and SET NULL would erase the only managed discriminator and leave an ordinary armed policy. Deleting the generated policy never uninstalls (compliance rows cascade; `software_deployments.software_policy_id` is already SET NULL).
- [ ] **Step 3:** classify `managed_by_link_id` as `included` in `CORE_TENANT_EXPORT_POLICY` (row identifier, no secret). Ownership model (`org_id` XOR `partner_id`, `software_policies_one_owner_chk`, dual-axis `software_policies_isolation`) is unchanged and `software_policies` is already in `DUAL_AXIS_TENANT_TABLES`; **no new dual-axis table, no new allowlist entry**.
- [ ] **Step 4:** mechanical grep: `git grep -n "software_policies" -- apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts` confirms existing registration; no new table to register.
- [ ] **Step 5:** Integration check (CI job **Integration Tests**; local `pnpm test-stack up`, run the export-policy + org-cascade + merge suites per `docs/agents/testing.md`, then `pnpm test-stack down`). Add an integration case: delete the owning config policy → generated policy row is gone, `software_deployments.software_policy_id` set NULL, no FK failure.
- [ ] **Step 6:** commit.

### Task 1.3: Vendor registry and inline-settings validator

**Files:** Create `services/securityAgents/securityAgentVendors.ts`, `packages/shared/src/validators/securityAgents.ts` (export from `packages/shared/src/validators/index.ts`); tests alongside.

**Interfaces (produced):**
```ts
export type VendorKey = 'huntress' | 'sentinelone' | 'controld' | 'nextdns';
export type PlatformSupport = 'supported' | 'requires_mdm' | 'unsupported';
export interface SecurityAgentVendor {
  key: VendorKey; label: string; catalogRef: string;
  orgSource: 'edr_mapping' | 'tenant_var'; requiredVars?: string[];
  platforms: Record<'windows'|'macos'|'linux', PlatformSupport>;
  presence: { windowsService?: string; macProcess?: string; linuxUnit?: string };
  enableable: boolean; // false for every vendor in W1
}
export function getVendor(key: VendorKey): SecurityAgentVendor;
export function listVendors(): readonly SecurityAgentVendor[];
export const securityAgentsInlineSettingsSchema; // Zod, strict, version 1
```
- [ ] **Step 1 (red):** tests: schema rejects unknown keys (`apiKey`), rejects duplicate vendors, accepts `{version:1,agents:[]}`; registry has all four keys; Huntress macOS is `requires_mdm`, Linux `unsupported`; every vendor `enableable === false` in W1.
- [ ] **Step 2:** run `cd apps/api && npx vitest run src/services/securityAgents/securityAgentVendors.test.ts`; expect FAIL (module missing).
- [ ] **Step 3:** implement; `.strict()` Zod so secrets cannot be smuggled in.
- [ ] **Step 4:** rerun, PASS. Commit.

### Task 1.4: Link validation, auth gate, partner-linkable

**Files:** modify `routes/configurationPolicies/featureLinks.ts`, `services/configurationPolicy.ts` (~2969 `PARTNER_LINKABLE_FEATURE_TYPES`; `validateFeaturePolicyExists` gains **no table**, assert NULL `featurePolicyId`), `routes/configurationPolicies/featureLinks.test.ts`.

- [ ] **Step 1 (red), in this order:** (a) `security_agents` ∈ `PARTNER_LINKABLE_FEATURE_TYPES`; (b) POST link with `featurePolicyId` set → 400; (c) inline settings with an unknown key → 400; (d) any `enabled:true` vendor → 400 `vendor_not_enableable` (W1); (e) partner-wide policy + writer without `canManagePartnerWidePolicies` → 403; (f) writer lacking `devices.execute` → 403 on `enabled:true`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/configurationPolicies/featureLinks.test.ts`; expect FAIL.
- [ ] **Step 3:** implement beside the `workload_inventory` branch (~line 402); reuse `softwarePolicyAuthorization.ts` for the arming check; add to `partner-wide-write-coverage` contract (locate with `git ls-files | grep partner-wide-write`).
- [ ] **Step 4:** PASS; run the partner-wide-write contract file. Commit.

### Task 1.5: Resolution dimension

**Files:** modify `featureConfigResolver.ts` (`resolveSoftwarePolicyForDevice` ~947, `resolveDeviceIdsForSoftwarePolicy` ~1062), test `featureConfigResolver.securityAgents.test.ts`.

**Interfaces (produced):**
```ts
export async function resolveSecurityAgentsLinkForDevice(deviceId: string):
  Promise<{ linkId: string; configPolicyId: string; inlineSettings: SecurityAgentsInlineSettings } | null>;
```
Closest wins within `security_agents` using the same hierarchy walk and the `config_policy_effective_feature_links` view the neighbors use.
- [ ] **Step 1 (red):** (a) a device with both a customer `software_policy` link (lower) and a `security_agents` link: `resolveDeviceIdsForSoftwarePolicy(managedPolicyId)` includes the device; (b) the customer policy still includes it too (neither shadows the other); (c) a closer `security_agents` link with `agents: []` excludes the device from the managed set; (d) device set is built from **effective inherited assignments**, not only the authoring policy's own; (e) a non-managed policy resolves exactly as before.
- [ ] **Step 2:** `npx vitest run src/services/featureConfigResolver.securityAgents.test.ts` FAIL.
- [ ] **Step 3:** implement the `managed_by_link_id IS NOT NULL` branch: device set = assignments of the managed policy's link (effective) ∩ devices where `resolveSecurityAgentsLinkForDevice(...).linkId === managed_by_link_id`; software_policy winner ignored. Surface the link and generated policy id in effective-config/`resolution.ts`.
- [ ] **Step 4:** PASS; run existing `featureConfigResolver` tests for regressions. Commit.

### Task 1.6: Read-only guards (409)

**Files:** `routes/softwarePolicies.ts` (PATCH/DELETE, manual remediation ~1066), `services/aiToolsPolicyPrereqs.ts` (~517), tests.

- [ ] **Step 1 (red):** a row with `managedByLinkId` set returns 409 with a pointer (config policy id) on PATCH, DELETE and manual remediation (which authorizes uninstall independently of `autoUninstall`), and the AI updater refuses it. Existing AI contract tests key `SAFE_WRITE_SITES` by line number: after editing `aiToolsPolicyPrereqs.ts`, update line keys (see memory trap) and rerun the AI contract tests.
- [ ] **Step 2:** `npx vitest run src/routes/softwarePolicies.test.ts src/services/aiToolsPolicyPrereqs.test.ts` FAIL; implement; PASS.
- [ ] **Step 3:** Typecheck (12 GB heap, check exit). Commit. Open PR `Refs #6960`.

**W1 leaves behind** (if W2 never ships): an inert registered type, an unused nullable column, and 409 guards that never fire. No tenant-visible behavior change.

---

## Wave 2: Huntress end to end

Branch from `main` after W1 merges.

### Task 2.0: Lab gate (not an assumption)
- [ ] The spec flags that the existing software-policy path deploying Huntress with correct keys is **not verified**. Before building: in a Windows lab VM with a test Huntress account, hand-build a software policy requiring the built-in Huntress catalog item and confirm install, key substitution and a second pass doing nothing. Record the outcome in the PR description. If it fails, stop and file the defect; do not build on it.

### Task 2.1: Readiness preflight

**Files:** Create `services/securityAgents/installerReadiness.ts` + test; modify `edrInstallerResolver.ts` (exhaustive over vendors: replace the non-Huntress fall-through with an explicit switch that returns an error for unknown providers).

**Interfaces (produced):**
```ts
export type ReadinessReason = 'org_not_mapped'|'integration_inactive'|'org_key_missing'|'account_key_missing'|'platform_unsupported'|'requires_mdm_approval'|'var_missing';
export async function checkInstallerReadiness(args: { vendor: VendorKey; deviceId: string; orgId: string; platform: 'windows'|'macos'|'linux' }):
  Promise<{ ok: true } | { ok: false; reason: ReadinessReason }>;
```
Never decrypts. Evaluated against the device's org and that org's partner's integration.
- [ ] **Step 1 (red):** one test per reason code; assert `decryptForColumn`/`tryDecryptColumn` mock is never called; unknown provider returns a not-ok result rather than falling through to S1.
- [ ] **Step 2:** `npx vitest run src/services/securityAgents/installerReadiness.test.ts` FAIL → implement → PASS. Commit.

### Task 2.2: Compliance worker semantics

**Files:** `jobs/softwareComplianceWorker.ts` (~668/792/934), `softwarePolicyInstallRemediation.ts`, tests.

- [ ] **Step 1 (red):** (a) the `missing` violation for a not-ready managed rule is filtered out of `software_compliance_status.violations` (device not reported non-compliant); (b) two vendors, one not ready: the ready vendor still gets all three attempts and the cooldown is unaffected by the not-ready one; (c) `createPolicyOwnedInstallDeployment` re-checks readiness **before** the attempt increment and creates no deployment when not ready; (d) recovery: org gets mapped → next pass installs.
- [ ] **Step 2:** `npx vitest run src/jobs/softwareComplianceWorker.test.ts src/services/softwarePolicyInstallRemediation.test.ts` FAIL → implement → PASS.
- [ ] **Step 3:** `software_compliance_status` has no free-text detail column (only `violations`/`remediationErrors` jsonb). W2 therefore carries not-applicable reasons **only in the worker's return value and structured logs**, with nothing durable; W3 persists them. Commit.

### Task 2.3: Managed policy generator

**Files:** Create `services/securityAgents/managedPolicyGenerator.ts` + test; modify `featureLinks.ts` (call on create/update/delete of a `security_agents` link; same transaction).

**Interfaces:** `syncManagedSoftwarePolicy(tx, link): Promise<{ policyId: string | null }>`; owner axis copied from the config policy (partner-wide → `partner_id`; org → `org_id`); one rule per enabled vendor, `catalogId` resolved to the **owner's** catalog row (partner catalog via `ensureBuiltinPackage` on integration connect). Missing catalog row → 400 with deep link (Decision 7). The vendor is **not** stored in rule JSON (normalizer drops unknown keys); downstream derives the vendor from `catalogId` through the registry.
- [ ] **Step 1 (red):** generated shape equals the Global Constraints; disabling a vendor removes only its rule and never uninstalls; zero enabled vendors deactivates (not deletes) the policy; ownership axis matches; `software_policy_audit` rows reference the managed policy.
- [ ] **Step 2:** FAIL → implement → PASS. Flip `enableable` to true for Huntress only. Workers run under `withSystemDbAccessContext` (call `runOutsideDbContext` first if inside a request) so fan-out never depends on caller scope. The existing SELECT-only partner branch (`software_policies_partner_wide_select`, migration `2026-10-11-000200`) lets an org-scoped session read its **own partner's** partner-owned rows but never write them or see another partner's. Test: org-scoped context can SELECT its partner's managed policy, cannot UPDATE/DELETE it, cannot see another partner's.
- [ ] **Step 3:** Commit.

### Task 2.4: Re-resolve at dispatch

**Files:** `jobs/softwareRemediationWorker.ts` (~767), test.

- [ ] **Step 1 (red):** queue an install, then (a) remove the device's assignment, (b) add a closer `security_agents` opt-out link, (c) remove one vendor while another stays enabled in the same link; the worker cancels dispatch in all three. Case (c) is invisible to re-resolving the winning link (same link wins), so the generator **bumps `software_policies.approval_generation`** on any rule change (the worker already skips on generation mismatch, `softwareRemediationWorker.ts` ~800) and drops cached violations for removed rules. Add a fan-out case in the integration test of Task 2.5.
- [ ] **Step 2:** FAIL → call `resolveSecurityAgentsLinkForDevice` immediately before dispatch for managed policies → PASS. Commit.

### Task 2.5: Partner-wide RLS + fan-out integration test

**Files:** Create `apps/api/src/__tests__/integration/securityAgentsPartnerRls.integration.test.ts`, modelled on `softwarePoliciesPartnerRls.integration.test.ts`.

- [ ] **Step 1 (red):** one partner, three orgs (mapped with key, mapped without key, unmapped), one partner-wide link with Huntress enabled. Assert: mapped org's device gets a policy-owned deployment with the correctly substituted keys; the other two get `not_applicable` with the right reason and **zero** `software_deployments` rows; org-scoped token can SELECT but not write the partner-owned generated policy; a second partner's devices untouched; org-scoped token cannot see another partner's rows.
- [ ] **Step 2:** `pnpm test-stack up`; run per `docs/agents/testing.md` (CI job **Integration Tests**); `pnpm test-stack down`. Say what you left running.
- [ ] **Step 3:** Commit.

### Task 2.6: Authoring tab (web)

**Files:** Create `SecurityAgentsTab.tsx` (+ test); modify `featureTabs/types.ts`, `ConfigPolicyDetailPage.tsx` (icon map ~135, switch ~487); locale JSON in all 7 locales.

- [ ] **Step 1 (red):** component tests: toggling Huntress calls the link API through `runAction` (guarded by `no-silent-mutations.test.ts`); catalog-missing renders a deep link; platform notes shown (macOS requires MDM); the closer-link warning appears; the **create-only** `ownerScope` selector and an "All orgs" badge for partner-wide (copy the selector pattern from existing partner-wide forms: `git grep -n ownerScope apps/web/src`); selected-tab/filter state in `window.location.hash`, not query params.
- [ ] **Step 2:** `cd apps/web && npx vitest run <tab test> src/lib/i18n/localeParity.test.ts` FAIL; implement; add every new en key to all 7 locales; PASS.
- [ ] **Step 3:** Managed badge ("Managed by config policy", links to owner) in the `software/` policy list; `PolicyForm` ownerScope selector disabled for managed rows. `runAction` catch pattern per CLAUDE.md.
- [ ] **Step 4:** Typecheck api + web (12 GB heap, check exit). `<table>.orgId` sweep: for `software_policies` run `git grep -n "softwarePolicies.orgId" -- apps/api/src` and confirm every site tolerates a NULL `orgId` for partner-owned managed rows. Commit, PR `Refs #6960`.

**W2 leaves behind** (if W3 never ships): a working Huntress policy with enforced installs and not-applicable handling, but coverage gaps/mismatches are invisible and unalerted.

---

## Wave 3: coverage state, reconciliation, alerts, UI

### Task 3.0: Slot check (as 1.0).

### Task 3.1: `security_agent_device_status` table

**Files:** Create `migrations/2026-12-25-200200-security-agent-device-status.sql`, `db/schema/securityAgents.ts` (add `export * from './securityAgents';` to `db/schema/index.ts`, the Drizzle entry point).

Shape (spec 4.3): `id, org_id NOT NULL, device_id NULL, vendor_endpoint_id NULL, vendor, state, reason_code, detail (text), policy_id → software_policies(id) ON DELETE SET NULL, last_evaluated_at`; unique `(device_id, vendor) WHERE device_id IS NOT NULL`, unique `(org_id, vendor, vendor_endpoint_id) WHERE device_id IS NULL`. **Justification for `org_id NOT NULL`:** derived per-device observed state like `edr_endpoints`, not a config/policy table; the dual-axis part lives on the software policy. RLS shape 1 (direct `org_id`), enabled + FORCE + policies in this same migration. Any composite FK referencing `org_id` is `DEFERRABLE INITIALLY IMMEDIATE`. Partner overview: add `partner_id NOT NULL` only if the EDR summary needs it (default: no; org-scoped aggregation).

- [ ] **Step 1 (red):** extend the contract tests first (they fail only under **Integration Tests**): rls-coverage (table has RLS enabled/forced/policy), org-cascade order, export policy, merge registry, device-cascade lists.
- [ ] **Step 2:** write migration + schema; mechanical registration, **grep don't judge**:
  - `git grep -n "'edr_endpoints'" -- apps/api/src | grep -v test` to see every list `edr_endpoints` sits in; mirror each for the new table.
  - `CORE_ORG_CASCADE_DELETE_ORDER` in `tenantCascade.ts` : the list must be **alphabetical** (`tenantCascade.integration.test.ts` asserts it, `organizations` last); do NOT hand-place it before `devices`. FK ordering is resolved at runtime from topology; the alphabetical slot is under `security_*`. Verify with that contract test.
  - `CORE_DEVICE_CASCADE_DELETE_TABLES` and `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (device_id + denormalized org_id, shape 5) in `routes/devices/core.ts` (device delete and org move).
  - `orgMergeRegistry.ts`; `CORE_TENANT_EXPORT_POLICY` (every column classified; no json/bytea so no `excludedOpen`; `detail` is text; if it ever becomes jsonb it is `excludedOpen`; review credential-ish names).
  - rls-coverage allowlists in `rls-coverage.integration.test.ts` (shape-1 list, not `DUAL_AXIS_TENANT_TABLES`).
- [ ] **Step 3:** `pnpm test-stack up`; run rls-coverage, org-cascade, export-policy, merge and device-move suites (CI **Integration Tests**; Test API will not catch these); `pnpm test-stack down`; `pnpm db:check-drift`.
- [ ] **Step 4:** move Task 2.2's recorded reasons into this table (compliance worker writes `not_applicable` + reason, clears on recovery). Test: unmapped org device has a `not_applicable/org_not_mapped` row and zero deployments.
- [ ] **Step 5:** Commit.

### Task 3.2: Reconciler + job

**Files:** Create `securityAgents/coverageReconciler.ts`, `jobs/securityAgentCoverageWorker.ts` (system context, partner → org fan-out, registered where other workers are).

**Interfaces:** `interface VendorEndpointSource { listForOrg(orgId): Promise<VendorEndpointView[]> }` backed by `huntress_agents` (Huntress wave), `s1_agents` (W4), `edr_endpoints` (framework later). States: `covered`, `gap`, `vendor_only`, `vendor_offline`, `mismatched_org`, `not_applicable(reason)`, `pending`.
- [ ] **Step 1 (red):** table-driven test of the state machine; mismatched-org case (`huntress_agents` org differs from `huntress_org_mappings` for the device's org) yields `mismatched_org` and **no redeploy** (detection treats it installed); vendors with no vendor-side org field never claim mismatch; `vendor_only` rows are idempotent via the partial unique index. Caveat encoded as a test: Huntress sync drops unmapped vendor orgs, so only retained rows are classified.
- [ ] **Step 2:** `npx vitest run src/services/securityAgents/coverageReconciler.test.ts` FAIL → implement → PASS.
- [ ] **Step 3:** Alerts: first verify (spec marks it not verified) whether a persistent software-compliance violation raises an alert today: `git grep -n "software" -- apps/api/src/services/alertService.ts apps/api/src/jobs | grep -i alert`. If not, add gap/mismatch transition alerts through the existing alert pipeline (fire on transition only, using the persisted prior state). Test: transition fires once, steady state fires zero.
- [ ] **Step 4:** Commit.

### Task 3.3: UI panels
- [ ] Red tests then implement: coverage in `ComplianceDashboard`, EDR summary, device EDR panel; filter/tab state in `window.location.hash`; read-only for org users; `runAction` for any mutation; new en keys in all 7 locales; `localeParity` run. Typecheck web; commit; PR `Refs #6960`.

**W3 leaves behind** (if W4 never ships): Huntress with persisted coverage, alerts and UI; no S1/DNS.

---

## Wave 4: SentinelOne

- [ ] Task 4.0 slot/branch check (no migration expected).
- [ ] Task 4.1 (red first): S1 `enableable` is false until the partner has uploaded the MSI (`requiresBinaryUpload` built-in); the generator returns 400 with a deep link; tab explains it. `edrInstallerResolver.ts` S1 branch becomes explicit (no fall-through) with a test that an unknown provider errors.
- [ ] Task 4.2: readiness reasons for S1 (`org_not_mapped`, `integration_inactive`, `org_key_missing`); `s1_agents` as a `VendorEndpointSource`; integration test extends Task 2.5 to S1 with placeholder keys (`<org-key>`).
- [ ] Run `npx vitest run` on touched files, typecheck, **Integration Tests** if the reconciler changed; PR `Refs #6960`.

**W4 leaves behind:** Huntress + S1, DNS vendors absent.

## Wave 5: DNS vendors (prerequisite **P** = #6958) and presence

Precondition: #6958's PRs merged (catalog entries, `controld_provisioning_code` / `nextdns_profile_id` variables, install args, `service_running` and the periodic bridge). If not merged, do only the presence descriptors that do not need them and stop.
- [ ] Task 5.1 (red): `tenant_var` readiness: missing variable for the device's org yields `not_applicable: var_missing`; macOS depends on #6958's args; registry entries flip `enableable` once catalog rows exist.
- [ ] Task 5.2: `service_running` is a **detection rule on the vendor's catalog version** (spec 2.6), not a field of the generated policy rule (the policy normalizer drops unknown keys). #6958 delivers it on the built-in catalog versions; this task adds a test that each registry `presence` descriptor matches the shipped detection rule and surfaces the resulting violations. If a built-in version lacks the rule, add it via `builtinDeploymentPackages.ts`. Agent-shipped parts (`service_running`) need an agent release plus Windows/macOS lab checks (not done in this plan's PRs).
- [ ] Task 5.3: coverage for DNS vendors is `mgmtdetect`/policy-state only (no vendor endpoint source until #3408); document in the tab.
- [ ] Tests, typecheck, Integration Tests; PR `Refs #6960`, `Refs #6958`.

**W5 leaves behind:** if #6958's bridge never ships, presence shows install state only; stopped-service violations are absent for every vendor.

---

## Self-review

- **Spec coverage:** 2.1 (W1/W2), 2.2 (W1 T1.5, W2 T2.4), 2.3 (W2 T2.1/2.2), 2.4 (W1 T1.3, W4, W5), 2.5 (no new secret surface; readiness never decrypts, T2.1), 2.6 (W5 + #6958), 2.7 (W3), 2.8 (W1 T1.6, W2 T2.6), 2.9 (W3 T3.2), 2.10 (registry platforms, `platform_unsupported`), section 4 items 1-7 (T1.1, T1.2, T3.1, T1.1/1.4, T1.5, T1.4, slot checks), section 7 test order (T1.3/1.5/1.6/1.4, T2.5).
- **Type consistency:** `VendorKey`, `ReadinessReason`, `resolveSecurityAgentsLinkForDevice`, `checkInstallerReadiness`, `syncManagedSoftwarePolicy` are defined once and reused by name.
- **Not verified at plan time:** line numbers cited from the spec drift; each task says to re-locate by symbol. The existence of violation alerting is checked in T3.2.

## Open Decisions

New questions this plan surfaces (spec items are decided above):

1. **Generator trigger.** (a) Synchronous in the link-write transaction plus a periodic repair sweep. (b) Event-driven worker only. (c) Sweep only. **Recommend (a):** the 409/read-only contract and "enable → rule exists" feedback need the policy to exist when the request returns; the sweep repairs drift from direct DB or catalog changes.
2. **Disabling the last vendor.** (a) Deactivate the generated policy, keep the row for audit. (b) Delete it. **Recommend (a):** `software_policy_audit` keeps a stable referent and re-enabling reuses the row.
3. **Gap alert severity/routing.** (a) Reuse the existing software-compliance alert pipeline and default severity; (b) new alert category. **Recommend (a):** no new notification surface for v1; revisit if MSPs ask to route security-agent gaps separately.

## Quorum

`codex exec` (gpt-6-astra, medium, read-only) returned 8 findings; cited files were re-read before acting. Folded in: approval-generation bump for same-link vendor removal (T2.4); exhaustive web records in W1 (T1.1); no durable reason storage until W3 (T2.2); corrected partner-SELECT RLS expectation (T2.3); presence rule lives on catalog versions (T5.2); barrel exports (T1.3, T3.1); alphabetical cascade placement (T3.1); corrected test paths and trust-tier symbol (T1.0, T1.1). No unresolved disagreements.

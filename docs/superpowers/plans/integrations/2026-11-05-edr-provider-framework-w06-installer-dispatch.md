---
tracking_issue: LanternOps/breeze#8164
wave_issue: LanternOps/breeze#8170
---
# EDR W06 — Installer dispatch + #6960 security-agents hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MSP with a mapped Bitdefender GravityZone company can install the GravityZone agent on that customer's Windows devices through a normal Breeze software deployment, and can tick "Bitdefender GravityZone" in a (partner-wide) Security agents configuration policy so every in-scope device gets the agent with the right per-company installer, with unmapped or ambiguous orgs reported as not applicable instead of failing.

**Architecture:** The installer link is vendor material, not something fetched at dispatch. The EDR sync worker fetches it in its vendor-I/O phase (`fetchInstallerMaterial`), seals it into `edr_tenants.installer_secret_encrypted` (row-bound AAD) and records non-secret status columns. Dispatch reads the sealed material, decrypts it and calls the adapter's **pure** `buildInstaller` — no vendor HTTP while the install-remediation worker holds its system transaction. One shared tenant-selection function backs both dispatch and the security-agents readiness preflight, so "which GravityZone company does this org install into" has exactly one answer and an ambiguous org never gets a guess. Framework providers join the existing inline `security_agents` feature (generated managed software policy); nothing new is added to the config-policy model. Everything ships **dormant** (`released: false` on the package definition, `enableable: false` on the security-agents vendor) until the owner lab wave flips both.

**Tech Stack:** Hono, Drizzle (queries only) + one hand-written SQL migration, PostgreSQL RLS, BullMQ, Vitest, Astro + React islands, `runAction`.

**Spec:** `docs/superpowers/specs/integrations/2026-09-30-edr-provider-framework-spec.md` §4.3 (adapter interface), §4.9 (credentials/hosts), §4.13 (installers and the #6960 hook), D3. Hook side: `docs/superpowers/specs/security/2026-10-12-security-agents-policy-spec.md` §2.3, §2.4, Decision 4, and its plan `docs/superpowers/plans/security/2026-10-13-security-agents-policy.md`. **Read the index first** (`2026-10-01-edr-provider-framework-index.md`, W06 section and corrections 1, 8). W01–W04 are merged; the security-agents feature (#8734) W01–W04 are merged, its W05 (#8739, DNS vendors) is open and file-disjoint from this plan. Written against `origin/main` at `36f9d9ca53` (2026-11-04).

Epic: #8164 · Wave sub-issue: #8170 · Hook feature: #6960 / #8734. PR bodies say `Refs #8170` / `Part of #8164`; only the **last** PR of the wave (W06.3) carries `Closes #8170`. Never write a closing keyword for #6960, #8734 or #3136. Branches: `feature/8164-edr-provider-framework/wave-8170` (W06.1), `…/wave-8170-hook` (W06.2), `…/wave-8170-lab` (W06.3). Each is cut from `main` after the previous one merges. A stacked branch gets **no CI** (`ci.yml` runs only on PRs targeting `main`): dispatch `gh workflow run CI --ref <branch>` before merge if you ever stack.

## What already exists (verified at `36f9d9ca53`)

The spec's §4.13 is partly delivered by the security-agents feature. Do not rebuild these:

| Item | Where | State |
|---|---|---|
| Exhaustive resolver switch (no S1 fall-through) | `services/edrInstallerResolver.ts:54-71` | **Done** (#6960 W02). It returns `{ error }` for an unknown provider instead of throwing; callers map that to a failed result, a throw would 500 a deployment. **Keep the `{ error }` contract** (spec correction 2). |
| Readiness preflight, exhaustive over vendors | `services/securityAgents/installerReadiness.ts:91-116` | Done for huntress / sentinelone / DNS. W06.2 adds the framework branch. |
| Security-agents vendor registry | `services/securityAgents/securityAgentVendors.ts` | Four vendors; `integrationProvider` typed `'huntress' \| 'sentinelone' \| null`. |
| Coverage vendor sources | `services/securityAgents/vendorEndpointSources.ts:12` | "EDR framework providers (`edr_endpoints`) come later" — W06.2. |
| `installer_secret_encrypted` column + row-bound AAD spec | `db/schema/edrProviders.ts:143`, `encryptedColumnRegistry.ts:120`, `edrProviders/credentials.ts:9-15` | Column exists, **never written**; export policy `excludedSensitive`; tenant read projection exposes only `hasInstallerSecret` (`routes/edr/access.ts:104-126`). |
| Capability + untyped hook | `edrProviders/types.ts:43` (`installer`), `:267` (`getInstaller?(...a: unknown[])`) | Both adapters declare `installer: 'none' // W06`. `registry.test.ts:18` pins `installer === 'none' \|\| getInstaller`. |
| Catalog CHECK | `migrations/2026-07-02-builtin-catalog-partner-read-rls.sql:23` | `integration_provider IN ('huntress','sentinelone')`. |
| Dispatch site | `services/softwareDeployment.ts:720-748` | Resolves only when `integrationProvider === 'huntress' \|\| 'sentinelone'`; payload `fileName`/`checksum` come from the version row (`:1203-1210`). |
| Agent installer handling | `agent/internal/remote/tools/software_install.go:170-279, 501-523` | Takes `fileName` and `fileType` from the server payload, keeps the basename (`filepath.Base`), requires the extension to equal `.<fileType>`; types `exe msi deb pkg dmg zip`. |

## Spec corrections (found while planning; the quorum agreed with each)

1. **`getInstaller` is split into a fetch and a pure build.** §4.3/§4.13 has one `getInstaller(ctx, tenant & { installerSecret }, platform)`. For an `api_generated_link` vendor that is vendor HTTP at dispatch, and dispatch runs inside the install-remediation worker's system transaction (`softwarePolicyInstallRemediation.ts:255-268`), breaking the framework's "no pooled connection across vendor HTTP" rule (#1105, W01 acceptance). Replaced by `fetchInstallerMaterial(ctx, tenant)` (sync worker, vendor-I/O phase) and `buildInstaller(data, platform)` (synchronous, no I/O, at dispatch). The untyped `getInstaller?` declaration is deleted.
2. **The "exhaustive switch that throws"** already landed and returns `{ error }`; it stays that way (table above).
3. **`ResolvedInstaller` needs `fileName`, `fileType` and `checksum` overrides.** §4.13's `{ downloadUrl, args, sha256? }` omits the file name; GravityZone's Windows downloader is believed to read its configuration from its own file name **[U]**, and the payload otherwise sends the version row's static `originalFileName`. `checksum` distinguishes *absent* (keep the version's) from explicit `null` (vendor gives none).
4. **The CHECK lists every EDR provider key, not only installer-capable ones.** Admission to `software_catalog.integration_provider` does not imply an installer; installer capability is the adapter's `capabilities.installer`. This keeps W04's promise (its "CHECK escape hatch" note) and means a later installer-capable adapter needs no migration.

## Global Constraints

- **No vendor name outside the vendor directory, the two EDR registries/label maps, `BUILTIN_PACKAGES` and the security-agents vendor registry.** If the resolver, sync job or readiness needs `provider === 'bitdefender'`, the interface has a bug.
- **No vendor HTTP at dispatch, and no pooled DB connection held across vendor HTTP.** `fetchInstallerMaterial` runs only in the sync job's vendor-I/O phase (under `runOutsideDbContext`); `buildInstaller` is synchronous and must not import `db`, `fetch` or the adapter context.
- **Installer material is a secret.** It is written, re-sealed or cleared **only** in `services/edrProviders/installerMaterial.ts` (contract test), sealed with `encryptEdrSecret('tenant_installer_secret', tenantId, …)`, never returned by a route, never logged, never put in an error message or an audit row, never handed to an AI tool. A vendor download URL is validated with `validateVendorUrl` (`guardedFetch.ts:19`) against the adapter's `installerHostAllowlist` before it is stored **and** again before it is dispatched.
- **`installer_fetch_error` holds a code from `EDR_INSTALLER_FETCH_ERROR_CODES`, never vendor text** (it is export-`included`).
- **Never `limit(1)` a tenant.** 0 tenants → not mapped; >1 → ambiguous; the device's org must still belong to the tenant's partner (`organizations.partner_id = edr_tenants.partner_id`), the tenant must not be vendor-missing, the connection must be `is_active` and not `reauth_required`.
- **An installer outcome never fails inventory or detections.** Installer fetch failures are tenant-scoped, recorded in the installer columns, excluded from `throwIfAllFailed`, and never flip a connection to `reauth_required`.
- **Dormant until W06.3.** `BUILTIN_PACKAGES.bitdefender.released === false` means: `ensureBuiltinPackage` provisions nothing, the sync job fetches no material (zero vendor calls), dispatch refuses with "Bitdefender GravityZone installs are not available yet". Security-agents `enableable: false` in both the API registry and `SecurityAgentsTab.tsx`. W06.3 flips all three.
- **Windows only.** macOS `requires_mdm` (system extension + full disk access cannot be granted silently); Linux `unsupported` (Decision 4). **No agent Go change in any W06 PR** — see "Agent statement".
- **Fixtures are synthetic.** No customer names, hostnames, IPs, company ids or key material in code, fixtures, PR text or comments (public repo). `example.test` domains, RFC 5737 IPs, `00000000-0000-4000-8000-…` ids, an obviously fake package token.
- **Tests:** API `cd apps/api && npx vitest run <files>` (no `--` before flags); web `cd apps/web && npx vitest run <files>`; shared `cd packages/shared && npx vitest run <files>`. Never `pnpm --filter <pkg> test -- --run <path>`; vitest path filters are substring matches (`docs/agents/testing.md`). Typecheck `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo exit=$?` and read the exit code (never pipe to `tail`). Same for `apps/web` when touched.
- **Locales:** every new `en` key goes into all **8** locale dirs (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`).

## Migration & tenancy statement

**One migration, in W06.1 only:** `apps/api/migrations/2027-01-21-100000-edr-installer-dispatch.sql`. Newest committed at plan time: `2027-01-20-120000-m365-mailbox-connect-baseline.sql`; open PRs hold `2027-01-20-130000`, `-140000` and `-160000`. **Task 1.0 re-checks** `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -5` and the open-PR slots, and moves the name up (e.g. `2027-01-22-…`) if anything newer landed. Read `apps/api/migrations/README.md` first. Contents:

1. `ALTER TABLE software_catalog DROP CONSTRAINT IF EXISTS software_catalog_integration_provider_chk;` then `ADD CONSTRAINT software_catalog_integration_provider_chk CHECK (integration_provider IS NULL OR integration_provider IN ('huntress','sentinelone','bitdefender','emsisoft'))`. Never edit the 2026-07-02 file. The re-add validates existing rows; only the two legacy values exist today.
2. `ALTER TABLE edr_tenants ADD COLUMN IF NOT EXISTS installer_fetched_at timestamptz, ADD COLUMN IF NOT EXISTS installer_expires_at timestamptz, ADD COLUMN IF NOT EXISTS installer_fetch_error varchar(40);`
3. No inner `BEGIN;`/`COMMIT;`. The file writes no rows, so it needs no `set_config('breeze.scope','system',true)`; if a later edit adds any `UPDATE`/`INSERT`, add it first (`migrationRlsScope.test.ts`). Then `pnpm db:check-drift`.

**RLS shape:** no new table. `edr_tenants` stays shape 3 (partner-axis, nullable `org_id` mapping target; policies from `2026-12-16-100000-edr-provider-framework.sql`); the new columns inherit them. `software_catalog` keeps its dual-axis policies; a `bitdefender` built-in row is read by org members through the existing `integration_provider IS NOT NULL` partner-read branch (`2026-07-02-…:28-38`), exactly like Huntress.

**The four registration lists** (`docs/agents/tenancy-rls.md`): grep, don't judge.
- `CORE_ORG_CASCADE_DELETE_ORDER` — no change (no new table). Verify: `git grep -n "'edr_tenants'" -- apps/api/src` still shows the existing entry.
- `orgMergeRegistry.ts` — no change (no new table; `edr_tenants` is `repoint`, the new columns move with the row).
- `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:511`) — **change**: add `installer_fetched_at`, `installer_expires_at`, `installer_fetch_error` to `edr_tenants.included` (timestamps + a controlled code; no json/bytea, no secret). `installer_secret_encrypted` stays `excludedSensitive`.
- Device / ticket lists — n/a (no device- or ticket-keyed column).

The export-policy and cascade suites fail only under **Integration Tests**, never Test API: run them locally (`pnpm test-stack up`, the commands in `docs/agents/testing.md`, then `pnpm test-stack down`) before opening W06.1. **Partner-wide first:** no config/policy table is added; the policy surface is the existing partner-wide-capable `security_agents` feature.

## Config-policy linkage decision (`configuration-policy` skill)

Pattern B (inline settings), unchanged: framework providers become additional `vendor` values in the existing `security_agents` inline settings (`{ version: 1, agents: [{ vendor, enabled, platforms? }] }`), which generates the managed `software_policies` row (`managed_by_link_id`). No new feature type, no Pattern A standalone table, no new assignment surface, `featurePolicyId` stays NULL. This is the security-agents spec's Decision 4 ("consume the framework's `installer` capability … no parallel vendor registry for EDR providers"). The framework vendor's entry in `securityAgentVendors.ts` takes its key and label from the EDR registry and adds only what that registry cannot know (platform support, inventory glob, `enableable`); a test pins the set of `orgSource: 'edr_framework'` vendors equal to `EDR_INSTALLER_PROVIDER_KEYS`.

## AI tool exposure

**No new AI tool and no new registry entry** (`aiTools.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts`, `aiToolRateLimits.ts`, `aiAgentSdkTools.ts`, `mcpCoverage.ts`, `agentToolCatalog.ts` untouched). Two strings grow in W06.2: the shared `SECURITY_AGENT_VENDOR_KEYS` enum (so `manage_policy_feature_link`'s `security_agents` schema accepts `"bitdefender"`), and the `security_agents` line of the settings-shape doc at `aiToolsConfigPolicy.ts:277` (`|"bitdefender"`, +14 B). The AI still cannot enable a vendor (that line's existing rule and its test stay). **Budget:** the chat tool index is lazy (`AI_TOOL_INDEX=lazy`), byte-invariant to the registry, per-domain blocks bounded at 2,048 B — run `apps/api/src/__tests__/aiToolIndex.test.ts` and the description-budget tests before and after and state both numbers in the PR body. If the flag is `full` in your environment, the old rule applies: raise the ceiling by exactly +128 B in its own commit only if over, never above 7,680 B; otherwise stop and ask. No new route, so `mcp-coverage.test.ts` gains no entry.

## Agent statement

**No agent Go change, and no agent release, in W06.1–W06.3.** The agent already takes `fileName`/`fileType` from the payload and keeps the basename (`software_install.go:279`); `exe` is a supported Windows type. Filename-derived secrets in agent error text are handled **server-side** (Task 1.8), not by an agent sanitizer. A Linux GravityZone installer would need a shell-installer file type in the agent (or a secret inside a script, which #6958 rejects by design) — out of scope (Decision 4). If the lab (W06.3) proves the agent must change (e.g. the downloader needs a working directory or a name the agent rewrites), **stop**: do not flip the gates, file the agent issue, and record the finding on #8170.

## Settings rule 9

- **W06.1:** no setting. The installer link is vendor material fetched from the console; the GravityZone package choice is made in the vendor console (exactly one package per company, Decision 6). Places configured: n/a.
- **W06.2:** no new setting. The concept "install this vendor's agent on these devices" keeps its one home: Configuration Policies → Security agents tab (level: partner default → org override via policy assignment; resolver `resolveSecurityAgentsLinkForDevice`; snapshot: the generated managed software policy). Places configured before/after: **1 → 1** (one more vendor row in the same tab).
- **W06.3:** none. Each PR states this in the PR-template checkbox.

## Review Focus

1. **An org mapped to two GravityZone companies** (two connections under D3, or two companies mapped to one org). Expected: dispatch fails with "Organization maps to 2 Bitdefender GravityZone tenants — map it to one", readiness says `tenant_ambiguous`, the compliance worker creates **zero** deployments; nothing ever picks one. Pinned in Task 1.5 (real Postgres) and Task 2.2.
2. **The API key is rotated, or the company's package is deleted and re-created in the console.** Expected: a credential/base-URL PATCH clears every tenant's material in the same transaction; until the next inventory run refetches, readiness says `installer_link_missing` and no deployment is created; an old link is never dispatched. Pinned in Task 1.4.
3. **Packages API not enabled on the key, or a company with 0 or 2 installation packages.** Expected: that tenant records `installer_fetch_error = packages_api_disabled | no_package | multiple_packages`; its inventory and detections still sync; the connection stays `connected`; the test-connection result carries a `packages: API not enabled on key` note. Pinned in Tasks 1.3 and 1.4.
4. **A device whose org moved to another partner, or a tenant the vendor no longer lists** (`vendor_missing_since` set). Expected: the tenant is not selectable for that org (not mapped / not ready); no install into another MSP's company. Pinned in Task 1.5.
5. **The installer fails and the agent's error echoes the downloader path** (`…\setupdownloader_[…].exe: …`). Expected: the stored `deployment_results.error_message` / output and anything an AI tool reads show `[installer]`, not the file name or URL. Pinned in Task 1.8.

---

# W06.1 — Framework installer path + GravityZone installer (API + one web panel)

Blast radius: **high** (ships to customer machines, secrets, migration). Full TDD, Opus implementers for every task not marked Sonnet-eligible, one independent review round.

## File Structure (W06.1)

| File | Change |
|---|---|
| `apps/api/migrations/2027-01-21-100000-edr-installer-dispatch.sql` | Create (above) |
| `apps/api/src/db/schema/edrProviders.ts` | `installerFetchedAt`, `installerExpiresAt`, `installerFetchError` on `edrTenants` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Three `edr_tenants` columns → `included` |
| `apps/api/src/services/edrProviders/types.ts` | Typed installer contract; delete `getInstaller?` |
| `apps/api/src/services/edrProviders/providerKeys.ts` | `EDR_INSTALLER_PROVIDER_KEYS`, `EdrInstallerProviderKey`, `isEdrInstallerProviderKey` |
| `apps/api/src/services/edrProviders/installerMaterial.ts` (+ test, + `installerMaterial.writer.contract.test.ts`) | Create: envelope schema, refresh policy, seal/open, persist outcomes, clear |
| `apps/api/src/services/edrProviders/installerTenant.ts` (+ test) | Create: shared tenant selection (single + batch) |
| `apps/api/src/services/edrProviders/bitdefender/{client,adapter}.ts` (+ tests, `__fixtures__/installation-links*.json`) | `listInstallationLinks`; `fetchInstallerMaterial`, `buildInstaller`, `installerHostAllowlist`; `installer: 'api_generated_link'`; testConnection note |
| `apps/api/src/jobs/edrProviderSync.ts` | Inventory stream: due tenants (Phase 1), fetch (Phase 2), persist (Phase 3) |
| `apps/api/src/routes/edr/connections.ts`, `routes/edr/tenants.ts` | Clear material on credential/base-URL PATCH and on unmap; `ensureBuiltinPackage` on create/PATCH for installer-capable providers |
| `apps/api/src/services/builtinDeploymentPackages.ts` | `BuiltinProvider` widened; `released`, `originalFileName`, `installerPlatform` on defs; `bitdefender` def; unreleased no-op |
| `apps/api/src/services/edrInstallerResolver.ts` | Framework branch; `ResolvedInstaller` overrides |
| `apps/api/src/services/softwareDeployment.ts` | Resolve for any non-null `integrationProvider`; payload uses overrides |
| `apps/api/src/services/softwareDeploymentResult.ts` | Scrub installer file name / URL from results of framework-provider deployments |
| `apps/api/src/services/builtinProviderCheck.test.ts` | Create: CHECK ↔ registry exhaustiveness |
| `apps/api/src/routes/edr/access.ts` + web tenant mapping table (`apps/web/src/components/integrations/…EdrTenant…`) + `edr` locale keys ×8 | Installer status column |
| Contract/test updates | `registry.test.ts:18`, `capabilities.test.ts`, `routes/edr/connections.test.ts:345` (capabilities snapshot gains `installer:api_generated_link`), `bitdefender/adapter.test.ts`, `edrProviderSync.test.ts`, `edrInstallerResolver.test.ts`, `softwareDeployment*.test.ts` |

## Execution split and parallelism (W06.1)

- **Seam:** API owns everything except Task 1.9's web half. The web half consumes `GET /edr/connections/:id/tenants` fields `installerFetchedAt: string | null`, `installerExpiresAt: string | null`, `installerFetchError: EdrInstallerFetchErrorCode | null` (plus the existing `hasInstallerSecret`), and can start once Task 1.1 fixes the names.
- **Order:** 1.0 → 1.1 → 1.2, then **PARALLEL GROUP A** {1.3 GravityZone (bitdefender/**), 1.5 tenant selection (installerTenant.ts), 1.6 built-in packages (builtinDeploymentPackages.ts)} — file-disjoint. Then **PARALLEL GROUP B** {1.4 material refresh (installerMaterial.ts, edrProviderSync.ts, routes/edr/{connections,tenants}.ts), 1.7 resolver + dispatch (edrInstallerResolver.ts, softwareDeployment.ts), 1.8 result scrub (softwareDeploymentResult.ts), 1.9 installer status (access.ts + web)} — file-disjoint; 1.4 and 1.7 both import `installerMaterial.ts`'s `openInstallerMaterial`, which Task 1.2 creates. Then 1.10.
- **Sonnet-eligible (mechanical, contract fully specified here):** 1.1 (schema/export/CHECK test — Opus reviews the SQL), 1.9 web half + locales. Everything else Opus.

### Task 1.0: Preflight

- [ ] `git fetch origin && git rebase origin/main`; confirm #8170 open and no open PR touches `edrInstallerResolver.ts`, `builtinDeploymentPackages.ts`, `edrProviders/**` (`gh pr list --state open --json number,files`).
- [ ] Re-check the migration slot (above); rename the planned file if needed.
- [ ] `get_feature_status` (#8164) → `start_wave` for #8170; branch `feature/8164-edr-provider-framework/wave-8170`.

### Task 1.1: Migration, schema, export policy, CHECK exhaustiveness

**Files:** Create the migration and `services/builtinProviderCheck.test.ts`; modify `db/schema/edrProviders.ts`, `tenantExportPolicyRegistry.ts`.

**Interfaces — Produces:** `edrTenants.installerFetchedAt: Date | null`, `installerExpiresAt: Date | null`, `installerFetchError: string | null` (typed `EdrInstallerFetchErrorCode | null` via `$type`).

- [ ] **Step 1: failing test** `builtinProviderCheck.test.ts`: reads every file in `apps/api/migrations/` (sorted), takes the **last** one that adds `software_catalog_integration_provider_chk`, extracts the `IN (…)` list, and asserts `sorted(list) == sorted(['huntress','sentinelone', ...EDR_PROVIDER_KEYS])`. A second case asserts `EDR_INSTALLER_PROVIDER_KEYS ⊆ EDR_PROVIDER_KEYS`. Run → FAIL (latest CHECK lists two values).
- [ ] **Step 2:** write the migration and Drizzle columns; add the three names to the `edr_tenants` `included` list.
- [ ] **Step 3:** run the test → PASS; `pnpm db:migrate` on a test stack, `pnpm db:check-drift` → clean; run the export-policy and cascade suites under the test stack (`docs/agents/testing.md`) → PASS.
- [ ] **Step 4:** commit `feat(edr): installer status columns + catalog provider CHECK covers EDR keys (#8170)`.

### Task 1.2: Typed installer contract + material envelope

**Files:** modify `edrProviders/types.ts`, `providerKeys.ts`, `registry.test.ts`, `capabilities.test.ts`; create `edrProviders/installerMaterial.ts` (+ test).

**Interfaces — Produces:**

```ts
// types.ts
export type EdrInstallerPlatform = 'windows' | 'macos' | 'linux';
export type EdrInstallerFileType = 'exe' | 'msi' | 'pkg' | 'dmg' | 'deb' | 'zip';
export const EDR_INSTALLER_FETCH_ERROR_CODES = ['packages_api_disabled', 'no_package', 'multiple_packages',
  'malformed_response', 'url_rejected', 'vendor_error'] as const;
export type EdrInstallerFetchErrorCode = (typeof EDR_INSTALLER_FETCH_ERROR_CODES)[number];
export type EdrInstallerFetchResult =
  | { ok: true; data: unknown; expiresAt: Date | null }
  | { ok: false; code: EdrInstallerFetchErrorCode };
export interface EdrInstallerSpec {
  downloadUrl: string; fileName: string; fileType: EdrInstallerFileType;
  silentInstallArgs: string; checksum: string | null;
}
export type EdrInstallerBuildError = { error: 'platform_unsupported' | 'material_invalid' };
// on EdrProviderAdapter (replaces getInstaller?):
readonly installerHostAllowlist?: readonly string[];
/** Sync worker vendor-I/O phase only. Throws EdrProviderRequestError for transport/auth failures. */
fetchInstallerMaterial?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef): Promise<EdrInstallerFetchResult>;
/** Pure and synchronous: no db, no fetch, no ctx. Validates `data` with the adapter's own schema. */
buildInstaller?(data: unknown, platform: EdrInstallerPlatform): EdrInstallerSpec | EdrInstallerBuildError;

// providerKeys.ts (import-free)
export const EDR_INSTALLER_PROVIDER_KEYS = ['bitdefender'] as const;
export type EdrInstallerProviderKey = (typeof EDR_INSTALLER_PROVIDER_KEYS)[number];
export function isEdrInstallerProviderKey(key: string): key is EdrInstallerProviderKey;

// installerMaterial.ts
export const installerMaterialEnvelopeSchema: z.ZodType<InstallerMaterialEnvelope>; // { v: 1, provider, fetchedAt (ISO), expiresAt (ISO|null), data: unknown }, strict
export function sealInstallerMaterial(tenantId: string, envelope: InstallerMaterialEnvelope): string;
export function openInstallerMaterial(tenantId: string, ciphertext: string): InstallerMaterialEnvelope | null; // null on decrypt OR schema failure, never throws, never logs plaintext
```

- [ ] **Step 1: failing tests.** `registry.test.ts`: replace line 18 with `expect(a.capabilities.installer !== 'none').toBe(typeof a.fetchInstallerMaterial === 'function' && typeof a.buildInstaller === 'function' && (a.installerHostAllowlist?.length ?? 0) > 0)` (iff, both directions) and add `EDR_INSTALLER_PROVIDER_KEYS` equals `listEdrProviders().filter(a => a.capabilities.installer !== 'none').map(a => a.key)`. `installerMaterial.test.ts`: seal→open round-trips; a blob sealed for tenant A does not open for tenant B (row AAD) → `null`; a sealed envelope with `v: 2` or an extra key → `null`; open never throws on garbage. Run → FAIL.
- [ ] **Step 2:** implement; delete `getInstaller?` from `types.ts:267`. (Registry test stays red until Task 1.3 flips GravityZone — mark that one case `it.todo` in this commit and remove the `todo` in 1.3, so the commit is green.)
- [ ] **Step 3:** PASS; typecheck exit 0. Commit.

### Task 1.3: GravityZone installer (client + adapter + fixtures)

**Files:** `bitdefender/client.ts`, `bitdefender/adapter.ts` (+ tests), `bitdefender/__fixtures__/installation-links-one.json`, `…-two.json`, `…-none.json`, `…-malformed.json`.

**Vendor facts [U] — settled by W06.3, fixtures follow the published Packages API:** JSON-RPC service `packages`, method `getInstallationLinks`, params `{ companyId }`; result: one entry per installation package with `packageName` and per-OS links, of which W06 uses the **Windows downloader** link (`installLinkWindows`). The downloader's file name (URL path basename) must be preserved **[U]**. Silent switches `/bdparams /silent` **[U]**. Download host(s) **[U]** — `installerHostAllowlist` starts as `['.gravityzone.bitdefender.com', 'download.bitdefender.com']` and W06.3 narrows it to what the lab observes. Link expiry: none believed **[U]** → `expiresAt: null`.

**Interfaces — Consumes:** Task 1.2 types. **Produces:** `GravityZoneClient.listInstallationLinks(companyId: string): Promise<GzInstallationLinks[]>` (operation class `packages`, budget `{ perMinute: 10 }` added to `operationBudgets`); adapter `fetchInstallerMaterial`, `buildInstaller`, `installerHostAllowlist`; `capabilities.installer = 'api_generated_link'`.

- [ ] **Step 1: failing tests** (`adapter.test.ts`, fixture-driven):
  - one package → `{ ok: true, data: { v: 1, packageName, windowsUrl }, expiresAt: null }`; the URL passed `validateVendorUrl`.
  - two packages → `{ ok: false, code: 'multiple_packages' }`; none → `no_package`; a link with `http:`, userinfo, or a host outside the allowlist → `url_rejected`; missing `installLinkWindows` → `malformed_response`.
  - the `packages` API refused (GZ permission error for that service) → `packages_api_disabled`, **not** a thrown reauth error; a dead key (401) still throws `EdrProviderRequestError { reauth: true, scope: 'connection' }`.
  - `buildInstaller(data, 'windows')` → `{ downloadUrl, fileName: <decoded URL basename>, fileType: 'exe', silentInstallArgs: '/bdparams /silent', checksum: null }`; `fileName` must end `.exe` else `{ error: 'material_invalid' }`; `'macos'`/`'linux'` → `{ error: 'platform_unsupported' }`; garbage `data` → `material_invalid`. `buildInstaller` imports nothing from `db`/`fetch` (static check: the test greps the adapter module for a `db` import — the existing adapter is DB-free, keep it).
  - `testConnection`: `enabledApis` without `packages` → result note `packages: API not enabled on key`.
  - Error messages carry method + status + the service name only; never the URL, company id or package name (redaction test like the existing client tests).
- [ ] **Step 2:** implement; remove the `it.todo` from 1.2; update `routes/edr/connections.test.ts:345` snapshot (`installer:api_generated_link`, the new note when applicable).
- [ ] **Step 3:** `npx vitest run src/services/edrProviders/bitdefender src/services/edrProviders/registry.test.ts src/services/edrProviders/capabilities.test.ts src/routes/edr/connections.test.ts` → PASS. Commit.

### Task 1.4: Installer material refresh in the sync job + invalidation

**Files:** `edrProviders/installerMaterial.ts` (extend), `installerMaterial.writer.contract.test.ts` (create), `jobs/edrProviderSync.ts`, `routes/edr/connections.ts`, `routes/edr/tenants.ts` (+ tests).

**Interfaces — Produces:**

```ts
export const INSTALLER_REFRESH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const INSTALLER_EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;
/** Pure. Due when: no material; expiresAt within the margin; fetchedAt older than max age;
 *  or the last attempt errored (retried every inventory run, i.e. at the inventory cadence).
 *  Never due for an unmapped tenant. */
export function installerRefreshDue(row: { orgId: string | null; hasMaterial: boolean; fetchedAt: Date | null;
  expiresAt: Date | null; fetchError: string | null }, now: Date): boolean;
export type InstallerOutcome = { tenantId: string } & ({ ok: true; data: unknown; expiresAt: Date | null } | { ok: false; code: EdrInstallerFetchErrorCode });
export async function persistInstallerOutcomes(tx: DbExecutor, provider: EdrInstallerProviderKey, outcomes: InstallerOutcome[], now: Date): Promise<void>;
export async function clearTenantInstallerMaterial(tx: DbExecutor, where: { connectionId: string } | { tenantId: string }): Promise<number>;
```

Behaviour: success → seal the envelope, set `installer_fetched_at = now`, `installer_expires_at`, `installer_fetch_error = NULL`; failure → keep the existing sealed material and `installer_fetched_at`, set `installer_fetch_error = code`. Clear → secret, fetched_at, expires_at, error all NULL.

Gating: the inventory run computes due tenants only when the provider is installer-capable **and** `getBuiltinPackage(provider).released`. Phase 1 of that run also calls `ensureBuiltinPackage` for the connection's partner (idempotent; a no-op while unreleased), so connections created before W06.3 get their catalog row the first run after release. With `released: false` the run makes zero installer calls and writes no catalog row.

- [ ] **Step 1: failing tests.**
  - `installerMaterial.test.ts`: `installerRefreshDue` table (unmapped never; no material; 23 h vs 25 h age; expiry inside/outside margin; errored → due).
  - `installerMaterial.writer.contract.test.ts`: `git grep -nE "installerSecretEncrypted|installer_secret_encrypted"` over `apps/api/src` (excluding tests, the schema file, the encrypted-column/export registries, `access.ts`'s boolean projection, and `credentials.ts`) returns **only** `installerMaterial.ts`. Fails if any other file assigns it.
  - `edrProviderSync.test.ts`: (a) released + one due tenant → `ensureBuiltinPackage` called in Phase 1, `fetchInstallerMaterial` called once **outside** DB context (existing tripwire helper), Phase 3 persists; (b) `released: false` → neither the fetch nor a catalog write happens; (c) fetch throws a tenant-scoped error / returns `{ ok: false }` → inventory for that tenant and the connection's status are unchanged, the error code is persisted, `throwIfAllFailed` is not triggered by installer results; (d) **any** throw from the installer fetch (including a 401) is recorded as `vendor_error` for that tenant and never changes connection status — the inventory call alone owns reauth classification; (e) a tenant remapped since Phase 1 → its outcome is dropped by the existing per-tenant fence.
  - `routes/edr/connections.test.ts`: PATCH with new `credentials` or `baseUrl` calls `clearTenantInstallerMaterial({ connectionId })` in the same transaction as the credential update (assert ordering via the tx mock); PATCH of `name` only does not clear. `routes/edr/tenants.test.ts`: unmapping a tenant (org → null) clears that tenant; remapping to another org keeps material (the vendor company is unchanged).
- [ ] **Step 2:** implement; Phase 1 reads `installer_*` + `updated_at` for mapped tenants; Phase 2 runs fetches with the connection limiter, `tenantFetchConcurrency`, and its own try/catch per tenant; Phase 3 calls `persistInstallerOutcomes` inside the existing system tx after the tenant fence.
- [ ] **Step 3:** PASS; typecheck exit 0. Commit.

### Task 1.5: Shared installer-tenant selection

**Files:** create `edrProviders/installerTenant.ts` (+ unit test) and `apps/api/src/__tests__/integration/edrInstallerTenant.integration.test.ts`.

**Interfaces — Produces:**

```ts
export type InstallerTenantSelection =
  | { kind: 'ok'; tenantId: string; connectionId: string; sealedMaterial: string; expiresAt: Date | null }
  | { kind: 'not_mapped' } | { kind: 'ambiguous'; count: number } | { kind: 'inactive' }
  | { kind: 'material_missing' } | { kind: 'material_expired' };
/** Own system context (runOutsideDbContext + withSystemDbAccessContext), like resolveHuntress. */
export async function selectInstallerTenant(provider: EdrInstallerProviderKey, orgId: string, now?: Date): Promise<InstallerTenantSelection>;
/** At most two queries for any number of orgs; every requested org gets an answer. */
export async function loadInstallerTenantSelections(provider: EdrInstallerProviderKey, orgIds: readonly string[], now?: Date): Promise<Map<string, InstallerTenantSelection>>;
```

Rules (in this order): candidate tenants = `edr_tenants` with `org_id = :org`, `vendor_missing_since IS NULL`, `partner_id = (SELECT partner_id FROM organizations WHERE id = :org)`, joined to `edr_connections` with `provider = :provider`. 0 → `not_mapped`; >1 → `ambiguous` (count); the one tenant's connection `is_active = false` or `status = 'reauth_required'` → `inactive`; no sealed material → `material_missing`; `installer_expires_at` within 1 h of `now` → `material_expired`; else `ok`. `selectInstallerTenant` is `loadInstallerTenantSelections` for one org. Readiness callers must not receive `sealedMaterial` (W06.2 maps to reasons).

- [ ] **Step 1: failing integration test** (real Postgres, seeded under system scope): partner P with orgs O1 (one tenant, material), O2 (two tenants under two connections), O3 (no tenant), O4 (tenant, connection `reauth_required`), O5 (tenant with `vendor_missing_since`), O6 (tenant, no material), O7 (material expiring in 30 min). A cross-partner tenant cannot exist (the `(org_id, partner_id)` composite FK refuses it with 23503 — assert that once); the partner predicate stays as defence in depth and is covered by a unit test with a mocked row. Assert each org's `kind`; assert `loadInstallerTenantSelections` issues ≤2 queries for 7 orgs (query counter).
- [ ] **Step 2:** implement. **Step 3:** PASS under the test stack + unit. Commit.

### Task 1.6: Built-in packages widened + dormant GravityZone package

**Files:** `services/builtinDeploymentPackages.ts` (+ test), `routes/edr/connections.ts` (ensure on create/PATCH), `routes/huntress.ts:514`, `routes/sentinelOne.ts:437` (return type only).

**Interfaces — Produces:**

```ts
export const LEGACY_BUILTIN_PROVIDERS = ['huntress', 'sentinelone'] as const;
export type BuiltinProvider = (typeof LEGACY_BUILTIN_PROVIDERS)[number] | EdrInstallerProviderKey;
export function isBuiltinProvider(value: string | null | undefined): value is BuiltinProvider;
// BuiltinPackageBase gains:
released: boolean;              // false = never provisioned, never dispatched
originalFileName: string | null;// was hard-coded 'HuntressInstaller.exe' in ensureBuiltinPackage
installerPlatform: 'windows';   // the one OS this catalog row installs (one is_latest per catalog)
// new def
bitdefender: { provider: 'bitdefender', name: 'Bitdefender GravityZone Agent', vendor: 'Bitdefender', category: 'security',
  websiteUrl: 'https://www.bitdefender.com', fileType: 'exe', supportedOs: ['windows'],
  downloadUrlTemplate: '{edr_installer_url}', silentInstallArgsTemplate: '{edr_installer_args}',
  originalFileName: 'GravityZoneInstaller.exe', requiresBinaryUpload: false, released: false, installerPlatform: 'windows' }
export async function ensureBuiltinPackage(p: { provider: BuiltinProvider; partnerId: string }):
  Promise<{ catalogId: string } | { catalogId: null; skipped: 'unreleased' }>;
```

The two template placeholders exist only so a version row is never blank; the framework resolver replaces the whole URL/args/file name from the material, it does not substitute into the template. `installArgsCarryPlaceholders` stays legacy-only (typed on `LegacyBuiltinProvider`).

- [ ] **Step 1: failing tests:** `ensureBuiltinPackage({ provider: 'bitdefender' })` with `released: false` inserts nothing and returns `skipped`; with `released` mocked true inserts one partner row (`integration_provider = 'bitdefender'`, `org_id NULL`) and one `latest` version with `originalFileName 'GravityZoneInstaller.exe'`, idempotent on a second call; Huntress still writes `HuntressInstaller.exe`. `isBuiltinProvider('emsisoft') === false` (no installer), `isBuiltinProvider('bitdefender') === true`. `POST /edr/connections` for an installer-capable provider calls `ensureBuiltinPackage` after a successful test; for `emsisoft` it does not.
- [ ] **Step 2:** implement. **Step 3:** PASS. Commit.

### Task 1.7: Resolver framework branch + dispatch overrides

**Files:** `services/edrInstallerResolver.ts` (+ test), `services/softwareDeployment.ts` (+ the existing dispatch tests).

**Interfaces — Consumes:** `selectInstallerTenant` (1.5), `openInstallerMaterial` (1.2), `getEdrProvider` + `buildInstaller` (1.3), `getBuiltinPackage` (1.6). **Produces:**

```ts
export interface ResolvedInstaller {
  downloadUrl: string | null; silentInstallArgs: string | null;
  /** Absent = keep the version row's value. */
  fileName?: string; fileType?: EdrInstallerFileType;
  /** Absent = keep the version's checksum; null = the vendor publishes none (dispatch sends no checksum). */
  checksum?: string | null;
}
```

Error strings (exact; `<L>` = `EDR_PROVIDER_LABELS[provider]`): `<L> installs are not available yet` (unreleased) · `Organization not mapped to <L>` · `Organization maps to <n> <L> tenants — map it to one` · `<L> integration is disconnected` · `<L> installer link not fetched yet — run Sync in Integrations` · `<L> installer link has expired — run Sync in Integrations` · `<L> installer link could not be read — reconnect the integration` (open → null, or `buildInstaller` → `material_invalid`, or the URL fails `validateVendorUrl` at dispatch) · `<L> installer is not available for this platform`.

- [ ] **Step 1: failing tests** (`edrInstallerResolver.test.ts`, registry and selection mocked): one test per error string above; the happy path returns the adapter's spec with `checksum: null`; the URL is re-validated (a stored material whose host was later removed from `installerHostAllowlist` is refused); `resolveEdrInstaller` never calls `fetchInstallerMaterial` (spy) and never runs inside an ambient DB context (it opens its own system context like `resolveHuntress`). Existing Huntress/S1 tests unchanged. `softwareDeployment` tests: a catalog item with `integrationProvider: 'bitdefender'` is resolved and the payload carries the override `fileName`/`fileType` and **no** `checksum`; an item with an unknown non-null provider (forced past the CHECK with a mock) fails every result with `Unsupported integration provider: <x>`; Huntress payloads are byte-identical to before (snapshot).
- [ ] **Step 2:** implement: `case` per `EdrInstallerProviderKey` in the switch delegating to `resolveFrameworkInstaller`; dispatch condition becomes `catalogItem.integrationProvider !== null` → `isBuiltinProvider` ? resolve : fail closed; the payload builder (`:1203-1210`) prefers `resolvedInstaller.fileName/fileType/checksum` when present.
- [ ] **Step 3:** PASS; typecheck exit 0. Commit.

### Task 1.8: Scrub installer secrets from results

**Files:** `services/softwareDeploymentResult.ts` (+ test).

**Interfaces — Produces:** `export function scrubInstallerSecrets(text: string, secrets: { fileName?: string | null; downloadUrl?: string | null }): string` — replaces every occurrence of the full URL, the URL without query, the file name, and the file-name stem (≥ 8 chars) with `[installer]`, case-insensitively; pure.

- [ ] **Step 1: failing tests:** a Windows-style exec error `fork/exec C:\…\setupdownloader_[aHR0…].exe: …` → stem replaced; URL with query replaced; short or absent secrets leave text unchanged. Wiring test: when the result handler persists a software-install result for a deployment whose catalog `integrationProvider` is an `EdrInstallerProviderKey`, `error_message` and stored output are scrubbed using the `fileName`/`downloadUrl` from that command's payload; Huntress results are untouched (no behaviour change outside framework providers).
- [ ] **Step 2:** implement. Also `git grep -n "downloadUrl" -- apps/api/src/services/softwareDeployment*.ts apps/api/src/routes` and confirm the resolved URL is persisted only in the device command payload (same exposure class as the Huntress account-key URL); note the result in the PR body.
- [ ] **Step 3:** PASS. Commit.

### Task 1.9: Installer status on the tenant mapping table (API + web)

**Files:** `routes/edr/access.ts` (tenant projection + test), the web EDR tenant mapping table component under `apps/web/src/components/integrations/` (+ test), `apps/web/src/locales/*/edr.json` ×8 (or the namespace the table already uses).

- [ ] **Step 1: failing tests:** the projection returns `installerFetchedAt`, `installerExpiresAt`, `installerFetchError` and still never `installerSecretEncrypted`; the web row shows "Installer: ready (fetched <relative>)", "Installer: <code copy>" for each `EDR_INSTALLER_FETCH_ERROR_CODES` value, or nothing for a provider without an installer; `data-testid="edr-tenant-installer-status"`. Unknown code falls back to a generic "Installer link unavailable".
- [ ] **Step 2:** implement + 8 locales (keys `edr.tenants.installer.{ready,packagesApiDisabled,noPackage,multiplePackages,malformedResponse,urlRejected,vendorError,unavailable}`). **Step 3:** PASS; web typecheck exit 0. Commit. (Sonnet-eligible.)

### Task 1.10: W06.1 verification gate

- [ ] API typecheck exit 0; targeted suites: `src/services/edrProviders src/services/edrInstallerResolver.test.ts src/services/softwareDeployment src/jobs/edrProviderSync.test.ts src/routes/edr src/services/builtinDeploymentPackages.test.ts src/services/builtinProviderCheck.test.ts` → PASS.
- [ ] Test stack up: `edrInstallerTenant.integration.test.ts`, export-policy, cascade, RLS-coverage suites → PASS; test stack down.
- [ ] `pnpm db:check-drift` clean. Web tests + typecheck for 1.9.
- [ ] One independent review round (Opus), focused on: no vendor HTTP at dispatch, sole-writer contract, ambiguity refusal, dormancy (`released: false` ⇒ zero vendor calls, zero catalog rows, dispatch refused).
- [ ] PR (base `main`): title `feat(edr): installer dispatch for EDR framework providers — GravityZone, dormant (#8170)`; body `Refs #8170`, `Part of #8164`, migration name, export-policy delta, settings rule 9 line, agent statement, tests run. **No closing keyword.**

---

# W06.2 — Security-agents hook for framework providers (API + web)

Blast radius: **high** (arms installs on customer machines through config policies; partner-wide fan-out). Full TDD, Opus except where marked. No migration. Ships dormant (`enableable: false`).

## File Structure (W06.2)

| File | Change |
|---|---|
| `packages/shared/src/validators/securityAgents.ts` (+ test) | `SECURITY_AGENT_VENDOR_KEYS` gains `'bitdefender'` |
| `apps/api/src/services/securityAgents/securityAgentVendors.ts` (+ test) | `orgSource: 'edr_framework'`; `integrationProvider: BuiltinProvider \| null`; `bitdefender` entry (`enableable: false`) |
| `apps/api/src/services/securityAgents/installerReadiness.ts` (+ test) | Framework branch; reasons `tenant_ambiguous`, `installer_link_missing` |
| `apps/api/src/services/securityAgents/managedPolicyOwnerCatalog.ts`, `managedPolicyGenerator.ts` (+ tests) | Widened typing; catalog-missing path for an unreleased/unprovisioned framework package |
| `apps/api/src/services/securityAgents/vendorEndpointSources.ts` (+ test) | `edr_endpoints` source for framework vendors |
| `apps/api/src/services/aiToolsConfigPolicy.ts:277` | `|"bitdefender"` in the doc string |
| `apps/api/src/__tests__/integration/securityAgentsFramework.integration.test.ts` | Create: partner-wide fan-out on real Postgres |
| `apps/web/src/components/configurationPolicies/featureTabs/SecurityAgentsTab.tsx` (+ test), `apps/web/src/lib/securityAgentCoverage.ts` (+ test), `apps/web/src/locales/*/security.json` ×8 | Vendor row (disabled), reason copy |

## Execution split and parallelism (W06.2)

- **Seam:** the web half consumes vendor key `'bitdefender'`, display name `Bitdefender GravityZone`, and readiness/coverage reason codes `tenant_ambiguous`, `installer_link_missing` (plus the existing `org_not_mapped`, `integration_inactive`, `vendor_unavailable`). It can start as soon as Task 2.1 lands the shared key.
- **Order:** 2.0 → 2.1, then **PARALLEL GROUP C** {2.2 readiness (installerReadiness.ts), 2.3 catalog/generator (managedPolicyOwnerCatalog.ts, managedPolicyGenerator.ts), 2.4 coverage (vendorEndpointSources.ts), 2.5 web (SecurityAgentsTab.tsx, securityAgentCoverage.ts, locales)} — file-disjoint. Then 2.6 → 2.7.
- **Sonnet-eligible:** 2.1's shared enum + AI doc string, 2.5 (web copy, 8 locales). Opus: 2.2, 2.3, 2.4, 2.6.

### Task 2.0: Preflight

- [ ] Rebase on `main` with W06.1 merged; confirm #8739 (security-agents W05) has no open PR touching the same files, or rebase after it; branch `…/wave-8170-hook`.

### Task 2.1: Vendor key + registry entry + exhaustiveness

**Interfaces — Produces:** `SECURITY_AGENT_VENDOR_KEYS = ['huntress','sentinelone','controld','nextdns','bitdefender']`; `SecurityAgentVendor.orgSource: 'edr_mapping' | 'tenant_var' | 'edr_framework'`; entry:

```ts
bitdefender: { key: 'bitdefender', label: EDR_PROVIDER_LABELS.bitdefender, catalogRef: 'builtin:bitdefender',
  orgSource: 'edr_framework', integrationProvider: 'bitdefender',
  detectionRuleName: 'Bitdefender Endpoint Security Tools*',   // [U] W06.3 confirms the Add/Remove Programs name
  setupPath: '/integrations#security',                         // verify the tab hash in IntegrationsPage.tsx
  platforms: { windows: 'supported', macos: 'requires_mdm', linux: 'unsupported' },
  presence: {}, enableable: false }
```

- [ ] **Step 1: failing tests:** the vendors whose `orgSource === 'edr_framework'` equal `EDR_INSTALLER_PROVIDER_KEYS` (set equality) and each one's `label === EDR_PROVIDER_LABELS[key]` and `integrationProvider === key`; every `SECURITY_AGENT_VENDOR_KEYS` value has a registry entry and vice versa; `vendorForIntegrationProvider('bitdefender') === 'bitdefender'`; the inline-settings schema accepts `{ vendor: 'bitdefender', enabled: false }` and the `agents` max grows to 5; enabling `bitdefender` through the link-write path is refused `vendor_not_enableable` (existing test, new vendor case); the AI path still cannot enable any vendor.
- [ ] **Step 2:** implement + the AI doc string; measure `aiToolIndex.test.ts` and description budgets before/after (numbers into the PR body).
- [ ] **Step 3:** PASS (shared + API). Commit.

### Task 2.2: Readiness for framework vendors

**Interfaces — Consumes:** `loadInstallerTenantSelections` (W06.1). **Produces:** `ReadinessReason` += `'tenant_ambiguous' | 'installer_link_missing'`; `loadOrgInstallerReadiness('bitdefender', orgIds)` maps `not_mapped → org_not_mapped`, `ambiguous → tenant_ambiguous`, `inactive → integration_inactive`, `material_missing | material_expired → installer_link_missing`, `ok → ready`; unreleased package (`getBuiltinPackage(p).released === false`) → `vendor_unavailable` for every org. No decrypt (the selection's `sealedMaterial` is never read here).

- [ ] **Step 1: failing tests:** each mapping; unreleased → `vendor_unavailable`; one call for many orgs (≤2 queries, via the batch loader); the switch stays exhaustive (`never` default); platform half: Windows ready, macOS `requires_mdm_approval`, Linux `platform_unsupported`.
- [ ] **Step 2:** implement. **Step 3:** PASS. Commit.

### Task 2.3: Owner catalog + generator for framework vendors

- [ ] **Step 1: failing tests:** with no `bitdefender` catalog row for the partner, saving a link that enables it (enableable mocked true) returns `security_agents_catalog_missing` with `setupPath`; with the row, the generator writes one rule `{ catalogId, name: 'Bitdefender Endpoint Security Tools*' }`; `vendorRequiresUploadedBinary('bitdefender') === false`; `vendorForCatalogPackage({ integrationProvider: 'bitdefender' })` → `{ vendor: 'bitdefender', platform: null }`.
- [ ] **Step 2:** widen types (`integrationProvider: BuiltinProvider | null`); no behaviour change for the four existing vendors (their suites pass unmodified). **Step 3:** PASS. Commit.

### Task 2.4: Coverage source from `edr_endpoints`

**Interfaces — Produces:** a `VendorEndpointSource` for each `edr_framework` vendor: views from `edr_endpoints` joined to `edr_tenants`/`edr_connections` (`provider = key`) for the partner's orgs — `endpointId = edr_endpoints.id`, `orgId = edr_endpoints.org_id`, `deviceId = breeze_device_id`, `hostname`, `online`. **Unavailable (null)** when any mapped tenant of that provider for the org has `last_inventory_sync_at` null or older than `VENDOR_VIEW_STALE_MS`, or its connection is inactive / `reauth_required` — never "empty". `mismatched_org` is never produced (device linking is same-org by construction; spec 2.9 "not claimed").

- [ ] **Step 1: failing tests:** covered (linked endpoint); `vendor_only` (unlinked endpoint); offline (`online === false`); stale tenant → unavailable, not gap; endpoints of another partner never read; runs in the caller's system context, read-only.
- [ ] **Step 2:** implement. **Step 3:** PASS. Commit.

### Task 2.5: Web — vendor row + reason copy (Sonnet-eligible)

- [ ] **Step 1: failing tests:** `SecurityAgentsTab` lists "Bitdefender GravityZone" with its toggle disabled (`enableable: false`, `data-testid="security-agent-vendor-bitdefender"`); `securityAgentCoverage.ts` maps `tenant_ambiguous → tenantAmbiguous`, `installer_link_missing → installerLinkMissing`, each with a setup-link label.
- [ ] **Step 2:** implement + `security.json` keys `securityAgentCoverage.reasons.{tenantAmbiguous,installerLinkMissing}` (and setup-link labels) in all 8 locales. Copy: "Organization maps to more than one Bitdefender GravityZone company" / "Bitdefender GravityZone installer link not available yet — run Sync in Integrations". **Step 3:** PASS; web typecheck exit 0. Commit.

### Task 2.6: Real-Postgres partner-wide fan-out

**File:** `__tests__/integration/securityAgentsFramework.integration.test.ts`, modelled on the security-agents W02 integration test. `enableable` and `released` are overridden for the test only (`vi.mock` of the two registries, nothing else mocked); `fetchInstallerMaterial` is never called — material is sealed directly with `sealInstallerMaterial` (synthetic link).

- [ ] **Step 1: failing test:** partner P, orgs A (one tenant, material), B (one tenant, no material), C (two tenants), D (unmapped); one partner-wide `security_agents` link with `bitdefender` enabled; one Windows device per org plus a macOS device in A. Run the compliance + remediation pass. Assert: A's Windows device gets exactly one policy-owned deployment whose command payload carries the material's URL, file name, `/bdparams /silent`, no checksum; A's macOS device `not_applicable: requires_mdm_approval`; B `installer_link_missing`, C `tenant_ambiguous`, D `org_not_mapped`, each with **zero** `software_deployments` rows; partner Q's devices untouched; an org-scoped token for D can SELECT but not write the generated policy.
- [ ] **Step 2:** fix whatever fails (expected: nothing beyond 2.1–2.4). **Step 3:** PASS under the test stack. Commit.

### Task 2.7: W06.2 verification gate

- [ ] Shared, API, web tests for touched files + typechecks (exit 0); integration test + RLS-coverage + partner-wide-write-coverage suites under the test stack; test stack down.
- [ ] One independent review round (Opus): readiness ↔ dispatch agree for every selection kind; no secret read on the readiness path; AI cannot enable; dormancy.
- [ ] PR: `feat(security-agents): Bitdefender GravityZone as a framework vendor, dormant (#8170)`; `Refs #8170`, `Part of #8164`, `Refs #6960` (no closing keyword); settings rule 9 line; AI byte numbers.

---

# W06.3 — Owner lab gate: GravityZone install through Breeze (Todd gate)

**This wave is a gate, not a build.** It runs on the `…/wave-8170-lab` branch, whose only code change flips the dormancy gates; it is merged **only** after the lab legs below are recorded in the PR. Operator: Todd (vendor console, lab VM), with an Opus session driving the stack. Credentials come from the private GravityZone trial recipe; **never** commit or paste them, and keep the trial's company names, ids and hostnames out of the PR (public repo).

### Task 3.1: Flip the gates (on the lab branch)

- [ ] `BUILTIN_PACKAGES.bitdefender.released = true`; security-agents registry `bitdefender.enableable = true`; `SecurityAgentsTab.tsx` `enableable: true`; update the tests that pinned them false. Narrow `installerHostAllowlist`, the silent args, the file-name rule and the detection glob to what the lab observes (Task 3.3). Docs: the EDR framework page (`apps/docs/src/content/docs/features/edr-provider-framework.mdx`) gains an "Installing the GravityZone agent" section (one package per company, Packages API on the key, Windows only, macOS needs MDM).

### Task 3.2: Lab preconditions

- [ ] GravityZone partner trial with one customer company, **exactly one** installation package for it, and an API key with Packages + Network + Companies enabled.
- [ ] A nested Windows lab VM (never a host with an installed Breeze agent), enrolled in a lab Breeze stack running the lab branch (`worktree-stack` skill; tear it down afterwards).
- [ ] A lab org mapped to the trial company.

### Task 3.3: Legs (record each PASS/FAIL with evidence in the PR)

- [ ] **L1 Material.** Connect (or re-test) the connection; the next inventory run sets `installer_fetched_at`, no `installer_fetch_error`. Record the real response field names, the download host, whether the file name carries configuration, and whether the link expires. Fix the fixtures/allowlist/args if they differ.
- [ ] **L2 Direct deployment.** Software → Bitdefender GravityZone Agent → deploy to the VM. Install succeeds; the endpoint appears under the mapped company in the console; on the next inventory Breeze links the `edr_endpoints` row to the device.
- [ ] **L3 Managed policy convergence.** A partner-wide `security_agents` link with GravityZone enabled reaches a second VM (or the first after uninstall): one remediation deployment, install succeeds, the detection glob matches the installed product, the device turns compliant, coverage `covered`, and **no repeat install** over two further compliance cycles.
- [ ] **L4 Not applicable.** A device in an unmapped lab org → `not_applicable: org_not_mapped` with zero deployments; a second package in the company → `multiple_packages` shown on the tenant row and `installer_link_missing` in coverage after the old material ages out (or clear it), zero deployments.
- [ ] **L5 Rotation.** Re-enter the API key → material cleared; the next run refetches; a deployment in between is refused (not dispatched with an old link).
- [ ] **L6 Secrecy.** Force an install failure (e.g. revoke the package between dispatch and run); the stored result shows `[installer]`, not the file name or link; grep the API logs for the link token → no hits.
- [ ] **Stop rule:** any leg needing an agent change, a different package model, or a secret in a script → do not merge; record the finding on #8170 and return to planning.

### Task 3.4: Close out

- [ ] PR: `feat(edr): enable GravityZone agent installs after owner lab (#8170)`, body with the leg table, `Closes #8170`, `Part of #8164`. `complete_wave` after merge.

---

## Decisions surfaced while planning (Gate — Todd)

1. **Spec correction 1 (split `getInstaller` into fetch + pure build; installer link cached encrypted on the tenant).** Options: (a) split — no vendor HTTP at dispatch; (b) keep the spec's single call and run vendor HTTP inside dispatch, accepting a pooled connection held across vendor I/O inside the remediation transaction; (c) move dispatch-time resolution out of the remediation transaction (a larger rework of `softwarePolicyInstallRemediation.ts`). **Recommend (a)**: it is how Huntress/S1 already work (keys stored, decrypted at dispatch) and the quorum agreed.
2. **Three PRs instead of the index's one.** (a) W06.1 framework + GravityZone, W06.2 security-agents hook, W06.3 lab flip; (b) one PR. **Recommend (a)**: the migration and dispatch change get their own review, the hook rides on a proven path, and the lab gate flips a known-dormant system.
3. **Emsisoft installer.** W04's Open Decision 6 recommended "W06 implements `getInstaller` … from `GET /v1/workspaces/{ws}/install`". Options: (a) defer to a follow-up wave of #8164 (adapter-only: `fetchInstallerMaterial` + `buildInstaller`, plus delivery-time handling for its expiring install token), with its own lab leg; (b) build it in W06.1 on fixtures, dormant, lab later; (c) build and lab it in W06. **Recommend (a)**: W06's lab is GravityZone only, and Emsisoft is the first vendor whose link expires, so it is the right wave to design delivery-time expiry (a queued command for an offline device can outlive the token) rather than guessing it now. The W06.1 contract already carries `expiresAt`. If accepted, the orchestrator adds the wave sub-issue. This **amends** the W04 plan's promise; W05 (Sophos) and W07 (Huntress decision) stay untouched.
4. **Linux (and macOS) scope.** **The quorum partly disagreed:** it noted Linux could ride the existing zip + post-install-script path without a Go change. My view: the GravityZone Linux link is a shell installer, not a zip, and a script that downloads it would have to carry the per-company link, i.e. a secret in a script, which #6958 rejects by design (lab gate L5). Options: (a) Windows only; macOS `requires_mdm`, Linux `unsupported`; (b) Linux via a script carrying the link (reverses the #6958 secret rule); (c) Linux via a new agent shell-installer file type (agent release + lab). **Recommend (a)** now, (c) as a follow-up if an MSP asks.
5. **Tenant ambiguity.** (a) Refuse (`tenant_ambiguous`, "map it to one"), no binding UI; (b) add a per-policy or per-catalog tenant binding now. **Recommend (a)**: §4.13 allows it, it never installs into the wrong company, and binding UI is new settings surface (rule 9) with no requester yet.
6. **GravityZone package choice.** (a) Exactly one installation package per company, else `multiple_packages`; (b) a per-tenant "installer package" setting on the mapping row (new column + settings surface). **Recommend (a)** for v1; the error names the remedy, and (b) can follow once an MSP needs two packages per company.
7. **Installer output secrecy.** (a) Scrub server-side when storing results (Task 1.8, no agent change); (b) an agent-side sanitizer (Go change + agent release). **Recommend (a)**; revisit (b) if the lab (L6) shows the name leaks somewhere the server never sees.

## Advisor quorum record

Position formed first (P1–P8: three PRs, fetch/build split, CHECK + status columns, file-name overrides with no Go change, fail-closed dispatch and ambiguity refusal, one-package rule, inline `security_agents` linkage with no new AI tool, Emsisoft deferred). Independent `codex exec` (gpt-6-astra, `xhigh`, read-only, stdin closed): **agreed with all eight**, with qualifications folded in above — EDR package defs had no dormancy flag (→ `released`, Task 1.6) and the web tab has its own `enableable` (→ Task 3.1); a versioned material envelope validated after decrypt (→ 1.2); `installer_fetch_error` must be a controlled code (→ Global Constraints); a `checksum` override with absent ≠ null (→ 1.7); one selection function shared by readiness and dispatch, requiring the org's current partner, an active connection, a non-missing tenant and unexpired material (→ 1.5); `validateVendorUrl` rather than an https check (→ 1.3, 1.7); Emsisoft deferral amends W04's promise (→ Decision 3). New risks it raised and where they landed: secrets in agent error text (→ 1.8, L6, Decision 7), stale material after credential rotation (→ 1.4 clear-on-PATCH), installer failures breaking inventory (→ 1.4 isolation), expiry after queueing (→ Decision 3, 1.5's 1 h margin), false coverage from stale data (→ 2.4), repeated installs if the glob misses (→ L3). **Partial disagreement:** Linux scope (→ Decision 4).

## Self-review notes (for executors)

- **Type consistency:** `EdrInstallerProviderKey`, `EdrInstallerFetchErrorCode`, `InstallerTenantSelection`, `ResolvedInstaller`, `openInstallerMaterial`, `sealInstallerMaterial`, `selectInstallerTenant` / `loadInstallerTenantSelections`, `released`, `orgSource: 'edr_framework'` are defined once (W06.1 / Task 2.1) and used by name.
- **Spec coverage:** §4.13 bullets → CHECK (1.1), `BuiltinProvider` (1.6), dispatch map + ambiguity (1.5, 1.7), `getInstaller` (1.2/1.3, corrected), `installer_secret_encrypted` row-bound helper (1.2, 1.4), exhaustiveness test (1.1, 1.2, 2.1), #6960 enumeration (2.1). §4.9 vendor-returned hosts validated (1.3, 1.7).
- **Not in scope:** Sophos (W05), Huntress/agent signatures (W07), Emsisoft installer (Decision 3), Linux/macOS installs, uninstall, tenant binding UI, the S1/Huntress port (D2).

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/integrations/2026-11-05-edr-provider-framework-w06-installer-dispatch.md`. Recommended execution: **subagent-driven** for W06.1 and W06.2 (cross-task interfaces, customer-machine blast radius, a shipped mistake installs the wrong company's agent); W06.3 is an operator session with Todd.

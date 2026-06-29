# Vulnerability correlation wire-up + per-org config-policy gating

**Date:** 2026-06-29
**Branch:** ToddHebebrand/Vulnerabilities-check

## Problem

BE-16 (PR #1861, live in 0.86.0) ships source sync + a global CVE catalog, but the
correlation step that produces `device_vulnerabilities` (`correlateOrg` /
`correlateOsVulns`) has **no production caller** — only tests invoke it. Verified on US
prod: catalog full (13.3K vulns / 3.4K products / 83K mappings / 4.3K OS facts), but
`device_vulnerabilities = 0`, so the dashboard is empty. Correlation must be wired into a
recurring job.

## Decision (Todd, 2026-06-29)

Gate correlation behind a **config-policy inline feature** (`vulnerability` → `{ enabled }`),
**default disabled** (absent policy = off). Correlation only runs for devices whose
**effective** config enables it. Rationale: correlation fires `vulnerability.critical_detected`
events per CVSS≥9 finding — gating lets us roll out org-by-org instead of flooding all orgs
at once, and matches MSP "vuln mgmt as a paid tier" monetization. Pattern B (inline), per the
configuration-policy skill decision guide: it's a toggle, no standalone table, no shared rules,
no compliance worker.

## Layers

### L1 — Register the `vulnerability` feature type
- [ ] `db/schema/configurationPolicies.ts`: add `'vulnerability'` to `configFeatureTypeEnum`.
- [ ] `services/configFeatureTypes.ts`: add `'vulnerability'` to `CONFIG_FEATURE_TYPES`.
- [ ] `packages/shared/src/validators/index.ts:491`: add `'vulnerability'` to `addFeatureLinkSchema.featureType`.
- [ ] Migration `2026-06-29-vuln-config-feature-type.sql`: idempotent `DO $$ … ALTER TYPE config_feature_type ADD VALUE 'vulnerability'` (pure JSONB → no normalized table, value unused in same migration → tx-safe). Mirrors 0029.
- [ ] Parity tests (`resolution.test.ts`, `policyBaselineDefaults.test.ts`) stay green.

### L2 — Inline settings handling (pure JSONB, like pam/helper/warranty)
- [ ] `configurationPolicy.ts`: export `vulnerabilityInlineSettingsSchema = z.object({ enabled: z.boolean().default(false) }).strict()`.
- [ ] Validate it in `addFeatureLink` + `updateFeatureLink` (mirror pam).
- [ ] `decomposeInlineSettings` / `deleteNormalizedRows`: add `case 'vulnerability':` to the pure-JSONB no-op group.
- [ ] `assembleInlineSettings`: `case 'vulnerability': return null` (settings live on the link).
- [ ] `validateFeaturePolicyExists`: add `vulnerability` to the "no policy table → reject featurePolicyId" branch.

### L3 — Effective-config resolver (featureConfigResolver.ts)
- [ ] `resolveVulnerabilityEnabledForDevice(deviceId): Promise<boolean>` — mirror `resolveSoftwarePolicyForDevice`; winning `vulnerability` link's `inlineSettings.enabled`; **default false**.
- [ ] `resolveAllVulnerabilityEnabledDevices(): Promise<Map<orgId, string[]>>` — global scan mirroring `resolveDeviceIdsForSoftwarePolicy`: feature links (`vulnerability`) on active policies → assignments → candidate device IDs → look up each candidate's orgId → verify each via `resolveVulnerabilityEnabledForDevice` (closest-wins; a closer `enabled:false` overrides org-level `enabled:true`) → group enabled devices by org.

### L4 — Gate correlation (vulnerabilityCorrelation.ts)
- [ ] `correlateOrg(orgId, opts?: { deviceIds?: string[] })`: when `deviceIds` provided, `inArray(softwareInventory.deviceId, …)` on both candidate queries + scope the resolve WHERE to those devices. **Empty array → early-return {0,0}** (must NOT mean "all" — would resolve everything).
- [ ] `correlateOsVulns(orgId, opts?)`: filter `macDevices` by `inArray(devices.id, deviceIds)`; empty → early-return.
- [ ] Omitting `opts` keeps current behavior (all devices) → existing tests green.

### L5 — Recurring + manual correlation job (vulnerabilityJobs.ts)
- [ ] `correlateEnabledOrgs()`: `resolveAllVulnerabilityEnabledDevices()` → per org `correlateOrg(orgId,{deviceIds})` + `correlateOsVulns(orgId,{deviceIds})`; aggregate {orgs, created, resolved}.
- [ ] `VULN_CORRELATE_CRON = '0 13 * * *'` (after SOFA 12:00). Add `'vuln-correlate'` repeatable to `scheduleVulnMaintenanceJobs` + handler in `createVulnMaintenanceWorker`.
- [ ] `enqueueVulnCorrelation()` for manual trigger.

### L6 — Admin manual trigger (routes/vulnerabilities.ts)
- [ ] Add `POST /vulnerabilities/sync/correlate` (platformAdmin + MFA + rate-limit), enqueues `vuln-correlate`. Lets us trigger a run on the droplet for testing.

### L7 — Frontend feature tab (Opus, in-session)
- [ ] `featureTabs/VulnerabilityTab.tsx` (copy PamTab — single `enabled` toggle).
- [ ] `featureTabs/types.ts`: `FeatureType` union + `FEATURE_META`.
- [ ] `ConfigPolicyDetailPage.tsx`: `FEATURE_TYPES`, `featureTabIcons`, `renderFeatureTab`.
- [ ] `VulnerabilityTab.test.tsx`; no-silent-mutations count/glob if needed.

### L8 — AI tool doc + tests
- [ ] `aiToolsConfigPolicy.ts` `manage_policy_feature_link` description: add `vulnerability: { enabled }` shape (generic tool already supports it via the enum).
- [ ] Integration tests: resolver (closest-wins, default-off), gated correlation (deviceIds filter, empty no-op), `correlateEnabledOrgs`.

## Verification gate
- tsc clean; web astro check; vuln integration suite; rls-coverage; site-scope-coverage;
  config-policy parity tests; web tab test. Then live-trigger on US droplet for one enabled org.
</content>

---
status: draft-for-approval
issue: LanternOps/breeze#6960
depends_on: [6958]
related: [3135, 3408, 4620]
decided: "Option A (Todd, 2026-09-24): one generic Security agents config-policy feature that generates a desired-state software policy; not per-vendor feature types"
---

# Security agents config-policy feature (Huntress → SentinelOne → Control D / NextDNS)

Verified against `origin/main` at `04d6cf11c0`. Items I could not confirm in code are marked **(not verified)**.

## 1. Problem / Users & scope

MSPs want to tick "Huntress" in a configuration policy and have every in-scope device get the agent, with the right per-customer keys, kept running, and visibly accounted for. Today they hand-build a software policy that requires the vendor's catalog item.

The pieces mostly exist: built-in Huntress/S1 catalog packages (`builtinDeploymentPackages.ts`), per-org key resolution at dispatch (`edrInstallerResolver.ts`, called from `softwareDeployment.ts`), desired-state install (`softwarePolicyInstallRemediation.ts`), and agent-side vendor detection (`mgmtdetect/signatures.go`). What is missing is the policy surface, a skip path for unmapped orgs, a "running" signal, and Breeze-versus-vendor coverage reconciliation.

**Users.** MSP partner admins and technicians (primary); org-scoped users get read-only coverage for their own org.

**Tenancy default: partner-wide first.** The feature is authored in a partner-wide config policy (`org_id` NULL, `partner_id` set) by default. Writing a partner-wide policy requires `canManagePartnerWidePolicies`. Org tokens can SELECT (read-only) their own partner's shared partner-wide rows through the existing SELECT-only partner read branches (`2026-10-11-000200-software-security-partner-wide-select.sql`, `2026-10-05-110000-config-policy-partner-wide-select.sql`) but cannot write them, and never see another partner's rows; the existing dual-axis RLS enforces both. Fan-out resolves each device's org and that org's vendor mapping at evaluation time.

**In scope:** the feature type, generated software-policy linkage, not-applicable handling, presence monitoring, coverage reconciliation, the UI, and Huntress, SentinelOne, Control D and NextDNS entries.

## 2. Proposed design

### 2.1 Shape: new feature type, generated software policy

- Append `security_agents` to `config_feature_type` (appended to match the migration's `ADD VALUE` order, as `time_sync` and `workload_inventory` were). Do not reuse `security`: that is the AV/scan feature, and `monitoring` vs `monitors` already shows how confusable names bite.
- The link's `inline_settings` holds only non-secret desired state:
  `{ version: 1, agents: [{ vendor: 'huntress' | 'sentinelone' | 'controld' | 'nextdns', enabled: boolean, platforms?: ('windows'|'macos'|'linux')[] }] }`.
  It never holds keys, tokens or provisioning codes.
- **Linked-policy vs inline-settings decision** (`configuration-policy` skill): the link is inline because the user-authored state is a few toggles. The enforcement artifact is a **generated `software_policies` row**, owned on the same axis as the config policy (partner-wide config policy → partner-owned software policy; org config policy → org-owned). No new tenancy shape.
- Generated policy: `mode='allowlist'` with `rules.allowUnknown=true` (only allowlist emits `missing`; `allowUnknown` stops unrelated software becoming `unauthorized`; codex-confirmed against `softwarePolicyService.ts` ~325/422), valid matching rule names, `enforceMode=true`, `remediationOptions.autoInstall=true`, `autoUninstall=false`. One rule per enabled vendor with `catalogId` resolved to the partner's catalog row. Rule normalization drops unknown keys, so the vendor is **not** stored in rule JSON; downstream code derives the vendor from `catalogId` via the registry (or the normalizer is extended in the plan).
- `featurePolicyId` on a `security_agents` link stays **NULL**. SQL-level feature-policy reference ownership/serialization (`2026-07-27-a-feature-policy-reference-ownership.sql`, `2026-08-01-a-serialize-feature-policy-references.sql`) recognizes only registered typed references; the generated policy is found via `software_policies.managed_by_link_id`, not via the link's pointer.
- **Authorization:** enabling a vendor arms auto-install on devices, so the writer must hold the existing install-arming authorization (`devices.execute`, `softwarePolicyAuthorization.ts`) in addition to the config-link write requirements (`devices.write` + MFA, `featureLinks.ts`) and `canManagePartnerWidePolicies` for partner-wide policies.
- Disabling a vendor removes its rule. **Uninstall is never implicit**; an opt-in uninstall action is a later feature.

### 2.2 Resolution trap: `software_policy` is closest-wins, and the generated policy must not compete with it

`resolveDeviceIdsForSoftwarePolicy` (`featureConfigResolver.ts:1054`) includes a device only if its closest-winning `software_policy` link points at that policy. If the generated policy were linked as a `software_policy`, a customer-authored software policy lower in the hierarchy would shadow Huntress enforcement, and the reverse. Security agents must therefore be an **independent resolution dimension**.

- Add `resolveSecurityAgentsLinkForDevice(deviceId)` (closest wins within `security_agents`, same hierarchy walk as the other features) and make `resolveDeviceIdsForSoftwarePolicy` branch on `software_policies.managed_by_link_id IS NOT NULL`. A managed policy's device set comes from the `security_agents` link's assignments plus the security_agents closest-wins check. The software_policy winner is ignored for managed policies.
- Consequence to document: within `security_agents`, a closer link replaces the farther one wholesale. Per-vendor merge is Open Decision 6.
- The device set must be built from **effective inherited-link assignments**, not only the authoring policy's own assignments.
- **Re-resolve at dispatch.** Queued installs today check policy activity/generation, ownership and cached violations, not the current winner (`softwareRemediationWorker.ts` ~767). For managed policies the remediation worker re-runs `resolveSecurityAgentsLinkForDevice` immediately before dispatch, so removing an assignment or adding a closer opt-out link cancels stale queued installs.
- Effective-config resolution and `resolution.ts` surface the security_agents link with its generated policy id.

### 2.3 Layering on software deployment (no duplication)

| Concern | Reused as-is | New in #6960 |
|---|---|---|
| Install dispatch, retries, results | `createPolicyOwnedInstallDeployment` → `createSoftwareDeployment` | none |
| Per-org key substitution | `resolveEdrInstaller` at dispatch | a **readiness preflight** (below) |
| Compliance cycle, remediation, cooldowns | `softwareComplianceWorker`, `softwareRemediationWorker` | managed-policy device resolution (2.2) |
| Catalog entries | `ensureBuiltinPackage` per partner on integration connect | vendor registry referencing them |
| UI list/detail | software policy list | badge + read-only guard |

**Unmapped / unconfigured org ⇒ `not_applicable`, not failed.** Today `resolveHuntress` fails each dispatch with strings such as "Organization not mapped to Huntress"; under the compliance cycle (default install-remediation cooldown 120 minutes, three consecutive attempts) that produces failed deployments per unmapped device. Add `checkInstallerReadiness(provider, orgId)` beside the resolver. It returns `{ ok: true }` or `{ ok: false, reason: <code> }` without decrypting anything, with codes `org_not_mapped`, `integration_inactive`, `org_key_missing`, `account_key_missing`, `platform_unsupported`, `requires_mdm_approval`, `var_missing`. The compliance worker calls it per (device, managed rule) before install-remediation enqueue, and `createPolicyOwnedInstallDeployment` re-checks it as a second line. A not-ready pair writes `not_applicable` plus the reason to `security_agent_device_status` and **creates no deployment**.

Semantics the plan must pin down (codex-confirmed gaps in `softwareComplianceWorker.ts` ~668/792/934): (a) the `missing` violation for a not-ready rule is filtered out of `software_compliance_status.violations` so the device is not reported non-compliant for an agent it cannot receive; (b) attempt counters and cooldowns are per `(policy, device)`, not per vendor, so a not-ready vendor must not increment attempts or start the cooldown for a ready vendor in the same policy; the dispatch-time recheck must run **before** the attempt increment; (c) recovery: when the org gets mapped, the next pass clears `not_applicable` and installs. Readiness is evaluated against the **device's org** and **that org's partner's** integration, never the policy owner's.

### 2.4 Vendor registry

A code-level `securityAgentVendors.ts` registry (not a table):

```
{ key, label, catalogRef,                 // integration_provider or catalog slug
  orgSource: 'edr_mapping' | 'tenant_var',
  requiredVars?: string[],                // e.g. controld_provisioning_code
  platforms: { windows, macos, linux },   // each: 'supported' | 'requires_mdm' | 'unsupported'
  presence: { windowsService?, macProcess?, linuxUnit? } }
```

- **Huntress** — `edr_mapping` (existing `huntress_org_mappings` + `huntress_integrations`). Windows supported. macOS `requires_mdm` (system-extension approval cannot be silent) → `not_applicable: requires_mdm_approval`. Linux unsupported until decided.
- **SentinelOne** — `edr_mapping`. The built-in package is `requiresBinaryUpload`, so the vendor is not enableable until the partner uploads the MSI; the UI says so.
- **Control D / NextDNS** — `tenant_var` (`controld_provisioning_code`, `nextdns_profile_id`) using the catalog entries #6958 delivers.
- Framework providers (Bitdefender, Sophos, …): enumerated from `listEdrProviders().filter(a => a.capabilities.installer !== 'none')`, as the EDR framework spec §4.13 already commits. Not v1.

Required tenant variables missing for a device's org ⇒ `not_applicable: var_missing`, same path.

### 2.5 Secrets and org-specific keys

The feature stores no secret. Huntress account key and org key already live in the integration and mapping tables (account key encrypted, read through `decryptForColumn`, via `tryDecryptColumn`); `edrInstallerResolver.ts` substitutes the single-brace EDR placeholders (`substituteHuntress`/`substituteS1`) at dispatch under system context, and `installerVariables.ts` handles `{{...}}`. DNS enrollment values are non-secret tenant variables by #6958's decision. The `{{var.*}}` path rejects secret variables by design, and this spec keeps that. Open Decision 2 covers future vendors that need a secret per org.

### 2.6 Presence monitoring and alerting

The enforcement signal is the **`service_running` detection rule from #6958** on each vendor's catalog version. A stopped or disabled agent becomes a software-policy violation, which feeds the existing remediation path.

**Gap (codex-confirmed):** software compliance today evaluates installed-software inventory; detection rules run during install (`software_install.go`), not on the periodic cycle. #6958's issue says the agent evaluates `service_running` "on the policy compliance cycle", but that bridge (periodic service state → compliance violations) is not in code. It must be in #6958's delivered scope or added here; Open Decision 9. Alerting on persistent violations reuses software-compliance alerting; **(not verified: confirm a violation raises an alert today, and if not, add it in this feature)**.

`mgmtdetect` is used differently, as the *device-view* input to reconciliation and conflict detection. It sees agents Breeze did not install, and it already carries Huntress and S1 signatures. A monitor template was rejected as the primary mechanism because it neither remediates nor shares state with the policy. See Open Decision 3.

### 2.7 Coverage reconciliation (Breeze ↔ vendor)

A scheduled job (BullMQ, system context, fan-out per partner → per org) builds, per (device, vendor):

- **Device view:** `software_compliance_status` for the managed policy plus `mgmtdetect` presence.
- **Vendor view:** a provider-neutral `VendorEndpointSource`, backed by `huntress_agents` (legacy; has `device_id` and `hostname`), `s1_agents` (legacy S1), and `edr_endpoints` for framework providers. Caveat: Huntress sync drops unmapped vendor orgs and matches hostnames only inside the mapped Breeze org (`huntressSync.ts` ~183/355), so `vendor_only` and cross-org detection cover only what sync retains.

States written to a new table `security_agent_device_status`: `covered`, `gap` (in scope, nothing installed or reported), `vendor_only` (vendor reports an agent no Breeze device matches), `vendor_offline`, `mismatched_org` (see 2.9), `not_applicable(reason)`, `pending`. Gap and mismatch transitions raise alerts. States surface in the EDR summary and the device EDR panel.

### 2.8 Visible-but-managed generated policy

Visible in the software policy list with a **"Managed by config policy"** badge linking to the owning config policy. It is read-only in software UI: PATCH/DELETE on a row with `managed_by_link_id` returns 409 with a pointer to the config policy; the same guard applies to the AI tool's direct policy updater and the manual remediation endpoint (which authorizes uninstall independently of `autoUninstall`), and the `PolicyForm` ownerScope selector is disabled for it. Hidden was rejected: operators would not find why a device is being acted on, and the audit trail (`software_policy_audit`) would reference an invisible row. This matches the issue's recommendation.

### 2.9 Conflict: Huntress already installed with a different org key

Detection already treats the agent as installed, so the managed rule is satisfied and **nothing is redeployed**. That is the right default, because a reinstall would silently move a device between two customers' Huntress organizations. Reconciliation catches it: `huntress_agents` reports the device under a Huntress org other than the one `huntress_org_mappings` maps to the device's Breeze org ⇒ `mismatched_org`, alert, and the technician decides. An explicit "reassign" action is out of scope. For vendors without a vendor-side org field the state cannot be detected and is not claimed.

### 2.10 Platform coverage

Windows is supported for all vendors. macOS: Huntress is `requires_mdm_approval` (shown, not failed); Control D and NextDNS depend on #6958's macOS install args. Linux: `.deb` only, and **(not verified)** whether software-policy auto-reinstall reaches Linux devices; per-platform status comes from the vendor registry, and an unsupported combination yields `not_applicable: platform_unsupported`.

## 3. What #6958 delivers vs what #6960 delivers

| | #6958 (separate PRs) | #6960 (this feature) |
|---|---|---|
| Pre/post-install script execution wired through deployment service and agent, `{{...}}` substitution | ✔ | uses it |
| macOS/Linux install args | ✔ | uses it |
| `service_running` rule type (agent-evaluated, Windows service / launchd / systemd) | ✔ | consumes it for presence |
| Periodic service-state → compliance bridge | Open Decision 9 | Open Decision 9 |
| Control D `ctrld` and NextDNS catalog entries, vars `controld_provisioning_code` / `nextdns_profile_id` | ✔ | registry entries reference them |
| `security_agents` feature type, link validation, resolution | | ✔ |
| Generated managed software policy and the 409 guard | | ✔ |
| Readiness preflight / `not_applicable` | | ✔ |
| Coverage reconciliation job, status table, alerts | | ✔ |
| Web: feature tab, badge, coverage panels | | ✔ |

**Sequencing:** #6958 lands before the DNS-vendor entries of #6960. Huntress (and S1) waves of #6960 do not depend on it, except that Huntress presence monitoring needs `service_running`; until then those waves ship install and reconciliation without the stopped-service violation.

## 4. Tenancy & data model impact

Read `docs/agents/tenancy-rls.md` and `apps/api/migrations/README.md` before implementing.

1. **Enum:** `ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'security_agents'` in **its own migration** (the new value cannot be used in the transaction that adds it); append to the drizzle enum list in the same position.
2. **`software_policies.managed_by_link_id uuid NULL`** → `config_policy_feature_links(id)`, **`ON DELETE CASCADE`**, plus a partial index. CASCADE (not SET NULL) because deleting a config policy cascades its links directly, bypassing link-service cleanup; SET NULL would erase the only managed discriminator and leave an ordinary-looking, still-armed policy. Deleting the generated policy never uninstalls anything (compliance rows cascade; `software_deployments.software_policy_id` is already SET NULL). `software_policies` is an org-cascade table, so the column needs an export classification in `CORE_TENANT_EXPORT_POLICY` (`included`: a row identifier, no secrets). The ownership model (`org_id` XOR `partner_id`, `software_policies_one_owner_chk`, ONE dual-axis policy `software_policies_isolation`) is **unchanged**; it was set by `2026-07-01-software-policies-partner-ownership.sql` and `software_policies` is already in `DUAL_AXIS_TENANT_TABLES` in `rls-coverage.integration.test.ts`. **No new dual-axis table is introduced**, so there is no new `DUAL_AXIS_TENANT_TABLES` entry.
3. **`security_agent_device_status`** (new): `id, org_id NOT NULL, device_id NULL, vendor_endpoint_id NULL, vendor, state, reason_code, detail, policy_id, last_evaluated_at`, with `policy_id` is a FK to `software_policies(id)` `ON DELETE SET NULL` (so deleting a config policy never fails on status rows); unique `(device_id, vendor) WHERE device_id IS NOT NULL` and unique `(org_id, vendor, vendor_endpoint_id) WHERE device_id IS NULL` so `vendor_only` rows (no matched device) are idempotent. `org_id NOT NULL` is justified: it is derived per-device observed state, not a config/policy table (like `edr_endpoints`); the policy side is the dual-axis part. RLS shape 1 (direct `org_id`; add `partner_id NOT NULL` only if the plan wants the `edr_endpoints`-style partner overview index), enabled and forced in the creating migration. Registrations required in the same PR:
   - `CORE_ORG_CASCADE_DELETE_ORDER` (before `devices`; FK child),
   - `orgMergeRegistry.ts`,
   - `CORE_TENANT_EXPORT_POLICY` (all columns; no jsonb or secret columns by design, so no `excludedSensitive`/`excludedOpen` entry; if `detail` is later made jsonb it becomes `excludedOpen`; any key/secret column would be `excludedSensitive`),
   - the device-side lists: **both** device-deletion and org-move registries in `routes/devices/core.ts` and the org-merge/move registry (device-keyed rows),
   - composite FKs referencing `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`.
4. **Config-policy wiring:** register `security_agents` in `CONFIG_FEATURE_TYPES` and the trust-tier classification (`packages/shared/src/constants/configFeatureTypes.ts`; trust tier `execution_gated`, same as `software_policy`, because it installs software with per-org keys), `policyBaselineDefaults.ts` `NOT_ENFORCED`, and add it to `PARTNER_LINKABLE_FEATURE_TYPES` (`apps/api/src/services/configurationPolicy.ts:2953`). `featurePolicyId` is always NULL for this type (the generated policy is found via `software_policies.managed_by_link_id`), so the `validateFeaturePolicyExists` dual-axis branch gains no table; the link route validates `inline_settings` and, for partner-wide policies, that the writer holds `canManagePartnerWidePolicies`. Add the type to `featureTypeParity.test.ts` expectations and the web `featureTabs`.
5. **Evaluation fan-out** for a partner-wide link is by each device's org's partner (as the other partner-wide features do), through the new resolver (2.2).
6. **Write gate:** extend the `partner-wide-write-coverage` contract to the new routes.
7. **Migration slot:** the newest committed migration on main is `2026-12-23-100000-tier1-sweep-indexes.sql`. Names must sort **after** whatever is newest at implementation time (re-check; do not assume the date). Any file that writes rows elects system scope first (`set_config('breeze.scope','system',true)`), and `pnpm db:check-drift` runs afterwards.

## 5. Out of scope

- New vendor integrations (Defender for Endpoint, #4620) and any vendor adapter work (EDR framework waves, #3408 Control D API sync).
- Reselling any vendor.
- Implicit or automatic uninstall.
- Reassigning a device between vendor orgs.
- Linux `.rpm` and MDM-driven macOS system-extension approval.
- Porting Huntress and S1 onto the EDR framework (a later feature per the framework spec).

## 6. Open Decisions

1. **v1 vendor list.** (a) Huntress only. (b) Huntress, then S1, then DNS vendors in waves. (c) All four at once. **Recommend (b):** Huntress proves the whole path; S1 needs the binary-upload precondition; DNS needs #6958.
2. **Secrets for org-specific keys.** (a) Keep keys in integration/mapping tables with `decryptForColumn`; DNS values as non-secret tenant vars. (b) Add secret tenant variables with a deliberate delivery design. (c) Per-link encrypted store. **Recommend (a):** zero new secret surface; revisit only when a vendor appears whose org value cannot live on its integration. The secret-var rejection in install args stays.
3. **Presence monitoring mechanism.** (a) Software-policy `service_running`. (b) Monitor template. (c) `mgmtdetect` only. **Recommend (a)** as the enforcement signal, with `mgmtdetect` as the reconciliation/conflict input; a monitor template has no remediation and duplicates state.
4. **Relation to the EDR provider framework.** (a) #6960 consumes the framework's `installer` capability and resolver dispatch map (framework W06) and keeps its own vendor registry for DNS vendors. (b) Generalise `integrationProvider`/`BuiltinProvider` to cover non-EDR vendors. (c) Separate resolver. **Recommend (a):** DNS clients are not EDR providers; widening the `software_catalog.integration_provider` CHECK to non-EDR keys couples two taxonomies. Until framework W06, `edrInstallerResolver.ts` still falls everything non-Huntress into the S1 branch, so the readiness preflight must be exhaustive over vendors and must not rely on that fall-through.
5. **Persist coverage state or compute on read.** (a) Persisted `security_agent_device_status` (alerts need transitions). (b) Compute on read only. **Recommend (a):** alerts and `not_applicable` reasons need history; (b) cannot raise gap alerts.
6. **Closest-wins granularity within `security_agents`.** (a) Whole-link replace, consistent with every other feature. (b) Per-vendor merge up the hierarchy. **Recommend (a) for v1** and document it; (b) when an MSP asks (a child link that omits Huntress silently drops enforcement, so the UI should warn).
7. **Enabling a vendor whose catalog item or integration is not ready.** (a) Block with a deep link. (b) Allow and show `not_applicable` everywhere. **Recommend (a)** for a missing catalog row and **(b)** for individual unmapped orgs, since that is the multi-customer reality.
8. **Generated-policy resolution mechanism.** (a) Branch in `resolveDeviceIdsForSoftwarePolicy` on `managed_by_link_id` (2.2). (b) Create a hidden auxiliary `software_policy` link. **Recommend (a):** (b) re-introduces the closest-wins shadowing.
9. **`service_running` periodic evaluation.** (a) #6958 owns the periodic agent→compliance bridge. (b) #6960 owns it. (c) Presence via `mgmtdetect` reporting instead. **Recommend (a):** it is the rule's reason to exist and #6958's issue already specifies it; #6960's presence story is blocked on it and must say so.

**Quorum note.** An independent `codex exec` review (gpt-6-astra, xhigh, read-only) produced 12 findings, all code-confirmed and folded in above; no unresolved disagreements. Decision 9 records the one gap (periodic `service_running` evaluation) whose ownership between #6958 and #6960 still needs Todd's call.

## 7. Test & rollout notes

- **Red first, in this order:** (1) unit: readiness preflight reason codes; (2) resolver: managed policy is not shadowed by a lower `software_policy` link, and vice versa; (3) route: 409 on PATCH/DELETE of a managed policy; (4) `PARTNER_LINKABLE_FEATURE_TYPES` and the `canManagePartnerWidePolicies` gate.
- **Integration test against real Postgres proving partner-wide fan-out** (modelled on `softwarePoliciesPartnerRls.integration.test.ts`): one partner, three orgs (mapped with key, mapped without key, unmapped), one partner-wide `security_agents` link. Assert: devices in the mapped org get a policy-owned deployment with the correct substituted keys; the other two orgs get `not_applicable` with the right reason code and **zero** `software_deployments` rows; an org-scoped token can read but not write the partner-owned generated policy; a second partner's devices are untouched.
- Also assert: the managed policy is read-only for the unmapped org's token (SELECT allowed, writes blocked), the AI policy-update tool and manual remediation endpoint refuse managed policies (`aiToolsPolicyPrereqs.ts` ~517, `routes/softwarePolicies.ts` ~1066), and deleting the owning config policy removes the generated policy.
- Cascade/export/merge suites run only under **Integration Tests** (`pnpm test-stack up`; tear down after). A stacked PR needs `gh workflow run CI --ref <branch>`.
- **Not verified end-to-end today:** that the existing software-policy path deploys Huntress with correct keys (stated in the issue). The first implementation wave must prove it in a lab (Windows VM, test Huntress account) before building on it; this is a gate, not an assumption.
- Agent-shipped parts (`service_running`) come from #6958 and need an agent release plus Windows/macOS lab checks.
- Web: `featureTabs/SecurityAgentsTab.tsx` on `FeatureTabShell`; badge in the `software/` list; coverage in `ComplianceDashboard` and the device EDR panel; new locale keys in **all 7 locales**.
- Public-repo hygiene: fixtures use placeholders (`<org-key>`, `<acct-key>`).

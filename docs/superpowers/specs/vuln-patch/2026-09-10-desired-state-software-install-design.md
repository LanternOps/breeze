# Desired-state software install (`autoInstall` remediation)

Status: design drafted 2026-09-10, awaiting review. Not implemented.
Tracking: TBD — register via feature-lifecycle once approved.
Prerequisite for: `device-lifecycle/2026-09-10-hp-warranty-cmsl-design.md`.

## Problem

`software_policies` in `allowlist` mode already means "this is the software that
should be on these machines". The detection half is built and working: for every
allowlist rule with no matching install, `evaluateSoftwareInventory` emits a
`{ type: 'missing', severity: 'high' }` violation and the compliance worker
records it on `software_compliance_status`
(`apps/api/src/services/softwarePolicyService.ts:331-345`).

Nothing ever acts on it. `remediationOptions` carries exactly one verb —
`autoUninstall?: boolean` (`apps/api/src/db/schema/softwarePolicies.ts:66`) —
the compliance worker's remediation branch gates on
`violation.type === 'unauthorized'`
(`apps/api/src/jobs/softwareComplianceWorker.ts:399-402`), and the remediation
worker only ever queues `CommandTypes.SOFTWARE_UNINSTALL`
(`apps/api/src/jobs/softwareRemediationWorker.ts:524`).

So today an allowlist policy tells a technician that required software is
missing on 400 machines and offers no way to fix it. This spec closes that loop.

## Why now, and why not a deployment

`software_deployments` cannot express continuing intent, and this is not a
tuning problem — it is structural:

- `createSoftwareDeployment` materialises the current device IDs into
  `deployment_results` at creation time
  (`apps/api/src/services/softwareDeployment.ts:1076`).
- The scheduler permanently excludes already-dispatched deployments and
  dispatches only the pending result rows that already exist; it never
  re-evaluates the stored target or filter
  (`apps/api/src/jobs/softwareDeploymentScheduler.ts:130,238`).

Consequences, all verified: a device that enrols after creation never gets the
software — even if it enrols *before* the scheduled dispatch time. A device
whose hardware inventory (and therefore manufacturer/OS identity) arrives later
is likewise missed. Editing `targetIds` after dispatch does nothing at all.

Compliance evaluation has the opposite shape. It runs every 15 minutes per
active policy, self-scheduled via `repeat: { every: SCAN_INTERVAL_MS }`
(`softwareComplianceWorker.ts:44,538`), and re-resolves target devices on each
pass. That is the reconciliation loop this feature needs, and it already exists.

## Non-goals

- The `'outdated'` violation type. The schema reserves it
  (`softwarePolicies.ts:48`) but nothing emits it, and version-drift remediation
  is a separate problem from presence. Out of scope; do not partially wire it.
- Replacing `software_deployments` for one-shot, operator-driven installs. Both
  remain. A deployment stays the right model for "push this now to these
  machines"; a policy is the right model for "keep this present".
- Uninstall behaviour. Untouched.

## Design

### 1. `remediationOptions.autoInstall`

Add to `SoftwarePolicyRemediationOptions`
(`apps/api/src/db/schema/softwarePolicies.ts:62-68`):

```ts
autoInstall?: boolean; // opt-in; absent or non-boolean means NOT armed
```

`remediation_options` is already classified `excludedOpen` in
`CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts:430`) because it is
jsonb, so this addition needs **no** export-policy change and **no** migration.

Arming mirrors `autoUninstall` exactly, and deliberately does not share its
flag: a policy that is armed to remove unauthorised software is not thereby
armed to install anything. Both verbs sit behind `enforceMode` and
`mode !== 'audit'`, and each has its own boolean. Extend
`isPolicyArmedForRemediation` (`softwarePolicyService.ts:171-174`) into a
verb-aware check rather than adding a second near-identical helper — the
existing refusal messages at `softwarePolicyService.ts:192,201` must gain an
install variant so a technician is told which verb is unarmed.

### 2. Missing-violation remediation branch

In `softwareComplianceWorker.ts:398-404`, the single remediation gate becomes
two independent gates over the same violation set:

- `unauthorized` + `autoUninstallEnabled` → existing uninstall path, unchanged.
- `missing` + `autoInstallEnabled` → new install path.

Both continue through `shouldQueueAutoRemediation`
(`softwareComplianceWorker.ts:184`) so grace period, cooldown and the
previous-remediation-status checks apply identically. A policy may arm both, one,
or neither; a device may be queued for both in the same pass (removing an
unauthorised app and installing a required one are not in conflict).

`softwareComplianceStatus.remediationStatus` is a single column today. Two verbs
sharing one status field will lie — a successful install alongside a failed
uninstall has no honest single value. Either widen it to a small jsonb
per-verb status or add a second column; **decide this in the plan, do not let
the implementation pick silently.** Recommendation: a second column
(`install_remediation_status`, `last_install_remediation_attempt`) so the
existing uninstall reaper logic and its cooldown reads stay untouched.

That is a migration on `software_compliance_status`, which needs **no**
registration changes — verified: it has no `org_id`, is absent from both
`CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`, and is already
registered in `CORE_DEVICE_CASCADE_DELETE_TABLES`
(`apps/api/src/routes/devices/core.ts:507`).

### 3. Install dispatch, and the `deploymentId` coupling

`dispatchSoftwareInstallToDevice` cannot be called directly: it takes a
`deploymentId`, and after dispatch it writes the command id back onto a
`deployment_results` row (`apps/api/src/services/softwareDeployment.ts:122-160`).
Its whole retry/reconciliation contract — the `sw-install-<deployment>-<device>-<attempt>`
result path and the superseded-attempt rejection in `applySoftwareInstallResult`
— hangs off that row.

**Decision: policy remediation creates a real, policy-owned deployment.** When
the compliance worker queues install remediation for a set of devices, the
remediation worker creates one `software_deployments` row per (policy, org,
batch) with `install_method_id` or `software_version_id` resolved from the
rule's `catalogId`, then dispatches through the existing seam.

Rejected alternative: a new dispatch seam that skips `deployment_results`. It
would need its own result correlation, its own retry accounting and its own
offline-queue reconciliation, duplicating three mechanisms that already work.

This requires marking a deployment as policy-originated so the UI can label it
and so the worker can dedupe. Add a nullable FK column to `software_deployments`:

```sql
software_policy_id uuid REFERENCES software_policies(id) ON DELETE SET NULL
```

**Registration obligations for that column, all mandatory in the same PR:**

- `software_deployments` is in `CORE_ORG_CASCADE_DELETE_ORDER`
  (`tenantCascade.ts:436`), so per the export-policy contract a *new column on an
  already-registered table* breaks `tenant-export-policy.integration.test.ts`.
  Add `software_policy_id` to the `included` list at
  `tenantExportPolicyRegistry.ts:427`.
- The FK references `software_policies`, which is also in the cascade order
  (`tenantCascade.ts:439`). `ON DELETE SET NULL` is required so deleting a policy
  does not abort an org cascade on an FK violation. Note that `software_policies`
  currently sorts *after* `software_deployments` alphabetically — verify the
  child-before-parent property still holds, since `tenantCascade.integration.test.ts`
  asserts FK children precede parents.
- This is not a composite `(x, org_id)` FK, so the `DEFERRABLE INITIALLY IMMEDIATE`
  rule does not apply. Confirm that reading remains true if the FK shape changes.

Note the existing dedup precedent: the uninstall path already dedupes in-flight
work by querying `deviceCommands.payload ->> 'policyId'`
(`softwareRemediationWorker.ts:174-181`). The install path should dedupe on the
deployment row instead — an unfinished policy-owned deployment for the same
(policy, device) means do not queue another.

### 4. Resolving what to install

`SoftwarePolicyRuleDefinition.catalogId` already exists
(`softwarePolicies.ts:28`) and is already used for match narrowing
(`softwarePolicyService.ts:279`). It becomes load-bearing here.

- A rule **without** `catalogId` can be detected as missing but **cannot** be
  auto-installed — there is nothing to install. The worker must skip it and say
  so, not fail silently. Surface this in the policy editor at authoring time:
  arming `autoInstall` on a policy whose rules lack `catalogId` should warn.
- A rule **with** `catalogId` resolves to the catalog item, then to either its
  install method (winget/homebrew) or its version artifact. Reuse the existing
  one-target rule: a deployment sets `software_version_id` XOR `install_method_id`
  (CHECK `software_deployments_one_target_chk`).
- Platform mismatch is already handled downstream —
  `softwareDeployment.ts:410` rejects when `device.osType !== installMethod.platform`
  — but the worker should filter first so a cross-platform policy does not
  generate guaranteed-failing deployments every 15 minutes.

`minVersion` on a rule is a detection input only in this iteration. Installing
to satisfy `minVersion` on already-present software is version drift, which is a
non-goal above.

### 5. Authorization

This is the sharpest edge in the feature. Today:

- Software policy writes are gated by the software policy routes.
- Creating a deployment requires `devices.execute` **plus** MFA
  (`apps/api/src/routes/software.ts:1754`, `requireSoftwareExecute`).

Arming `autoInstall` causes software installation on customer machines. It must
therefore carry authorization **at least as strong as creating a deployment** —
`devices.execute` + `requireMfa()` — on every path that can set it, including
policy create, policy update, and any bulk/import path. A weaker gate on the
policy route would be a privilege-escalation route around the deployment gate.

`aiGuardrails.ts:225` currently describes the arming pair as
`enforceMode` + `remediationOptions.autoUninstall`; it must learn about
`autoInstall`, and the AI tool schemas that expose `remediationOptions`
(`aiToolSchemas.ts:1121,1142,1648`, `aiToolsPolicyPrereqs.ts:360`,
`aiToolsCompliance.ts:464`) must not let an agent arm installation implicitly.
Treat "can the AI arm autoInstall" as an explicit product decision in the plan;
the safe default is no.

### 6. Audit

`software_policy_audit` already carries both axes deliberately so partner and
org admins each see events (`softwarePolicies.ts:120-124`). Install remediation
emits its own action values (`install_queued`, `install_succeeded`,
`install_failed`) rather than reusing the uninstall ones — an audit reader must
never have to infer the verb.

## Risks

- **Install loops.** A policy whose rule never matches what actually gets
  installed (name/vendor mismatch between the catalog item and what the
  installer registers in Add/Remove Programs) will re-detect `missing` every 15
  minutes and reinstall forever. Grace period and cooldown bound the rate but do
  not stop the loop. Mitigation: a per-(policy, device) consecutive-attempt
  counter that gives up and marks the compliance row `remediation_failed` after
  N attempts, with the count visible in the UI. **This is the failure mode most
  likely to reach a customer; do not defer it to a follow-up.**
- **Fleet-wide first run.** Arming `autoInstall` on an existing broad policy
  could queue thousands of installs in one 15-minute pass. The compliance worker
  should cap installs queued per pass per policy, and the UI should show a
  dry-run count ("this will install X on N devices") before arming.
- **Detection rules vs. exit code.** `software_detection.go` already evaluates
  `detection_rules` independently of installer exit code
  (`software.ts:67-71`). Catalog items used by policies should carry detection
  rules, or a "successful" install that the inventory never sees will feed the
  loop above.

## Testing

- Unit: verb-aware arming (armed for uninstall only, install only, both,
  neither); missing-violation branch selection; rule-without-`catalogId` skip;
  platform filter.
- Unit: `shouldQueueAutoRemediation` applied to install decisions — grace,
  cooldown, previous-status.
- Integration (real DB): a partner-owned allowlist policy with `autoInstall`
  armed creates a policy-owned deployment for an eligible device, and does *not*
  create a second one while the first is in flight.
- Integration: org cascade still passes with the new FK — this is the contract
  that has caught this class of mistake 5/5 times.
- Contract: `tenant-export-policy.integration.test.ts` with the new column.
- Regression: arming install does not arm uninstall, and vice versa.

Both integration suites need a live database and run only in the **Integration
Tests** job, so a locally-green branch proves nothing here. Run them explicitly
before opening the PR.

## Wave sketch

1. Schema + arming: `autoInstall`, verb-aware arming helper, authorization gate,
   audit actions. No dispatch yet.
2. Compliance worker: missing-violation branch, per-pass cap, attempt counter.
3. Remediation worker: policy-owned deployment creation + dispatch, dedup,
   `software_policy_id` column and its three registrations.
4. UI: arm/disarm with dry-run count, `catalogId` authoring warning, policy-owned
   deployments labelled as such in the deployment list.
5. AI guardrails + tool schema decisions.

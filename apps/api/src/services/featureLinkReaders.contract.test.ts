import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Files allowed to read config_policy_feature_links DIRECTLY: they edit or
// report a policy's OWN (authored) links. Everything that resolves, delivers,
// or schedules must read config_policy_effective_feature_links (the view) so a
// child policy inherits its parent's links (#5080). Adding a resolver here is a
// design decision, not a fix — see the spec's Resolver sweep section
// (docs/superpowers/specs/config-policy/2026-09-06-config-policy-inheritance-design.md).
//
// The mirror-image failure is just as bad: an *authored* surface that switched
// to the view would show a child's inherited rows as if the tech had authored
// them, and would let a DELETE/UPDATE target a row the child does not own. Each
// entry below records which side of that line it is on.
const DIRECT_READ_ALLOWLIST = new Set([
  // Schema declarations: the table itself plus the FK targets that reference it.
  'db/schema/configurationPolicies.ts',
  'db/schema/backup.ts',
  'db/schema/onedriveHelper.ts',
  // #5289 — config_policy_monitors declares its FK to the link table.
  'db/schema/monitorDefinitions.ts',

  // #5289 — monitors resolve CUMULATIVELY, which is exactly what the effective
  // view cannot express: the view hands back a parent's link only for feature
  // types the child does NOT override, so a child policy with its own monitors
  // link would silently drop every monitor attached to its parent. The resolver
  // therefore reads the AUTHORED links for the policy and its parent and ranks
  // the attachments itself (closest attachment wins, per monitor).
  'services/monitors/monitorResolver.ts',
  // The interval inherits field-level (own explicit interval else parent's).
  // The effective view returns the child's monitors link whenever it exists,
  // hiding the parent's interval. Other feature resolvers still use the view.
  'routes/agents/helpers.ts',
  // #5289 — attachment CRUD and the "which policies attach this monitor" view:
  // the policy's own links, never an inherited projection of them.
  'routes/monitorDefinitions.ts',
  // #5289 — AI-tool mirror of routes/monitorDefinitions.ts above: every read
  // here is either reporting a monitor's own (authored) policy attachments
  // (get_monitor) or the attach/detach path over the same authored rows.
  // None of these resolve a policy's EFFECTIVE monitor set — that's
  // services/monitors/monitorResolver.ts's job — so there is no call site here
  // that should switch to the view.
  'services/aiToolsMonitors.ts',
  // W05d boot-time system sweep: finds partners that still own an unretired
  // legacy source row. It must see AUTHORED links, including the retired
  // `alert_rule` / `monitoring` types the effective view no longer exposes.
  'services/monitors/conversion/retirementSweep.ts',
  // #6371 — the attach/detach read-modify-write shared by the two files above.
  // It rewrites the policy's OWN link (items + its `inheritance`), so it must
  // read that authored row; an inherited projection would write a parent's
  // settings back onto the child.
  'services/monitors/monitorAttachments.ts',

  // #6370 W05c1 — conversion operates on the policy's OWN authored rows: it
  // retires them and re-homes their alerts. The effective view would hand back
  // a PARENT policy's link for a feature the child does not override, and
  // retiring that would silently convert a sibling policy's sources. Preview,
  // equivalence and scope read the same authored set so the preview hash covers
  // exactly what convert will retire.
  'services/monitors/conversion/convert.ts',
  'services/monitors/conversion/equivalence.ts',
  'services/monitors/conversion/loadSources.ts',
  'services/monitors/conversion/previewScope.ts',

  // #6371 W05c2 — the hosted-sweep backlog counts UNRETIRED legacy rows per
  // partner in one raw aggregate. It joins the authored links because that is
  // where a legacy row physically hangs; the effective view would fold a
  // parent's link into every child policy and count the same rows repeatedly.
  'services/monitors/conversion/partnerBacklog.ts',

  // The retirement sweep counts source rows attached to authored links. An
  // effective projection would count a parent's source once for every child.
  'services/monitors/conversion/retirementSweep.ts',

  // Authored link CRUD + listFeatureLinks (the editor's own-links view). This
  // file's own effective-config resolver imports the view instead.
  'services/configurationPolicy.ts',
  // Authored-vs-effective split inside: loadPolicyLocalPatchConfig reads the
  // view, the reference/ownership lookups stay authored. Each query is marked.
  'services/configPolicyPatching.ts',
  // Evidence naming for RCA output only — never decides what a device gets.
  'services/alertCorrelationRca.ts',
  // AI tools operate on a policy's own links (create/update/remove/list).
  'services/aiToolsConfigPolicy.ts',
  'services/aiToolsFleet.ts',
  'services/aiToolsBackup.ts',
  // Approval-digest content pin for the AI tool `manage_policy_feature_link:update`.
  // It pins the CURRENT content of the one authored row the approver evaluated,
  // by primary key. Through the view a single link id maps to the parent AND
  // every child, so the pin must stay on the base table to identify exactly one
  // row; a miss returns TARGET_ABSENT (deny), never "no constraint applies".
  'services/actionIntents/effectDigest.ts',
  // Fleet Designer evidence (W01): reports each policy's AUTHORED watches and
  // rules so the design's `retired` section names rows the policy actually
  // owns — the W03 retire step rewrites that policy's own link. Reading the
  // view would let the designer propose retiring an inherited row the child
  // cannot edit. Never decides what a device gets.
  'services/aiAgents/designEvidence.ts',
  // Fleet Designer drift (W05): compares the approved design against the
  // AUTHORED watches and rules of the policies the apply step itself wrote
  // (and of the policies whose own links the retire step rewrote). Those are
  // exactly the rows rollback can restore, so inherited rows must not appear:
  // through the view a parent's link would read as "extra" drift on a child
  // policy nobody edited. Never decides what a device gets.
  'services/fleetDesign/drift.ts',

  // Standalone-entity delete guards and authored-link editors.
  'routes/updateRingsHelpers.ts',
  'routes/policyManagement/helpers.ts',
  'routes/scripts.ts',
  'routes/backup/profiles.ts',
  'routes/softwareInventory.ts',
  // Partner API exports the AUTHORED form; consumers derive the effective set.
  'routes/partnerApi/configuration.ts',
  'scripts/migrateToConfigPolicies.ts',
]);

const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') walk(p, out);
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

// `config_policy_feature_links_partner_wide_select` is an RLS POLICY name, not
// a table reference — the trailing \b keeps it from matching, and the same goes
// for any other `config_policy_feature_links_*` identifier.
function readsBaseTable(src: string): boolean {
  // Documentation naming a table does not constitute a direct read.
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  return /\bconfigPolicyFeatureLinks\b/.test(code) || /\bconfig_policy_feature_links\b/.test(code);
}

describe('feature-link readers contract', () => {
  it('only allowlisted files read config_policy_feature_links directly', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replace(/\\/g, '/');
      if (readsBaseTable(readFileSync(file, 'utf8')) && !DIRECT_READ_ALLOWLIST.has(rel)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `switch these to configPolicyEffectiveFeatureLinks or add them to the allowlist with a reason:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every allowlist entry still exists (stale entries hide regressions)', () => {
    const missing = [...DIRECT_READ_ALLOWLIST].filter((rel) => {
      try {
        statSync(join(SRC, rel));
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });

  it('every allowlist entry actually reads the base table (stale entries hide regressions)', () => {
    // An entry that no longer touches the table is a standing exemption for a
    // file nobody is watching: the day a resolver is added there it ships
    // silently. Existence alone is not enough — the exemption has to still be
    // earned.
    const inert = [...DIRECT_READ_ALLOWLIST].filter((rel) => {
      try {
        return !readsBaseTable(readFileSync(join(SRC, rel), 'utf8'));
      } catch {
        return false; // absence is the previous test's failure, not this one's
      }
    });
    expect(
      inert,
      `these allowlist entries no longer read config_policy_feature_links — remove them:\n${inert.join('\n')}`,
    ).toEqual([]);
  });

  // Slices a named function's body: from its declaration to the next top-level
  // declaration. Crude but deterministic, and enough to say which table a
  // specific function reads when the file-level checks are too coarse.
  function functionBody(file: string, fn: string): string | null {
    const src = readFileSync(join(SRC, file), 'utf8');
    const start = src.search(new RegExp(`^(export )?(async )?function ${fn}\\b`, 'm'));
    if (start === -1) return null;
    const rest = src.slice(start + 1);
    const nextDecl = rest.search(/^(export )?(async )?(function|const) /m);
    return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
  }

  it('the specific functions that must read the view actually do', () => {
    // Function-granular, because the file-level check below only proves the view
    // is named SOMEWHERE in the file. For a file with several feature-link
    // queries that is not enough: one of them could quietly go back to the
    // authored table and the file-level check would stay green.
    const MUST_USE_VIEW: Array<{ file: string; fn: string }> = [
      { file: 'jobs/patchSchedulerWorker.ts', fn: 'scanAndCreateJobs' },
      { file: 'jobs/backupWorker.ts', fn: 'processCheckSchedules' },
      { file: 'jobs/automationWorker.ts', fn: 'processTriggerConfigPolicySchedule' },
      { file: 'services/configPolicyPatching.ts', fn: 'loadPolicyLocalPatchConfig' },
      { file: 'services/automationRuntime.ts', fn: 'resolveConfigPolicyAutomationContext' },
    ];

    const problems: string[] = [];
    for (const { file, fn } of MUST_USE_VIEW) {
      const body = functionBody(file, fn);
      if (body === null) {
        problems.push(`${file}: function ${fn} no longer exists — re-point this entry`);
        continue;
      }
      if (!/\bconfigPolicyEffectiveFeatureLinks\b/.test(body)) {
        problems.push(`${file}: ${fn} does not read the effective view`);
      }
      if (/\bconfigPolicyFeatureLinks\b/.test(body)) {
        problems.push(`${file}: ${fn} reads the AUTHORED table — a child policy would inherit nothing here`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('authored-only functions inside allowlisted files have NOT switched to the view', () => {
    // The allowlist is file-granular, so a file that legitimately mixes authored
    // and effective reads has a blind spot: switching one of its AUTHORED
    // queries to the view breaks nothing above. Both functions below would
    // misbehave concretely — through the view a parent's link surfaces once per
    // inheriting child, so `backfillMissingPatchSettings` would try to insert
    // the same `feature_link_id` several times, and `buildPatchInventory` would
    // report one authoring policy's broken reference once per child rather than
    // naming the policy that has to be fixed.
    const MUST_STAY_AUTHORED: Array<{ file: string; fn: string }> = [
      { file: 'services/configPolicyPatching.ts', fn: 'backfillMissingPatchSettings' },
      { file: 'services/configPolicyPatching.ts', fn: 'buildPatchInventory' },
    ];

    const problems: string[] = [];
    for (const { file, fn } of MUST_STAY_AUTHORED) {
      const body = functionBody(file, fn);
      if (body === null) {
        problems.push(`${file}: function ${fn} no longer exists — re-classify it or drop this entry`);
        continue;
      }
      if (/\bconfigPolicyEffectiveFeatureLinks\b/.test(body)) {
        problems.push(`${file}: ${fn} reads the EFFECTIVE view but must stay authored`);
      }
      if (!/\bconfigPolicyFeatureLinks\b/.test(body)) {
        problems.push(`${file}: ${fn} no longer reads the authored table at all`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the effective view is actually used by the resolver/delivery layer', () => {
    // Guards against the sweep being "completed" by deleting reads rather than
    // switching them: these are the files the spec names as must-switch.
    const mustUseView = [
      'services/configurationPolicy.ts',
      'services/featureConfigResolver.ts',
      'routes/agents/helpers.ts',
      'routes/remote/helpers.ts',
      'services/deviceLifecyclePolicy.ts',
      'services/helperPermissions.ts',
      // #5511 W02: the warranty hierarchy read moved out of warrantyAlertEvaluator.ts
      // into this shared module (alerting + HP CMSL heartbeat delivery).
      'services/warrantyPolicyResolution.ts',
      'services/configPolicyPatching.ts',
      'jobs/automationWorker.ts',
      'jobs/backupWorker.ts',
      'jobs/patchSchedulerWorker.ts',
      'services/patchJobService.ts',
      'services/automationRuntime.ts',
    ];
    const notUsingView = mustUseView.filter(
      (rel) => !/\bconfigPolicyEffectiveFeatureLinks\b/.test(readFileSync(join(SRC, rel), 'utf8')),
    );
    expect(notUsingView).toEqual([]);
  });
});

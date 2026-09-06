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

  // Standalone-entity delete guards and authored-link editors.
  'routes/updateRingsHelpers.ts',
  'routes/policyManagement/helpers.ts',
  'routes/policyManagement/compliance.ts',
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
  return /\bconfigPolicyFeatureLinks\b/.test(src) || /\bconfig_policy_feature_links\b/.test(src);
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

  it('the effective view is actually used by the resolver/delivery layer', () => {
    // Guards against the sweep being "completed" by deleting reads rather than
    // switching them: these are the files the spec names as must-switch.
    const mustUseView = [
      'services/configurationPolicy.ts',
      'services/featureConfigResolver.ts',
      'routes/agents/helpers.ts',
      'services/configPolicyPatching.ts',
      'jobs/automationWorker.ts',
      'jobs/backupWorker.ts',
      'jobs/patchSchedulerWorker.ts',
      'services/automationRuntime.ts',
    ];
    const notUsingView = mustUseView.filter(
      (rel) => !/\bconfigPolicyEffectiveFeatureLinks\b/.test(readFileSync(join(SRC, rel), 'utf8')),
    );
    expect(notUsingView).toEqual([]);
  });
});

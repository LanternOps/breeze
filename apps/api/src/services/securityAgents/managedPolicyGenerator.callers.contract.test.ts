/**
 * CONTRACT TEST — pins who can reach the security-agents managed-policy
 * generator (#6960 / #8736).
 *
 * managedPolicyGenerator.ts writes partner-axis `software_policies` rows and is
 * allowlisted in BOTH tenancy write-gate contracts
 * (`__tests__/partner-wide-write-coverage.test.ts`,
 * `__tests__/site-ceiling-write-coverage.test.ts`) on the grounds that its
 * callers gate first. Those allowlists only check that the file is listed, so
 * a new caller would silently make their reasons false. This test turns the
 * reasons into assertions:
 *
 *  1. syncManagedSoftwarePolicy is called only from configurationPolicy.ts's
 *     addFeatureLink / updateFeatureLink.
 *  2. repairManagedSoftwarePolicies is called only from the compliance worker
 *     (system context).
 *  3. The set of files that call addFeatureLink / updateFeatureLink is fixed.
 *     The two that can carry a `security_agents` link carry both gates; the
 *     rest are monitor-family callers that pass only `monitors` links.
 *
 * A failure here means: re-verify the new caller gates (or is system-only),
 * update the allowlist reasons in both contracts, then update the sets below.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const API_SRC = resolve(__dirname, '../..');

let cached: Array<{ rel: string; source: string }> | null = null;

function sourceFiles(): Array<{ rel: string; source: string }> {
  if (cached) return cached;
  const out: Array<{ rel: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!full.endsWith('.ts') || full.endsWith('.test.ts') || full.endsWith('.d.ts')) continue;
      out.push({ rel: relative(API_SRC, full), source: readFileSync(full, 'utf8') });
    }
  };
  walk(API_SRC);
  cached = out;
  return out;
}

function filesCalling(pattern: RegExp): string[] {
  return sourceFiles()
    .filter(({ source }) => pattern.test(source))
    .map(({ rel }) => rel)
    .sort();
}

const GENERATOR = 'services/securityAgents/managedPolicyGenerator.ts';

describe('security-agents managed-policy generator callers (#8736)', () => {
  it('syncManagedSoftwarePolicy is reached only through configurationPolicy.ts feature-link writes', () => {
    expect(filesCalling(/\bsyncManagedSoftwarePolicy\s*\(/)).toEqual(
      [GENERATOR, 'services/configurationPolicy.ts'].sort(),
    );
  }, 30_000);

  it('repairManagedSoftwarePolicies is called only from the compliance worker', () => {
    expect(filesCalling(/\brepairManagedSoftwarePolicies\s*\(/)).toEqual(
      [GENERATOR, 'jobs/softwareComplianceWorker.ts'].sort(),
    );
  }, 30_000);

  it('the add/updateFeatureLink caller set is fixed', () => {
    expect(filesCalling(/\b(?:addFeatureLink|updateFeatureLink)\s*\(/)).toEqual(
      [
        'services/configurationPolicy.ts',
        // Can carry a security_agents link — gated (asserted below).
        'routes/configurationPolicies/featureLinks.ts',
        'services/aiToolsConfigPolicy.ts',
        // Monitor family: pass only `monitors` links.
        'modules/mcpInvites/tools/configureDefaults.monitors.ts',
        'routes/monitorDefinitions.ts',
        'services/aiToolsMonitors.ts',
        'services/fleetDesign/monitorAttachments.ts',
        'services/monitors/conversion/convert.ts',
        'services/monitors/conversion/equivalence.ts',
        'services/monitors/conversion/networkChecks.ts',
      ].sort(),
    );
  }, 30_000);

  it('the security_agents-capable callers carry both gates', () => {
    for (const rel of ['routes/configurationPolicies/featureLinks.ts', 'services/aiToolsConfigPolicy.ts']) {
      const source = readFileSync(join(API_SRC, rel), 'utf8');
      expect(source.includes('canMutateOrgWideGovernance'), `${rel} lost its site-ceiling gate`).toBe(true);
      expect(source.includes('canManagePartnerWidePolicies'), `${rel} lost its partner-wide gate`).toBe(true);
    }
  });
});

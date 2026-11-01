import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { SERVICES_DIR, blankComments } from './__testutils__/aiToolScopeScan';

/**
 * #10396 (the #6667 / #7827 / #9529 class): an AI tool that resolves its org
 * as `auth.orgId ?? auth.accessibleOrgIds[0]` silently reads or acts on ONE
 * arbitrary org for a partner login (no `auth.orgId`): whichever customer org
 * sorts first. Reads use `resolveReadableToolOrgScope`, writes
 * `resolveWritableToolOrgId`, device-keyed tools the device's own org.
 *
 * Ratchet over every `services/aiTool*.ts` source: the count of
 * `accessibleOrgIds[0]` reads (comments blanked, so prose does not count) per
 * file must equal the frozen baseline below. A NEW use fails; a REMOVED one
 * also fails until the baseline entry is lowered, so a fixed site cannot
 * silently regress.
 *
 * The non-zero entries are known, unaudited sites (the issue traced only
 * search_agent_logs and manage_patches against a transcript). Shrink them; do
 * not add to them.
 */
const BASELINE: Record<string, number> = {
  // Legitimate: the single-org branch (`accessibleOrgIds.length === 1`).
  'aiToolWriteOrg.ts': 1,
  // Known, unaudited `getOrgId`-style fallbacks.
  'aiToolsAlerts.ts': 1,
  'aiToolsAnalytics.ts': 2,
  'aiToolsAudit.ts': 2,
  'aiToolsBackup.ts': 1,
  'aiToolsBackupVm.ts': 1,
  'aiToolsCisBenchmark.ts': 1,
  'aiToolsCompliance.ts': 3,
  'aiToolsDR.ts': 1,
  'aiToolsDevice.ts': 2,
  'aiToolsDns.ts': 1,
  'aiToolsEventLogs.ts': 1,
  // manage_patches approve/decline/defer/bulk_approve and the org-config
  // tools still use `getOrgId`; list/compliance no longer do (#10396).
  'aiToolsFleet.ts': 1,
  'aiToolsHuntress.ts': 2,
  'aiToolsHyperv.ts': 1,
  'aiToolsMonitoring.ts': 1,
  'aiToolsMssql.ts': 1,
  'aiToolsPam.ts': 1,
  'aiToolsPeripherals.ts': 1,
  'aiToolsSLABackup.ts': 1,
  'aiToolsSecurity.ts': 1,
  'aiToolsVault.ts': 1,
  'aiToolsVulnerability.ts': 1,
};

const FALLBACK = /accessibleOrgIds\s*(?:\?\.|!)?\s*\[\s*0\s*\]/g;

function countFallbacks(src: string): number {
  return blankComments(src).match(FALLBACK)?.length ?? 0;
}

function aiToolSources(): string[] {
  return readdirSync(SERVICES_DIR)
    .filter((name) => /^aiTool.*\.ts$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
    .sort();
}

describe('aiTool* sources never default to accessibleOrgIds[0] (#10396)', () => {
  it('scanner: counts code reads in every spelling and ignores comments', () => {
    expect(countFallbacks('const a = auth.accessibleOrgIds?.[0] ?? null;')).toBe(1);
    expect(countFallbacks('const a = auth.accessibleOrgIds[0];')).toBe(1);
    expect(countFallbacks('const a = auth.accessibleOrgIds![0];')).toBe(1);
    expect(countFallbacks('// never accessibleOrgIds[0]\n/* accessibleOrgIds?.[0] */')).toBe(0);
    expect(countFallbacks('const a = auth.accessibleOrgIds?.[1];')).toBe(0);
  });

  it('the scan finds the AI tool sources (guards a vacuous pass)', () => {
    const files = aiToolSources();
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain('aiToolsAgentLogs.ts');
    expect(files).toContain('aiToolsFleet.ts');
  });

  it('per-file counts match the frozen baseline', () => {
    const actual: Record<string, number> = {};
    for (const file of aiToolSources()) {
      const n = countFallbacks(readFileSync(join(SERVICES_DIR, file), 'utf8'));
      if (n > 0) actual[file] = n;
    }
    const problems: string[] = [];
    for (const file of new Set([...Object.keys(actual), ...Object.keys(BASELINE)])) {
      const got = actual[file] ?? 0;
      const want = BASELINE[file] ?? 0;
      if (got > want) {
        problems.push(`${file}: ${got} accessibleOrgIds[0] read(s), baseline ${want}. Resolve the org with resolveReadableToolOrgScope (reads), resolveWritableToolOrgId (writes) or the device's own org instead.`);
      } else if (got < want) {
        problems.push(`${file}: ${got} accessibleOrgIds[0] read(s), baseline ${want}. Lower the baseline entry to ${got} so the fix cannot regress.`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the two tools traced in #10396 carry no fallback at all', () => {
    const src = readFileSync(join(SERVICES_DIR, 'aiToolsAgentLogs.ts'), 'utf8');
    expect(countFallbacks(src)).toBe(0);
    expect(BASELINE['aiToolsAgentLogs.ts']).toBeUndefined();
  });
});

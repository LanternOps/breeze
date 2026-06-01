import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Contract: every `verifyDeviceAccess` implementation in the AI-tools layer
 * MUST enforce the site axis (not just org). The tool layer is a parallel path
 * to the device-scoped tables; an org-only device gate lets a site-restricted
 * user act on devices in forbidden sites (privilege escalation — incl. the
 * mutating script/remote/filesystem tools). This guards against re-introducing
 * an org-only copy when these files get duplicated (the root cause of the bug
 * class). The site axis is enforced by referencing `canAccessSite` in the body.
 */
const SERVICES_DIR = __dirname;

function verifyDeviceAccessBodies(source: string): string[] {
  const bodies: string[] = [];
  let idx = source.indexOf('function verifyDeviceAccess');
  while (idx !== -1) {
    // A copy is at most ~30 lines; 1000 chars comfortably spans its body.
    bodies.push(source.slice(idx, idx + 1000));
    idx = source.indexOf('function verifyDeviceAccess', idx + 1);
  }
  return bodies;
}

describe('contract: AI-tools verifyDeviceAccess enforces the site axis', () => {
  const files = readdirSync(SERVICES_DIR).filter(
    (f) => /^aiTools.*\.ts$/.test(f) && !f.includes('.test.'),
  );

  it('finds aiTools source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const source = readFileSync(join(SERVICES_DIR, file), 'utf8');
    const bodies = verifyDeviceAccessBodies(source);
    if (bodies.length === 0) continue;
    it(`${file}: every verifyDeviceAccess body references canAccessSite`, () => {
      for (const body of bodies) {
        expect(body).toContain('canAccessSite');
      }
    });
  }
});

/**
 * Contract: the device-touching AI-tool files that do NOT use the shared
 * `verifyDeviceAccess` helper (they query the `devices` table / device-id-keyed
 * tables org-only, or resolve a device indirectly via a VM/snapshot/alert) MUST
 * still enforce the site axis. They do so by routing through the shared
 * site-scope helpers in `aiToolsSiteScope.ts` (`deviceSiteDenied`,
 * `deviceIdSiteDenied`, `resolveSiteAllowedDeviceIds`) or by referencing
 * `canAccessSite` directly. This guards the class of bug where one of these
 * files is edited/duplicated and silently drops site enforcement again.
 *
 * NOTE: this is an explicit per-file allowlist, not a generic static scanner
 * that proves *every* `devices`-table query in the aiTools layer is site-gated.
 * A full scanner (parse each handler, find every `from(devices)` /
 * device-id-keyed read, assert a site gate dominates it) is a larger,
 * AST-level effort and remains a FOLLOW-UP. Until then, newly added
 * device-touching tools must be added to this list in the same PR.
 */
const SITE_GATED_NON_VERIFY_FILES = [
  'aiToolsVault.ts',
  'aiToolsSecurity.ts',
  'aiToolsBackup.ts',
  'aiToolsBackupVm.ts',
  'aiToolsMssql.ts',
  'aiToolsHyperv.ts',
  'aiToolsDevice.ts',
  'aiToolsFleet.ts',
  'aiToolsFleetStatus.ts',
  'aiToolsAgentLogs.ts',
  'aiToolsAlerts.ts',
  'aiToolsBrowser.ts',
];

const SITE_GATE_MARKERS = [
  'deviceSiteDenied',
  'deviceIdSiteDenied',
  'resolveSiteAllowedDeviceIds',
  'canAccessSite',
  'allowedSiteIds',
];

describe('contract: device-touching AI-tool files enforce the site axis', () => {
  for (const file of SITE_GATED_NON_VERIFY_FILES) {
    it(`${file}: references a site-axis gate (helper or canAccessSite)`, () => {
      const source = readFileSync(join(SERVICES_DIR, file), 'utf8');
      const hasGate = SITE_GATE_MARKERS.some((m) => source.includes(m));
      expect(hasGate, `${file} must enforce the site axis via aiToolsSiteScope helpers or canAccessSite`).toBe(true);
    });
  }
});

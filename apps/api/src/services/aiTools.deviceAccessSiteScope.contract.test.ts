import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  aiToolsSources,
  blankComments,
  siteAttributableCallCount,
  siteAttributableTables,
} from './__testutils__/aiToolScopeScan';

/**
 * SCOPE NOTE (2026-09-17 audit §5.1). This file used to carry a second,
 * hand-maintained contract: a per-FILE allowlist (`SITE_GATED_NON_VERIFY_FILES`)
 * asserting only that a listed file MENTIONED a site marker somewhere. Its own
 * header called a real scanner a follow-up. That scanner now exists —
 * `aiToolsSiteScope.contract.test.ts` — and it is strictly stronger on every
 * axis that mattered: per CALL SITE rather than per file, comment-blind,
 * scoped to the enclosing handler window, with device-axis reachability
 * blanking and frozen shrink-only baselines. The allowlist is retired here and
 * what remains below is only what that scanner does NOT subsume:
 *
 *   1. the `verifyDeviceAccess` body contract (a COPY-shaped bug class: the
 *      new suite treats `verifyDeviceAccess` as a marker, so nothing else
 *      checks that the helper itself still enforces the site axis);
 *   2. a retirement-safety check that every file the old allowlist covered is
 *      genuinely reached by the new scanner, plus a named residual for the one
 *      that is not.
 *
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
 * RETIREMENT SAFETY for `SITE_GATED_NON_VERIFY_FILES` (see the scope note).
 *
 * The old allowlist's 25 files are listed here ONCE more, not as an assertion
 * about their contents but to prove the stronger scanner actually reaches them:
 * a file that touches no site-attributable table is invisible to a call-site
 * scan, so retiring a file-level assertion for it would lose coverage rather
 * than upgrade it.
 */
const RETIRED_PER_FILE_ALLOWLIST = [
  'aiToolsVault.ts', 'aiToolsSecurity.ts', 'aiToolsBackup.ts', 'aiToolsBackupVm.ts',
  'aiToolsMssql.ts', 'aiToolsHyperv.ts', 'aiToolsDevice.ts', 'aiToolsFleet.ts',
  'aiToolsFleetStatus.ts', 'aiToolsAgentLogs.ts', 'aiToolsAlerts.ts', 'aiToolsRemote.ts',
  'aiToolsBrowser.ts', 'aiToolsAnalytics.ts', 'aiToolsEventLogs.ts', 'aiToolsPeripherals.ts',
  'aiToolsSentinelOne.ts', 'aiToolsCompliance.ts', 'aiToolsMonitoring.ts', 'aiToolsDns.ts',
  'aiToolsHuntress.ts', 'aiToolsSLABackup.ts', 'aiToolsAudit.ts', 'aiToolsCisBenchmark.ts',
  'aiToolsPam.ts',
] as const;

/**
 * The ONLY previously-listed files that reach no site-attributable table
 * directly, so the call-site scanner says nothing about them. They push their
 * whole read into a shared read model, and the file-level assertion is kept for
 * them — weak, but strictly better than nothing.
 *
 * `aiToolsEventLogs.ts` delegates to `eventLogs/logSearch.ts`, which INTERSECTS
 * caller-supplied `deviceIds`/`siteIds` filters with the resolved allowlists
 * rather than substituting them (audit §3.1 calls this out as exemplary).
 */
const SITE_GATED_DELEGATING_FILES = ['aiToolsEventLogs.ts'] as const;

const SITE_GATE_MARKERS = [
  'deviceSiteDenied',
  'deviceIdSiteDenied',
  'resolveSiteAllowedDeviceIds',
  'canAccessSite',
  'allowedSiteIds',
  'siteScopeCondition',
  'scopeDeviceIdsToCaller',
];

describe('contract: retiring the per-file site allowlist loses no coverage', () => {
  const tables = siteAttributableTables();
  const callCount = (file: string) =>
    siteAttributableCallCount(
      blankComments(readFileSync(join(SERVICES_DIR, file), 'utf8')),
      tables,
    );

  it('every retired file is reached by the call-site scanner, except the named delegators', () => {
    const unreached = RETIRED_PER_FILE_ALLOWLIST.filter((f) => callCount(f) === 0);
    // A NEW name here means that file stopped touching site-attributable tables
    // directly, so `aiToolsSiteScope.contract.test.ts` no longer says anything
    // about it. Either follow the delegate (add it to that suite's
    // CROSS_FILE_GUARDED_DELEGATES) or add it to SITE_GATED_DELEGATING_FILES.
    expect(unreached).toEqual([...SITE_GATED_DELEGATING_FILES]);
  });

  it('the scanner sees the aiTools surface at all', () => {
    // Guards the vacuous pass: if the table model collapsed, every file would
    // report zero calls and the test above would still fail loudly, but this
    // states the expectation directly.
    expect(aiToolsSources().length).toBeGreaterThan(40);
    expect(callCount('aiToolsFleet.ts')).toBeGreaterThan(10);
  });

  for (const file of SITE_GATED_DELEGATING_FILES) {
    it(`${file}: references a site-axis gate (helper or canAccessSite)`, () => {
      const source = blankComments(readFileSync(join(SERVICES_DIR, file), 'utf8'));
      const hasGate = SITE_GATE_MARKERS.some((m) => source.includes(m));
      expect(hasGate, `${file} must enforce the site axis via aiToolsSiteScope helpers or canAccessSite`).toBe(true);
    });
  }
});

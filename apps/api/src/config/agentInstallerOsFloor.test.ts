import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up (same as composeBindMounts.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const WXS_PATH = path.join(REPO_ROOT, 'agent/installer/breeze.wxs');

/**
 * Why this test exists
 * ---------------------
 * Issue #4608 (Option C, decision recorded 2026-09-02): the agent's Go
 * toolchain (agent/go.mod) requires Go 1.22+, which structurally cannot run
 * on Windows 7/8/8.1/Server 2008 R2 through 2012 R2 -- only Windows 10 /
 * Server 2016 and later. Before this fix the MSI only checked bitness
 * (`VersionNT64`), so it would install successfully on a legacy box and the
 * service would then fail at runtime with no useful message. This asserts
 * the MSI has a LaunchCondition that blocks the install up front, with a
 * message identifying the real floor -- so a future edit to breeze.wxs
 * can't silently drop the guard.
 *
 * 2026-09-10 (v0.111.1): the original `VersionNT >= 1000` condition refused
 * every fresh install on Windows 10/11, because Windows Installer reports
 * VersionNT = 603 on all Windows 10+ by design (msiexec.exe is manifested
 * only up to 8.1; Microsoft KB 3202260). The floor is now the presence of
 * HKLM\...\CurrentVersion\CurrentMajorVersionNumber via RegistrySearch, and
 * AppSearch must be scheduled before LaunchConditions. This suite guards
 * both, alongside agent/installer/wxs_test.go in the agent CI job.
 */
describe('agent installer minimum-OS LaunchCondition (#4608)', () => {
  const wxs = readFileSync(WXS_PATH, 'utf8');

  it('blocks install below the Windows 10 / Server 2016 floor via the registry, not VersionNT', () => {
    // VersionNT / WindowsBuild are NOT trustworthy: Windows Installer
    // reports the Windows 8.1 values (603 / 9600) on every Windows 10+
    // install by design (msiexec.exe is manifested only up to 8.1, KB
    // 3202260). First seen as NinjaRMM/Action1 pushes of 0.111.1 refused on
    // Windows 11 24H2 (2026-09-10). CurrentMajorVersionNumber exists only on
    // Windows 10 / Server 2016+, and registry reads bypass the shim.
    const prop = wxs.match(
      /<Property\s+Id="([A-Z_0-9]+)"[^>]*>\s*<RegistrySearch\s+[^>]*Key="SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"[^>]*Name="CurrentMajorVersionNumber"/s,
    )?.[1];
    expect(prop, 'a <Property> wrapping the CurrentMajorVersionNumber RegistrySearch').toBeDefined();
    const launchConditions = [...wxs.matchAll(/<Launch\s+Condition="([^"]*)"/g)].map((m) => m[1]);
    // The Launch condition must read the property the search fills, and
    // `Installed OR` keeps repair/upgrade/uninstall unblocked.
    expect(launchConditions).toContain(`Installed OR ${prop}`);
    for (const cond of launchConditions) {
      expect(cond).not.toMatch(/VersionNT\s*[<>=]/);
      expect(cond).not.toContain('WindowsBuild');
    }
  });

  it('schedules AppSearch before LaunchConditions in both sequences', () => {
    // Default sequence puts AppSearch (400) AFTER LaunchConditions (100), so
    // the registry-backed property would still be empty when evaluated.
    for (const seq of ['InstallUISequence', 'InstallExecuteSequence']) {
      const block = wxs.match(new RegExp(`<${seq}>([\\s\\S]*?)</${seq}>`))?.[1] ?? '';
      expect(block, seq).toMatch(/<AppSearch\s+Before="LaunchConditions"\s*\/>/);
    }
  });

  it('gives a clear message naming the supported floor', () => {
    const match = wxs.match(/<Launch\s+Condition="Installed OR WINDOWS_CURRENT_MAJOR_VERSION"\s+Message="([^"]+)"/);
    expect(match).not.toBeNull();
    const message = match?.[1] ?? '';
    expect(message).toContain('Windows 10');
    expect(message).toContain('Server 2016');
  });

  it('keeps the existing 64-bit-Windows LaunchCondition intact', () => {
    // Regression guard: the new condition must be additive, not a
    // replacement of the pre-existing bitness check.
    expect(wxs).toMatch(/<Launch Condition="VersionNT64" Message="Breeze Agent requires 64-bit Windows\." \/>/);
  });
});

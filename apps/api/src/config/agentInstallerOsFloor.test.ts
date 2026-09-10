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
 */
describe('agent installer minimum-OS LaunchCondition (#4608)', () => {
  const wxs = readFileSync(WXS_PATH, 'utf8');

  it('blocks install below the Windows 10 / Server 2016 floor via the registry, not VersionNT', () => {
    // VersionNT / WindowsBuild are NOT trustworthy: Windows reports a fake
    // 6.3/9600 (VersionNT=603) to any msiexec client process without a
    // Windows 10 supportedOS manifest, and NinjaRMM / Action1 script hosts
    // are such processes. A "VersionNT >= 1000" floor refused a fully
    // patched Windows 11 24H2 box pushed by Ninja (v0.111.1, 2026-09-10).
    // HKLM\...\CurrentVersion\CurrentMajorVersionNumber exists only on
    // Windows 10 / Server 2016+, and registry reads bypass the shim.
    expect(wxs).toMatch(
      /<RegistrySearch[^>]*Key="SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"[^>]*Name="CurrentMajorVersionNumber"/s,
    );
    expect(wxs).toMatch(/<Launch\s+Condition="WINDOWS_CURRENT_MAJOR_VERSION"/);
    const launchConditions = [...wxs.matchAll(/<Launch\s+Condition="([^"]*)"/g)].map((m) => m[1]);
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
      expect(block, seq).toContain('<AppSearch Before="LaunchConditions" />');
    }
  });

  it('gives a clear message naming the supported floor', () => {
    const match = wxs.match(/<Launch\s+Condition="WINDOWS_CURRENT_MAJOR_VERSION"\s+Message="([^"]+)"/);
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

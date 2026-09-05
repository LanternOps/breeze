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

  it('blocks install below the Windows 10 / Server 2016 floor', () => {
    // VersionNT is Windows Installer's OS-version property
    // (major*100+minor). Windows 10 and every Server release from 2016
    // onward report NT 10.0, i.e. VersionNT=1000, so ">= 1000" is exactly
    // the Windows-10/Server-2016 floor.
    expect(wxs).toMatch(/<Launch\s+Condition="VersionNT\s*>=\s*1000"/);
  });

  it('gives a clear message naming the supported floor', () => {
    const match = wxs.match(/<Launch\s+Condition="VersionNT\s*>=\s*1000"\s+Message="([^"]+)"/);
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

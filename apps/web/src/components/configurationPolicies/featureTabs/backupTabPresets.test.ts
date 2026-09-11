import { describe, it, expect } from 'vitest';
import { describeExclusionPattern } from '@breeze/shared';
import {
  createOsPresets,
  createExclusionGroups,
  createWholeMachinePresets,
  LINUX_WHOLE_MACHINE_EXCLUDES,
  WINDOWS_WHOLE_MACHINE_EXCLUDES,
} from './backupTabPresets';

/**
 * Every exclusion glob this UI ships must be accepted by the API-side validator
 * added in #2473.
 *
 * If a preset or suggestion chip were rejected, EVERY policy save that used it
 * would fail with a validation error — the over-strict catastrophe the issue
 * explicitly warns about, triggered by our own defaults.
 *
 * This deliberately iterates the REAL preset modules rather than a hand-copied
 * list. An earlier version of this test copied the patterns by hand and was
 * already out of sync on day one (it missed `*.swp`), which is exactly the kind
 * of drift a "kept in sync by hand" comment never prevents.
 */
describe('shipped backup exclusion presets are valid in the agent dialect (#2473)', () => {
  const presetPatterns = createOsPresets().flatMap((p) => p.excludes);
  const suggestionPatterns = createExclusionGroups().flatMap((g) =>
    g.items.map((i) => i.pattern),
  );
  const wholeMachinePatterns = createWholeMachinePresets().flatMap((p) => p.excludes);
  const shipped = [
    ...new Set([...presetPatterns, ...suggestionPatterns, ...wholeMachinePatterns]),
  ];

  it('finds patterns to check (guards against the presets being emptied)', () => {
    expect(presetPatterns.length).toBeGreaterThan(0);
    expect(suggestionPatterns.length).toBeGreaterThan(0);
  });

  it.each(shipped)('accepts %s', (pattern) => {
    const verdict = describeExclusionPattern(pattern);
    expect(verdict.usable, `${pattern} → ${verdict.message ?? ''}`).toBe(true);
  });
});

describe('createWholeMachinePresets', () => {
  it('backs up the whole root with root-anchored excludes for virtual and volatile trees', () => {
    const presets = createWholeMachinePresets();
    const linux = presets.find((p) => p.id === 'whole-machine-linux')!;
    const windows = presets.find((p) => p.id === 'whole-machine-windows')!;
    expect(linux.paths).toEqual(['/']);
    expect(windows.paths).toEqual(['C:\\']);
    expect(linux.excludes).toBe(LINUX_WHOLE_MACHINE_EXCLUDES);
    expect(windows.excludes).toBe(WINDOWS_WHOLE_MACHINE_EXCLUDES);
    // Every Linux exclude is root-anchored so "/dev/**" cannot swallow ~/dev.
    for (const e of LINUX_WHOLE_MACHINE_EXCLUDES) {
      expect(e.startsWith('/') || e.startsWith('**/')).toBe(true);
    }
    for (const must of ['/proc/**', '/sys/**', '/dev/**', '/run/**', '/tmp/**', '/mnt/**', '/media/**']) {
      expect(LINUX_WHOLE_MACHINE_EXCLUDES).toContain(must);
    }
    for (const must of ['/pagefile.sys', '/hiberfil.sys', '/swapfile.sys', '/$Recycle.Bin/**', '/System Volume Information/**']) {
      expect(WINDOWS_WHOLE_MACHINE_EXCLUDES).toContain(must);
    }
  });

  // #5581: a whole-machine backup must never capture the agent's own
  // live checkpoint-journal (or bare-metal rebuild scratch) state — a
  // journal file GROWS across the very run that is backing it up, which is
  // exactly the "manifest describes stale bytes" failure mode. Defense in
  // depth alongside the agent's own hard-exclude of its resolved journal
  // directory (agent/internal/backup/backup.go, collectBackupFilesFromPaths):
  // this preset-level exclude is what protects a custom (non-whole-machine)
  // path selection that happens to include /var/lib/breeze, and keeps the
  // whole-machine preset itself clean even if an operator inspects the glob
  // list rather than relying on the agent-side guard.
  it('excludes the agent\'s own checkpoint-journal and rebuild-scratch state (#5581)', () => {
    for (const must of ['/var/lib/breeze/backup-journal/**', '/var/lib/breeze/rebuild/**']) {
      expect(LINUX_WHOLE_MACHINE_EXCLUDES).toContain(must);
    }
    expect(WINDOWS_WHOLE_MACHINE_EXCLUDES).toContain('/ProgramData/Breeze/data/backup-journal/**');
  });
});

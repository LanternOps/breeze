// scripts/dev/wt-stack/project.test.ts
import { describe, it, expect } from 'vitest';
import {
  deriveProjectName, legacyBranchProjectName, resolveProject, downCandidates,
  pickExistingProject, assertCaddyPortAvailable, descriptorPath, envStackPath, SHARED_PROJECT,
} from './project';

describe('deriveProjectName (#9864 — keyed on the worktree path, never the branch)', () => {
  it('uses the shared project name when shared=true', () => {
    expect(deriveProjectName({ worktreePath: '/x', shared: true })).toBe(SHARED_PROJECT);
  });

  it('is a readable slug of the worktree directory plus a path hash', () => {
    expect(deriveProjectName({ worktreePath: '/Users/t/wt/Fix_9864' })).toMatch(/^breeze-wt-fix-9864-[a-f0-9]{6}$/);
  });

  it('gives two worktrees with the same directory name different projects', () => {
    const a = deriveProjectName({ worktreePath: '/a/breeze' });
    const b = deriveProjectName({ worktreePath: '/b/breeze' });
    expect(a).not.toBe(b);
  });

  it('ignores trailing slashes so the same worktree always maps to one project', () => {
    expect(deriveProjectName({ worktreePath: '/Users/t/wt-a/' })).toBe(deriveProjectName({ worktreePath: '/Users/t/wt-a' }));
  });

  it('stays within 50 characters for very long directory names', () => {
    const name = deriveProjectName({ worktreePath: '/x/' + 'a'.repeat(80) });
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name).toMatch(/^breeze-wt-a+-[a-f0-9]{6}$/);
  });

  it('falls back to the hash alone when the directory name has no slug characters', () => {
    expect(deriveProjectName({ worktreePath: '/x/___' })).toMatch(/^breeze-wt-[a-f0-9]{6}$/);
  });
});

describe('legacyBranchProjectName (pre-#9864 naming, kept to find older stacks)', () => {
  it('slugs a branch into a breeze-wt- project name', () => {
    expect(legacyBranchProjectName('feat/Quotes_P3')).toBe('breeze-wt-feat-quotes-p3');
  });
  it('truncates very long branch slugs but stays unique via a suffix', () => {
    const name = legacyBranchProjectName('feature/' + 'a'.repeat(80))!;
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name.startsWith('breeze-wt-')).toBe(true);
  });
  it('returns null on a detached HEAD', () => {
    expect(legacyBranchProjectName(undefined)).toBeNull();
  });
});

describe('resolveProject', () => {
  const wt = '/Users/t/wt/fix-x';

  it('uses the project recorded in .breeze-stack.json before deriving one', () => {
    expect(resolveProject({ worktreePath: wt, recordedProject: 'breeze-wt-main' }))
      .toEqual({ project: 'breeze-wt-main', source: 'descriptor' });
  });

  it('derives from the worktree path when nothing is recorded', () => {
    expect(resolveProject({ worktreePath: wt })).toEqual({ project: deriveProjectName({ worktreePath: wt }), source: 'path' });
  });

  it('lets BREEZE_WT_PROJECT override the descriptor', () => {
    expect(resolveProject({ worktreePath: wt, recordedProject: 'breeze-wt-main', override: 'breeze-wt-lab' }))
      .toEqual({ project: 'breeze-wt-lab', source: 'override' });
  });

  it('rejects an override compose would refuse', () => {
    expect(() => resolveProject({ worktreePath: wt, override: 'Bad Name' })).toThrow(/BREEZE_WT_PROJECT/);
  });

  it('--shared always means the shared project', () => {
    expect(resolveProject({ worktreePath: wt, shared: true, recordedProject: 'breeze-wt-main' }))
      .toEqual({ project: SHARED_PROJECT, source: 'shared' });
  });

  it('refuses to act on a recorded shared project without --shared', () => {
    expect(() => resolveProject({ worktreePath: wt, recordedProject: SHARED_PROJECT })).toThrow(/--shared/);
  });
});

describe('downCandidates', () => {
  const wt = '/Users/t/wt/fix-x';

  it('is only the resolved project when a descriptor names it', () => {
    expect(downCandidates({ worktreePath: wt, branch: 'main', recordedProject: 'breeze-wt-main' })).toEqual(['breeze-wt-main']);
  });

  it('is only the override when BREEZE_WT_PROJECT is set', () => {
    expect(downCandidates({ worktreePath: wt, branch: 'main', override: 'breeze-wt-lab' })).toEqual(['breeze-wt-lab']);
  });

  it('without a descriptor, tries the path project then the legacy branch project', () => {
    expect(downCandidates({ worktreePath: wt, branch: 'main' }))
      .toEqual([deriveProjectName({ worktreePath: wt }), 'breeze-wt-main']);
  });

  it('without a descriptor on a detached HEAD, tries only the path project', () => {
    expect(downCandidates({ worktreePath: wt })).toEqual([deriveProjectName({ worktreePath: wt })]);
  });
});

describe('pickExistingProject (#9864 — down must never silently no-op)', () => {
  it('returns the first candidate that exists', () => {
    expect(pickExistingProject(['a', 'b'], (p) => p === 'b', ['b'])).toBe('b');
  });

  it('throws, naming what it looked for and what is running, when none exist', () => {
    expect(() => pickExistingProject(['breeze-wt-abc123'], () => false, ['breeze-wt-main']))
      .toThrow(/breeze-wt-abc123[\s\S]*breeze-wt-main[\s\S]*BREEZE_WT_PROJECT/);
  });
});

describe('assertCaddyPortAvailable (#9864 — no second stack on a pinned port)', () => {
  it('passes when nothing publishes the port', () => {
    expect(() => assertCaddyPortAvailable(8443, 'p', [])).not.toThrow();
  });
  it('passes when only this project publishes it (re-up)', () => {
    expect(() => assertCaddyPortAvailable(8443, 'p', ['p'])).not.toThrow();
  });
  it('throws when another compose project holds it', () => {
    expect(() => assertCaddyPortAvailable(8443, 'p', ['breeze-wt-main']))
      .toThrow(/8443[\s\S]*breeze-wt-main/);
  });
  it('throws when a non-compose container holds it', () => {
    expect(() => assertCaddyPortAvailable(8443, 'p', [''])).toThrow(/8443/);
  });
});

describe('paths', () => {
  it('builds descriptor and env paths under the worktree', () => {
    expect(descriptorPath('/x')).toBe('/x/.breeze-stack.json');
    expect(envStackPath('/x')).toBe('/x/.env.stack');
  });
});

// scripts/dev/wt-stack/down.test.ts
import { describe, it, expect } from 'vitest';
import { downStack, type DownDeps } from './down';
import { deriveProjectName } from './project';

const WT = '/Users/t/wt/fix-x';
const PATH_PROJECT = deriveProjectName({ worktreePath: WT });

function deps(opts: { recorded?: string | null; existing?: string[] } = {}) {
  const calls: string[] = [];
  const existing = opts.existing ?? [];
  const d: DownDeps = {
    readRecordedProject: () => opts.recorded ?? null,
    composeProjectExists: (p) => existing.includes(p),
    listBreezeProjects: () => existing,
    composeDown: (p, rm) => { calls.push(`down:${p}:${rm ? 'rm-volumes' : 'keep-volumes'}`); },
    removeDescriptor: () => { calls.push('removeDescriptor'); },
    log: (m) => { calls.push(`log:${m}`); },
  };
  return { calls, d };
}

describe('downStack (#9864)', () => {
  it('tears down the recorded project even on a detached HEAD, then removes the descriptor', () => {
    const { calls, d } = deps({ recorded: 'breeze-wt-main', existing: ['breeze-wt-main'] });
    expect(downStack({ worktreePath: WT, shared: false, keepVolumes: false }, d)).toBe('breeze-wt-main');
    expect(calls.filter((c) => !c.startsWith('log:'))).toEqual(['down:breeze-wt-main:rm-volumes', 'removeDescriptor']);
  });

  it('keeps the descriptor with --keep-volumes', () => {
    const { calls, d } = deps({ recorded: 'breeze-wt-main', existing: ['breeze-wt-main'] });
    downStack({ worktreePath: WT, shared: false, keepVolumes: true }, d);
    expect(calls.filter((c) => !c.startsWith('log:'))).toEqual(['down:breeze-wt-main:keep-volumes']);
  });

  it('keeps the descriptor when an override targets a different project', () => {
    const { calls, d } = deps({ recorded: 'breeze-wt-main', existing: ['breeze-wt-lab'] });
    downStack({ worktreePath: WT, shared: false, keepVolumes: false, override: 'breeze-wt-lab' }, d);
    expect(calls.filter((c) => !c.startsWith('log:'))).toEqual(['down:breeze-wt-lab:rm-volumes']);
  });

  it('throws before composeDown when no candidate exists', () => {
    const { calls, d } = deps({ recorded: null, existing: ['breeze-wt-other'] });
    expect(() => downStack({ worktreePath: WT, shared: false, keepVolumes: false, branch: 'main' }, d))
      .toThrow(/No compose project found[\s\S]*breeze-wt-other/);
    expect(calls).toEqual([]);
  });

  it('throws when the recorded project no longer exists (no fallback past a descriptor)', () => {
    const { calls, d } = deps({ recorded: 'breeze-wt-main', existing: [PATH_PROJECT] });
    expect(() => downStack({ worktreePath: WT, shared: false, keepVolumes: false }, d)).toThrow(/breeze-wt-main/);
    expect(calls).toEqual([]);
  });

  it('without a descriptor, prefers the path project', () => {
    const { calls, d } = deps({ existing: [PATH_PROJECT, 'breeze-wt-main'] });
    expect(downStack({ worktreePath: WT, shared: false, keepVolumes: false, branch: 'main' }, d)).toBe(PATH_PROJECT);
    expect(calls).not.toContain('removeDescriptor');
  });

  it('without a descriptor, falls back to the legacy branch project and says so', () => {
    const { calls, d } = deps({ existing: ['breeze-wt-main'] });
    expect(downStack({ worktreePath: WT, shared: false, keepVolumes: false, branch: 'main' }, d)).toBe('breeze-wt-main');
    expect(calls.find((c) => c.startsWith('log:'))).toMatch(/pre-#9864 branch-derived/);
  });
});

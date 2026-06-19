// scripts/dev/wt-stack/project.test.ts
import { describe, it, expect } from 'vitest';
import { deriveProjectName, descriptorPath, envStackPath, SHARED_PROJECT } from './project';

describe('deriveProjectName', () => {
  it('uses the shared project name when shared=true', () => {
    expect(deriveProjectName({ worktreePath: '/x', branch: 'feat/a', shared: true })).toBe(SHARED_PROJECT);
  });

  it('slugs a branch into a breeze-wt- project name', () => {
    expect(deriveProjectName({ worktreePath: '/x', branch: 'feat/Quotes_P3' }))
      .toBe('breeze-wt-feat-quotes-p3');
  });

  it('falls back to a path hash when branch is missing or detached', () => {
    const a = deriveProjectName({ worktreePath: '/Users/t/wt-a' });
    const b = deriveProjectName({ worktreePath: '/Users/t/wt-b' });
    expect(a).toMatch(/^breeze-wt-[a-f0-9]{8}$/);
    expect(a).not.toBe(b);
  });

  it('truncates very long branch slugs but stays unique via a suffix', () => {
    const name = deriveProjectName({ worktreePath: '/x', branch: 'feature/' + 'a'.repeat(80) });
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name.startsWith('breeze-wt-')).toBe(true);
  });
});

describe('paths', () => {
  it('builds descriptor and env paths under the worktree', () => {
    expect(descriptorPath('/x')).toBe('/x/.breeze-stack.json');
    expect(envStackPath('/x')).toBe('/x/.env.stack');
  });
});

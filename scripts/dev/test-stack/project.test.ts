import { describe, expect, it } from 'vitest';
import { deriveTestProjectName, stackEnv } from './project';

describe('deriveTestProjectName', () => {
  it('slugs the branch under the breeze-test- prefix', () => {
    expect(deriveTestProjectName({ worktreePath: '/tmp/wt', branch: 'fix/3066-Test_DB' }))
      .toBe('breeze-test-fix-3066-test-db');
  });

  it('truncates over-long branch slugs with a stable suffix', () => {
    const branch = 'feature/extremely-long-branch-name-that-never-ends-anywhere-soon';
    const name = deriveTestProjectName({ worktreePath: '/tmp/wt', branch });
    expect(name.length).toBeLessThanOrEqual(50);
    expect(name).toMatch(/^breeze-test-[a-z0-9-]+-[0-9a-f]{6}$/);
    // Stable: same branch, same name.
    expect(deriveTestProjectName({ worktreePath: '/other', branch })).toBe(name);
  });

  it('falls back to a worktree-path hash on detached HEAD', () => {
    const name = deriveTestProjectName({ worktreePath: '/Users/x/breeze-wt/foo' });
    expect(name).toMatch(/^breeze-test-[0-9a-f]{8}$/);
  });
});

describe('stackEnv', () => {
  it('derives per-project container/network names and ephemeral ports', () => {
    expect(stackEnv('breeze-test-foo')).toEqual({
      BREEZE_TEST_PG_PORT: '0',
      BREEZE_TEST_REDIS_PORT: '0',
      BREEZE_TEST_PG_CONTAINER: 'breeze-test-foo-postgres',
      BREEZE_TEST_REDIS_CONTAINER: 'breeze-test-foo-redis',
      BREEZE_TEST_NETWORK: 'breeze-test-foo-net',
    });
  });
});

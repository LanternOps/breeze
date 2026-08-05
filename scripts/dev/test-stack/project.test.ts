import { describe, expect, it } from 'vitest';
import { deriveTestProjectName, parsePublishedPort, stackEnv } from './project';

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

  it('falls back to the path hash when the branch slugs to empty', () => {
    expect(deriveTestProjectName({ worktreePath: '/Users/x/breeze-wt/foo', branch: '___' }))
      .toBe(deriveTestProjectName({ worktreePath: '/Users/x/breeze-wt/foo' }));
  });
});

describe('parsePublishedPort', () => {
  it('parses the IPv4 form', () => {
    expect(parsePublishedPort('0.0.0.0:54321\n')).toBe(54321);
  });

  it('parses the IPv6 form, including when docker emits it first', () => {
    expect(parsePublishedPort('[::]:54321\n')).toBe(54321);
    expect(parsePublishedPort('[::]:54321\n0.0.0.0:54321\n')).toBe(54321);
  });

  it('tolerates surrounding whitespace/CR', () => {
    expect(parsePublishedPort('\n  0.0.0.0:32791 \r\n')).toBe(32791);
  });

  it('throws on empty or unrecognizable output instead of writing a garbage port', () => {
    expect(() => parsePublishedPort('')).toThrow(/no published port/);
    expect(() => parsePublishedPort('something went wrong')).toThrow(/no published port/);
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

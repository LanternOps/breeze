import { afterEach, describe, expect, it, vi } from 'vitest';

// The factory is exercised against the real fake backend and a stubbed Vercel module:
// loading @vercel/sandbox for real would drag undici/jose into this unit test for nothing.
vi.mock('./vercelSandboxBackend', () => ({
  createVercelSandboxBackend: vi.fn(() => ({ name: 'vercel' })),
}));

import {
  SandboxError,
  __resetSandboxBackendsForTests,
  assertSandboxPath,
  createCappedCollector,
  getSandboxBackend,
  getSandboxBackendByName,
  resolveSandboxBackendName,
} from './sandboxBackend';

describe('SandboxError', () => {
  it('carries a code, a backend and the cause', () => {
    const cause = new Error('boom');
    const err = new SandboxError('quota', 'vendor said no', { backend: 'vercel', cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SandboxError');
    expect(err.code).toBe('quota');
    expect(err.backend).toBe('vercel');
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('vendor said no');
  });
});

describe('resolveSandboxBackendName', () => {
  it.each([
    [{ AI_WORKSPACE_BACKEND: 'vercel' }, 'vercel'],
    [{ AI_WORKSPACE_BACKEND: ' FAKE ' }, 'fake'],
    [{ NODE_ENV: 'test' }, 'fake'],
    [{ NODE_ENV: 'development' }, 'fake'],
  ])('%o → %s', (env, expected) => {
    expect(resolveSandboxBackendName(env as NodeJS.ProcessEnv)).toBe(expected);
  });

  it('refuses an unset backend in production (never a silent default there)', () => {
    expect(() => resolveSandboxBackendName({ NODE_ENV: 'production' } as NodeJS.ProcessEnv))
      .toThrow(SandboxError);
  });

  it('refuses an unknown backend name', () => {
    expect(() => resolveSandboxBackendName({ AI_WORKSPACE_BACKEND: 'gvisor_pool' } as NodeJS.ProcessEnv))
      .toThrowError(/Unsupported AI_WORKSPACE_BACKEND "gvisor_pool"/);
  });
});

describe('getSandboxBackend / getSandboxBackendByName', () => {
  const original = process.env.AI_WORKSPACE_BACKEND;
  afterEach(() => {
    __resetSandboxBackendsForTests();
    if (original === undefined) delete process.env.AI_WORKSPACE_BACKEND;
    else process.env.AI_WORKSPACE_BACKEND = original;
  });

  it('returns the fake backend for AI_WORKSPACE_BACKEND=fake and memoises it', () => {
    process.env.AI_WORKSPACE_BACKEND = 'fake';
    const a = getSandboxBackend();
    expect(a.name).toBe('fake');
    expect(getSandboxBackend()).toBe(a);
    expect(getSandboxBackendByName('fake')).toBe(a);
  });

  it('dispatches vercel by name and throws create_failed for an unimplemented backend', () => {
    expect(getSandboxBackendByName('vercel').name).toBe('vercel');
    expect(() => getSandboxBackendByName('agentcore')).toThrowError(
      expect.objectContaining({ code: 'create_failed' }),
    );
  });
});

describe('assertSandboxPath', () => {
  it.each([
    ['/work', '/work'],
    ['/work/in/a.txt', '/work/in/a.txt'],
    ['in/a.txt', '/work/in/a.txt'],
    ['/work/out/../in/b', '/work/in/b'],
  ])('%s → %s', (input, expected) => {
    expect(assertSandboxPath(input)).toBe(expected);
  });

  it.each(['/etc/passwd', '/work/../etc/x', '../x', '/workspace/x', '/'])('refuses %s', (bad) => {
    expect(() => assertSandboxPath(bad)).toThrowError(expect.objectContaining({ code: 'invalid_path' }));
  });
});

describe('createCappedCollector', () => {
  it('keeps exactly cap bytes and flags truncation', () => {
    const c = createCappedCollector(5);
    c.push(Buffer.from('abc'));
    expect(c.truncated).toBe(false);
    c.push(Buffer.from('defg'));
    expect(c.buffer().toString()).toBe('abcde');
    expect(c.size).toBe(5);
    expect(c.truncated).toBe(true);
    c.push(Buffer.from('h'));
    expect(c.buffer().toString()).toBe('abcde');
  });
});

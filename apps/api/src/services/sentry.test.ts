import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Mock the Sentry SDK so we can observe how initSentry/captureException/flushSentry
// drive it without making real network calls.
const initMock = vi.fn();
const captureMock = vi.fn();
const flushMock = vi.fn().mockResolvedValue(true);
const setTagMock = vi.fn();
const setUserMock = vi.fn();
const moduleSetTagMock = vi.fn();
const withScopeMock = vi.fn((cb: (scope: unknown) => void) =>
  cb({ setTag: setTagMock, setContext: vi.fn() }),
);

vi.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initMock(...args),
  captureException: (...args: unknown[]) => captureMock(...args),
  flush: (...args: unknown[]) => flushMock(...args),
  withScope: (cb: (scope: unknown) => void) => withScopeMock(cb),
  setUser: (...args: unknown[]) => setUserMock(...args),
  setTag: (...args: unknown[]) => moduleSetTagMock(...args),
}));

const ORIGINAL_ENV = { ...process.env };

describe('sentry service', () => {
  beforeEach(() => {
    vi.resetModules();
    initMock.mockClear();
    captureMock.mockClear();
    flushMock.mockClear();
    setTagMock.mockClear();
    withScopeMock.mockClear();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('tags the release with the running API version, not a stale SENTRY_RELEASE env', async () => {
    // The droplets carry a stale SENTRY_RELEASE (e.g. 0.64.1) that nobody updates
    // on deploy. The release Sentry sees must instead follow the deployed version
    // (APP_VERSION -> API_VERSION -> BREEZE_VERSION) so issues are tagged correctly.
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    process.env.SENTRY_RELEASE = '0.64.1';
    process.env.APP_VERSION = '9.9.9-test';

    const { initSentry } = await import('./sentry');
    initSentry();

    expect(initMock).toHaveBeenCalledTimes(1);
    const initArg = initMock.mock.calls[0]![0] as { release?: string; dsn?: string };
    expect(initArg.release).toBe('9.9.9-test');
    expect(initArg.release).not.toBe('0.64.1');
  });

  it('does not initialize the SDK when no DSN is configured', async () => {
    delete process.env.SENTRY_DSN;
    const { initSentry, isSentryEnabled } = await import('./sentry');
    initSentry();
    expect(initMock).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it('captureException is a no-op until initSentry has run', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureException } = await import('./sentry');

    captureException(new Error('before init'));
    expect(captureMock).not.toHaveBeenCalled();
    // The tag logic lives inside withScope, past the init guard — it must not
    // run (against an undefined scope) before initSentry.
    expect(setTagMock).not.toHaveBeenCalled();

    initSentry();
    captureException(new Error('after init'));
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('tags an RLS-deny (SQLSTATE 42501) error with pg_code + rls_deny so cross-tenant spikes are filterable', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureException } = await import('./sentry');
    initSentry();

    const denial = Object.assign(new Error('permission denied for table devices'), {
      code: '42501',
    });
    captureException(denial);

    expect(setTagMock).toHaveBeenCalledWith('pg_code', '42501');
    expect(setTagMock).toHaveBeenCalledWith('rls_deny', true);
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('unwraps the Drizzle .cause chain to find the SQLSTATE', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureException } = await import('./sentry');
    initSentry();

    // DrizzleQueryError shape: top-level code undefined, real SQLSTATE on .cause.
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('permission denied'), { code: '42501' }),
    });
    captureException(wrapped);

    expect(setTagMock).toHaveBeenCalledWith('pg_code', '42501');
    expect(setTagMock).toHaveBeenCalledWith('rls_deny', true);
  });

  it('tags a non-RLS Postgres error with pg_code only (no rls_deny)', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureException } = await import('./sentry');
    initSentry();

    const conflict = Object.assign(new Error('duplicate key'), { code: '23505' });
    captureException(conflict);

    expect(setTagMock).toHaveBeenCalledWith('pg_code', '23505');
    expect(setTagMock).not.toHaveBeenCalledWith('rls_deny', expect.anything());
    // Tagging must never gate the capture itself.
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a plain non-Postgres error untagged', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureException } = await import('./sentry');
    initSentry();

    captureException(new Error('something unrelated'));

    expect(setTagMock).not.toHaveBeenCalledWith('pg_code', expect.anything());
    expect(setTagMock).not.toHaveBeenCalledWith('rls_deny', expect.anything());
    expect(captureMock).toHaveBeenCalledTimes(1);
  });
});

describe('setSentryRequestContext', () => {
  beforeEach(() => {
    vi.resetModules();
    setUserMock.mockClear();
    moduleSetTagMock.mockClear();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('is a no-op when Sentry is not initialized', async () => {
    // Ensure no DSN so initSentry does NOT mark initialized.
    delete process.env.SENTRY_DSN;
    const { setSentryRequestContext } = await import('./sentry');
    setSentryRequestContext({ userId: 'u-1', scope: 'organization', orgId: 'o-1', partnerId: 'p-1' });
    expect(setUserMock).not.toHaveBeenCalled();
    expect(moduleSetTagMock).not.toHaveBeenCalled();
  });

  it('sets user id + tenant tags when initialized', async () => {
    process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0';
    const { initSentry, setSentryRequestContext } = await import('./sentry');
    initSentry();
    setSentryRequestContext({ userId: 'u-1', scope: 'organization', orgId: 'o-1', partnerId: 'p-1' });
    expect(setUserMock).toHaveBeenCalledWith({ id: 'u-1' });
    expect(moduleSetTagMock).toHaveBeenCalledWith('scope', 'organization');
    expect(moduleSetTagMock).toHaveBeenCalledWith('orgId', 'o-1');
    expect(moduleSetTagMock).toHaveBeenCalledWith('partnerId', 'p-1');
  });

  it('maps null orgId and partnerId to "none"', async () => {
    process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0';
    const { initSentry, setSentryRequestContext } = await import('./sentry');
    initSentry();
    setSentryRequestContext({ userId: 'u-2', scope: 'system', orgId: null, partnerId: null });
    expect(moduleSetTagMock).toHaveBeenCalledWith('orgId', 'none');
    expect(moduleSetTagMock).toHaveBeenCalledWith('partnerId', 'none');
  });
});

describe('scrubEvent', () => {
  it('redacts authorization and cookie headers', async () => {
    const { scrubEvent } = await import('./sentry');
    const out = scrubEvent({
      request: { headers: { authorization: 'Bearer brz_secret', cookie: 'session=abc', 'user-agent': 'x' } },
    } as any);
    expect(out.request.headers.authorization).toBe('[redacted]');
    expect(out.request.headers.cookie).toBe('[redacted]');
    expect(out.request.headers['user-agent']).toBe('x');
  });

  it('redacts password and mfaSecret in extra', async () => {
    const { scrubEvent } = await import('./sentry');
    const out = scrubEvent({ extra: { password: 'p', mfaSecret: 's', orgId: 'o-1' } } as any);
    expect(out.extra.password).toBe('[redacted]');
    expect(out.extra.mfaSecret).toBe('[redacted]');
    expect(out.extra.orgId).toBe('o-1');
  });

  it('redacts extra values starting with brz_', async () => {
    const { scrubEvent } = await import('./sentry');
    const out = scrubEvent({ extra: { apiKey: 'brz_abc123', orgId: 'o-1' } } as any);
    expect(out.extra.apiKey).toBe('[redacted]');
    expect(out.extra.orgId).toBe('o-1');
  });

  it('does not throw on events missing request/headers/extra', async () => {
    const { scrubEvent } = await import('./sentry');
    expect(() => scrubEvent({} as any)).not.toThrow();
    expect(() => scrubEvent({ request: {} } as any)).not.toThrow();
    expect(() => scrubEvent({ request: { headers: {} } } as any)).not.toThrow();
  });
});

describe('sentry bootstrap wiring (index.ts)', () => {
  const indexSource = readFileSync(
    fileURLToPath(new URL('../index.ts', import.meta.url)),
    'utf-8',
  );

  it('actually calls initSentry() during startup', () => {
    // Regression guard: initSentry was defined but never invoked, so every
    // captureException across the codebase silently no-op'd in production.
    expect(indexSource).toMatch(/initSentry\s*\(/);
  });

  it('flushes Sentry on shutdown so buffered events are not lost', () => {
    expect(indexSource).toMatch(/flushSentry\s*\(/);
  });
});

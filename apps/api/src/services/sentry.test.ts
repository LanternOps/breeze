import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Mock the Sentry SDK so we can observe how initSentry/captureException/flushSentry
// drive it without making real network calls.
const initMock = vi.fn();
const captureMock = vi.fn();
const flushMock = vi.fn().mockResolvedValue(true);
const withScopeMock = vi.fn((cb: (scope: unknown) => void) =>
  cb({ setTag: vi.fn(), setContext: vi.fn() }),
);

vi.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initMock(...args),
  captureException: (...args: unknown[]) => captureMock(...args),
  flush: (...args: unknown[]) => flushMock(...args),
  withScope: (cb: (scope: unknown) => void) => withScopeMock(cb),
}));

const ORIGINAL_ENV = { ...process.env };

describe('sentry service', () => {
  beforeEach(() => {
    vi.resetModules();
    initMock.mockClear();
    captureMock.mockClear();
    flushMock.mockClear();
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

    initSentry();
    captureException(new Error('after init'));
    expect(captureMock).toHaveBeenCalledTimes(1);
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

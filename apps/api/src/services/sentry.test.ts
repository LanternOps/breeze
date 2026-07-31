import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';

// Mock the Sentry SDK so we can observe how initSentry/captureException/flushSentry
// drive it without making real network calls.
const initMock = vi.fn();
const captureMock = vi.fn();
const flushMock = vi.fn().mockResolvedValue(true);
const setTagMock = vi.fn();
const setUserMock = vi.fn();
const moduleSetTagMock = vi.fn();
const captureMessageMock = vi.fn();
const setLevelMock = vi.fn();
const setExtrasMock = vi.fn();
const setContextMock = vi.fn();
const withScopeMock = vi.fn((cb: (scope: unknown) => void) =>
  cb({
    setTag: setTagMock,
    setContext: setContextMock,
    setLevel: setLevelMock,
    setExtras: setExtrasMock,
  }),
);

vi.mock('@sentry/node', () => ({
  init: (...args: unknown[]) => initMock(...args),
  captureException: (...args: unknown[]) => captureMock(...args),
  captureMessage: (...args: unknown[]) => captureMessageMock(...args),
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
    captureMessageMock.mockClear();
    setLevelMock.mockClear();
    setExtrasMock.mockClear();
    setContextMock.mockClear();
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

  it('captureMessage drops arbitrary extras and non-allowlisted tags', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureMessage } = await import('./sentry');
    initSentry();

    captureMessage('held a pooled connection', 'warning', { heldMs: 12000 }, {
      dbContextLabel: 'agentWs.heartbeat',
    });

    expect(captureMessageMock).toHaveBeenCalledWith('held a pooled connection');
    expect(setTagMock).not.toHaveBeenCalledWith('dbContextLabel', expect.anything());
    expect(setLevelMock).toHaveBeenCalledWith('warning');
    expect(setExtrasMock).not.toHaveBeenCalled();
  });

  it('captureMessage retains only bounded allowlisted tags', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureMessage } = await import('./sentry');
    initSentry();

    captureMessage('database warning', 'warning', undefined, {
      pg_code: '42501',
      org_id: '00000000-0000-4000-8000-000000000001',
      path: '/quotes/raw-capability',
      route_template: '/quotes/:token',
      partner_id: 'x'.repeat(129),
    });

    expect(setTagMock).toHaveBeenCalledWith('pg_code', '42501');
    expect(setTagMock).toHaveBeenCalledWith(
      'org_id',
      '00000000-0000-4000-8000-000000000001',
    );
    expect(setTagMock).not.toHaveBeenCalledWith('path', expect.anything());
    expect(setTagMock).not.toHaveBeenCalledWith('route_template', expect.anything());
    expect(setTagMock).not.toHaveBeenCalledWith('partner_id', expect.anything());
  });

  // BREEZE-X: the CAS 0-row warning is only self-diagnosing if these two reach
  // Sentry. They are gated TWICE — setCallerTags here, pickAllowedTags in the
  // beforeSend scrubber (see the scrubEvent suite below) — and passing one gate
  // while being dropped by the other is a silent failure.
  it('captureMessage keeps the BREEZE-X cas_label and prior_status tags', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureMessage } = await import('./sentry');
    initSentry();

    captureMessage('Expected-rows write affected 0 rows', 'warning', undefined, {
      cas_label: 'device_commands.ws_result_terminal_cas',
      prior_status: 'failed:server-timeout',
    });

    expect(setTagMock).toHaveBeenCalledWith(
      'cas_label',
      'device_commands.ws_result_terminal_cas',
    );
    expect(setTagMock).toHaveBeenCalledWith('prior_status', 'failed:server-timeout');
  });

  it('captureMessage sets no tags when none are passed (existing callers unaffected)', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureMessage } = await import('./sentry');
    initSentry();

    captureMessage('plain warning');

    expect(captureMessageMock).toHaveBeenCalledWith('plain warning');
    expect(setTagMock).not.toHaveBeenCalled();
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

  it('captureException retains a matched template without reading the raw path', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureException } = await import('./sentry');
    initSentry();

    const c = {
      req: {
        method: 'GET',
        routePath: '/public/quotes/:token',
        get path() {
          throw new Error('raw path must not be read');
        },
        get url() {
          throw new Error('raw URL must not be read');
        },
      },
    } as unknown as Context;

    expect(() => captureException(new Error('failed'), c)).not.toThrow();
    expect(setTagMock).toHaveBeenCalledWith('method', 'GET');
    expect(setTagMock).toHaveBeenCalledWith(
      'route_template',
      '/public/quotes/:token',
    );
    expect(setTagMock).not.toHaveBeenCalledWith('path', expect.anything());
    expect(setContextMock).not.toHaveBeenCalled();
  });

  it('captureException labels wildcard and unavailable route matches as unmatched', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureException } = await import('./sentry');
    initSentry();

    const c = {
      req: { method: 'GET', routePath: '*' },
    } as unknown as Context;
    captureException(new Error('failed'), c);

    expect(setTagMock).toHaveBeenCalledWith('route_template', 'unmatched');
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
    expect(moduleSetTagMock).toHaveBeenCalledWith('user_id', 'u-1');
    expect(moduleSetTagMock).toHaveBeenCalledWith('scope', 'organization');
    expect(moduleSetTagMock).toHaveBeenCalledWith('org_id', 'o-1');
    expect(moduleSetTagMock).toHaveBeenCalledWith('partner_id', 'p-1');
  });

  it('maps null orgId and partnerId to "none"', async () => {
    process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0';
    const { initSentry, setSentryRequestContext } = await import('./sentry');
    initSentry();
    setSentryRequestContext({ userId: 'u-2', scope: 'system', orgId: null, partnerId: null });
    expect(moduleSetTagMock).toHaveBeenCalledWith('org_id', 'none');
    expect(moduleSetTagMock).toHaveBeenCalledWith('partner_id', 'none');
  });
});

describe('scrubEvent', () => {
  it('rebuilds request and telemetry surfaces from allowlisted fields only', async () => {
    const { scrubEvent } = await import('./sentry');
    const out = scrubEvent({
      release: '1.2.3',
      request: {
        method: 'POST',
        url: '/public/quotes/raw-capability',
        path: '/public/quotes/raw-capability',
        query_string: 'token=raw-capability',
        headers: {
          Authorization: 'Bearer raw-capability',
          COOKIE: 'session=raw-capability',
          'user-agent': 'sdk',
        },
        data: { token: 'raw-capability' },
        cookies: { session: 'raw-capability' },
        env: { REMOTE_ADDR: 'raw-capability' },
      },
      transaction: '/public/quotes/raw-capability',
      message: 'raw-capability',
      logentry: { message: 'raw-capability', params: ['raw-capability'] },
      breadcrumbs: [{ message: 'raw-capability', data: { path: 'raw-capability' } }],
      contexts: { trace: { op: 'raw-capability' } },
      extra: {
        password: 'raw-capability',
        harmless: { nested: ['raw-capability'] },
      },
      tags: {
        method: 'POST',
        route_template: '/public/quotes/:token',
        pg_code: '42501',
        rls_deny: true,
        user_id: 'u-1',
        scope: 'organization',
        org_id: 'o-1',
        partner_id: 'p-1',
        cas_label: 'device_commands.ws_result_terminal_cas',
        prior_status: 'failed:server-timeout',
        path: '/public/quotes/raw-capability',
        arbitrary: 'raw-capability',
      },
      exception: {
        values: [{
          type: 'TypeError',
          value: 'raw-capability',
          mechanism: { type: 'raw-capability', data: { token: 'raw-capability' } },
          stacktrace: {
            frames: [{
              function: 'handleQuote',
              module: 'quotesPublic',
              lineno: 42,
              colno: 7,
              in_app: true,
              filename: '/srv/raw-capability.ts',
              abs_path: '/srv/raw-capability.ts',
              context_line: 'throw new Error("raw-capability")',
              pre_context: ['raw-capability'],
              post_context: ['raw-capability'],
              vars: { token: 'raw-capability' },
            }],
          },
        }],
      },
    } as any);

    expect(out.release).toBe('1.2.3');
    expect(out.request).toEqual({ method: 'POST' });
    expect(out.transaction).toBeUndefined();
    expect(out.message).toBeUndefined();
    expect(out.logentry).toBeUndefined();
    expect(out.breadcrumbs).toBeUndefined();
    expect(out.contexts).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.tags).toEqual({
      method: 'POST',
      route_template: '/public/quotes/:token',
      pg_code: '42501',
      rls_deny: true,
      user_id: 'u-1',
      scope: 'organization',
      org_id: 'o-1',
      partner_id: 'p-1',
      // BREEZE-X: must survive the scrubber too, not just setCallerTags.
      cas_label: 'device_commands.ws_result_terminal_cas',
      prior_status: 'failed:server-timeout',
    });
    expect(out.exception).toEqual({
      values: [{
        type: 'TypeError',
        value: '[redacted]',
        stacktrace: {
          frames: [{
            function: 'handleQuote',
            module: 'quotesPublic',
            lineno: 42,
            colno: 7,
            in_app: true,
          }],
        },
      }],
    });
    expect(JSON.stringify(out)).not.toContain('raw-capability');
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

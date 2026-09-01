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

    captureMessage('held a pooled connection', {
      eventCode: 'db_context_held_too_long',
      level: 'warning',
      tags: { dbContextLabel: 'agentWs.heartbeat' },
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

    captureMessage('database warning', {
      eventCode: 'db_contextless_write',
      level: 'warning',
      tags: {
      pg_code: '42501',
      org_id: '00000000-0000-4000-8000-000000000001',
      // #3517: without these the body-limit 413 event arrives contentless —
      // scrubEvent strips message/logentry/extra, so the rule label IS the event.
      body_limit_rule: 'image-upload',
      body_limit_max_size: '5308416',
      path: '/quotes/raw-capability',
      route_template: '/quotes/:token',
      partner_id: 'x'.repeat(129),
      },
    });

    expect(setTagMock).toHaveBeenCalledWith('pg_code', '42501');
    expect(setTagMock).toHaveBeenCalledWith(
      'org_id',
      '00000000-0000-4000-8000-000000000001',
    );
    expect(setTagMock).toHaveBeenCalledWith('body_limit_rule', 'image-upload');
    expect(setTagMock).toHaveBeenCalledWith('body_limit_max_size', '5308416');
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

    captureMessage('Expected-rows write affected 0 rows', {
      eventCode: 'db_write_expecting_rows_zero',
      level: 'warning',
      tags: {
        cas_label: 'device_commands.ws_result_terminal_cas',
        prior_status: 'failed:server-timeout',
      },
    });

    expect(setTagMock).toHaveBeenCalledWith(
      'cas_label',
      'device_commands.ws_result_terminal_cas',
    );
    expect(setTagMock).toHaveBeenCalledWith('prior_status', 'failed:server-timeout');
  });

  // #3022: a CONNECT_TIMEOUT already arrives tagged `pg_code:CONNECT_TIMEOUT`,
  // but that bucket mixes two unrelated failures — a handshake that really
  // failed, and a main thread too busy to run the socket callbacks. These tags
  // split it. Like the BREEZE-X pair above they are gated TWICE (setTag here,
  // pickAllowedTags in the beforeSend scrubber), so both gates are asserted.
  it('captureException tags a Postgres CONNECT_TIMEOUT with its likely cause', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureException, setConnectTimeoutClassifier } = await import('./sentry');
    const { diagnoseConnectTimeout } = await import('./postgresConnectTimeout');
    initSentry();
    setConnectTimeoutClassifier(diagnoseConnectTimeout);

    captureException(Object.assign(new Error('write CONNECT_TIMEOUT db:5432'), {
      code: 'CONNECT_TIMEOUT',
    }));

    expect(setTagMock).toHaveBeenCalledWith('pg_code', 'CONNECT_TIMEOUT');
    // Assert the VALUES, not just that some string arrived. No monitor is
    // started in this suite, so the honest verdict is 'unknown' — and
    // `expect.any(String)` would pass just as happily on a regression that
    // reported a confident 'connectivity' with no evidence behind it.
    expect(setTagMock).toHaveBeenCalledWith('connect_timeout_cause', 'unknown');
    expect(setTagMock).toHaveBeenCalledWith('event_loop_lag_bucket', 'unknown');
    setConnectTimeoutClassifier(null);
  });

  it('captureException leaves non-timeout errors untagged by the #3022 classifier', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureException, setConnectTimeoutClassifier } = await import('./sentry');
    const { diagnoseConnectTimeout } = await import('./postgresConnectTimeout');
    initSentry();
    setConnectTimeoutClassifier(diagnoseConnectTimeout);

    captureException(Object.assign(new Error('duplicate key'), { code: '23505' }));

    expect(setTagMock).toHaveBeenCalledWith('pg_code', '23505');
    expect(setTagMock).not.toHaveBeenCalledWith('connect_timeout_cause', expect.anything());
    expect(setTagMock).not.toHaveBeenCalledWith('event_loop_lag_bucket', expect.anything());
    setConnectTimeoutClassifier(null);
  });

  it('captureException omits the #3022 tags when no classifier is registered', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureException } = await import('./sentry');
    initSentry();

    // The classifier is injected at boot (index.ts). Until then the tags are
    // omitted rather than guessed — an unwired process must not claim a cause.
    captureException(Object.assign(new Error('write CONNECT_TIMEOUT db:5432'), {
      code: 'CONNECT_TIMEOUT',
    }));

    expect(setTagMock).toHaveBeenCalledWith('pg_code', 'CONNECT_TIMEOUT');
    expect(setTagMock).not.toHaveBeenCalledWith('connect_timeout_cause', expect.anything());
  });

  // BREEZE-18: this used to assert that a bare captureMessage set NO tags —
  // which was exactly the defect. `scrubEvent` deletes message/logentry/extra,
  // so a tagless event ships completely empty and Sentry folds every one of
  // them into a single 11k-occurrence issue. The required `eventCode` is now
  // applied by captureMessage itself, so the floor is one tag, never zero.
  it('captureMessage always tags event_code even when the caller passes nothing else', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureMessage } = await import('./sentry');
    initSentry();

    captureMessage('plain warning', { eventCode: 'db_contextless_write' });

    expect(captureMessageMock).toHaveBeenCalledWith('plain warning');
    expect(setTagMock).toHaveBeenCalledWith('event_code', 'db_contextless_write');
    expect(setTagMock).toHaveBeenCalledTimes(1);
    expect(setLevelMock).toHaveBeenCalledWith('warning');
  });

  it('captureMessage will not let a caller tag bag override the call site event code', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureMessage } = await import('./sentry');
    initSentry();

    captureMessage('plain warning', {
      eventCode: 'db_contextless_write',
      // A caller could plausibly reach for the tag name directly; the call
      // site's own code has to win, or two conditions merge back into one
      // untriageable bucket.
      tags: { event_code: 'something_else' },
    });

    expect(setTagMock).toHaveBeenLastCalledWith('event_code', 'db_contextless_write');
  });

  it('captureMessage degrades an unregistered event code to a named sentinel', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry, captureMessage } = await import('./sentry');
    initSentry();

    // Reachable from compiled JS, an `any`-typed test double or an ee/
    // extension, none of which tsc checked. A bogus value must not become an
    // unbounded tag — but it must still leave the event groupable.
    captureMessage('plain warning', {
      eventCode: 'totally-made-up' as never,
    });

    expect(setTagMock).toHaveBeenCalledWith('event_code', 'unregistered_event_code');
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
        connect_timeout_cause: 'event-loop-starvation',
        event_loop_lag_bucket: 'over-10s',
        db_pool_health_verdict: 'pool-degraded',
        event_code: 'db_write_expecting_rows_zero',
        binary_component: 'agent',
        release_asset_name: 'breeze-agent-darwin-arm64',
        manifest_refusal_reason: 'not-distributable',
        release_sync_failure_reason: 'ssrf-blocked',
        release_sync_context: 'stale-volume-fallback',
        worker: 'patchScheduler',
        worker_failure_reason: 'desktop_stop_pending',
        patch_reconcile_stage: 'enqueue_failed',
        patch_reconcile_repeat: '2-4',
        jobId: 'bull-job-918273',
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
      // #3022: same double gate — a CONNECT_TIMEOUT tagged in captureException
      // but dropped here would leave the starvation-vs-connectivity split
      // invisible in Sentry, which is the entire point of adding it.
      connect_timeout_cause: 'event-loop-starvation',
      event_loop_lag_bucket: 'over-10s',
      // #3214: scrubEvent deletes message/logentry/extra from every event, so
      // this tag is the ONLY part of a pool-health capture that reaches Sentry —
      // and it is the field that decides whether the operator restarts the API.
      // Dropped here, the watchdog's alerts arrive as contentless blanks.
      db_pool_health_verdict: 'pool-degraded',
      // BREEZE-18: the tag that makes a captureMessage event groupable at all.
      // captureMessage sets it on every call, so if the scrubber dropped it
      // here EVERY message event would go back to arriving contentless — the
      // 11,466-occurrence single-issue bucket this whole mechanism removes.
      event_code: 'db_write_expecting_rows_zero',
      // BREEZE-1Z: the three tags that make a refused release artifact
      // identifiable. Without them the operator cannot tell the intended
      // unsigned-darwin refusal from a real trust regression.
      binary_component: 'agent',
      release_asset_name: 'breeze-agent-darwin-arm64',
      manifest_refusal_reason: 'not-distributable',
      // #4262: binarySync's SSRF-guard refusals fail OPEN by design, so the
      // Sentry event is the only durable record that one happened. Dropped
      // here, the capture arrives as a contentless blank and an operator
      // cannot tell a guard refusal from an ordinary GitHub outage.
      release_sync_failure_reason: 'ssrf-blocked',
      release_sync_context: 'stale-volume-fallback',
      // #1379/BREEZE-9: attachWorkerObservability sets this on every worker,
      // and the allowlist introduced two days later (a50769487) has discarded
      // it ever since, which is why ~12k held-context events carry an empty
      // `worker`. Dropped here, no worker-attributed triage is possible.
      worker: 'patchScheduler',
      // #3912's tags. Inert until that PR lands, but asserted now so a future
      // edit to ALLOWED_TAG_NAMES cannot quietly un-allowlist them.
      worker_failure_reason: 'desktop_stop_pending',
      patch_reconcile_stage: 'enqueue_failed',
      patch_reconcile_repeat: '2-4',
      // NB: `jobId` was in the input bag and is deliberately absent here — a
      // BullMQ per-job counter is unbounded by construction, so allowlisting it
      // would inflate Sentry's tag index without making anything triageable.
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

describe('scrubTransactionEvent (#3077)', () => {
  beforeEach(() => {
    vi.resetModules();
    initMock.mockClear();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // A transaction event as `requestDataIntegration()` builds it: the SDK copies
  // the request header bag verbatim onto EVERY event type, and only applies its
  // own SENSITIVE_KEY_SNIPPETS deny list on the span-attribute path — so the
  // event body is where a live `brz_` credential rides out.
  const transactionEvent = () => ({
    type: 'transaction',
    release: '1.2.3',
    transaction: 'GET /api/devices/:id',
    request: {
      method: 'GET',
      url: 'https://example.test/api/devices/1?token=raw-capability',
      query_string: 'token=raw-capability',
      headers: {
        'X-API-Key': 'brz_raw-capability',
        Authorization: 'Bearer raw-capability',
        COOKIE: 'session=raw-capability',
        'user-agent': 'sdk',
      },
      data: { token: 'raw-capability' },
      cookies: { session: 'raw-capability' },
    },
    contexts: {
      trace: { trace_id: 'abc123', span_id: 'def456', op: 'http.server' },
      runtime: { name: 'node', version: 'raw-capability' },
      os: { name: 'raw-capability' },
    },
    breadcrumbs: [{ message: 'raw-capability' }],
    extra: { apiKey: 'brz_raw-capability' },
    tags: { method: 'GET', org_id: 'o-1', arbitrary: 'raw-capability' },
    spans: [{ span_id: 'def456', op: 'db.query' }],
  });

  it('strips the api key (and every other header) from a sampled transaction', async () => {
    const { scrubTransactionEvent } = await import('./sentry');
    const out = scrubTransactionEvent(transactionEvent() as any);

    expect(out.request).toEqual({ method: 'GET' });
    expect(out.extra).toBeUndefined();
    expect(out.breadcrumbs).toBeUndefined();
    expect(out.tags).toEqual({ method: 'GET', org_id: 'o-1' });
    expect(JSON.stringify(out)).not.toContain('raw-capability');
    expect(JSON.stringify(out)).not.toContain('brz_');
  });

  it('keeps contexts.trace so the transaction stays a valid event', async () => {
    // Reusing scrubEvent here would delete `contexts` outright and silently
    // disable tracing rather than secure it — a transaction event without
    // contexts.trace is rejected.
    const { scrubTransactionEvent } = await import('./sentry');
    const out = scrubTransactionEvent(transactionEvent() as any);

    expect(out.contexts).toEqual({
      trace: { trace_id: 'abc123', span_id: 'def456', op: 'http.server' },
    });
    expect(out.transaction).toBe('GET /api/devices/:id');
    expect(out.spans).toEqual([{ span_id: 'def456', op: 'db.query' }]);
  });

  it('does not throw on sparse or trace-less events', async () => {
    const { scrubTransactionEvent } = await import('./sentry');
    expect(() => scrubTransactionEvent({} as any)).not.toThrow();
    expect(() => scrubTransactionEvent({ request: {} } as any)).not.toThrow();
    expect(scrubTransactionEvent({ contexts: {} } as any).contexts).toBeUndefined();
  });

  it('is wired as beforeSendTransaction, which beforeSend never covers', async () => {
    process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/2';
    const { initSentry } = await import('./sentry');
    initSentry();

    const initArg = initMock.mock.calls[0]![0] as {
      beforeSend?: (e: unknown) => unknown;
      beforeSendTransaction?: (e: unknown) => unknown;
    };
    expect(typeof initArg.beforeSend).toBe('function');
    expect(typeof initArg.beforeSendTransaction).toBe('function');

    const scrubbed = initArg.beforeSendTransaction!(transactionEvent() as any) as any;
    expect(scrubbed.request).toEqual({ method: 'GET' });
    expect(JSON.stringify(scrubbed)).not.toContain('brz_');
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

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  bodyLimitOnError,
  createGlobalBodyLimitMiddleware,
  resetBodyLimitTelemetry,
  safeContentLength,
} from './bodyLimitGate';
import { requestPathLogger } from './requestPathLogger';

const MB = 1024 * 1024;

interface Capture {
  message: string;
  tags: Record<string, string>;
}

function buildApp() {
  const warnings: string[] = [];
  const captures: Capture[] = [];
  const app = new Hono();
  app.use('*', requestPathLogger(() => undefined));
  app.use(
    '*',
    createGlobalBodyLimitMiddleware({
      warn: (message) => warnings.push(message),
      capture: (message, tags) => captures.push({ message, tags }),
    })
  );
  app.post('/api/v1/quotes/:token/images', (c) => c.json({ reached: true }));
  app.post('/api/v1/devices', (c) => c.json({ reached: true }));
  app.post('/oauth/token', (c) => c.json({ reached: true }));
  return { app, warnings, captures };
}

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

// The Sentry throttle is module state shared by the gate and the route-level
// limits, so it must not leak between cases.
beforeEach(() => resetBodyLimitTelemetry());

describe('createGlobalBodyLimitMiddleware', () => {
  it('logs a bounded rule/size/correlation record on 413 and never the raw path', async () => {
    const { app, warnings, captures } = buildApp();
    const contentLength = MB + 1;

    const response = await app.request('/api/v1/devices?token=secret-capability', {
      method: 'POST',
      headers: { 'Content-Length': String(contentLength), 'X-Request-Id': REQUEST_ID },
      body: 'x'.repeat(contentLength),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Request body too large' });
    expect(warnings).toEqual([
      `[body-limit] rejected method=POST rule=default max_size=${MB} ` +
        `content_length=${contentLength} request_id=${REQUEST_ID}`,
    ]);
    expect(captures).toEqual([
      {
        message: 'Request body limit rejected a request',
        tags: {
          method: 'POST',
          body_limit_rule: 'default',
          body_limit_max_size: String(MB),
        },
      },
    ]);
    const emitted = JSON.stringify({ warnings, captures });
    expect(emitted).not.toContain('/api/v1/devices');
    expect(emitted).not.toContain('secret-capability');
  });

  it('reports the carve-out rule that matched, not just the default', async () => {
    const { app, warnings, captures } = buildApp();
    const oversized = 5 * MB + 64 * 1024 + 1;

    const response = await app.request('/api/v1/quotes/tok-1/images', {
      method: 'POST',
      headers: { 'Content-Length': String(oversized) },
      body: 'x'.repeat(oversized),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Image too large (max 5 MB)' });
    expect(warnings[0]).toContain('rule=image-upload');
    expect(warnings[0]).toContain(`max_size=${5 * MB + 64 * 1024}`);
    expect(captures[0]?.tags.body_limit_rule).toBe('image-upload');
  });

  it('throttles Sentry per rule while console telemetry stays complete', async () => {
    const { app, warnings, captures } = buildApp();
    const contentLength = MB + 1;

    for (let i = 0; i < 3; i += 1) {
      const response = await app.request('/api/v1/devices', {
        method: 'POST',
        headers: { 'Content-Length': String(contentLength) },
        body: 'x'.repeat(contentLength),
      });
      expect(response.status).toBe(413);
    }

    // Self-hosted operators read the console, so every rejection is recorded
    // there; Sentry only needs to learn the condition exists.
    expect(warnings).toHaveLength(3);
    expect(captures).toHaveLength(1);
  });

  it('reports request_id=unknown rather than echoing a forged X-Request-Id', async () => {
    const warnings: string[] = [];
    const app = new Hono();
    // No requestPathLogger mounted, so nothing set the correlation ID. The gate
    // must not fall back to the caller-supplied header.
    app.use('*', createGlobalBodyLimitMiddleware({ warn: (m) => warnings.push(m) }));
    app.post('/api/v1/devices', (c) => c.json({ reached: true }));

    const contentLength = MB + 1;
    const response = await app.request('/api/v1/devices', {
      method: 'POST',
      headers: { 'Content-Length': String(contentLength), 'X-Request-Id': 'not-a-uuid' },
      body: 'x'.repeat(contentLength),
    });

    expect(response.status).toBe(413);
    expect(warnings).toEqual([
      `[body-limit] rejected method=POST rule=default max_size=${MB} ` +
        `content_length=${contentLength} request_id=unknown`,
    ]);
    expect(warnings[0]).not.toContain('not-a-uuid');
  });

  it('reports content_length=unknown for a streamed body with no Content-Length', async () => {
    const { app, warnings } = buildApp();
    const chunk = new Uint8Array(MB + 1);

    const response = await app.request('/api/v1/devices', {
      method: 'POST',
      headers: { 'X-Request-Id': REQUEST_ID },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      // Required by undici for a streaming request body.
      duplex: 'half',
    } as RequestInit);

    expect(response.status).toBe(413);
    expect(warnings).toEqual([
      `[body-limit] rejected method=POST rule=default max_size=${MB} ` +
        `content_length=unknown request_id=${REQUEST_ID}`,
    ]);
  });

  // `Content-Length` is the one caller-controlled value that reaches the log
  // line and (indirectly) an operator's eye, so it gets the same re-validation
  // treatment as `X-Request-Id`. Exercised directly: Hono's gate short-circuits
  // on an unparseable header, so these never reach `onError` over HTTP.
  it('only echoes a Content-Length that is a plain, round-tripping decimal', () => {
    expect(safeContentLength('1048577')).toBe('1048577');
    expect(safeContentLength('0')).toBe('0');

    for (const forged of [
      undefined,
      '',
      '1e9', // exponent notation — parseInt() would read this as 1
      ' 1048577',
      '1048577 ',
      '+1048577',
      '-1',
      '1048577, 5', // duplicate headers joined by the fetch layer
      '1048577\n injected=1',
      '0x100000',
      '1'.repeat(17), // over the 16-digit ceiling
      '9'.repeat(16), // 16 digits but past Number.MAX_SAFE_INTEGER
    ]) {
      expect({ forged, reported: safeContentLength(forged) }).toEqual({
        forged,
        reported: 'unknown',
      });
    }
  });

  it('throttles Sentry per rule, so a second rule is not muted by the first', async () => {
    const { app, warnings, captures } = buildApp();
    const overDefault = MB + 1;
    const overImage = 5 * MB + 64 * 1024 + 1;

    await app.request('/api/v1/devices', {
      method: 'POST',
      headers: { 'Content-Length': String(overDefault) },
      body: 'x'.repeat(overDefault),
    });
    // A different rule inside the same throttle window must still report — a
    // globally-keyed throttle would swallow this one.
    await app.request('/api/v1/quotes/tok-1/images', {
      method: 'POST',
      headers: { 'Content-Length': String(overImage) },
      body: 'x'.repeat(overImage),
    });

    expect(warnings).toHaveLength(2);
    expect(captures.map((c) => c.tags.body_limit_rule)).toEqual(['default', 'image-upload']);
  });

  it('still lets the oidc-provider paths through untouched', async () => {
    const { app, warnings, captures } = buildApp();

    const response = await app.request('/oauth/token', {
      method: 'POST',
      body: 'x'.repeat(MB + 1),
    });

    expect(response.status).toBe(200);
    expect(warnings).toEqual([]);
    expect(captures).toEqual([]);
  });

  it('does not log anything for a request under the limit', async () => {
    const { app, warnings, captures } = buildApp();

    const response = await app.request('/api/v1/devices', {
      method: 'POST',
      headers: { 'X-Request-Id': REQUEST_ID },
      body: 'small',
    });

    expect(response.status).toBe(200);
    expect(warnings).toEqual([]);
    expect(captures).toEqual([]);
  });
});

describe('bodyLimitOnError (route-level limits tighter than the global gate)', () => {
  // #3517 regression: agent log shipping and process samples declare 256KB,
  // which is TIGHTER than the global 1MB default, so the instrumented global
  // gate never answers for them. Before this, their 413s were fully silent on
  // an agent-authenticated path where nobody is watching.
  it('reports the route rule and returns the route message', async () => {
    const warnings: string[] = [];
    const captures: Capture[] = [];
    const maxSize = 256 * 1024;
    const app = new Hono();
    app.use('*', requestPathLogger(() => undefined));
    // The global gate runs first in production and is a no-op here (256KB is
    // well under its 1MB default), exactly as it is for these routes.
    app.use('*', createGlobalBodyLimitMiddleware({ warn: () => {}, capture: () => {} }));
    app.post(
      '/api/v1/agents/:id/logs',
      bodyLimit({
        maxSize,
        onError: bodyLimitOnError('agent-logs', maxSize, 'Log batch too large (max 256KB gzipped)', {
          warn: (m) => warnings.push(m),
          capture: (message, tags) => captures.push({ message, tags }),
        }),
      }),
      (c) => c.json({ reached: true })
    );

    const contentLength = maxSize + 1;
    const response = await app.request('/api/v1/agents/agent-1/logs', {
      method: 'POST',
      headers: { 'Content-Length': String(contentLength), 'X-Request-Id': REQUEST_ID },
      body: 'x'.repeat(contentLength),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Log batch too large (max 256KB gzipped)' });
    expect(warnings).toEqual([
      `[body-limit] rejected method=POST rule=agent-logs max_size=${maxSize} ` +
        `content_length=${contentLength} request_id=${REQUEST_ID}`,
    ]);
    expect(captures[0]?.tags.body_limit_rule).toBe('agent-logs');
    expect(JSON.stringify({ warnings, captures })).not.toContain('/api/v1/agents/agent-1/logs');
  });

  it('still answers 413 when the telemetry sinks throw', async () => {
    const maxSize = 256 * 1024;
    const app = new Hono();
    app.post(
      '/api/v1/agents/:id/logs',
      bodyLimit({
        maxSize,
        onError: bodyLimitOnError('agent-logs', maxSize, 'Log batch too large (max 256KB gzipped)', {
          warn: () => {
            throw new Error('log sink down');
          },
          capture: () => {
            throw new Error('sentry down');
          },
        }),
      }),
      (c) => c.json({ reached: true })
    );

    const contentLength = maxSize + 1;
    const response = await app.request('/api/v1/agents/agent-1/logs', {
      method: 'POST',
      headers: { 'Content-Length': String(contentLength) },
      body: 'x'.repeat(contentLength),
    });

    // A faulting telemetry sink must not escalate a precise 413 into a 500.
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Log batch too large (max 256KB gzipped)' });
  });
});

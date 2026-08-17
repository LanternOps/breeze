import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createGlobalBodyLimitMiddleware } from './bodyLimitGate';
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
        message: 'Global request body limit rejected a request',
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

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { formatZodError, zValidator } from './validation';

describe('zValidator wrapper (issue #2201)', () => {
  const schema = z
    .object({
      name: z.string().min(1, 'Name is required'),
      email: z.string().email('Invalid email'),
    })
    .strict();

  function makeApp() {
    const app = new Hono();
    app.post('/things', zValidator('json', schema), (c) => {
      const body = c.req.valid('json');
      return c.json({ ok: true, name: body.name });
    });
    return app;
  }

  it('returns a readable string-first 400 body with field paths and messages', async () => {
    const app = makeApp();
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: 'not-an-email' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();

    // String-first contract: `error` is a string, never a serialized ZodError.
    expect(typeof body.error).toBe('string');
    expect(body.error).toContain('name: Name is required');
    expect(body.error).toContain('email: Invalid email');
    expect(body.success).toBeUndefined();

    // Structured details for programmatic consumers.
    expect(body.details.fieldErrors).toEqual({
      name: ['Name is required'],
      email: ['Invalid email'],
    });
    expect(body.details.formErrors).toEqual([]);
  });

  it('surfaces unrecognized keys from strict schemas as formErrors', async () => {
    const app = makeApp();
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a', email: 'a@b.co', maxUses: 5 }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    // The offending key name must be visible to the caller (see
    // enrollmentKeys_strict.test.ts / issue #945).
    expect(body.error).toContain('maxUses');
    expect(body.details.formErrors.join(' ')).toContain('maxUses');
  });

  it('passes validated data through on success', async () => {
    const app = makeApp();
    const res = await app.request('/things', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Widget', email: 'a@b.co' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: 'Widget' });
  });

  it('lets a custom hook Response win (orgs.ts /partners/me pattern)', async () => {
    const app = new Hono();
    app.post(
      '/custom',
      zValidator('json', schema, (result, c) => {
        if (!result.success && result.error.issues.some((i) => i.path[0] === 'email')) {
          return c.json({ error: 'custom email error' }, 422);
        }
      }),
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'a', email: 'nope' }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('custom email error');
  });

  it('falls through to the readable default when a custom hook returns nothing', async () => {
    const app = new Hono();
    app.post(
      '/custom',
      zValidator('json', schema, (result, c) => {
        if (!result.success && result.error.issues.some((i) => i.path[0] === 'email')) {
          return c.json({ error: 'custom email error' }, 422);
        }
      }),
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: 'a@b.co' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('name: Name is required');
    expect(body.details.fieldErrors).toEqual({ name: ['Name is required'] });
  });

  it('validates non-json targets (query) with the same contract', async () => {
    const app = new Hono();
    app.get(
      '/list',
      zValidator('query', z.object({ orgId: z.string().uuid('Invalid org id') })),
      (c) => c.json({ ok: true })
    );

    const res = await app.request('/list?orgId=nope');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('orgId: Invalid org id');
  });
});

describe('formatZodError', () => {
  it('joins nested paths with dots and groups repeated fields', () => {
    const result = formatZodError({
      issues: [
        { path: ['contacts', 0, 'email'], message: 'Invalid email' },
        { path: ['contacts', 0, 'email'], message: 'Too short' },
        { path: [], message: 'Unrecognized key: "extra"' },
      ],
    });
    expect(result.error).toBe(
      'Unrecognized key: "extra"; contacts.0.email: Invalid email; Too short'
    );
    expect(result.details).toEqual({
      formErrors: ['Unrecognized key: "extra"'],
      fieldErrors: { 'contacts.0.email': ['Invalid email', 'Too short'] },
    });
  });

  it('falls back to a generic message when there are no issues', () => {
    expect(formatZodError({ issues: [] }).error).toBe('Validation failed');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { dbSelectMock, withDbAccessContextMock, runOutsideDbContextMock, capturedContexts } =
  vi.hoisted(() => {
    const captured: unknown[] = [];
    return {
      dbSelectMock: vi.fn(),
      withDbAccessContextMock: vi.fn((ctx: unknown, fn: () => unknown) => {
        captured.push(ctx);
        return fn();
      }),
      runOutsideDbContextMock: vi.fn((fn: () => unknown) => fn()),
      capturedContexts: captured,
    };
  });

vi.mock('../../db', () => ({
  db: { select: dbSelectMock },
  withDbAccessContext: withDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock,
}));

vi.mock('../../middleware/clientAiAuth', () => ({
  clientAiAuthMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'unauthorized' }, 401);
    c.set('clientAiAuth', {
      clientUserId: 'beefbeef-1111-4222-8333-444455556666',
      orgId: '0c0c0c0c-1111-4222-8333-444455556666',
      email: 'finance.user@contoso.com',
      name: 'Finance User',
      token: 'tok',
    });
    return next();
  }),
  requireClientAiEnabledMiddleware: vi.fn((_c: any, next: any) => next()),
}));

import { clientAiTemplateRoutes } from './templates';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const PARTNER_ID = 'f0f0f0f0-1111-4222-8333-444455556666';

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const self = vi.fn(() => c);
  for (const m of ['from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'limit', 'offset']) {
    c[m] = self;
  }
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

function buildApp() {
  const app = new Hono();
  app.route('/client-ai', clientAiTemplateRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedContexts.length = 0;
  let call = 0;
  dbSelectMock.mockImplementation(() => {
    call++;
    if (call === 1) return chain([{ partnerId: PARTNER_ID }]); // org row lookup
    return chain([
      {
        id: 't-org',
        name: 'Org template',
        description: null,
        category: 'finance',
        promptBody: 'Org body',
      },
      {
        id: 't-partner',
        name: 'Partner template',
        description: 'For all orgs',
        category: null,
        promptBody: 'Partner body',
      },
    ]);
  });
});

describe('GET /client-ai/templates', () => {
  it('401s without a session', async () => {
    const res = await buildApp().request('/client-ai/templates');
    expect(res.status).toBe(401);
  });

  it('returns the pinned bare-array shape with promptBody mapped to body', async () => {
    const res = await buildApp().request('/client-ai/templates', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[1]).toEqual({
      id: 't-partner',
      name: 'Partner template',
      description: 'For all orgs',
      category: null,
      body: 'Partner body',
    });
    expect(body[0]).not.toHaveProperty('promptBody');
  });

  it('appends the host built-in starter templates after the custom rows', async () => {
    const res = await buildApp().request('/client-ai/templates?host=excel', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    // Custom (DB) rows come first…
    expect(body[0]?.id).toBe('t-org');
    expect(body[1]?.id).toBe('t-partner');
    // …then the Excel defaults, and nothing from another host.
    const defaultIds = body.filter((t) => t.id.startsWith('default-')).map((t) => t.id);
    expect(defaultIds.length).toBeGreaterThan(0);
    expect(defaultIds.every((id) => id.startsWith('default-excel-'))).toBe(true);
  });

  it('omits built-in defaults when no host is supplied (back-compat)', async () => {
    const res = await buildApp().request('/client-ai/templates', {
      headers: { Authorization: 'Bearer tok' },
    });
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.some((t) => t.id.startsWith('default-'))).toBe(false);
  });

  it('re-scopes the template read with the org partner axis (decision 4)', async () => {
    await buildApp().request('/client-ai/templates', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toEqual({
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      accessiblePartnerIds: [PARTNER_ID],
      userId: null,
    });
  });

  it('still serves org-scoped templates when the org row has no partner (defensive)', async () => {
    let call = 0;
    dbSelectMock.mockImplementation(() => {
      call++;
      if (call === 1) return chain([]); // org row not visible — should not happen, fail safe
      return chain([
        { id: 't-org', name: 'Org template', description: null, category: null, promptBody: 'X' },
      ]);
    });
    const res = await buildApp().request('/client-ai/templates', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(res.status).toBe(200);
    expect((await res.json())[0].id).toBe('t-org');
    expect((capturedContexts[0] as { accessiblePartnerIds: string[] }).accessiblePartnerIds).toEqual([]);
  });
});

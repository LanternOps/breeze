/**
 * W08 #3902 — permission and scope contract for the attachment routes.
 *
 * The wave deliberately introduces NO new permission: every route reuses
 * PERMISSIONS.TICKETS_{READ,WRITE,MANAGE}. That is worth pinning rather than
 * leaving to silence, because adding a permission later requires the six-list
 * registration sweep (AI-agents W1 lesson) and a reviewer would not spot the
 * omission from a diff.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, requireScopeCalls, requirePermissionCalls } = vi.hoisted(() => ({
  authRef: {
    current: null as null | Record<string, unknown>,
  },
  requireScopeCalls: [] as string[][],
  requirePermissionCalls: [] as Array<[string, string]>,
}));

vi.mock('../../middleware/auth', async () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (!authRef.current) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', authRef.current);
    await next();
  }),
  requireScope: (...scopes: string[]) => {
    requireScopeCalls.push(scopes);
    return async (c: any, next: any) => {
      if (!c.get('auth')) return c.json({ error: 'Not authenticated' }, 401);
      await next();
    };
  },
  requirePermission: (resource: string, action: string) => {
    requirePermissionCalls.push([resource, action]);
    return async (_c: any, next: any) => next();
  },
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: (await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth')).siteAccessCheck,
}));

vi.mock('../../middleware/userRateLimit', () => ({
  userRateLimit: () => async (_c: any, next: any) => next(),
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve([])) })) })),
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([])),
          then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([])) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  },
}));

vi.mock('./tickets', async () => {
  const actual = await vi.importActual<typeof import('./tickets')>('./tickets');
  return { ...actual, getScopedTicketOr404: vi.fn(async () => null) };
});

import { authMiddleware } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';

const TICKET_ID = '3f2f1d8e-1111-4222-8333-444455556666';
const ATT_ID = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';

// ./attachments imports ./tickets, which registers ~19 middlewares of its own.
// Import that FIRST, snapshot the recorders, and attribute only what lands
// afterwards to this router — otherwise the assertion counts the whole ticket
// surface and proves nothing about the three new routes.
let app: Hono;
let permissionCalls: Array<[string, string]>;
let scopeCalls: string[][];

// 60s, not the 10s default: this hook imports ./tickets, one of the largest
// modules in the API (it pulls the whole ticket route surface plus the service
// layer). Under a loaded CI runner the transform alone can exceed 10s, and the
// hook timing out SKIPS all nine assertions while still reporting a "failure"
// that reads like a contract break rather than a stopwatch.
beforeAll(async () => {
  await import('./tickets');
  const permBaseline = requirePermissionCalls.length;
  const scopeBaseline = requireScopeCalls.length;
  const { ticketAttachmentRoutes } = await import('./attachments');
  permissionCalls = requirePermissionCalls.slice(permBaseline);
  scopeCalls = requireScopeCalls.slice(scopeBaseline);
  app = new Hono();
  app.use('*', authMiddleware);
  app.route('/', ticketAttachmentRoutes);
}, 60_000);

const ROUTES: Array<[string, string, RequestInit]> = [
  ['POST', `/${TICKET_ID}/attachments`, { method: 'POST', body: new FormData() }],
  ['GET', `/${TICKET_ID}/attachments/${ATT_ID}/content`, { method: 'GET' }],
  ['DELETE', `/${TICKET_ID}/attachments/${ATT_ID}`, { method: 'DELETE' }],
];

describe('attachment routes permission + scope contract (W08 #3902)', () => {
  beforeEach(() => {
    authRef.current = {
      scope: 'partner',
      user: { id: 'u-1', name: 'T', email: 't@example.com', isPlatformAdmin: false },
      partnerId: 'p-1',
      orgId: null,
      accessibleOrgIds: null,
      orgCondition: () => undefined,
      canAccessOrg: () => true,
    };
  });

  it('introduces no attachment-shaped permission', () => {
    expect(Object.keys(PERMISSIONS).filter((k) => /attach/i.test(k))).toEqual([]);
    const values = Object.values(PERMISSIONS) as Array<{ resource: string; action: string }>;
    expect(values.filter((p) => /attach/i.test(p.resource) || /attach/i.test(p.action))).toEqual([]);
  });

  it('registers only existing tickets read/write permissions on the three routes', () => {
    // Registration happens at module import; the calls recorded above are
    // exactly the middleware the router mounted.
    expect(permissionCalls).toEqual([
      [PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action],
      [PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action],
      [PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action],
    ]);
    expect(permissionCalls.every(([r]) => r === 'tickets')).toBe(true);
  });

  it('gates every route on the three tenant scopes', () => {
    expect(scopeCalls).toHaveLength(3);
    for (const scopes of scopeCalls) {
      expect(scopes).toEqual(['organization', 'partner', 'system']);
    }
  });

  it.each(ROUTES)('%s %s 401s without an auth context', async (_m, path, init) => {
    authRef.current = null;
    const res = await app.request(path, init);
    expect(res.status).toBe(401);
  });

  it.each(ROUTES)('%s %s 403s an organization-scoped caller with no orgId', async (_m, path, init) => {
    authRef.current = { ...authRef.current!, scope: 'organization', orgId: null };
    const res = await app.request(path, init);
    expect(res.status).toBe(403);
  });
});

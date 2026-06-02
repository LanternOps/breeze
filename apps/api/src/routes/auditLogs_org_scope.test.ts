/**
 * Regression: dashboard "Recent Activity" widget leaked rows across orgs for
 * partner-scope users. The widget POSTs ?orgId=<thorne-uuid> but the API
 * schema dropped the field and the LATERAL fast path scanned every
 * accessibleOrgId. (Reported live 2026-05-21: switched UI to Thorne, saw
 * agent enrollments from a different org.)
 *
 * GIVEN a partner-scope user with access to orgs A and B
 *  WHEN they call GET /audit-logs/logs?limit=5&skipCount=true&orgId=A
 *  THEN the LATERAL fast path runs against [A] only, NOT [A, B]
 *   AND requesting an inaccessible org returns 403
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const FOREIGN_ORG = '33333333-3333-3333-3333-333333333333';

vi.mock('../services', () => ({}));
vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  writeRouteAudit: vi.fn(),
}));

// Capture the SQL fragments passed to db.execute so we can assert which orgs
// the LATERAL CROSS JOIN was given. Drizzle's sql template builder produces
// an object; we just need to inspect what the route SAW as the org list.
const executeMock: ReturnType<typeof vi.fn> = vi.fn(async (..._args: unknown[]) => [] as unknown[]);

// Same chain shape as auditLogs.test.ts; only adds db.execute.
const createDbChain = () => ({
  from: vi.fn().mockReturnValue({
    leftJoin: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve([]), {
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              offset: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      ),
    }),
    where: vi.fn().mockReturnValue(
      Object.assign(Promise.resolve([{ count: 0 }]), {
        limit: vi.fn().mockResolvedValue([]),
      }),
    ),
  }),
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => createDbChain()),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: executeMock,
  },
  withDbAccessContext: vi.fn(async (_ctx: any, fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: any) => fn()),
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  SYSTEM_DB_ACCESS_CONTEXT: { scope: 'system', orgId: null, accessibleOrgIds: null },
}));

vi.mock('../db/schema', () => ({
  auditLogs: { orgId: 'orgId', actorId: 'actorId', timestamp: 'timestamp', id: 'id', action: 'action' },
  users: { id: 'id', name: 'name' },
  devices: { agentId: 'agentId', hostname: 'hostname', displayName: 'displayName' },
}));

// Partner-scope auth with access to ORG_A and ORG_B only.
const canAccessOrgSpy = vi.fn((id: string) => id === ORG_A || id === ORG_B);
const orgConditionSpy = vi.fn(() => undefined); // would be inArray(...) in prod

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'partner-user-1', email: 'partner@example.com', name: 'Partner User' },
      scope: 'partner',
      orgId: null,
      partnerId: 'partner-1',
      accessibleOrgIds: [ORG_A, ORG_B],
      canAccessOrg: canAccessOrgSpy,
      orgCondition: orgConditionSpy,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

describe('audit-logs cross-org leak fix (dashboard Recent Activity widget)', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue([]);
    const { auditLogRoutes } = await import('./auditLogs');
    app = new Hono();
    app.route('/audit-logs', auditLogRoutes);
  });

  it('scopes the LATERAL fast path to the requested orgId only', async () => {
    const res = await app.request(
      `/audit-logs/logs?limit=5&skipCount=true&orgId=${ORG_A}`,
    );
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);

    // Drizzle's `sql` template assembles a query object. We don't need to
    // re-parse it — instead, walk every nested string/queryChunk and assert
    // ORG_A appears and ORG_B does NOT. If the bug regresses, the LATERAL
    // unnest(ARRAY[...]) will contain BOTH UUIDs.
    const queryArg = executeMock.mock.calls[0]?.[0];
    const serialized = JSON.stringify(queryArg);
    expect(serialized).toContain(ORG_A);
    expect(serialized).not.toContain(ORG_B);
  });

  it('returns 403 when the requested orgId is outside accessibleOrgIds', async () => {
    const res = await app.request(
      `/audit-logs/logs?limit=5&skipCount=true&orgId=${FOREIGN_ORG}`,
    );
    expect(res.status).toBe(403);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('without orgId, fast path scans all accessibleOrgIds (existing behaviour)', async () => {
    const res = await app.request(`/audit-logs/logs?limit=5&skipCount=true`);
    expect(res.status).toBe(200);
    expect(executeMock).toHaveBeenCalledTimes(1);

    const serialized = JSON.stringify(executeMock.mock.calls[0]?.[0]);
    expect(serialized).toContain(ORG_A);
    expect(serialized).toContain(ORG_B);
  });
});

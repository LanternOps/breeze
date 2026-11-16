import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const REVIEW = '00000000-0000-4000-8000-0000000000d1';

/** A chainable, awaitable Drizzle stand-in: every builder method returns the chain; awaiting it yields `rows`. */
function chain(rows: unknown[]): unknown {
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(rows);
      return () => proxy;
    },
  });
  return proxy;
}

const h = vi.hoisted(() => ({ select: vi.fn(), grants: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: h.select },
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('./roleInheritance', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRolesPermissionGrants: h.grants,
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerAccessReviewTools } from './aiToolsAccessReviews';

const tools = new Map<string, AiTool>();
registerAccessReviewTools(tools);

const auth = {
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'organization',
  orgId: ORG,
  partnerId: null,
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  token: { mfa: true, amr: ['pwd', 'mfa'] },
  aiOrigin: { kind: 'chat', sessionId: 'session-1' },
} as unknown as AuthContext;

const item = (id: string, userId: string, roleId: string, roleName: string) => ({
  id, userId, userName: userId, userEmail: `${userId}@x`, lastActiveAt: null, roleId, roleName,
  decision: 'pending', notes: null, reviewedAt: null, selfDecided: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.grants.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, []])));
});

describe('manage_access_reviews get: per-role permissions', () => {
  it('lists a role\'s inherited grants, once per role, in resource:action form (#11702)', async () => {
    h.select
      .mockReturnValueOnce(chain([{ id: REVIEW, name: 'Q4', description: null, status: 'pending', reviewerId: 'user-1', dueDate: null, createdAt: new Date(), completedAt: null }]))
      .mockReturnValueOnce(chain([
        item('i1', 'u1', 'role-child', 'Child'),
        item('i2', 'u2', 'role-bare', 'Bare'),
        item('i3', 'u3', 'role-child', 'Child'),
      ]));
    h.grants.mockResolvedValueOnce(new Map([
      ['role-child', [{ resource: 'devices', action: 'read' }, { resource: 'tickets', action: 'write' }]],
      ['role-bare', []],
    ]));

    const out = JSON.parse(await tools.get('manage_access_reviews')!.handler({ action: 'get', reviewId: REVIEW }, auth));

    expect(h.grants).toHaveBeenCalledTimes(1);
    expect(h.grants.mock.calls[0]![0]).toEqual(['role-child', 'role-bare']);
    expect(out.roles).toEqual({
      'role-child': { name: 'Child', permissions: ['devices:read', 'tickets:write'] },
      'role-bare': { name: 'Bare', permissions: [] },
    });
  });

  it('skips the resolver when the review has no items', async () => {
    h.select
      .mockReturnValueOnce(chain([{ id: REVIEW, name: 'Q4', description: null, status: 'pending', reviewerId: 'user-1', dueDate: null, createdAt: new Date(), completedAt: null }]))
      .mockReturnValueOnce(chain([]));
    const out = JSON.parse(await tools.get('manage_access_reviews')!.handler({ action: 'get', reviewId: REVIEW }, auth));
    expect(h.grants).not.toHaveBeenCalled();
    expect(out.roles).toEqual({});
  });
});

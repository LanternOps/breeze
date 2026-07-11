import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

vi.mock('../services/onedriveGraph', () => ({
  listSharePointLibraries: vi.fn(),
}));
vi.mock('../services/m365DirectGraph', () => ({
  hasDirectM365Connection: vi.fn(),
}));

// --- mutable auth state, set per-test ---
let authState: {
  scope: 'organization' | 'partner' | 'system';
  orgId?: string | null;
  accessibleOrgIds?: string[] | null;
  canAccessOrg?: (orgId: string) => boolean;
  user?: { id: string } | null;
};

// Mock only authMiddleware + requirePermission (thin passthrough); requireScope
// and resolveScopedOrgId (./c2c/helpers) are left as the REAL implementations so
// the cross-tenant test exercises actual org-access enforcement, not a stub.
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', authState);
      return next();
    }),
    requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  };
});

import { listSharePointLibraries } from '../services/onedriveGraph';
import { hasDirectM365Connection } from '../services/m365DirectGraph';
import { authMiddleware } from '../middleware/auth';
import { onedriveRoutes } from './onedrive';

describe('GET /onedrive/libraries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState = {
      scope: 'organization',
      orgId: ORG_A,
      accessibleOrgIds: [ORG_A],
      canAccessOrg: (orgId: string) => orgId === ORG_A,
      user: { id: 'user-1' },
    };
  });

  it('returns libraries for an accessible org', async () => {
    (hasDirectM365Connection as any).mockResolvedValue(true);
    (listSharePointLibraries as any).mockResolvedValue({
      kind: 'ok',
      data: { libraries: [{ libraryName: 'Documents', autoMountValue: 'tenantId=t&…' }], skippedSites: [] },
    });
    const res = await onedriveRoutes.request(`/libraries?orgId=${ORG_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.libraries).toHaveLength(1);
    expect(listSharePointLibraries).toHaveBeenCalledWith(ORG_A);
  });

  it('rejects an org the caller cannot access (cross-tenant)', async () => {
    const res = await onedriveRoutes.request(`/libraries?orgId=${ORG_B}`);
    expect(res.status).toBe(400); // resolveScopedOrgId returns null → orgId required error
    expect(hasDirectM365Connection).not.toHaveBeenCalled();
    expect(listSharePointLibraries).not.toHaveBeenCalled();
  });

  it('409s when the org has no M365 connection', async () => {
    (hasDirectM365Connection as any).mockResolvedValue(false);
    const res = await onedriveRoutes.request(`/libraries?orgId=${ORG_A}`);
    expect(res.status).toBe(409);
    expect(listSharePointLibraries).not.toHaveBeenCalled();
  });

  it('502s on a Graph error', async () => {
    (hasDirectM365Connection as any).mockResolvedValue(true);
    (listSharePointLibraries as any).mockResolvedValue({ kind: 'error', code: 'graph_error', message: 'boom' });
    const res = await onedriveRoutes.request(`/libraries?orgId=${ORG_A}`);
    expect(res.status).toBe(502);
  });

  // Regression: the route module itself must attach authMiddleware. index.ts
  // does NOT apply a global auth middleware to the /api/v1 group, so a route
  // that forgets `.use('*', authMiddleware)` reaches requirePermission with no
  // auth context and 401s every authenticated request. Mount the router WITHOUT
  // the harness auth and assert the router invoked authMiddleware on its own.
  it('attaches authMiddleware itself (regression: 401 for all callers when missing)', async () => {
    const bare = new Hono();
    bare.route('/onedrive', onedriveRoutes);
    await bare.request('/onedrive/libraries');
    expect(authMiddleware).toHaveBeenCalled();
  });
});

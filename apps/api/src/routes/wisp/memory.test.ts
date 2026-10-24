import { readFileSync } from 'fs';
import { resolve } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => {
  class MemoryServiceError extends Error {
    readonly code: string;
    constructor(code: string, message = code) {
      super(message);
      this.name = 'MemoryServiceError';
      this.code = code;
    }
  }
  return {
    MemoryServiceError,
    auth: {} as Record<string, unknown>,
    wispEnabled: vi.fn(() => true),
    hasPerm: vi.fn<(resource: string, action: string) => boolean>(() => true),
    svc: {
      listBlocksForUser: vi.fn(),
      listBlocksForOrg: vi.fn(),
      listBlocksForPartner: vi.fn(),
      listUserBlocksForPartnerAdmin: vi.fn(),
      confirmBlock: vi.fn(),
      retractBlock: vi.fn(),
    },
    writeRouteAudit: vi.fn(),
    hasEntitlement: vi.fn(async () => true),
    /** organizations.partner_id rows handed to the org-scope entitlement lookup. */
    orgRows: [{ partnerId: '44444444-4444-4444-8444-444444444444' }] as Array<{ partnerId: string }>,
    orgWhere: [] as unknown[],
  };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', h.auth);
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: (resource: string, action: string) => async (
    c: { json: (body: unknown, status: number) => Response },
    next: () => Promise<void>,
  ) => (h.hasPerm(resource, action) ? next() : c.json({ error: 'Permission denied' }, 403)),
}));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  wispEnabled: () => h.wispEnabled(),
}));
vi.mock('../../services/wisp/memoryService', () => ({ ...h.svc, MemoryServiceError: h.MemoryServiceError }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAudit }));
vi.mock('../../services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasEntitlement: h.hasEntitlement,
}));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const p: Record<string, unknown> = {};
      p.from = vi.fn(() => p);
      p.where = vi.fn((cond: unknown) => { h.orgWhere.push(cond); return p; });
      p.limit = vi.fn(async () => h.orgRows);
      return p;
    }),
  },
}));

import { wispMemoryRoutes } from './memory';

const app = new Hono().route('/wisp/memory', wispMemoryRoutes);
app.onError((err, c) => c.json({ error: 'internal', message: err.message }, 500));

const BLOCK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const GRANT_ID = '66666666-6666-4666-8666-666666666666';

const partnerAuth = { scope: 'partner', partnerId: PARTNER_ID, orgId: null, user: { id: USER_ID, email: 'a@example.com' }, principal: { kind: 'user_session' } };
const orgAuth = { scope: 'organization', partnerId: null, orgId: ORG_ID, user: { id: USER_ID, email: 'a@example.com' }, principal: { kind: 'user_session' } };

function block(overrides: Record<string, unknown> = {}) {
  return {
    id: BLOCK_ID,
    tenantPartnerId: PARTNER_ID,
    owner: { kind: 'user', userId: USER_ID },
    blockType: 'preference',
    subjectKey: 'reboot.window',
    content: { text: 'after 6pm' },
    confidence: 'medium',
    status: 'unconfirmed',
    authoredByGrantId: GRANT_ID,
    authoredByGrantRevisionId: '77777777-7777-4777-8777-777777777777',
    supersededById: null,
    sourceSessionId: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    ...overrides,
  };
}

const post = { method: 'POST' };

describe('wisp memory routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.auth = partnerAuth;
    h.wispEnabled.mockReturnValue(true);
    h.hasPerm.mockReturnValue(true);
    h.hasEntitlement.mockResolvedValue(true);
    h.orgRows = [{ partnerId: PARTNER_ID }];
    h.orgWhere.length = 0;
    for (const fn of Object.values(h.svc)) fn.mockReset();
  });

  describe('entitlement gate (W04: requireEntitlement(\'wisp\'))', () => {
    const reqs: Array<[string, RequestInit?]> = [
      ['/wisp/memory?scope=mine'],
      [`/wisp/memory/users/${USER_ID}`],
      [`/wisp/memory/${BLOCK_ID}/confirm`, { method: 'POST' }],
      [`/wisp/memory/${BLOCK_ID}/retract`, { method: 'POST' }],
    ];

    it('every route is 403 entitlement_required when the partner lacks wisp, without a service call', async () => {
      h.hasEntitlement.mockResolvedValue(false);
      for (const [path, init] of reqs) {
        const res = await app.request(path, init);
        expect(res.status, path).toBe(403);
        expect(await res.json()).toEqual({ code: 'entitlement_required', error: 'Wisp', featureKey: 'wisp' });
      }
      expect(h.hasEntitlement).toHaveBeenCalledWith(PARTNER_ID, 'wisp');
      for (const fn of Object.values(h.svc)) expect(fn).not.toHaveBeenCalled();
    });

    it('flag off wins: not entitled AND flag off is 404, never 403, and the resolver is not consulted', async () => {
      h.wispEnabled.mockReturnValue(false);
      h.hasEntitlement.mockResolvedValue(false);
      for (const [path, init] of reqs) {
        const res = await app.request(path, init);
        expect(res.status, path).toBe(404);
      }
      expect(h.hasEntitlement).not.toHaveBeenCalled();
    });

    it('an organization-scope caller (partnerId null) is checked against its org\'s owning partner', async () => {
      h.auth = orgAuth;
      h.svc.listBlocksForUser.mockResolvedValue([]);
      const ok = await app.request('/wisp/memory?scope=mine');
      expect(ok.status).toBe(200);
      expect(h.hasEntitlement).toHaveBeenCalledWith(PARTNER_ID, 'wisp');
      expect(h.orgWhere).toHaveLength(1);

      h.hasEntitlement.mockResolvedValue(false);
      const denied = await app.request('/wisp/memory?scope=mine');
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'entitlement_required' });
    });

    it('an organization-scope caller whose org row is not visible fails closed (403, resolver not consulted)', async () => {
      h.auth = orgAuth;
      h.orgRows = [];
      const res = await app.request('/wisp/memory?scope=mine');
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'entitlement_required' });
      expect(h.hasEntitlement).not.toHaveBeenCalled();
      expect(h.svc.listBlocksForUser).not.toHaveBeenCalled();
    });
  });

  it('every route is 404 { error: not_found } while wispEnabled() is false', async () => {
    h.wispEnabled.mockReturnValue(false);
    const reqs: Array<[string, RequestInit?]> = [
      ['/wisp/memory?scope=mine'],
      [`/wisp/memory/users/${USER_ID}`],
      [`/wisp/memory/${BLOCK_ID}/confirm`, post],
      [`/wisp/memory/${BLOCK_ID}/retract`, post],
    ];
    for (const [path, init] of reqs) {
      const res = await app.request(path, init);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    for (const fn of Object.values(h.svc)) expect(fn).not.toHaveBeenCalled();
  });

  it('requires ai_sessions:use on every route', async () => {
    h.hasPerm.mockImplementation((r, a) => !(r === 'ai_sessions' && a === 'use'));
    expect((await app.request('/wisp/memory?scope=mine')).status).toBe(403);
    expect((await app.request(`/wisp/memory/users/${USER_ID}`)).status).toBe(403);
    expect((await app.request(`/wisp/memory/${BLOCK_ID}/confirm`, post)).status).toBe(403);
    expect((await app.request(`/wisp/memory/${BLOCK_ID}/retract`, post)).status).toBe(403);
    for (const fn of Object.values(h.svc)) expect(fn).not.toHaveBeenCalled();
  });

  it('GET ?scope=mine lists the caller\'s blocks as DTOs (ISO dates, owner flattened, no partner/revision ids)', async () => {
    h.svc.listBlocksForUser.mockResolvedValue([block()]);
    const res = await app.request('/wisp/memory?scope=mine');
    expect(res.status).toBe(200);
    expect(h.svc.listBlocksForUser).toHaveBeenCalledWith(partnerAuth);
    expect(await res.json()).toEqual({
      blocks: [{
        id: BLOCK_ID,
        ownerKind: 'user',
        ownerUserId: USER_ID,
        ownerOrgId: null,
        blockType: 'preference',
        subjectKey: 'reboot.window',
        content: { text: 'after 6pm' },
        confidence: 'medium',
        status: 'unconfirmed',
        authoredByGrantId: GRANT_ID,
        supersededById: null,
        sourceSessionId: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
      }],
    });
  });

  it('a block with sourceSessionId serialises it', async () => {
    h.svc.listBlocksForUser.mockResolvedValue([block({ sourceSessionId: SESSION_ID })]);
    const body = await (await app.request('/wisp/memory?scope=mine')).json();
    expect(body.blocks[0].sourceSessionId).toBe(SESSION_ID);
  });

  it('missing or unknown scope is 400', async () => {
    expect((await app.request('/wisp/memory')).status).toBe(400);
    expect((await app.request('/wisp/memory?scope=everyone')).status).toBe(400);
  });

  it('scope=org without orgId is 400; with a non-uuid orgId is 400', async () => {
    expect((await app.request('/wisp/memory?scope=org')).status).toBe(400);
    expect((await app.request('/wisp/memory?scope=org&orgId=nope')).status).toBe(400);
    expect(h.svc.listBlocksForOrg).not.toHaveBeenCalled();
  });

  it('scope=org&orgId= calls listBlocksForOrg and flattens the org owner', async () => {
    h.auth = orgAuth;
    h.svc.listBlocksForOrg.mockResolvedValue([block({ owner: { kind: 'org', orgId: ORG_ID } })]);
    const res = await app.request(`/wisp/memory?scope=org&orgId=${ORG_ID}`);
    expect(res.status).toBe(200);
    expect(h.svc.listBlocksForOrg).toHaveBeenCalledWith(orgAuth, ORG_ID);
    const body = await res.json();
    expect(body.blocks[0]).toMatchObject({ ownerKind: 'org', ownerUserId: null, ownerOrgId: ORG_ID });
  });

  it('scope=org maps a service not_found to 404', async () => {
    h.svc.listBlocksForOrg.mockRejectedValue(new h.MemoryServiceError('not_found'));
    const res = await app.request(`/wisp/memory?scope=org&orgId=${ORG_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('scope=partner from organization scope is 403 partner_scope_required, without a service call', async () => {
    h.auth = orgAuth;
    const res = await app.request('/wisp/memory?scope=partner');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'partner_scope_required' });
    expect(h.svc.listBlocksForPartner).not.toHaveBeenCalled();
  });

  it('scope=partner from partner scope lists partner blocks', async () => {
    h.svc.listBlocksForPartner.mockResolvedValue([block({ owner: { kind: 'partner' } })]);
    const res = await app.request('/wisp/memory?scope=partner');
    expect(res.status).toBe(200);
    expect(h.svc.listBlocksForPartner).toHaveBeenCalledWith(partnerAuth);
    expect((await res.json()).blocks[0]).toMatchObject({ ownerKind: 'partner', ownerUserId: null, ownerOrgId: null });
  });

  it('GET /users/:userId returns the admin view and writes no route audit (the service audits)', async () => {
    h.svc.listUserBlocksForPartnerAdmin.mockResolvedValue([block()]);
    const res = await app.request(`/wisp/memory/users/${USER_ID}`);
    expect(res.status).toBe(200);
    expect(h.svc.listUserBlocksForPartnerAdmin).toHaveBeenCalledWith(partnerAuth, USER_ID);
    expect((await res.json()).blocks).toHaveLength(1);
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('GET /users/:userId maps cross_partner and partner_wide_write_denied to 403', async () => {
    h.svc.listUserBlocksForPartnerAdmin.mockRejectedValueOnce(new h.MemoryServiceError('cross_partner'));
    let res = await app.request(`/wisp/memory/users/${USER_ID}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'cross_partner' });

    h.svc.listUserBlocksForPartnerAdmin.mockRejectedValueOnce(new h.MemoryServiceError('partner_wide_write_denied'));
    res = await app.request(`/wisp/memory/users/${USER_ID}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'partner_wide_write_denied' });
  });

  it('GET /users/:userId with a non-uuid id is 400 without a service call', async () => {
    expect((await app.request('/wisp/memory/users/not-a-uuid')).status).toBe(400);
    expect(h.svc.listUserBlocksForPartnerAdmin).not.toHaveBeenCalled();
  });

  it('POST /:id/confirm returns the block and audits wisp.memory.confirm', async () => {
    h.svc.confirmBlock.mockResolvedValue(block({ status: 'confirmed' }));
    const res = await app.request(`/wisp/memory/${BLOCK_ID}/confirm`, post);
    expect(res.status).toBe(200);
    expect(h.svc.confirmBlock).toHaveBeenCalledWith(partnerAuth, BLOCK_ID);
    expect((await res.json()).block).toMatchObject({ id: BLOCK_ID, status: 'confirmed', createdAt: '2026-10-01T00:00:00.000Z' });
    expect(h.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.memory.confirm',
      resourceType: 'ai_memory_blocks',
      resourceId: BLOCK_ID,
      orgId: null,
      partnerId: PARTNER_ID,
    }));
  });

  it('POST /:id/retract audits wisp.memory.retract with the owner org for an org block', async () => {
    h.svc.retractBlock.mockResolvedValue(block({ status: 'retracted', owner: { kind: 'org', orgId: ORG_ID } }));
    const res = await app.request(`/wisp/memory/${BLOCK_ID}/retract`, post);
    expect(res.status).toBe(200);
    expect(h.svc.retractBlock).toHaveBeenCalledWith(partnerAuth, BLOCK_ID);
    expect((await res.json()).block).toMatchObject({ status: 'retracted', ownerKind: 'org', ownerOrgId: ORG_ID });
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'wisp.memory.retract',
      resourceType: 'ai_memory_blocks',
      resourceId: BLOCK_ID,
      orgId: ORG_ID,
    }));
  });

  it('confirm of a retracted block is 409 and is not audited', async () => {
    h.svc.confirmBlock.mockRejectedValue(new h.MemoryServiceError('retracted'));
    const res = await app.request(`/wisp/memory/${BLOCK_ID}/confirm`, post);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'retracted' });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('confirm of an already-superseded block is 409 superseded and is not audited', async () => {
    h.svc.confirmBlock.mockRejectedValue(new h.MemoryServiceError('superseded'));
    const res = await app.request(`/wisp/memory/${BLOCK_ID}/confirm`, post);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'superseded' });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('not_found → 404, human_only / owner_mismatch / partner_wide_write_denied → 403, invalid_memory → 400', async () => {
    const cases: Array<[string, number]> = [
      ['not_found', 404],
      ['human_only', 403],
      ['owner_mismatch', 403],
      ['partner_wide_write_denied', 403],
      ['invalid_memory', 400],
    ];
    for (const [code, status] of cases) {
      h.svc.retractBlock.mockRejectedValueOnce(new h.MemoryServiceError(code));
      const res = await app.request(`/wisp/memory/${BLOCK_ID}/retract`, post);
      expect(res.status, code).toBe(status);
      expect(await res.json()).toEqual({ error: code });
    }
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('confirm/retract with a non-uuid id is 400 without a service call', async () => {
    expect((await app.request('/wisp/memory/nope/confirm', post)).status).toBe(400);
    expect((await app.request('/wisp/memory/nope/retract', post)).status).toBe(400);
    expect(h.svc.confirmBlock).not.toHaveBeenCalled();
    expect(h.svc.retractBlock).not.toHaveBeenCalled();
  });

  it('an unknown error is not swallowed: it reaches onError as a 500', async () => {
    h.svc.confirmBlock.mockRejectedValue(new Error('db exploded'));
    const res = await app.request(`/wisp/memory/${BLOCK_ID}/confirm`, post);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal', message: 'db exploded' });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  describe('mount order', () => {
    it('index.ts mounts /wisp/memory BEFORE /wisp, so W02\'s partner-only /wisp/* middleware never runs for memory routes', () => {
      const src = readFileSync(resolve(__dirname, '../../index.ts'), 'utf8');
      const memoryAt = src.indexOf("api.route('/wisp/memory', wispMemoryRoutes)");
      const grantsAt = src.indexOf("api.route('/wisp', wispRoutes)");
      expect(memoryAt).toBeGreaterThan(-1);
      expect(grantsAt).toBeGreaterThan(-1);
      expect(memoryAt).toBeLessThan(grantsAt);
    });

    it('with that order, a sibling /wisp router\'s use(\'*\') gate does not reach a matched memory route', async () => {
      // Stand-in for W02's wispRoutes: requireScope('partner') as a /wisp/* use('*').
      const sibling = new Hono();
      sibling.use('*', async (c) => c.json({ error: 'sibling gate ran' }, 403));
      sibling.get('/grants', (c) => c.json({ ok: true }));
      const composed = new Hono();
      composed.route('/wisp/memory', wispMemoryRoutes);
      composed.route('/wisp', sibling);

      h.auth = orgAuth;
      h.svc.listBlocksForUser.mockResolvedValue([]);
      const res = await composed.request('/wisp/memory?scope=mine');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ blocks: [] });
      // ...and the sibling's own routes still get its gate.
      expect((await composed.request('/wisp/grants')).status).toBe(403);

      // Control: the reverse order would put the sibling gate in front.
      const reversed = new Hono();
      reversed.route('/wisp', sibling);
      reversed.route('/wisp/memory', wispMemoryRoutes);
      expect((await reversed.request('/wisp/memory?scope=mine')).status).toBe(403);
    });
  });
});

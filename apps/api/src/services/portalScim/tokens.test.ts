/**
 * Unit tests for the SCIM bearer credential (portal registration W9 #11386,
 * plan Task 3; D1, D2, D11), over a scripted Drizzle mock. The cross-org RLS
 * proof lives in rls-coverage.integration.test.ts; the end-to-end token
 * suspension in __tests__/integration/portalScim.integration.test.ts.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Step = [string, unknown[]];
interface Call { op: 'select' | 'insert' | 'update' | 'delete' | 'execute'; args: unknown[]; steps: Step[]; depth: number }

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const results: unknown[] = [];
  const txDepth = { current: 0 };
  const held = { current: false };
  function builder(op: Call['op'], args: unknown[]): unknown {
    const call: Call = { op, args, steps: [], depth: txDepth.current };
    calls.push(call);
    const proxy: unknown = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          const next = results.length > 0 ? results.shift() : [];
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            next instanceof Error ? reject(next) : resolve(next);
        }
        return (...stepArgs: unknown[]) => {
          call.steps.push([String(prop), stepArgs]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  return { calls, results, txDepth, held, builder };
});

vi.mock('../../db', () => ({
  db: {
    select: (...a: unknown[]) => h.builder('select', a),
    insert: (...a: unknown[]) => h.builder('insert', a),
    update: (...a: unknown[]) => h.builder('update', a),
    delete: (...a: unknown[]) => h.builder('delete', a),
    execute: (...a: unknown[]) => h.builder('execute', a),
  },
  hasDbAccessContext: vi.fn(() => h.held.current || h.txDepth.current > 0),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.txDepth.current += 1;
    try { return await fn(); } finally { h.txDepth.current -= 1; }
  }),
}));

const proof = vi.hoisted(() => ({ tenantId: '11111111-2222-4333-8444-555555555555' as string | null }));
vi.mock('../portalEntraTenantProof', () => ({
  findProvenEntraTenantForOrg: vi.fn(async () => (proof.tenantId ? { tenantId: proof.tenantId, provenAt: new Date() } : null)),
}));
const tenant = vi.hoisted(() => ({ active: true }));
vi.mock('../tenantStatus', () => ({
  getActiveOrgTenant: vi.fn(async (orgId: string) => (tenant.active ? { orgId, partnerId: 'partner-1' } : null)),
}));
vi.mock('../auditRequestTracking', () => ({ markRequestAuditWritten: vi.fn() }));

import { auditLogs, portalScimTokens } from '../../db/schema';
import {
  PORTAL_SCIM_LIVE_TOKEN_CAP,
  PortalScimTokenError,
  hashScimSecret,
  listPortalScimTokens,
  mintPortalScimToken,
  parseScimBearer,
  revokePortalScimToken,
  verifyPortalScimToken,
} from './tokens';

const ORG = '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01';
const OTHER_ORG = '4a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const TOKEN_ID = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';
const ACTOR = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const TID = '11111111-2222-4333-8444-555555555555';
const SECRET = 'A'.repeat(43);
const NOW = new Date('2027-02-01T12:00:00.000Z');
const wire = (id = TOKEN_ID, secret = SECRET) => `Bearer brzscim_${id.replace(/-/g, '')}_${secret}`;

function stepsOf(call: Call | undefined, name: string): unknown[][] {
  return (call?.steps ?? []).filter(([n]) => n === name).map(([, a]) => a);
}
const firstArg = (call: Call | undefined, name: string) => stepsOf(call, name)[0]?.[0] as Record<string, unknown>;
const writes = () => h.calls.filter((c) => c.op === 'insert' || c.op === 'update' || c.op === 'delete');

function tokenRow(over: Record<string, unknown> = {}) {
  return {
    id: TOKEN_ID, orgId: ORG, entraTenantId: TID, secretHash: hashScimSecret(SECRET), revokedAt: null,
    lastUsedAt: NOW, ...over,
  };
}

beforeEach(() => {
  h.calls.length = 0;
  h.results.length = 0;
  h.txDepth.current = 0;
  h.held.current = false;
  proof.tenantId = TID;
  tenant.active = true;
  vi.clearAllMocks();
});

describe('parseScimBearer', () => {
  it('parses the wire format into the row id and the secret', () => {
    expect(parseScimBearer(wire())).toEqual({ tokenId: TOKEN_ID, secret: SECRET });
  });

  it.each([
    ['no header', undefined],
    ['not bearer', `Basic ${'x'.repeat(10)}`],
    ['no prefix', `Bearer ${TOKEN_ID.replace(/-/g, '')}_${SECRET}`],
    ['short id', `Bearer brzscim_abc_${SECRET}`],
    ['upper-case id', `Bearer brzscim_${TOKEN_ID.replace(/-/g, '').toUpperCase()}_${SECRET}`],
    ['short secret', `Bearer brzscim_${TOKEN_ID.replace(/-/g, '')}_${'A'.repeat(42)}`],
    ['bad secret alphabet', `Bearer brzscim_${TOKEN_ID.replace(/-/g, '')}_${'A'.repeat(42)}=`],
    ['trailing junk', `${wire()} extra`],
    ['a staff JWT', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig'],
  ])('refuses %s', (_label, header) => {
    expect(parseScimBearer(header)).toBeNull();
  });
});

describe('hashScimSecret', () => {
  it('is lowercase hex SHA-256 of the secret', () => {
    expect(hashScimSecret(SECRET)).toBe(createHash('sha256').update(SECRET).digest('hex'));
  });
});

describe('verifyPortalScimToken (D1, D2)', () => {
  it('accepts the exact token: org, tenant and issuer come from the row', async () => {
    h.results.push([tokenRow()]);
    const out = await verifyPortalScimToken(wire(), NOW);
    expect(out).toEqual({
      tokenId: TOKEN_ID, orgId: ORG, partnerId: 'partner-1', tenantId: TID,
      issuer: `https://login.microsoftonline.com/${TID}/v2.0`,
    });
    // last_used_at is fresh (< 1 min): no write.
    expect(writes()).toEqual([]);
  });

  it('stamps last_used_at at most once a minute', async () => {
    h.results.push([tokenRow({ lastUsedAt: new Date(NOW.getTime() - 61_000) })], []);
    await verifyPortalScimToken(wire(), NOW);
    const [update] = writes();
    expect(update!.args[0]).toBe(portalScimTokens);
    expect(firstArg(update, 'set')).toEqual({ lastUsedAt: NOW });
  });

  it.each([
    ['a wrong secret', () => { h.results.push([tokenRow()]); return wire(TOKEN_ID, 'B'.repeat(43)); }],
    ['an unknown id', () => { h.results.push([]); return wire(); }],
    ['a revoked token', () => { h.results.push([tokenRow({ revokedAt: NOW })]); return wire(); }],
    ['a removed proof', () => { proof.tenantId = null; h.results.push([tokenRow()]); return wire(); }],
    ['a proof of another tenant', () => { proof.tenantId = '99999999-2222-4333-8444-555555555555'; h.results.push([tokenRow()]); return wire(); }],
    ['an inactive org or partner', () => { tenant.active = false; h.results.push([tokenRow()]); return wire(); }],
    ['a malformed header', () => 'Bearer nope'],
  ])('refuses %s with the same null result and writes nothing', async (_label, arrange) => {
    const header = arrange();
    expect(await verifyPortalScimToken(header, NOW)).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('compares the tenant case-insensitively (a mapping stored upper-case still matches)', async () => {
    proof.tenantId = TID.toUpperCase();
    h.results.push([tokenRow()]);
    expect(await verifyPortalScimToken(wire(), NOW)).not.toBeNull();
  });

  it('a malformed header never touches the database', async () => {
    await verifyPortalScimToken('Bearer brzscim_x', NOW);
    expect(h.calls).toEqual([]);
  });
});

describe('mintPortalScimToken (D1)', () => {
  it('returns the secret once, stores only its hash, binds the proven tenant and audits', async () => {
    h.results.push([], [{ n: 0 }], [], []);
    const out = await mintPortalScimToken({ orgId: ORG, label: ' Entra provisioning ', actorUserId: ACTOR, now: NOW });

    const m = /^brzscim_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/.exec(out.token);
    expect(m, out.token).not.toBeNull();
    const [lock, , insert, audit] = h.calls;
    expect(lock!.op).toBe('execute');
    expect(insert!.args[0]).toBe(portalScimTokens);
    const stored = firstArg(insert, 'values');
    expect(stored).toMatchObject({ orgId: ORG, entraTenantId: TID, label: 'Entra provisioning', createdByUserId: ACTOR });
    expect(stored.secretHash).toBe(hashScimSecret(m![2]!));
    expect(stored.secretHint).toBe(m![2]!.slice(-4));
    expect(JSON.stringify(stored)).not.toContain(m![2]!);
    expect((stored.id as string).replace(/-/g, '')).toBe(m![1]);
    expect(out.view).toMatchObject({ id: stored.id, label: 'Entra provisioning', hint: m![2]!.slice(-4), revokedAt: null, usable: true });
    expect(audit!.args[0]).toBe(auditLogs);
    expect(firstArg(audit, 'values')).toMatchObject({
      orgId: ORG, actorType: 'user', actorId: ACTOR, action: 'organization.portal_scim_token.create',
      resourceType: 'portal_scim_token', resourceId: stored.id, details: { tenantId: TID },
    });
    expect(JSON.stringify(firstArg(audit, 'values'))).not.toContain(m![2]!);
    expect(h.calls.every((c) => c.depth === 1)).toBe(true);
  });

  it('refuses an org with no proven tenant: PORTAL_SCIM_TENANT_NOT_PROVEN, nothing written', async () => {
    proof.tenantId = null;
    h.results.push([]);
    const err = await mintPortalScimToken({ orgId: ORG, label: 'x', actorUserId: ACTOR, now: NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortalScimTokenError);
    expect(err).toMatchObject({ code: 'PORTAL_SCIM_TENANT_NOT_PROVEN', httpStatus: 409 });
    expect(writes()).toEqual([]);
  });

  it(`refuses a third live token: PORTAL_SCIM_TOKEN_LIMIT (cap ${PORTAL_SCIM_LIVE_TOKEN_CAP})`, async () => {
    h.results.push([], [{ n: PORTAL_SCIM_LIVE_TOKEN_CAP }]);
    const err = await mintPortalScimToken({ orgId: ORG, label: 'x', actorUserId: ACTOR, now: NOW }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PORTAL_SCIM_TOKEN_LIMIT', httpStatus: 409 });
    expect(writes()).toEqual([]);
  });

  it('refuses inside a held DB context', async () => {
    h.held.current = true;
    await expect(mintPortalScimToken({ orgId: ORG, label: 'x', actorUserId: ACTOR, now: NOW })).rejects.toThrow(/runOutsideDbContext/);
  });
});

describe('revokePortalScimToken (D11)', () => {
  it('revokes by org AND id, audits, and is idempotent', async () => {
    h.results.push([{ id: TOKEN_ID, revokedAt: null }], [], []);
    await revokePortalScimToken({ orgId: ORG, tokenId: TOKEN_ID, actorUserId: ACTOR, now: NOW });
    const [select, update, audit] = h.calls;
    expect(stepsOf(select, 'for')[0]).toEqual(['update']);
    expect(firstArg(update, 'set')).toEqual({ revokedAt: NOW, revokedByUserId: ACTOR });
    expect(firstArg(audit, 'values')).toMatchObject({ action: 'organization.portal_scim_token.revoke', resourceId: TOKEN_ID });

    h.calls.length = 0;
    h.results.push([{ id: TOKEN_ID, revokedAt: NOW }]);
    await revokePortalScimToken({ orgId: ORG, tokenId: TOKEN_ID, actorUserId: ACTOR, now: NOW });
    expect(writes()).toEqual([]);
  });

  it('a token of another org (or none) is PORTAL_SCIM_TOKEN_NOT_FOUND', async () => {
    h.results.push([]);
    const err = await revokePortalScimToken({ orgId: OTHER_ORG, tokenId: TOKEN_ID, actorUserId: ACTOR, now: NOW }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PORTAL_SCIM_TOKEN_NOT_FOUND', httpStatus: 404 });
    expect(writes()).toEqual([]);
  });

  it('a malformed id is PORTAL_SCIM_TOKEN_NOT_FOUND without a query', async () => {
    const err = await revokePortalScimToken({ orgId: ORG, tokenId: 'nope', actorUserId: ACTOR, now: NOW }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PORTAL_SCIM_TOKEN_NOT_FOUND' });
    expect(h.calls).toEqual([]);
  });
});

describe('listPortalScimTokens', () => {
  it('lists the org\'s tokens without secret material and marks which can authenticate now', async () => {
    h.results.push([
      { id: TOKEN_ID, label: 'A', secretHint: 'wxyz', entraTenantId: TID, createdAt: NOW, lastUsedAt: null, revokedAt: null },
      { id: OTHER_ORG, label: 'B', secretHint: 'abcd', entraTenantId: '99999999-2222-4333-8444-555555555555', createdAt: NOW, lastUsedAt: null, revokedAt: null },
    ]);
    const out = await listPortalScimTokens(ORG);
    expect(out).toEqual([
      { id: TOKEN_ID, label: 'A', hint: 'wxyz', tenantId: TID, createdAt: NOW.toISOString(), lastUsedAt: null, revokedAt: null, usable: true },
      { id: OTHER_ORG, label: 'B', hint: 'abcd', tenantId: '99999999-2222-4333-8444-555555555555', createdAt: NOW.toISOString(), lastUsedAt: null, revokedAt: null, usable: false },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/secretHash|secret_hash/);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const state = { inSystem: false };
  return {
    calls,
    state,
    selectRows: [] as unknown[][],
    selectWheres: [] as Array<{ where: unknown; system: boolean }>,
    updateReturning: [] as unknown[][],
    updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
    insertReturning: [] as unknown[][],
    inserts: [] as Array<Record<string, unknown>>,
    executes: [] as unknown[],
    systemLabels: [] as Array<string | undefined>,
    auditMock: vi.fn(async (_p: unknown) => { calls.push('audit'); }),
  };
});

vi.mock('../../db', () => {
  const select = vi.fn(() => {
    h.calls.push(h.state.inSystem ? 'select:system' : 'select');
    const system = h.state.inSystem;
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'orderBy', 'limit', 'for']) chain[m] = () => chain;
    chain.where = (w: unknown) => { h.selectWheres.push({ where: w, system }); return chain; };
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(h.selectRows.shift() ?? []).then(res, rej);
    return chain;
  });
  const update = vi.fn(() => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: unknown) => {
        h.calls.push('update');
        h.updates.push({ set, where });
        return Object.assign(Promise.resolve(undefined), { returning: async () => h.updateReturning.shift() ?? [] });
      },
    }),
  }));
  const insert = vi.fn(() => ({
    values: (values: Record<string, unknown>) => {
      h.calls.push('insert');
      h.inserts.push(values);
      return { returning: async () => h.insertReturning.shift() ?? [] };
    },
  }));
  const execute = vi.fn(async (q: unknown) => { h.calls.push('execute'); h.executes.push(q); return []; });
  const db: Record<string, unknown> = { select, update, insert, execute };
  db.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => { h.calls.push('tx'); return fn(db); });
  return {
    db,
    runOutsideDbContext: vi.fn((fn: () => unknown) => { h.calls.push('outside'); return fn(); }),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>, label?: string) => {
      h.systemLabels.push(label);
      h.state.inSystem = true;
      try { return await fn(); } finally { h.state.inSystem = false; }
    }),
  };
});
vi.mock('../auditService', () => ({ createAuditLog: h.auditMock }));

import type { AuthContext } from '../../middleware/auth';
import {
  MemoryServiceError, confirmBlock, listBlocksForOrg, listBlocksForPartner, listBlocksForUser,
  listUserBlocksForPartnerAdmin, recordHumanBlock, retractBlock,
} from './memoryService';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const O1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const O2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const B1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const B0 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const G1 = '99999999-9999-4999-8999-999999999999';

function userSession(
  partnerId: string | null,
  userId: string,
  scope: AuthContext['scope'] = 'partner',
  partnerOrgAccess: AuthContext['partnerOrgAccess'] = 'selected',
  orgIds: string[] = [O1],
): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: `${userId}@example.com`, name: 'Tech', isPlatformAdmin: false },
    token: null,
    partnerId,
    orgId: scope === 'organization' ? orgIds[0]! : null,
    scope,
    accessibleOrgIds: orgIds,
    partnerOrgAccess,
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => orgIds.includes(id),
  } as AuthContext;
}

function agentAuth(): AuthContext {
  return { ...userSession(P1, U1, 'partner', 'all'), principal: { kind: 'ai_agent' } as AuthContext['principal'] };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: B1, tenantPartnerId: P1, ownerKind: 'user', ownerUserId: U1, ownerOrgId: null,
  blockType: 'preference', subjectKey: 'k', content: { text: 'x' }, confidence: 'medium', status: 'unconfirmed',
  authoredByGrantId: null, authoredByGrantRevisionId: null, supersededById: null, sourceSessionId: null,
  createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});

const sqlOf = (where: unknown) => {
  const q = new PgDialect().sqlToQuery(where as never);
  return { text: q.sql.toLowerCase(), params: q.params };
};

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (err) {
    expect(err).toBeInstanceOf(MemoryServiceError);
    return (err as MemoryServiceError).code;
  }
  return undefined;
}

beforeEach(() => {
  h.calls.length = 0; h.selectRows.length = 0; h.selectWheres.length = 0; h.updateReturning.length = 0;
  h.updates.length = 0; h.insertReturning.length = 0; h.inserts.length = 0; h.executes.length = 0;
  h.systemLabels.length = 0; h.state.inSystem = false;
  h.auditMock.mockReset().mockImplementation(async () => { h.calls.push('audit'); });
});

describe('memoryService', () => {
  it('confirmBlock: unconfirmed → confirmed, updated_at bumped, guarded so a concurrent retract cannot be resurrected', async () => {
    h.selectRows.push([row()]);
    h.updateReturning.push([row({ status: 'confirmed', updatedAt: new Date('2026-10-23T00:00:00Z') })]);
    const out = await confirmBlock(userSession(P1, U1), B1);
    expect(out.status).toBe('confirmed');
    // 1: the guarded confirm; 2: supersede the other live blocks of the same key (the human's choice wins).
    expect(h.updates).toHaveLength(2);
    expect(h.updates[0]!.set.status).toBe('confirmed');
    // DB clock (now()), not the API host's — the insert default is now() too, so no cross-clock skew.
    expect(sqlOf(h.updates[0]!.set.updatedAt).text).toMatch(/now\(\)/);
    const where = sqlOf(h.updates[0]!.where);
    expect(where.text).toMatch(/"status" <> \$\d/);
    expect(where.params).toContain('retracted');
    expect(h.updates[1]!.set.supersededById).toBe(B1);
  });

  it('confirmBlock: already confirmed is idempotent (returns the row, no update)', async () => {
    h.selectRows.push([row({ status: 'confirmed' })]);
    const out = await confirmBlock(userSession(P1, U1), B1);
    expect(out.status).toBe('confirmed');
    expect(h.updates).toHaveLength(0);
  });

  it('confirmBlock on a retracted block throws MemoryServiceError code retracted', async () => {
    h.selectRows.push([row({ status: 'retracted' })]);
    expect(await codeOf(confirmBlock(userSession(P1, U1), B1))).toBe('retracted');
    expect(h.updates).toHaveLength(0);
  });

  it('confirmBlock: a retract that lands between the read and the UPDATE surfaces as retracted (0 rows → re-read)', async () => {
    h.selectRows.push([row()], [row({ status: 'retracted' })]);
    h.updateReturning.push([]);
    expect(await codeOf(confirmBlock(userSession(P1, U1), B1))).toBe('retracted');
  });

  it('retractBlock: any non-retracted status → retracted; already retracted is idempotent', async () => {
    for (const status of ['unconfirmed', 'confirmed'] as const) {
      h.updates.length = 0;
      h.selectRows.push([row({ status })]);
      h.updateReturning.push([row({ status: 'retracted' })]);
      const out = await retractBlock(userSession(P1, U1), B1);
      expect(out.status).toBe('retracted');
      expect(h.updates[0]!.set.status).toBe('retracted');
    }
    h.updates.length = 0;
    h.selectRows.push([row({ status: 'retracted' })]);
    expect((await retractBlock(userSession(P1, U1), B1)).status).toBe('retracted');
    expect(h.updates).toHaveLength(0);
  });

  it('confirm/retract on a partner-owned block need canManagePartnerWidePolicies (code partner_wide_write_denied)', async () => {
    const partnerRow = row({ ownerKind: 'partner', ownerUserId: null });
    h.selectRows.push([partnerRow]);
    expect(await codeOf(confirmBlock(userSession(P1, U1, 'partner', 'selected'), B1))).toBe('partner_wide_write_denied');
    h.selectRows.push([partnerRow]);
    expect(await codeOf(retractBlock(userSession(P1, U1, 'partner', 'selected'), B1))).toBe('partner_wide_write_denied');
    expect(h.updates).toHaveLength(0);
    // control: a full-access partner admin may
    h.selectRows.push([partnerRow]);
    h.updateReturning.push([{ ...partnerRow, status: 'confirmed' }]);
    expect((await confirmBlock(userSession(P1, U1, 'partner', 'all'), B1)).status).toBe('confirmed');
  });

  it('confirm/retract refuse a non-user_session principal (code human_only) before any query', async () => {
    expect(await codeOf(confirmBlock(agentAuth(), B1))).toBe('human_only');
    expect(await codeOf(retractBlock(agentAuth(), B1))).toBe('human_only');
    expect(h.calls).toEqual([]);
  });

  it('a block RLS hides surfaces as not_found (select returns [])', async () => {
    h.selectRows.push([]);
    expect(await codeOf(confirmBlock(userSession(P1, U2), B1))).toBe('not_found');
    h.selectRows.push([]);
    expect(await codeOf(retractBlock(userSession(P1, U2), B1))).toBe('not_found');
    expect(h.updates).toHaveLength(0);
  });

  it('listBlocksForPartner on an organization-scope auth returns [] without querying', async () => {
    expect(await listBlocksForPartner(userSession(P1, U1, 'organization', null))).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it('list reads exclude superseded rows (retracted stay visible) and filter by owner', async () => {
    h.selectRows.push([row(), row({ id: B0, status: 'retracted' })]);
    const mine = await listBlocksForUser(userSession(P1, U1));
    expect(mine.map((b) => b.status)).toEqual(['unconfirmed', 'retracted']);
    const w = sqlOf(h.selectWheres[0]!.where);
    expect(w.text).toContain('"superseded_by_id" is null');
    expect(w.text).not.toContain('"status"');
    expect(w.params).toEqual(expect.arrayContaining(['user', U1]));
    expect(h.selectWheres[0]!.system).toBe(false);

    h.selectRows.push([row({ ownerKind: 'org', ownerUserId: null, ownerOrgId: O1 })]);
    await listBlocksForOrg(userSession(P1, U1), O1);
    expect(sqlOf(h.selectWheres[1]!.where).params).toEqual(expect.arrayContaining(['org', O1]));

    h.selectRows.push([]);
    await listBlocksForPartner(userSession(P1, U1));
    expect(sqlOf(h.selectWheres[2]!.where).params).toEqual(expect.arrayContaining(['partner', P1]));
  });

  it('listBlocksForOrg refuses an org the caller cannot reach (not_found) without querying', async () => {
    expect(await codeOf(listBlocksForOrg(userSession(P1, U1), O2))).toBe('not_found');
    expect(h.calls).toEqual([]);
  });

  describe('listUserBlocksForPartnerAdmin', () => {
    const admin = () => userSession(P1, U1, 'partner', 'all');

    it('refuses without canManagePartnerWidePolicies, before any query', async () => {
      expect(await codeOf(listUserBlocksForPartnerAdmin(userSession(P1, U1, 'partner', 'selected'), U2)))
        .toBe('partner_wide_write_denied');
      expect(await codeOf(listUserBlocksForPartnerAdmin(userSession(P1, U1, 'organization', null), U2)))
        .toBe('partner_wide_write_denied');
      expect(await codeOf(listUserBlocksForPartnerAdmin(agentAuth(), U2))).toBe('human_only');
      expect(h.calls).toEqual([]);
      expect(h.auditMock).not.toHaveBeenCalled();
    });

    it('refuses a user from another partner (code cross_partner) — and an invisible user — with no system read and no audit', async () => {
      h.selectRows.push([{ partnerId: P2 }]);
      expect(await codeOf(listUserBlocksForPartnerAdmin(admin(), U2))).toBe('cross_partner');
      h.selectRows.push([]);
      expect(await codeOf(listUserBlocksForPartnerAdmin(admin(), U2))).toBe('cross_partner');
      expect(h.calls).toEqual(['select', 'select']);
      expect(h.auditMock).not.toHaveBeenCalled();
    });

    it('reads under system context filtered by tenant_partner_id = auth.partnerId, and writes exactly one audit row', async () => {
      h.selectRows.push([{ partnerId: P1 }], [row({ ownerUserId: U2 }), row({ id: B0, ownerUserId: U2 })]);
      const out = await listUserBlocksForPartnerAdmin(admin(), U2);
      expect(out).toHaveLength(2);
      expect(h.calls).toEqual(['select', 'outside', 'select:system', 'audit']);
      expect(h.systemLabels).toEqual(['wisp.memoryService.adminView']);
      const w = sqlOf(h.selectWheres[1]!.where);
      expect(h.selectWheres[1]!.system).toBe(true);
      expect(w.text).toContain('"tenant_partner_id" = $');
      expect(w.text).toContain('"superseded_by_id" is null');
      expect(w.params).toEqual(expect.arrayContaining(['user', U2, P1]));
      expect(h.auditMock).toHaveBeenCalledTimes(1);
      expect(h.auditMock.mock.calls[0]![0]).toMatchObject({
        orgId: null, partnerId: P1, actorType: 'user', actorId: U1, actorEmail: `${U1}@example.com`,
        action: 'wisp.memory.user_blocks_viewed', resourceType: 'ai_memory_blocks', resourceId: U2,
        details: { count: 2 }, result: 'success',
      });
    });

    it('a failed audit write fails the read (no data is returned unaudited)', async () => {
      h.selectRows.push([{ partnerId: P1 }], [row({ ownerUserId: U2 })]);
      h.auditMock.mockRejectedValueOnce(new Error('audit down'));
      await expect(listUserBlocksForPartnerAdmin(admin(), U2)).rejects.toThrow('audit down');
    });
  });

  describe('recordHumanBlock', () => {
    const input = (over: Record<string, unknown> = {}) => ({
      owner: { kind: 'user' as const, userId: U1 },
      blockType: 'preference' as const,
      subjectKey: 'nudge_feedback:device:high',
      content: { verdict: 'not_useful' },
      confidence: 'high' as const,
      authoredByGrantId: G1,
      ...over,
    });

    it('a user owner that is not auth.user.id is refused before any write', async () => {
      expect(await codeOf(recordHumanBlock(userSession(P1, U1), input({ owner: { kind: 'user', userId: U2 } }))))
        .toBe('owner_mismatch');
      expect(h.calls).toEqual([]);
    });

    it('a non-user_session principal is refused', async () => {
      expect(await codeOf(recordHumanBlock(agentAuth(), input()))).toBe('human_only');
      expect(h.calls).toEqual([]);
    });

    it('lands confirmed, keeps the grant id, nulls the revision, supersedes the prior block — in one transaction', async () => {
      const created = row({ id: B1, status: 'confirmed', confidence: 'high', authoredByGrantId: G1, content: { verdict: 'not_useful' } });
      h.insertReturning.push([created]);
      const out = await recordHumanBlock(userSession(P1, U1), input());
      expect(out.status).toBe('confirmed');
      expect(out.authoredByGrantId).toBe(G1);
      expect(out.authoredByGrantRevisionId).toBeNull();
      expect(h.calls).toEqual(['tx', 'execute', 'insert', 'update']);
      const lock = sqlOf(h.executes[0]);
      expect(lock.text).toContain('pg_advisory_xact_lock');
      // Postgres text rejects NUL (22021): the lock key must never carry one.
      expect(lock.params.some((p) => typeof p === 'string' && p.includes('\u0000'))).toBe(false);
      // Same key shape as memoryBroker.rememberForGrant, so human and agent writes on one key share the lock.
      expect(lock.params).toContain(JSON.stringify([P1, 'user', U1, 'preference', 'nudge_feedback:device:high']));
      expect(h.inserts[0]).toMatchObject({
        tenantPartnerId: P1, ownerKind: 'user', ownerUserId: U1, ownerOrgId: null,
        blockType: 'preference', subjectKey: 'nudge_feedback:device:high', status: 'confirmed', confidence: 'high',
        authoredByGrantId: G1, authoredByGrantRevisionId: null, sourceSessionId: null,
      });
      expect(h.updates[0]!.set).toMatchObject({ supersededById: B1 });
      const w = sqlOf(h.updates[0]!.where);
      expect(w.text).toContain('"superseded_by_id" is null');
      expect(w.text).toMatch(/"status" <> \$\d/);
      expect(w.text).toMatch(/"id" <> \$\d/);
      expect(w.params).toEqual(expect.arrayContaining([P1, 'user', U1, 'preference', 'nudge_feedback:device:high', 'retracted', B1]));
    });

    it('owner { kind: "user" } without a userId resolves to auth.user.id (the W06 call shape)', async () => {
      h.insertReturning.push([row({ status: 'confirmed' })]);
      await recordHumanBlock(userSession(P1, U1), input({ owner: { kind: 'user' } }));
      expect(h.inserts[0]).toMatchObject({ ownerKind: 'user', ownerUserId: U1, tenantPartnerId: P1 });
    });

    it('user-owned memory needs a partner-scope session (an org token has no partner anchor)', async () => {
      expect(await codeOf(recordHumanBlock(userSession(null, U1, 'organization', null), input({ owner: { kind: 'user' } }))))
        .toBe('owner_mismatch');
      expect(h.calls).toEqual([]);
    });

    it('org owner: refused when unreachable; anchored on the org row’s partner when reachable', async () => {
      expect(await codeOf(recordHumanBlock(userSession(P1, U1), input({ owner: { kind: 'org', orgId: O2 } }))))
        .toBe('owner_mismatch');
      expect(h.calls).toEqual([]);

      h.selectRows.push([{ partnerId: P1 }]);
      h.insertReturning.push([row({ ownerKind: 'org', ownerUserId: null, ownerOrgId: O1, status: 'confirmed' })]);
      await recordHumanBlock(userSession(null, U1, 'organization', null, [O1]), input({ owner: { kind: 'org', orgId: O1 } }));
      expect(h.inserts[0]).toMatchObject({ tenantPartnerId: P1, ownerKind: 'org', ownerOrgId: O1, ownerUserId: null });
    });

    it('partner owner needs canManagePartnerWidePolicies', async () => {
      expect(await codeOf(recordHumanBlock(userSession(P1, U1, 'partner', 'selected'), input({ owner: { kind: 'partner' } }))))
        .toBe('partner_wide_write_denied');
      expect(h.calls).toEqual([]);
      h.insertReturning.push([row({ ownerKind: 'partner', ownerUserId: null, status: 'confirmed' })]);
      await recordHumanBlock(userSession(P1, U1, 'partner', 'all'), input({ owner: { kind: 'partner' } }));
      expect(h.inserts[0]).toMatchObject({ tenantPartnerId: P1, ownerKind: 'partner', ownerUserId: null, ownerOrgId: null });
    });

    it('validates subject key, content, closed lists and ids before any write (code invalid_memory)', async () => {
      const bad = [
        input({ subjectKey: '' }),
        input({ subjectKey: '   ' }),
        input({ subjectKey: 'x'.repeat(281) }),
        input({ content: [] }),
        input({ content: null }),
        input({ content: 'text' }),
        input({ content: { blob: 'x'.repeat(8_200) } }),
        input({ blockType: 'rumor' }),
        input({ confidence: 'certain' }),
        input({ authoredByGrantId: 'not-a-uuid' }),
        input({ sourceSessionId: 'not-a-uuid' }),
      ];
      for (const b of bad) {
        expect(await codeOf(recordHumanBlock(userSession(P1, U1), b as never))).toBe('invalid_memory');
      }
      expect(h.calls).toEqual([]);
    });

    it('a sourceSessionId the caller cannot see is refused (invalid_memory); a visible one is stamped', async () => {
      const S1 = '12121212-1212-4212-8212-121212121212';
      h.selectRows.push([]);
      expect(await codeOf(recordHumanBlock(userSession(P1, U1), input({ sourceSessionId: S1 })))).toBe('invalid_memory');
      expect(h.inserts).toHaveLength(0);
      h.selectRows.push([{ id: S1 }]);
      h.insertReturning.push([row({ status: 'confirmed', sourceSessionId: S1 })]);
      await recordHumanBlock(userSession(P1, U1), input({ sourceSessionId: S1 }));
      expect(h.inserts[0]).toMatchObject({ sourceSessionId: S1 });
    });
  });
});

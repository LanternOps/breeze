/**
 * yara_rule_sets / yara_rules RLS (#6263 W03a, migration
 * 2026-12-30-230000-yara-rule-sets.sql).
 *
 * Proves, through the real postgres.js driver as breeze_app:
 *  - the dual-axis FOR ALL policy (org OR partner) and its WITH CHECK
 *    (cross-partner forge -> 42501);
 *  - the SELECT-only partner-wide branch (org tokens and agents READ their
 *    partner's partner-wide sets, never write them);
 *  - the SELECT-only built-in branch (everyone reads the built-in pack, only
 *    system scope writes it) and the CHECK that stops a tenant minting one;
 *  - the owner-inheritance triggers on yara_rules (a caller cannot lie about
 *    a rule's owner, and cannot write rules under a set it cannot write);
 *  - the agent-auth context (scope organization + currentPartnerId) the
 *    agent fetch route runs under.
 *
 * The partner-wide fan-out case (Partner-Wide First step 5) lives in
 * yaraScanRefs.integration.test.ts, next to the resolver it exercises.
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { yaraRuleSets, yaraRules } from '../../db/schema';
import { YARA_BUILTIN_RULE_SET_ID } from '@breeze/shared';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerCtx(partnerId: string, orgIds: string[] = []): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/** An org token: currentPartnerId is the token's own partner (buildDbAccessContext). */
function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/** Exactly the context middleware/agentAuth.ts opens for a device in `orgId`. */
function agentCtx(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

const as = <T>(ctx: DbAccessContext, fn: () => Promise<T>) => withDbAccessContext(ctx, fn);

async function ensureBuiltin(): Promise<void> {
  await as(SYSTEM_CTX, () =>
    db
      .insert(yaraRuleSets)
      .values({ id: YARA_BUILTIN_RULE_SET_ID, name: 'Built-in pack', source: 'builtin', isBuiltin: true })
      .onConflictDoNothing(),
  );
}

// The built-in row has no tenant FK, so cleanupDatabase()'s TRUNCATE of
// partners/organizations never reaches it. Leave the table as we found it.
afterAll(async () => {
  await as(SYSTEM_CTX, () => db.delete(yaraRuleSets).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID)));
});

interface World {
  P1: string; P2: string; O1a: string; O1b: string; O2: string;
  setO1a: string; setO1b: string; setP1: string; setP2: string; setO2: string;
}

async function seedWorld(): Promise<World> {
  const p1 = await createPartner();
  const p2 = await createPartner();
  const o1a = await createOrganization({ partnerId: p1.id });
  const o1b = await createOrganization({ partnerId: p1.id });
  const o2 = await createOrganization({ partnerId: p2.id });
  await ensureBuiltin();
  const mk = (orgId: string | null, partnerId: string | null, name: string) =>
    as(SYSTEM_CTX, async () => {
      const [row] = await db.insert(yaraRuleSets).values({ orgId, partnerId, name }).returning({ id: yaraRuleSets.id });
      return row!.id;
    });
  return {
    P1: p1.id, P2: p2.id, O1a: o1a.id, O1b: o1b.id, O2: o2.id,
    setO1a: await mk(o1a.id, null, 'O1a set'),
    setO1b: await mk(o1b.id, null, 'O1b set'),
    setP1: await mk(null, p1.id, 'P1 partner-wide'),
    setP2: await mk(null, p2.id, 'P2 partner-wide'),
    setO2: await mk(o2.id, null, 'O2 set'),
  };
}

const RULE = { name: 'r_one', source: 'rule r_one { condition: true }' };

describe('yara_rule_sets RLS', () => {
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('org O1a sees own-org, P1 partner-wide and built-in sets; not O1b, O2 or P2 sets', async () => {
    const ids = await as(orgCtx(w.O1a, w.P1), () => db.select({ id: yaraRuleSets.id }).from(yaraRuleSets));
    expect(new Set(ids.map((r) => r.id))).toEqual(new Set([w.setO1a, w.setP1, YARA_BUILTIN_RULE_SET_ID]));
  });

  it('partner P1 sees its orgs\' sets, its partner-wide set and the built-in; nothing of P2', async () => {
    const ids = await as(partnerCtx(w.P1, [w.O1a, w.O1b]), () => db.select({ id: yaraRuleSets.id }).from(yaraRuleSets));
    expect(new Set(ids.map((r) => r.id))).toEqual(
      new Set([w.setO1a, w.setO1b, w.setP1, YARA_BUILTIN_RULE_SET_ID]),
    );
  });

  it('org O1a cannot UPDATE or DELETE a P1 partner-wide set (SELECT-only branch)', async () => {
    const updated = await as(orgCtx(w.O1a, w.P1), () =>
      db.update(yaraRuleSets).set({ name: 'HIJACKED' }).where(eq(yaraRuleSets.id, w.setP1)).returning({ id: yaraRuleSets.id }),
    );
    expect(updated).toEqual([]);
    const deleted = await as(orgCtx(w.O1a, w.P1), () =>
      db.delete(yaraRuleSets).where(eq(yaraRuleSets.id, w.setP1)).returning({ id: yaraRuleSets.id }),
    );
    expect(deleted).toEqual([]);
  });

  it('nobody but system can UPDATE or DELETE the built-in set', async () => {
    for (const ctx of [orgCtx(w.O1a, w.P1), partnerCtx(w.P1, [w.O1a, w.O1b])]) {
      const updated = await as(ctx, () =>
        db.update(yaraRuleSets).set({ enabled: false }).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID)).returning({ id: yaraRuleSets.id }),
      );
      expect(updated).toEqual([]);
      const deleted = await as(ctx, () =>
        db.delete(yaraRuleSets).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID)).returning({ id: yaraRuleSets.id }),
      );
      expect(deleted).toEqual([]);
    }
    const sys = await as(SYSTEM_CTX, () =>
      db.update(yaraRuleSets).set({ description: 'touched' }).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID)).returning({ id: yaraRuleSets.id }),
    );
    expect(sys).toHaveLength(1);
  });

  it('partner P1 cannot forge a P2-owned set (42501)', async () => {
    await expect(
      as(partnerCtx(w.P1), () => db.insert(yaraRuleSets).values({ partnerId: w.P2, name: 'forged' })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org O1a cannot create a set for O1b (42501) nor a partner-wide set (42501)', async () => {
    await expect(
      as(orgCtx(w.O1a, w.P1), () => db.insert(yaraRuleSets).values({ orgId: w.O1b, name: 'forged' })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      as(orgCtx(w.O1a, w.P1), () => db.insert(yaraRuleSets).values({ partnerId: w.P1, name: 'forged' })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a tenant cannot mint a built-in on a row it owns (23514)', async () => {
    await expect(
      as(partnerCtx(w.P1), () => db.insert(yaraRuleSets).values({ partnerId: w.P1, isBuiltin: true, source: 'builtin', name: 'f' })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('a tenant cannot turn its own set into a built-in (23514)', async () => {
    await expect(
      as(partnerCtx(w.P1), () =>
        db.update(yaraRuleSets).set({ isBuiltin: true, source: 'builtin', partnerId: null }).where(eq(yaraRuleSets.id, w.setP1)),
      ),
    ).rejects.toMatchObject({ cause: { code: expect.stringMatching(/^(23514|42501)$/) } });
  });

  it('XOR: both owners set, or neither on a non-built-in, is rejected (23514)', async () => {
    await expect(
      as(SYSTEM_CTX, () => db.insert(yaraRuleSets).values({ orgId: w.O1a, partnerId: w.P1, name: 'both' })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      as(SYSTEM_CTX, () => db.insert(yaraRuleSets).values({ name: 'neither' })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('source "builtin" is reserved for the built-in row (23514)', async () => {
    await expect(
      as(SYSTEM_CTX, () => db.insert(yaraRuleSets).values({ orgId: w.O1a, source: 'builtin', name: 'liar' })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('only one built-in row can exist (23505)', async () => {
    await expect(
      as(SYSTEM_CTX, () => db.insert(yaraRuleSets).values({ name: 'second builtin', source: 'builtin', isBuiltin: true })),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('a published version needs bundle bytes and a lowercase sha256 (23514)', async () => {
    await expect(
      as(SYSTEM_CTX, () =>
        db.update(yaraRuleSets).set({ currentVersion: 1, publishedVersion: 1 }).where(eq(yaraRuleSets.id, w.setO1a)),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      as(SYSTEM_CTX, () =>
        db.update(yaraRuleSets).set({
          currentVersion: 1, publishedVersion: 1, publishedBundle: Buffer.from('{}'), publishedSha256: 'A'.repeat(64),
        }).where(eq(yaraRuleSets.id, w.setO1a)),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('the agent-auth context of a device in O1a sees O1a, P1-wide and built-in sets only', async () => {
    const ids = await as(agentCtx(w.O1a, w.P1), () => db.select({ id: yaraRuleSets.id }).from(yaraRuleSets));
    expect(new Set(ids.map((r) => r.id))).toEqual(new Set([w.setO1a, w.setP1, YARA_BUILTIN_RULE_SET_ID]));
  });

  it('the agent-auth context cannot write any set, even its own org\'s partner-wide one', async () => {
    const updated = await as(agentCtx(w.O1a, w.P1), () =>
      db.update(yaraRuleSets).set({ name: 'x' }).where(inArray(yaraRuleSets.id, [w.setP1, YARA_BUILTIN_RULE_SET_ID])).returning({ id: yaraRuleSets.id }),
    );
    expect(updated).toEqual([]);
  });
});

describe('yara_rules RLS + owner inheritance', () => {
  let w: World;
  beforeEach(async () => {
    w = await seedWorld();
  });

  it('a rule inherits its owner from the parent set even if the caller lies', async () => {
    const [row] = await as(partnerCtx(w.P1, [w.O1a]), () =>
      db.insert(yaraRules).values({ ...RULE, ruleSetId: w.setP1, orgId: w.O1a, isBuiltin: true }).returning(),
    );
    expect(row!.orgId).toBeNull();
    expect(row!.partnerId).toBe(w.P1);
    expect(row!.isBuiltin).toBe(false);
  });

  it('an UPDATE cannot move a rule\'s owner away from its parent', async () => {
    const [row] = await as(orgCtx(w.O1a, w.P1), () =>
      db.insert(yaraRules).values({ ...RULE, ruleSetId: w.setO1a }).returning(),
    );
    const [after] = await as(SYSTEM_CTX, () =>
      db.update(yaraRules).set({ orgId: w.O1b }).where(eq(yaraRules.id, row!.id)).returning(),
    );
    expect(after!.orgId).toBe(w.O1a);
  });

  it('org O1a cannot insert a rule into a P1 partner-wide set (42501)', async () => {
    await expect(
      as(orgCtx(w.O1a, w.P1), () => db.insert(yaraRules).values({ ...RULE, ruleSetId: w.setP1 })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org O1a cannot insert a rule into the built-in set (42501)', async () => {
    await expect(
      as(orgCtx(w.O1a, w.P1), () => db.insert(yaraRules).values({ ...RULE, ruleSetId: YARA_BUILTIN_RULE_SET_ID })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a caller who cannot see the parent set gets 23503, not a row under someone else\'s set', async () => {
    await expect(
      as(orgCtx(w.O1a, w.P1), () => db.insert(yaraRules).values({ ...RULE, ruleSetId: w.setO2 })),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('rule visibility follows the parent: O1a reads its own, P1-wide and built-in rules only', async () => {
    const insertAs = (ctx: DbAccessContext, ruleSetId: string, name: string) =>
      as(ctx, async () => (await db.insert(yaraRules).values({ name, source: `rule ${name} { condition: true }`, ruleSetId }).returning())[0]!.id);
    const own = await insertAs(orgCtx(w.O1a, w.P1), w.setO1a, 'own_rule');
    const sibling = await insertAs(orgCtx(w.O1b, w.P1), w.setO1b, 'sibling_rule');
    const pw = await insertAs(partnerCtx(w.P1), w.setP1, 'pw_rule');
    const foreign = await insertAs(partnerCtx(w.P2), w.setP2, 'foreign_rule');
    const builtin = await insertAs(SYSTEM_CTX, YARA_BUILTIN_RULE_SET_ID, 'builtin_rule');

    const ids = await as(orgCtx(w.O1a, w.P1), () => db.select({ id: yaraRules.id }).from(yaraRules));
    const seen = new Set(ids.map((r) => r.id));
    expect(seen.has(own)).toBe(true);
    expect(seen.has(pw)).toBe(true);
    expect(seen.has(builtin)).toBe(true);
    expect(seen.has(sibling)).toBe(false);
    expect(seen.has(foreign)).toBe(false);

    await as(SYSTEM_CTX, () => db.delete(yaraRules).where(eq(yaraRules.id, builtin)));
  });

  it('an owner change on the parent (org merge repoint) rewrites the children', async () => {
    const [rule] = await as(orgCtx(w.O1a, w.P1), () =>
      db.insert(yaraRules).values({ ...RULE, ruleSetId: w.setO1a }).returning(),
    );
    await as(SYSTEM_CTX, () => db.update(yaraRuleSets).set({ orgId: w.O1b }).where(eq(yaraRuleSets.id, w.setO1a)));
    const [after] = await as(SYSTEM_CTX, () => db.select().from(yaraRules).where(eq(yaraRules.id, rule!.id)));
    expect(after!.orgId).toBe(w.O1b);
  });

  it('a rule name must be a YARA identifier (23514)', async () => {
    await expect(
      as(orgCtx(w.O1a, w.P1), () => db.insert(yaraRules).values({ name: '1bad-name', source: 'x', ruleSetId: w.setO1a })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

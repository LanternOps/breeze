/**
 * YARA rule sets through org merge and org erasure (#6263 W03a, plan Review
 * Focus #5). yara_rule_sets is a plain `repoint`; yara_rules is `derived`
 * (its owner columns are trigger-copied from the parent), so the merge never
 * writes yara_rules directly — the parent repoint's
 * yara_rule_sets_propagate_owner trigger must carry the rules along. Erasure
 * cascades both; partner-wide and built-in rows are untouched by either.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { YARA_BUILTIN_RULE_SET_ID } from '@breeze/shared';
import { withSystemDbAccessContext } from '../../db';
import { yaraRuleSets, yaraRules } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import { executeOrgMerge } from '../../services/orgMerge';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

async function seed() {
  const db = getTestDb() as any;
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const loser = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const actor = await createUser({ partnerId: partner.id });
    await db.insert(yaraRuleSets)
      .values({ id: YARA_BUILTIN_RULE_SET_ID, name: 'Built-in pack', source: 'builtin', isBuiltin: true })
      .onConflictDoNothing();
    const [orgSet] = await db.insert(yaraRuleSets).values({ orgId: loser.id, name: 'loser set' }).returning({ id: yaraRuleSets.id });
    const [pwSet] = await db.insert(yaraRuleSets).values({ partnerId: partner.id, name: 'partner-wide' }).returning({ id: yaraRuleSets.id });
    const [orgRule] = await db.insert(yaraRules)
      .values({ ruleSetId: orgSet.id, name: 'loser_rule', source: 'rule loser_rule { condition: true }' })
      .returning({ id: yaraRules.id });
    const [pwRule] = await db.insert(yaraRules)
      .values({ ruleSetId: pwSet.id, name: 'pw_rule', source: 'rule pw_rule { condition: true }' })
      .returning({ id: yaraRules.id });
    return {
      partnerId: partner.id, loserId: loser.id, survivorId: survivor.id, actorId: actor.id,
      orgSet: orgSet.id as string, pwSet: pwSet.id as string, orgRule: orgRule.id as string, pwRule: pwRule.id as string,
    };
  });
}

const read = <T>(fn: (db: any) => Promise<T>) => withSystemDbAccessContext(() => fn(getTestDb() as any));

describe('yara rule sets through org merge / erasure', () => {
  it('a merge repoints the loser\'s sets AND their rules (derived) to the survivor; partner-wide untouched', async () => {
    const s = await seed();
    await executeOrgMerge({ loserOrgId: s.loserId, survivorOrgId: s.survivorId, partnerId: s.partnerId, performedBy: s.actorId });

    const sets = await read((db) => db.select().from(yaraRuleSets).where(inArray(yaraRuleSets.id, [s.orgSet, s.pwSet])));
    const byId = new Map(sets.map((r: any) => [r.id, r]));
    expect((byId.get(s.orgSet) as any).orgId).toBe(s.survivorId);
    expect((byId.get(s.pwSet) as any)).toMatchObject({ orgId: null, partnerId: s.partnerId });

    const rules = await read((db) => db.select().from(yaraRules).where(inArray(yaraRules.id, [s.orgRule, s.pwRule])));
    const ruleById = new Map(rules.map((r: any) => [r.id, r]));
    expect((ruleById.get(s.orgRule) as any)).toMatchObject({ orgId: s.survivorId, partnerId: null });
    expect((ruleById.get(s.pwRule) as any)).toMatchObject({ orgId: null, partnerId: s.partnerId });

    const stranded = await read((db) => db.select({ id: yaraRules.id }).from(yaraRules).where(eq(yaraRules.orgId, s.loserId)));
    expect(stranded).toEqual([]);
  }, 120000);

  it('erasing an org deletes its sets and rules; partner-wide and built-in survive', async () => {
    const s = await seed();
    await cascadeDeleteOrg(s.loserId, s.actorId);

    const sets = await read((db) => db.select({ id: yaraRuleSets.id }).from(yaraRuleSets)
      .where(inArray(yaraRuleSets.id, [s.orgSet, s.pwSet, YARA_BUILTIN_RULE_SET_ID])));
    expect(new Set(sets.map((r: any) => r.id))).toEqual(new Set([s.pwSet, YARA_BUILTIN_RULE_SET_ID]));
    const rules = await read((db) => db.select({ id: yaraRules.id }).from(yaraRules).where(inArray(yaraRules.id, [s.orgRule, s.pwRule])));
    expect(rules.map((r: any) => r.id)).toEqual([s.pwRule]);

    await read((db) => db.delete(yaraRuleSets).where(eq(yaraRuleSets.id, YARA_BUILTIN_RULE_SET_ID)));
  }, 120000);
});

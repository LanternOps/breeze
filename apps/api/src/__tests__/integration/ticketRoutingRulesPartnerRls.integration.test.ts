/**
 * Ticket routing rules — dual-axis (org XOR partner) RLS, the org-links
 * parent join, the same-partner reference guard and the delete semantics of
 * every reference (#8883 W5, plan Task 5.1).
 *
 * Migration under test: 2027-01-04-120000-ticket-routing-rules.sql.
 *   ticket_routing_rules_isolation (FOR ALL):
 *     system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *            OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *   ticket_routing_rules_partner_wide_select (FOR SELECT):
 *     org_id IS NULL AND partner_id = breeze_current_partner_id()
 *   ticket_routing_rules_org_member_select (FOR SELECT):
 *     org_id IS NULL AND an org of that partner passes breeze_has_org_access
 *   ticket_routing_rule_org_links_isolation (FOR ALL): parent-join
 *   ticket_routing_rule_org_links_parent_visible_select (FOR SELECT):
 *     the parent rule is readable under the caller's own RLS
 *
 * `rls-coverage.integration.test.ts` proves the policies exist; this suite
 * drives the real driver as breeze_app under FORCE RLS to prove they enforce.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  ticketCategories,
  ticketRoutingRuleOrgLinks,
  ticketRoutingRules,
  ticketStatuses,
  tickets,
  users,
} from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION = '2027-01-04-120000-ticket-routing-rules.sql';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId };
}

/** Org-scope token: carries its partner id (the partner-wide SELECT branch keys on it). */
function orgScopeContext(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId };
}

/** Org session: JWT partnerId is NULL (middleware/auth.ts) — only the org-member branch admits it. */
function orgSessionContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: null };
}

async function sqlState(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    return pgErrorCode(err) ?? `non-pg error: ${(err as Error).message}`;
  }
  return undefined;
}

async function constraintName(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    const e = err as { constraint_name?: string; cause?: { constraint_name?: string } };
    return e.constraint_name ?? e.cause?.constraint_name;
  }
  return undefined;
}

type Owner = { orgId: string | null; partnerId: string | null };
type RuleInsert = typeof ticketRoutingRules.$inferInsert;

const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

async function seedRule(owner: Owner, extra: Partial<RuleInsert> = {}) {
  return sys(async () => {
    const [rule] = await db.insert(ticketRoutingRules).values({
      ...owner, name: `Rule ${Math.random().toString(36).slice(2, 8)}`, setPriority: 'high', ...extra,
    }).returning();
    return rule!;
  });
}

async function seedLink(ruleId: string, orgId: string) {
  return sys(async () => (await db.insert(ticketRoutingRuleOrgLinks).values({ ruleId, orgId }).returning())[0]!);
}

async function seedCategory(partnerId: string) {
  return sys(async () => (await db.insert(ticketCategories).values({ partnerId, name: `Cat ${randomUUID().slice(0, 8)}` }).returning())[0]!);
}

async function seedStatus(partnerId: string, coreStatus: 'open' | 'pending' = 'pending') {
  return sys(async () => (await db.insert(ticketStatuses).values({ partnerId, name: `Status ${randomUUID().slice(0, 8)}`, coreStatus }).returning())[0]!);
}

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  return { partnerA: partnerA!, partnerB: partnerB!, orgA1: orgA1!, orgA2: orgA2!, orgB1: orgB1! };
}

const ruleIds = (ctx: DbAccessContext) => withDbAccessContext(ctx, async () =>
  (await db.select({ id: ticketRoutingRules.id }).from(ticketRoutingRules)).map((r) => r.id).sort());

describe(`ticket routing rules partner RLS (#8883 W5 Task 5.1, ${MIGRATION})`, () => {
  describe('RLS forge: another tenant cannot write rows it does not own (42501)', () => {
    runDb("partner B forging partner A's rule, or a link on partner A's rule, is rejected", async () => {
      const { partnerA, partnerB, orgA1 } = await fixture();
      const wide = await seedRule({ orgId: null, partnerId: partnerA.id });
      const asB = <T>(fn: () => Promise<T>) => withDbAccessContext(partnerContext(partnerB.id, []), fn);
      expect(await sqlState(() => asB(() => db.insert(ticketRoutingRules).values({ orgId: null, partnerId: partnerA.id, name: 'forged', setPriority: 'low' })))).toBe('42501');
      expect(await sqlState(() => asB(() => db.insert(ticketRoutingRuleOrgLinks).values({ ruleId: wide.id, orgId: orgA1.id })))).toBe('42501');
    });

    runDb("org A2 forging org A1's org_id is rejected", async () => {
      const { partnerA, orgA1, orgA2 } = await fixture();
      expect(await sqlState(() => withDbAccessContext(orgScopeContext(orgA2.id, partnerA.id), () =>
        db.insert(ticketRoutingRules).values({ orgId: orgA1.id, partnerId: null, name: 'forged', setPriority: 'low' })))).toBe('42501');
    });

    runDb('an org token cannot add a link to its partner-wide rule (read-only branch)', async () => {
      const { partnerA, orgA1 } = await fixture();
      const wide = await seedRule({ orgId: null, partnerId: partnerA.id });
      expect(await sqlState(() => withDbAccessContext(orgScopeContext(orgA1.id, partnerA.id), () =>
        db.insert(ticketRoutingRuleOrgLinks).values({ ruleId: wide.id, orgId: orgA1.id })))).toBe('42501');
    });
  });

  runDb('both owners and neither owner violate ticket_routing_rules_one_owner_chk (23514)', async () => {
    const { partnerA, orgA1 } = await fixture();
    for (const owner of [{ orgId: orgA1.id, partnerId: partnerA.id }, { orgId: null, partnerId: null }]) {
      const insert = () => sys(() => db.insert(ticketRoutingRules).values({ ...owner, name: 'x', setPriority: 'low' }));
      expect(await sqlState(insert)).toBe('23514');
      expect(await constraintName(insert)).toBe('ticket_routing_rules_one_owner_chk');
    }
  });

  runDb('more than 20 subject keywords violate ticket_routing_rules_keywords_chk (23514)', async () => {
    const { partnerA } = await fixture();
    const insert = () => seedRule({ orgId: null, partnerId: partnerA.id }, { matchSubjectKeywords: Array.from({ length: 21 }, (_, i) => `kw${i}`) });
    expect(await constraintName(insert)).toBe('ticket_routing_rules_keywords_chk');
    expect(await sqlState(() => seedRule({ orgId: null, partnerId: partnerA.id }, { matchSubjectKeywords: Array.from({ length: 20 }, (_, i) => `kw${i}`) }))).toBeUndefined();
  });

  describe('read visibility', () => {
    runDb('an org-scope token reads its own org rules and its partner-wide rules, but cannot UPDATE/DELETE a partner-wide row', async () => {
      const { partnerA, partnerB, orgA1, orgA2 } = await fixture();
      const wide = await seedRule({ orgId: null, partnerId: partnerA.id });
      const own = await seedRule({ orgId: orgA1.id, partnerId: null });
      await seedRule({ orgId: orgA2.id, partnerId: null });
      await seedRule({ orgId: null, partnerId: partnerB.id });
      const ctx = orgScopeContext(orgA1.id, partnerA.id);

      expect(await ruleIds(ctx)).toEqual([wide.id, own.id].sort());

      const touched = await withDbAccessContext(ctx, async () => ({
        upd: (await db.update(ticketRoutingRules).set({ name: 'hijacked' }).where(eq(ticketRoutingRules.id, wide.id)).returning()).length,
        del: (await db.delete(ticketRoutingRules).where(eq(ticketRoutingRules.id, wide.id)).returning()).length,
      }));
      expect(touched).toEqual({ upd: 0, del: 0 });
      const [still] = await sys(() => db.select().from(ticketRoutingRules).where(eq(ticketRoutingRules.id, wide.id)));
      expect(still?.name).not.toBe('hijacked');
    });

    runDb('an org SESSION (currentPartnerId NULL) sees the same partner-wide rows, read-only, via _org_member_select', async () => {
      const { partnerA, partnerB, orgA1 } = await fixture();
      const wide = await seedRule({ orgId: null, partnerId: partnerA.id });
      const own = await seedRule({ orgId: orgA1.id, partnerId: null });
      await seedRule({ orgId: null, partnerId: partnerB.id });
      const ctx = orgSessionContext(orgA1.id);

      expect(await ruleIds(ctx)).toEqual([wide.id, own.id].sort());
      const touched = await withDbAccessContext(ctx, async () => ({
        upd: (await db.update(ticketRoutingRules).set({ enabled: false }).where(eq(ticketRoutingRules.id, wide.id)).returning()).length,
        del: (await db.delete(ticketRoutingRules).where(eq(ticketRoutingRules.id, wide.id)).returning()).length,
      }));
      expect(touched).toEqual({ upd: 0, del: 0 });
    });

    runDb('org isolation: a sibling org and another partner see none of an org-owned rule', async () => {
      const { partnerA, partnerB, orgA1, orgA2, orgB1 } = await fixture();
      const own = await seedRule({ orgId: orgA1.id, partnerId: null });
      const sees = (ctx: DbAccessContext) => withDbAccessContext(ctx, async () =>
        (await db.select({ id: ticketRoutingRules.id }).from(ticketRoutingRules).where(eq(ticketRoutingRules.id, own.id))).length);
      expect(await sees(orgScopeContext(orgA2.id, partnerA.id))).toBe(0);
      expect(await sees(orgSessionContext(orgA2.id))).toBe(0);
      expect(await sees(orgScopeContext(orgB1.id, partnerB.id))).toBe(0);
      expect(await sees(partnerContext(partnerB.id, [orgB1.id]))).toBe(0);
      expect(await sees(partnerContext(partnerA.id, [orgA1.id, orgA2.id]))).toBe(1);
    });
  });

  describe('org links (parent join)', () => {
    runDb('a link is visible only through its rule; another partner sees none', async () => {
      const { partnerA, partnerB, orgA1, orgA2, orgB1 } = await fixture();
      const wide = await seedRule({ orgId: null, partnerId: partnerA.id });
      const l1 = await seedLink(wide.id, orgA1.id);
      const l2 = await seedLink(wide.id, orgA2.id);
      const links = (ctx: DbAccessContext) => withDbAccessContext(ctx, async () =>
        (await db.select({ id: ticketRoutingRuleOrgLinks.id }).from(ticketRoutingRuleOrgLinks).where(eq(ticketRoutingRuleOrgLinks.ruleId, wide.id))).map((r) => r.id).sort());
      expect(await links(partnerContext(partnerA.id, [orgA1.id, orgA2.id]))).toEqual([l1.id, l2.id].sort());
      expect(await links(partnerContext(partnerB.id, [orgB1.id]))).toEqual([]);
      expect(await links(orgScopeContext(orgB1.id, partnerB.id))).toEqual([]);
      expect(await links(orgSessionContext(orgB1.id))).toEqual([]);
      // The link's own org_id is NOT the tenancy axis: a (malformed) link on
      // partner A's rule naming partner B's org stays invisible to that org.
      await seedLink(wide.id, orgB1.id);
      expect(await links(orgSessionContext(orgB1.id))).toEqual([]);
      expect(await links(orgScopeContext(orgB1.id, partnerB.id))).toEqual([]);
    });

    runDb("an org context reads its OWN org's link of a partner-wide rule (the evaluator's allowlist read), never a sibling's", async () => {
      const { partnerA, orgA1, orgA2 } = await fixture();
      const wide = await seedRule({ orgId: null, partnerId: partnerA.id }, { orgScoped: true });
      const l1 = await seedLink(wide.id, orgA1.id);
      const l2 = await seedLink(wide.id, orgA2.id);
      const links = (ctx: DbAccessContext) => withDbAccessContext(ctx, async () =>
        (await db.select({ id: ticketRoutingRuleOrgLinks.id, orgId: ticketRoutingRuleOrgLinks.orgId })
          .from(ticketRoutingRuleOrgLinks).where(eq(ticketRoutingRuleOrgLinks.ruleId, wide.id))));
      expect(await links(orgScopeContext(orgA1.id, partnerA.id))).toEqual([{ id: l1.id, orgId: orgA1.id }]);
      expect(await links(orgSessionContext(orgA1.id))).toEqual([{ id: l1.id, orgId: orgA1.id }]);
      expect(await links(orgSessionContext(orgA2.id))).toEqual([{ id: l2.id, orgId: orgA2.id }]);
      // And the org contexts cannot delete their own link.
      const del = await withDbAccessContext(orgSessionContext(orgA1.id), async () =>
        (await db.delete(ticketRoutingRuleOrgLinks).where(eq(ticketRoutingRuleOrgLinks.id, l1.id)).returning()).length);
      expect(del).toBe(0);
    });

    runDb('only a partner-wide rule can be org_scoped (ticket_routing_rules_org_scoped_chk, 23514)', async () => {
      const { orgA1 } = await fixture();
      expect(await constraintName(() => seedRule({ orgId: orgA1.id, partnerId: null }, { orgScoped: true }))).toBe('ticket_routing_rules_org_scoped_chk');
    });

    runDb('deleting the only listed org leaves an org_scoped rule with no links — it stays limited (fail closed), never widened', async () => {
      const { partnerA } = await fixture();
      const doomed = await createOrganization({ partnerId: partnerA.id });
      const wide = await seedRule({ orgId: null, partnerId: partnerA.id }, { orgScoped: true });
      await seedLink(wide.id, doomed!.id);
      await sys(() => db.execute(sql`DELETE FROM organizations WHERE id = ${doomed!.id}`));
      const [after] = await sys(() => db.select().from(ticketRoutingRules).where(eq(ticketRoutingRules.id, wide.id)));
      expect(after?.orgScoped).toBe(true);
      expect(await sys(() => db.select().from(ticketRoutingRuleOrgLinks).where(eq(ticketRoutingRuleOrgLinks.ruleId, wide.id)))).toEqual([]);
    });

    runDb('duplicate (rule_id, org_id) violates ticket_routing_rule_org_links_rule_org_uq; deleting the rule cascades its links', async () => {
      const { partnerA, orgA1 } = await fixture();
      const wide = await seedRule({ orgId: null, partnerId: partnerA.id });
      await seedLink(wide.id, orgA1.id);
      expect(await constraintName(() => seedLink(wide.id, orgA1.id))).toBe('ticket_routing_rule_org_links_rule_org_uq');
      await sys(() => db.delete(ticketRoutingRules).where(eq(ticketRoutingRules.id, wide.id)));
      const left = await sys(() => db.select().from(ticketRoutingRuleOrgLinks).where(eq(ticketRoutingRuleOrgLinks.ruleId, wide.id)));
      expect(left).toEqual([]);
    });
  });

  describe('references', () => {
    runDb("deleting a user who is a rule's ONLY action succeeds and leaves a no-action rule (Gate B13)", async () => {
      const { partnerA, orgA1 } = await fixture();
      const user = await createUser({ partnerId: partnerA.id, email: `rr-only-${randomUUID().slice(0, 8)}@example.com` });
      const rule = await seedRule({ orgId: orgA1.id, partnerId: null }, { setPriority: null, setAssigneeUserId: user.id });
      expect(await sqlState(() => sys(() => db.delete(users).where(eq(users.id, user.id))))).toBeUndefined();
      const [after] = await sys(() => db.select().from(ticketRoutingRules).where(eq(ticketRoutingRules.id, rule.id)));
      expect(after).toMatchObject({ setAssigneeUserId: null, setPriority: null, setCategoryId: null, setStatusId: null, addTags: null });
    });

    runDb('references of another partner on an org-owned or partner-wide rule violate ticket_routing_rules_ref_partner_chk (23514, Gate B4)', async () => {
      const { partnerA, partnerB, orgA1 } = await fixture();
      const catB = await seedCategory(partnerB.id);
      const statusB = await seedStatus(partnerB.id);
      const userB = await createUser({ partnerId: partnerB.id, email: `rr-b-${randomUUID().slice(0, 8)}@example.com` });
      const orgOwned = { orgId: orgA1.id, partnerId: null };
      const wide = { orgId: null, partnerId: partnerA.id };
      for (const owner of [orgOwned, wide]) {
        for (const extra of [
          { matchCategoryId: catB.id },
          { setCategoryId: catB.id },
          { setStatusId: statusB.id },
          { setAssigneeUserId: userB.id },
        ] satisfies Partial<RuleInsert>[]) {
          const insert = () => seedRule(owner, extra);
          expect(await sqlState(insert), JSON.stringify({ owner, extra })).toBe('23514');
          expect(await constraintName(insert)).toBe('ticket_routing_rules_ref_partner_chk');
        }
      }
      // Same-partner references are accepted on an org-owned rule (partner resolved through the org).
      const catA = await seedCategory(partnerA.id);
      const statusA = await seedStatus(partnerA.id);
      const userA = await createUser({ partnerId: partnerA.id, email: `rr-a-${randomUUID().slice(0, 8)}@example.com` });
      expect(await sqlState(() => seedRule(orgOwned, { matchCategoryId: catA.id, setCategoryId: catA.id, setStatusId: statusA.id, setAssigneeUserId: userA.id }))).toBeUndefined();
    });

    runDb('re-pointing an org-owned rule to an org of another partner re-checks its references (UPDATE OF org_id)', async () => {
      const { partnerA, orgA1, orgB1 } = await fixture();
      const catA = await seedCategory(partnerA.id);
      const rule = await seedRule({ orgId: orgA1.id, partnerId: null }, { setCategoryId: catA.id });
      expect(await constraintName(() => sys(() => db.update(ticketRoutingRules).set({ orgId: orgB1.id }).where(eq(ticketRoutingRules.id, rule.id))))).toBe('ticket_routing_rules_ref_partner_chk');
    });

    runDb('deleting a referenced category or status is refused (23503, RESTRICT); deleting a referenced user nulls the action', async () => {
      const { partnerA } = await fixture();
      const cat = await seedCategory(partnerA.id);
      const cat2 = await seedCategory(partnerA.id);
      const status = await seedStatus(partnerA.id);
      const user = await createUser({ partnerId: partnerA.id, email: `rr-del-${randomUUID().slice(0, 8)}@example.com` });
      const wide = { orgId: null, partnerId: partnerA.id };
      await seedRule(wide, { matchCategoryId: cat.id });
      await seedRule(wide, { setCategoryId: cat2.id, setStatusId: status.id });
      const rule = await seedRule(wide, { setAssigneeUserId: user.id });

      expect(await sqlState(() => sys(() => db.delete(ticketCategories).where(eq(ticketCategories.id, cat.id))))).toBe('23503');
      expect(await sqlState(() => sys(() => db.delete(ticketCategories).where(eq(ticketCategories.id, cat2.id))))).toBe('23503');
      expect(await sqlState(() => sys(() => db.delete(ticketStatuses).where(eq(ticketStatuses.id, status.id))))).toBe('23503');
      await sys(() => db.delete(users).where(eq(users.id, user.id)));
      const [after] = await sys(() => db.select().from(ticketRoutingRules).where(eq(ticketRoutingRules.id, rule.id)));
      expect(after?.setAssigneeUserId).toBeNull();
      expect(after?.setPriority).toBe('high');
    });

    runDb('ticket_statuses_id_partner_id_key exists', async () => {
      const rows = await sys(() => db.execute(
        sql`SELECT conname FROM pg_constraint WHERE conname = 'ticket_statuses_id_partner_id_key' AND contype = 'u'`,
      ));
      expect(Array.from(rows as unknown as Array<{ conname: string }>).map((r) => r.conname)).toEqual(['ticket_statuses_id_partner_id_key']);
    });
  });

  runDb('tickets.routing_rule_id is nulled when its rule is deleted (tickets_routing_rule_id_fk ON DELETE SET NULL)', async () => {
    const { partnerA, orgA1 } = await fixture();
    const rule = await seedRule({ orgId: null, partnerId: partnerA.id });
    const [ticket] = await sys(() => db.insert(tickets).values({
      orgId: orgA1.id, partnerId: partnerA.id, ticketNumber: `RR-${randomUUID().slice(0, 8)}`, subject: 'routed', source: 'api', routingRuleId: rule.id,
    }).returning());
    await sys(() => db.delete(ticketRoutingRules).where(eq(ticketRoutingRules.id, rule.id)));
    const [after] = await sys(() => db.select({ routingRuleId: tickets.routingRuleId }).from(tickets).where(eq(tickets.id, ticket!.id)));
    expect(after?.routingRuleId).toBeNull();
  });
});

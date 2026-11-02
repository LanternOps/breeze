/**
 * Tool Catalog W06 (#5221) Task B7 — live RLS, owner guards, append-only claims
 * and the org-merge repoint for `flow_automation_conversions` and
 * `automation_occurrence_claims` (migration 2027-01-09-100000), driven on the
 * real connection as `breeze_app` under FORCE RLS.
 *
 *   *_isolation              FOR ALL     system OR breeze_has_org_access(org_id)
 *                                        OR breeze_has_partner_access(partner_id)
 *   *_partner_wide_select    FOR SELECT  org_id IS NULL
 *                                        AND partner_id = breeze_current_partner_id()
 *   owner guards (constraint triggers): a conversion's owner = its automation's
 *   AND its flow's; a claim's owner = its automation's; a switched automation's
 *   flow has the automation's owner.
 *   claims: append-only (UPDATE revoked except org_id; trigger refuses the rest).
 *
 * rls-coverage proves the policies EXIST. The guard-flip control proves the
 * isolation cases here would go red: the same probe, run in a rolled-back
 * transaction in which both isolation policies are `USING (true)`, sees the
 * other tenant's rows. All tenants are synthetic.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { automationOccurrenceClaims, automations, flowAutomationConversions, flows } from '../../db/schema';
import { executeOrgMerge } from '../../services/orgMerge';
import { createOrganization, createPartner, createUser } from './db-utils';
import { seedEnabledFlow } from './helpers/flowSeed';
import { expectSqlState, orgContext, partnerContext } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

// `breeze_test` (rolsuper on the test DB): ALTER POLICY and the append-only proof.
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

const PIN = { stepId: 'look', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null } as const;
const STEP = { id: 'look', tool: 'list_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 };
const DOC = { version: 1, name: 'Converted job', trigger: { type: 'event', event: 'device.offline', filter: {} }, inputs: [], steps: [STEP] };

interface Owned {
  automationId: string;
  flowId: string;
  conversionId: string;
  claimId: string;
}

/** A Job, its converted flow, a shadow conversion and one flow claim, all on one owner axis. */
async function converted(owner: { orgId: string; partnerId: string } | { partnerWide: string }, delegatorUserId: string): Promise<Owned> {
  const orgId = 'orgId' in owner ? owner.orgId : null;
  const partnerId = 'orgId' in owner ? owner.partnerId : owner.partnerWide;
  const { flowId } = await seedEnabledFlow({
    partnerId, ...(orgId ? { orgId } : { owner: 'partner' as const }), delegatorUserId, definition: DOC, pins: [PIN],
  });
  return system(async () => {
    const [automation] = await db.insert(automations).values({
      orgId, partnerId: orgId ? null : partnerId, name: `Rls ${randomUUID().slice(0, 8)}`, enabled: true,
      trigger: { type: 'event', eventType: 'device.offline' }, conditions: orgId ? {} : [], actions: [{ type: 'execute_command', command: 'synthetic' }],
      onFailure: 'stop',
    }).returning({ id: automations.id });
    const [conversion] = (await db.execute(sql`
      INSERT INTO flow_automation_conversions (org_id, partner_id, automation_id, flow_id, fidelity, source_digest, source_snapshot, document_digest)
      VALUES (${orgId}, ${orgId ? null : partnerId}, ${automation!.id}, ${flowId}, 'exact', ${'a'.repeat(64)}, '{}', ${'b'.repeat(64)})
      RETURNING id`)) as unknown as Array<{ id: string }>;
    const [claim] = await db.insert(automationOccurrenceClaims).values({
      orgId, partnerId: orgId ? null : partnerId, automationId: automation!.id, occurrenceKey: `event:${randomUUID()}`,
      engine: 'flow', conversionId: conversion!.id, occurrenceAt: new Date(),
    }).returning({ id: automationOccurrenceClaims.id });
    return { automationId: automation!.id, flowId, conversionId: conversion!.id, claimId: claim!.id };
  });
}

interface World {
  partnerA: string;
  partnerB: string;
  orgA1: string;
  orgA2: string;
  orgB: string;
  a1: Owned;
  a2: Owned;
  pw: Owned;
  b: Owned;
}

let w: World;

// setup.ts truncates the tenant tables before every test, so the world is rebuilt per test.
beforeEach(async () => {
  if (!process.env.DATABASE_URL) return;
  const partnerA = (await createPartner()).id;
  const partnerB = (await createPartner()).id;
  const orgA1 = (await createOrganization({ partnerId: partnerA })).id;
  const orgA2 = (await createOrganization({ partnerId: partnerA })).id;
  const orgB = (await createOrganization({ partnerId: partnerB })).id;
  const userA = await createUser({ partnerId: partnerA, orgId: orgA1, email: `conv-rls-a-${randomUUID()}@rls.test` });
  const userB = await createUser({ partnerId: partnerB, orgId: orgB, email: `conv-rls-b-${randomUUID()}@rls.test` });
  w = {
    partnerA, partnerB, orgA1, orgA2, orgB,
    a1: await converted({ orgId: orgA1, partnerId: partnerA }, userA.id),
    a2: await converted({ orgId: orgA2, partnerId: partnerA }, userA.id),
    pw: await converted({ partnerWide: partnerA }, userA.id),
    b: await converted({ orgId: orgB, partnerId: partnerB }, userB.id),
  };
});

/**
 * The isolation probe, as plain SQL so the SAME text runs through the app's
 * `withDbAccessContext` and inside the guard-flip transaction. Counts what an
 * org-A2 token and an org-B token can see and change of the other tenants'
 * rows. Every value here is 0 under the shipped policies, except the
 * partner-wide SELECT branch (`a2SeesPartnerWide*`, 1).
 */
type Exec = (ctx: DbAccessContext, text: string) => Promise<number>;

async function probe(exec: Exec) {
  const ids = (xs: string[]) => xs.map((x) => `'${x}'`).join(', ');
  const count = (table: string, idList: string[]) => `SELECT id FROM ${table} WHERE id IN (${ids(idList)})`;
  const asA2 = orgContext(w.orgA2, w.partnerA);
  const asB = orgContext(w.orgB, w.partnerB);
  return {
    // A sibling org under the same partner.
    a2SeesSiblingConversion: await exec(asA2, count('flow_automation_conversions', [w.a1.conversionId])),
    a2SeesSiblingClaim: await exec(asA2, count('automation_occurrence_claims', [w.a1.claimId])),
    a2UpdatesSiblingConversion: await exec(asA2,
      `UPDATE flow_automation_conversions SET updated_at = updated_at WHERE id = '${w.a1.conversionId}' RETURNING id`),
    a2DeletesSiblingClaim: await exec(asA2, `DELETE FROM automation_occurrence_claims WHERE id = '${w.a1.claimId}' RETURNING id`),
    // Its partner's partner-wide rows: readable, never writable.
    a2SeesPartnerWideConversion: await exec(asA2, count('flow_automation_conversions', [w.pw.conversionId])),
    a2SeesPartnerWideClaim: await exec(asA2, count('automation_occurrence_claims', [w.pw.claimId])),
    a2UpdatesPartnerWideConversion: await exec(asA2,
      `UPDATE flow_automation_conversions SET updated_at = updated_at WHERE id = '${w.pw.conversionId}' RETURNING id`),
    a2DeletesPartnerWideConversion: await exec(asA2, `DELETE FROM flow_automation_conversions WHERE id = '${w.pw.conversionId}' RETURNING id`),
    a2DeletesPartnerWideClaim: await exec(asA2, `DELETE FROM automation_occurrence_claims WHERE id = '${w.pw.claimId}' RETURNING id`),
    // Another partner's org.
    bSeesPartnerA: await exec(asB, count('flow_automation_conversions', [w.a1.conversionId, w.a2.conversionId, w.pw.conversionId])),
    bSeesPartnerAClaims: await exec(asB, count('automation_occurrence_claims', [w.a1.claimId, w.a2.claimId, w.pw.claimId])),
  };
}

const SHIPPED = {
  a2SeesSiblingConversion: 0,
  a2SeesSiblingClaim: 0,
  a2UpdatesSiblingConversion: 0,
  a2DeletesSiblingClaim: 0,
  a2SeesPartnerWideConversion: 1,
  a2SeesPartnerWideClaim: 1,
  a2UpdatesPartnerWideConversion: 0,
  a2DeletesPartnerWideConversion: 0,
  a2DeletesPartnerWideClaim: 0,
  bSeesPartnerA: 0,
  bSeesPartnerAClaims: 0,
};

/** The app path: the real pool as breeze_app, the real GUC prologue. Writes roll back with the probe. */
const appExec: Exec = async (ctx, text) => {
  const rows = await withDbAccessContext(ctx, () => db.execute(sql.raw(text)));
  return (rows as unknown as unknown[]).length;
};

function serialize(ids: string[] | null | undefined): string {
  return ids && ids.length > 0 ? ids.join(',') : '';
}

describe('flow conversion ledger and occurrence claims — live RLS (#5221 B7)', () => {
  runDb('an org token cannot read or change a sibling org\'s conversions or claims; it reads its partner\'s partner-wide rows but cannot change them', async () => {
    // Writes in the probe can only ever match 0 rows here; anything else is a real leak.
    expect(await probe(appExec)).toEqual(SHIPPED);

    // Inserts on another owner's axis are refused by WITH CHECK.
    const asA2 = orgContext(w.orgA2, w.partnerA);
    await expectSqlState(() => withDbAccessContext(asA2, () => db.execute(sql`
      INSERT INTO flow_automation_conversions (org_id, automation_id, flow_id, fidelity, source_digest, source_snapshot, document_digest)
      VALUES (${w.orgA1}, ${w.a1.automationId}, ${w.a1.flowId}, 'exact', ${'c'.repeat(64)}, '{}', ${'d'.repeat(64)})`)), '42501');
    await expectSqlState(() => withDbAccessContext(asA2, () => db.insert(automationOccurrenceClaims).values({
      orgId: w.orgA1, automationId: w.a1.automationId, occurrenceKey: `event:${randomUUID()}`, engine: 'flow',
    })), '42501');
    // A partner-wide row cannot be written from an org session either.
    await expectSqlState(() => withDbAccessContext(asA2, () => db.insert(automationOccurrenceClaims).values({
      partnerId: w.partnerA, automationId: w.pw.automationId, occurrenceKey: `event:${randomUUID()}`, engine: 'flow',
    })), '42501');

    // Positive controls: each owner sees its own; the partner session sees its partner-wide rows and writes them.
    const own = await withDbAccessContext(orgContext(w.orgA1, w.partnerA), () =>
      db.select({ id: flowAutomationConversions.id }).from(flowAutomationConversions).where(eq(flowAutomationConversions.id, w.a1.conversionId)));
    expect(own).toHaveLength(1);
    const asPartner = partnerContext(w.partnerA, [w.orgA1, w.orgA2]);
    const touched = await withDbAccessContext(asPartner, () => db.update(flowAutomationConversions)
      .set({ updatedAt: new Date() }).where(eq(flowAutomationConversions.id, w.pw.conversionId)).returning({ id: flowAutomationConversions.id }));
    expect(touched).toHaveLength(1);
    // The other partner's session sees none of partner A's partner-wide rows.
    const otherPartner = await withDbAccessContext(partnerContext(w.partnerB, [w.orgB]), () =>
      db.select({ id: flowAutomationConversions.id }).from(flowAutomationConversions).where(eq(flowAutomationConversions.id, w.pw.conversionId)));
    expect(otherPartner).toEqual([]);
  });

  runDb('guard-flip control: with both isolation policies USING (true) the isolation cases go red', async () => {
    let flipped: Awaited<ReturnType<typeof probe>> | null = null;
    await adminSql.begin(async (tx) => {
      for (const table of ['flow_automation_conversions', 'automation_occurrence_claims']) {
        await tx.unsafe(`ALTER POLICY ${table}_isolation ON ${table} USING (true) WITH CHECK (true)`);
      }
      // The flipped policies, seen by the same unprivileged role the app uses.
      await tx.unsafe('SET LOCAL ROLE breeze_app');
      const flipExec: Exec = async (ctx, text) => {
        await tx.unsafe('SAVEPOINT probe');
        await tx`SELECT set_config('breeze.scope', ${ctx.scope}, true),
          set_config('breeze.org_id', ${ctx.orgId ?? ''}, true),
          set_config('breeze.accessible_org_ids', ${serialize(ctx.accessibleOrgIds)}, true),
          set_config('breeze.accessible_partner_ids', ${serialize(ctx.accessiblePartnerIds)}, true),
          set_config('breeze.user_id', ${ctx.userId ?? ''}, true),
          set_config('breeze.current_partner_id', ${ctx.currentPartnerId ?? ''}, true),
          set_config('breeze.report_history_org_ids', '', true)`;
        const rows = await tx.unsafe(text);
        // Undo the probe's writes so later probes see the rows.
        await tx.unsafe('ROLLBACK TO SAVEPOINT probe');
        return rows.length;
      };
      flipped = await probe(flipExec);
      throw new Error('rollback-sentinel'); // never keep the flipped policies
    }).catch((err) => { if ((err as Error).message !== 'rollback-sentinel') throw err; });

    expect(flipped).not.toBeNull();
    const red = flipped!;
    // Every isolation case flips: the sibling's and the other partner's rows are visible and writable,
    // and the partner-wide row is writable from an org session.
    expect(red.a2SeesSiblingConversion).toBe(1);
    expect(red.a2SeesSiblingClaim).toBe(1);
    expect(red.a2UpdatesSiblingConversion).toBe(1);
    expect(red.a2DeletesSiblingClaim).toBe(1);
    expect(red.a2UpdatesPartnerWideConversion).toBe(1);
    expect(red.a2DeletesPartnerWideClaim).toBe(1);
    expect(red.bSeesPartnerA).toBe(3);
    expect(red.bSeesPartnerAClaims).toBe(3);

    // And the flip was rolled back: the shipped policies hold again.
    expect(await probe(appExec)).toEqual(SHIPPED);
  });

  runDb('the owner guards raise', async () => {
    // A fresh Job (org A1) and a fresh flow (sibling org A2), so no unique index answers first.
    const spare = await system(async () => (await db.insert(automations).values({
      orgId: w.orgA1, name: `Spare ${randomUUID().slice(0, 6)}`, enabled: true, trigger: { type: 'manual' }, actions: [], onFailure: 'stop',
    }).returning({ id: automations.id }))[0]!.id);
    const delegator = await createUser({ partnerId: w.partnerA, orgId: w.orgA2, email: `conv-rls-sp-${randomUUID()}@rls.test` });
    const { flowId: siblingFlow } = await seedEnabledFlow({ partnerId: w.partnerA, orgId: w.orgA2, delegatorUserId: delegator.id, definition: DOC, pins: [PIN] });
    const ledger = (orgId: string) => system(() => db.execute(sql`
      INSERT INTO flow_automation_conversions (org_id, automation_id, flow_id, fidelity, source_digest, source_snapshot, document_digest)
      VALUES (${orgId}, ${spare}, ${siblingFlow}, 'exact', ${'e'.repeat(64)}, '{}', ${'f'.repeat(64)})`));
    // Owner = the flow's but not the automation's …
    await expectSqlState(() => ledger(w.orgA2), '23514');
    // … and owner = the automation's but not the flow's.
    await expectSqlState(() => ledger(w.orgA1), '23514');
    // A claim on another owner's axis.
    await expectSqlState(() => system(() => db.insert(automationOccurrenceClaims).values({
      orgId: w.orgA2, automationId: w.a1.automationId, occurrenceKey: `event:${randomUUID()}`, engine: 'flow',
    })), '23514');
    await expectSqlState(() => system(() => db.insert(automationOccurrenceClaims).values({
      partnerId: w.partnerA, automationId: w.a1.automationId, occurrenceKey: `event:${randomUUID()}`, engine: 'flow',
    })), '23514');
    // A switched automation pointing at a flow of another owner.
    await expectSqlState(() => system(() => db.update(automations).set({
      enabled: false, retiredAt: new Date(), retiredReason: 'converted_to_flow', convertedToFlowId: siblingFlow,
    }).where(eq(automations.id, spare))), '23514');
    // Positive control: the matching owner is admitted.
    await system(() => db.update(automations).set({
      enabled: false, retiredAt: new Date(), retiredReason: 'converted_to_flow', convertedToFlowId: w.a1.flowId,
    }).where(eq(automations.id, spare)));
  });

  runDb('claims reject UPDATE', async () => {
    // breeze_app holds no UPDATE beyond org_id: any other column is a privilege error, even as system.
    await expectSqlState(() => system(() => db.update(automationOccurrenceClaims)
      .set({ engine: 'legacy' }).where(eq(automationOccurrenceClaims.id, w.a1.claimId))), '42501');
    await expectSqlState(() => system(() => db.execute(sql`
      UPDATE automation_occurrence_claims SET occurrence_key = ${`event:${randomUUID()}`} WHERE id = ${w.a1.claimId}`)), '42501');
    // The org_id restamp it may do is still held to the automation's owner (the merge repoint path only).
    await expectSqlState(() => system(() => db.update(automationOccurrenceClaims)
      .set({ orgId: w.orgA2 }).where(eq(automationOccurrenceClaims.id, w.a1.claimId))), '23514');
    // Even a role with the table privilege (the superuser) is stopped by the append-only trigger.
    let raised: unknown;
    try {
      await adminSql`UPDATE automation_occurrence_claims SET engine = 'flow', flow_run_id = ${randomUUID()} WHERE id = ${w.a1.claimId}`;
    } catch (err) {
      raised = err;
    }
    expect((raised as { code?: string } | undefined)?.code).toBe('23000');
    const [claim] = await system(() => db.select().from(automationOccurrenceClaims).where(eq(automationOccurrenceClaims.id, w.a1.claimId)));
    expect(claim).toMatchObject({ orgId: w.orgA1, engine: 'flow', flowRunId: null });
  });

  runDb('an org merge repoints the Job, its flow, its conversion and its claims to the survivor', async () => {
    const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const partner = (await createPartner()).id;
      const loser = (await createOrganization({ partnerId: partner })).id;
      const survivor = (await createOrganization({ partnerId: partner })).id;
      const actor = await createUser({ partnerId: partner, email: `conv-merge-${randomUUID()}@rls.test` });
      const moved = await converted({ orgId: loser, partnerId: partner }, actor.id);
      // A switched generation: the Job carries converted_to_flow_id, so its owner guard runs too.
      await system(async () => {
        await db.execute(sql`UPDATE flow_automation_conversions SET state = 'switched', switch_at = now(), switched_at = now()
          WHERE id = ${moved.conversionId}`);
        await db.update(automations).set({
          enabled: false, retiredAt: new Date(), retiredReason: 'converted_to_flow', convertedToFlowId: moved.flowId,
        }).where(eq(automations.id, moved.automationId));
      });

      const result = await executeOrgMerge({
        loserOrgId: loser, survivorOrgId: survivor, partnerId: partner, performedBy: actor.id, performedByEmail: actor.email,
      });
      expect(result.tables.flow_automation_conversions).toEqual({ moved: 1, dropped: 0 });
      expect(result.tables.automation_occurrence_claims).toEqual({ moved: 1, dropped: 0 });

      await system(async () => {
        expect((await db.select().from(automations).where(eq(automations.id, moved.automationId)))[0])
          .toMatchObject({ orgId: survivor, convertedToFlowId: moved.flowId });
        expect((await db.select().from(flows).where(eq(flows.id, moved.flowId)))[0]).toMatchObject({ orgId: survivor });
        expect((await db.select().from(flowAutomationConversions).where(eq(flowAutomationConversions.id, moved.conversionId)))[0])
          .toMatchObject({ orgId: survivor, partnerId: null, state: 'switched' });
        expect(await db.select().from(automationOccurrenceClaims).where(and(
          eq(automationOccurrenceClaims.automationId, moved.automationId), eq(automationOccurrenceClaims.orgId, survivor),
        ))).toHaveLength(1);
      });
      // The survivor's session reads the moved ledger; the loser's id no longer matches anything.
      const seen = await withDbAccessContext(orgContext(survivor, partner), () =>
        db.select({ id: flowAutomationConversions.id }).from(flowAutomationConversions).where(eq(flowAutomationConversions.id, moved.conversionId)));
      expect(seen).toHaveLength(1);
    } finally {
      if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
    }
  }, 120_000);
});

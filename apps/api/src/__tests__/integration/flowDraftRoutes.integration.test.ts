/**
 * Flows completion W01b (#12435): the REST draft routes' services against a
 * real database, as breeze_app under forced RLS.
 *
 *  - deleteDraftFlow (DELETE /flows/:id): RLS and the partner-wide gate decide
 *    reach; the FOR UPDATE lock serializes it against a concurrent enable; a
 *    delete removes the draft and nothing else.
 *  - notMovedCountColumn (GET /automations jobCounts.notMoved): the SQL
 *    mirror of classifyAutomation() === 'S' && !convertedToFlowId, which the
 *    route unit suite cannot check against its mocked schema.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { automations, flows, flowVersions } from '../../db/schema';
import { assignUserToOrganization, assignUserToPartner, createOrganization, createPartner, createRole, createUser } from './db-utils';
import { deleteDraftFlow } from '../../services/flows/deleteDraft';
import { enableFlow } from '../../services/flows/versions';
import { notMovedCountColumn } from '../../routes/automations';
import {
  interactiveOrgAuth,
  interactivePartnerAuth,
  orgContext,
  partnerContext,
  SYSTEM_CTX,
} from './helpers/flowRls';

const DEFINITION = { version: 1, name: 'Seeded', trigger: { type: 'manual' }, inputs: [], steps: [{ id: 'a', tool: 'wait', input: { minutes: 1 } }] };

async function seedFlow(owner: { orgId?: string | null; partnerId?: string | null }, slug: string): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(flows).values({
      orgId: owner.orgId ?? null,
      partnerId: owner.partnerId ?? null,
      slug,
      name: 'Seeded',
      definition: DEFINITION,
      effectiveTier: 1,
    }).returning({ id: flows.id }),
  );
  return rows[0]!.id;
}

const flowExists = async (id: string) =>
  (await withDbAccessContext(SYSTEM_CTX, () => db.select({ id: flows.id }).from(flows).where(eq(flows.id, id)))).length === 1;

/** Fails loudly if the suite is not on the unprivileged role: a BYPASSRLS connection would pass every RLS case vacuously. */
async function assertAppRole() {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.execute(sql`select current_user as role, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`));
  expect(row).toMatchObject({ role: 'breeze_app', bypass: false });
}

async function orgFixture() {
  const p = await createPartner();
  const org = await createOrganization({ partnerId: p.id });
  const role = await createRole({ scope: 'organization', orgId: org.id });
  const user = await createUser({ partnerId: p.id, orgId: org.id, email: `draft-del-${randomUUID()}@example.com` });
  await assignUserToOrganization(user.id, org.id, role.id);
  return { p, org, user, ctx: orgContext(org.id, p.id, user.id), auth: interactiveOrgAuth(org.id, p.id, user) };
}

describe('deleteDraftFlow against a real database (W01b #12435)', () => {
  it('runs as breeze_app without BYPASSRLS', async () => {
    await assertAppRole();
  });

  it('an org user deletes its own never-published draft', async () => {
    const { org, ctx, auth } = await orgFixture();
    const id = await seedFlow({ orgId: org.id }, 'own_draft');
    expect(await withDbAccessContext(ctx, () => deleteDraftFlow(auth, id, 1))).toEqual({ ok: true });
    expect(await flowExists(id)).toBe(false);
  });

  it('org token cannot delete a partner-wide draft', async () => {
    const { p, ctx, auth } = await orgFixture();
    const id = await seedFlow({ partnerId: p.id }, 'pw_org_delete');
    // The org token reads the row (flows_partner_wide_select) but FOR UPDATE matches only updatable rows.
    expect(await withDbAccessContext(ctx, () => deleteDraftFlow(auth, id, 1))).toEqual({ ok: false, error: 'flow_not_found' });
    expect(await flowExists(id)).toBe(true);
  });

  it('selected-access partner user cannot delete a partner-wide draft', async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const role = await createRole({ scope: 'partner', partnerId: p.id });
    const user = await createUser({ partnerId: p.id, email: `selected-del-${randomUUID()}@example.com` });
    await assignUserToPartner(user.id, p.id, role.id, 'selected');
    const id = await seedFlow({ partnerId: p.id }, 'pw_selected_delete');

    const r = await withDbAccessContext(partnerContext(p.id, [org.id], user.id), () =>
      deleteDraftFlow(interactivePartnerAuth(p.id, [org.id], user, 'selected'), id, 1));
    expect(r).toEqual({ ok: false, error: 'partner_wide_forbidden' });
    expect(await flowExists(id)).toBe(true);
  });

  it('an all-orgs partner user deletes a partner-wide draft', async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const role = await createRole({ scope: 'partner', partnerId: p.id });
    const user = await createUser({ partnerId: p.id, email: `all-del-${randomUUID()}@example.com` });
    await assignUserToPartner(user.id, p.id, role.id, 'all');
    const id = await seedFlow({ partnerId: p.id }, 'pw_all_delete');

    const r = await withDbAccessContext(partnerContext(p.id, [org.id], user.id), () =>
      deleteDraftFlow(interactivePartnerAuth(p.id, [org.id], user, 'all'), id, 1));
    expect(r).toEqual({ ok: true });
    expect(await flowExists(id)).toBe(false);
  });

  it('delete after a concurrent enable commits is flow_has_history', async () => {
    const { org, ctx, auth } = await orgFixture();
    const id = await seedFlow({ orgId: org.id }, 'race');

    // Tab 1 enables and holds its transaction open (the row stays locked FOR UPDATE).
    // If enableFlow throws before `enabled()`, `enable` rejects and the race below fails instead of hanging.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let enabled!: () => void;
    const enabledInTx = new Promise<void>((resolve) => { enabled = resolve; });
    const enable = withDbAccessContext(ctx, async () => {
      const r = await enableFlow(auth, id, { expectedVersion: 1, preApprovedStepIds: [] });
      enabled();
      await held;
      return r;
    });
    await Promise.race([enabledInTx, enable.then(() => { throw new Error('enable finished before signalling'); })]);

    // Tab 2 deletes while tab 1 is still open: it must wait on the row lock, not read the old draft.
    let settled = false;
    const del = withDbAccessContext(ctx, () => deleteDraftFlow(auth, id, 1)).finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    expect((await enable).ok).toBe(true);
    expect(await del).toEqual({ ok: false, error: 'flow_has_history' });
    expect(await flowExists(id)).toBe(true);
  });

  it('an enable after a committed delete is flow_not_found', async () => {
    const { org, ctx, auth } = await orgFixture();
    const id = await seedFlow({ orgId: org.id }, 'deleted_first');
    expect(await withDbAccessContext(ctx, () => deleteDraftFlow(auth, id, 1))).toEqual({ ok: true });
    expect(await withDbAccessContext(ctx, () => enableFlow(auth, id, { expectedVersion: 1, preApprovedStepIds: [] })))
      .toEqual({ ok: false, error: 'flow_not_found' });
  });

  it('a draft-status flow with a publication row is flow_has_history and survives', async () => {
    const { org, user, ctx, auth } = await orgFixture();
    const id = await seedFlow({ orgId: org.id }, 'published_once');
    await withDbAccessContext(SYSTEM_CTX, () => db.insert(flowVersions).values({
      flowId: id, orgId: org.id, partnerId: null, publicationSeq: 1, definitionVersion: 1, definition: DEFINITION, effectiveTier: 1,
      stepPins: [], preApprovals: [], enabledByUserId: user.id,
    }));
    expect(await withDbAccessContext(ctx, () => deleteDraftFlow(auth, id, 1))).toEqual({ ok: false, error: 'flow_has_history' });
    expect(await flowExists(id)).toBe(true);
  });

  it("a converted Job's draft is flow_has_history with its conversion and Job ids, and survives", async () => {
    const { org, ctx, auth } = await orgFixture();
    const id = await seedFlow({ orgId: org.id }, 'converted_draft');
    const { automationId, conversionId } = await withDbAccessContext(SYSTEM_CTX, async () => {
      const [automation] = await db.insert(automations).values({
        orgId: org.id, partnerId: null, name: `Converted ${randomUUID().slice(0, 8)}`, enabled: true,
        trigger: { type: 'manual' }, actions: [], onFailure: 'stop',
      } as never).returning({ id: automations.id });
      const [conversion] = (await db.execute(sql`
        INSERT INTO flow_automation_conversions (org_id, partner_id, automation_id, flow_id, fidelity, source_digest, source_snapshot, document_digest)
        VALUES (${org.id}, ${null}, ${automation!.id}, ${id}, 'exact', ${'a'.repeat(64)}, '{}', ${'b'.repeat(64)})
        RETURNING id`)) as unknown as Array<{ id: string }>;
      return { automationId: automation!.id, conversionId: conversion!.id };
    });
    expect(await withDbAccessContext(ctx, () => deleteDraftFlow(auth, id, 1)))
      .toEqual({ ok: false, error: 'flow_has_history', conversionId, automationId });
    expect(await flowExists(id)).toBe(true);
  });

  it('deleting a draft cascades nothing else', async () => {
    const { org, ctx, auth } = await orgFixture();
    const victim = await seedFlow({ orgId: org.id }, 'victim');
    const sibling = await seedFlow({ orgId: org.id }, 'sibling');
    // The sibling has history: a publication from a real enable.
    expect((await withDbAccessContext(ctx, () => enableFlow(auth, sibling, { expectedVersion: 1, preApprovedStepIds: [] }))).ok).toBe(true);
    const publicationsOf = (flowId: string) =>
      withDbAccessContext(SYSTEM_CTX, () => db.select({ id: flowVersions.id }).from(flowVersions).where(eq(flowVersions.flowId, flowId)));
    expect(await publicationsOf(sibling)).toHaveLength(1);

    expect(await withDbAccessContext(ctx, () => deleteDraftFlow(auth, victim, 1))).toEqual({ ok: true });
    expect(await flowExists(victim)).toBe(false);
    expect(await flowExists(sibling)).toBe(true);
    expect(await publicationsOf(sibling)).toHaveLength(1);
    // And an enabled flow is never deletable.
    expect(await withDbAccessContext(ctx, () => deleteDraftFlow(auth, sibling, 1))).toEqual({ ok: false, error: 'flow_has_history' });
  });
});

describe('GET /automations jobCounts.notMoved predicate against a real database (W01b #12435)', () => {
  it('counts standalone unswitched Jobs only, including a trigger with no filter key', async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const flowId = await seedFlow({ orgId: org.id }, 'switched_target');
    const base = { orgId: org.id, partnerId: null, actions: [] as unknown[] };
    const rows = [
      // Counted: no filter key at all (the NULL trap), and an ordinary filter.
      { ...base, name: 'plain', trigger: { type: 'manual' } },
      { ...base, name: 'event', trigger: { type: 'event', eventType: 'device.offline', filter: { severity: 'high' } } },
      // Not counted.
      { ...base, name: 'policy', trigger: { type: 'event', eventType: 'device.offline', filter: { _policyWorkflow: 'x' } } },
      { ...base, name: 'retired', trigger: { type: 'manual' }, retiredAt: new Date(), retiredReason: 'operator' },
      { ...base, name: 'switched', trigger: { type: 'manual' }, retiredAt: new Date(), retiredReason: 'converted_to_flow', convertedToFlowId: flowId },
    ];
    await withDbAccessContext(SYSTEM_CTX, () => db.insert(automations).values(rows as never));

    // The handler's own column, over the org's rows (the list's reach condition stands in for whereCondition).
    const [count] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select({ total: sql<number>`count(*)::int`, notMoved: notMovedCountColumn }).from(automations).where(eq(automations.orgId, org.id)));
    // count(*) is a bigint the driver returns as a string; the handler reads it through Number().
    expect({ total: count!.total, notMoved: Number(count!.notMoved) }).toEqual({ total: 5, notMoved: 2 });
  });
});

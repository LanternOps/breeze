/**
 * Tool Catalog W06 (#5221), plan Task B1 — the conversion service on REAL
 * Postgres as `breeze_app` under FORCE RLS, through the real services
 * (loadConversionContext, convertAutomation, saveDraftFlow, the ledger):
 *
 *  - create refuses a source digest that no longer matches the live row and
 *    writes nothing (no flow, no ledger row);
 *  - the draft and the ledger row are on the automation's owner axis (an org
 *    Job → that org; a partner-wide Job → the partner, org_id NULL);
 *  - a second live conversion is `conversion_exists`, including two creates
 *    racing for the same Job (the automation row lock + the live unique index);
 *  - an org token cannot preview, convert or read a sibling org's Job or
 *    conversion, nor read a partner-wide conversion;
 *  - editing the Job's source, or the draft's document, resets the shadow
 *    counters; an edit that changes neither leaves them.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { automations, flowAutomationConversions, flows, scripts } from '../../db/schema';
import { saveDraftFlow } from '../../services/flows/service';
import { automationSourceDigest } from '../../services/flows/conversion/convertAutomation';
import { resetShadowIfChanged } from '../../services/flows/conversion/ledger';
import {
  createConversion,
  getConversion,
  listConversions,
  previewConversion,
} from '../../services/flows/conversion/service';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { interactiveOrgAuth, interactivePartnerAuth, orgContext, partnerContext } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

process.env.FLOWS_ENABLED = 'true';

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const sibling = await createOrganization({ partnerId: partner.id });
  const orgUser = await createUser({ partnerId: partner.id, orgId: org.id, email: `conv-o-${randomUUID()}@example.com`, withMembership: true });
  const siblingUser = await createUser({ partnerId: partner.id, orgId: sibling.id, email: `conv-s-${randomUUID()}@example.com`, withMembership: true });
  const partnerUser = await createUser({ partnerId: partner.id, email: `conv-p-${randomUUID()}@example.com`, withMembership: true });
  const [orgScript] = await withSystemDbAccessContext(() => db.insert(scripts).values({
    orgId: org.id, partnerId: partner.id, name: `cs-${randomUUID().slice(0, 6)}`, language: 'bash', content: 'echo ok', osTypes: ['linux'], runAs: 'system', timeoutSeconds: 60,
  }).returning({ id: scripts.id }));
  const [partnerScript] = await withSystemDbAccessContext(() => db.insert(scripts).values({
    orgId: null, partnerId: partner.id, name: `ps-${randomUUID().slice(0, 6)}`, language: 'bash', content: 'echo ok', osTypes: ['linux'], runAs: 'system', timeoutSeconds: 60,
  }).returning({ id: scripts.id }));
  const asOrg = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(org.id, partner.id, orgUser.id), fn);
  const asSibling = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(sibling.id, partner.id, siblingUser.id), fn);
  const asPartner = <T>(fn: () => Promise<T>) =>
    withDbAccessContext(partnerContext(partner.id, [org.id, sibling.id], partnerUser.id), fn);
  return {
    partnerId: partner.id,
    orgId: org.id,
    siblingId: sibling.id,
    orgScript: orgScript!.id,
    partnerScript: partnerScript!.id,
    orgAuth: interactiveOrgAuth(org.id, partner.id, orgUser),
    siblingAuth: interactiveOrgAuth(sibling.id, partner.id, siblingUser),
    partnerAuth: interactivePartnerAuth(partner.id, [org.id, sibling.id], partnerUser),
    asOrg,
    asSibling,
    asPartner,
  };
}

async function job(values: Partial<typeof automations.$inferInsert>) {
  const [row] = await withSystemDbAccessContext(() => db.insert(automations).values({
    name: `conv-${randomUUID().slice(0, 6)}`,
    trigger: { type: 'manual' },
    conditions: [],
    onFailure: 'stop',
    ...values,
  } as typeof automations.$inferInsert).returning());
  return row!;
}

const ledgerFor = (automationId: string) => withSystemDbAccessContext(() =>
  db.select().from(flowAutomationConversions).where(eq(flowAutomationConversions.automationId, automationId)));
const flowById = (id: string) => withSystemDbAccessContext(async () => (await db.select().from(flows).where(eq(flows.id, id)))[0]);

async function convert(t: Awaited<ReturnType<typeof tenant>>, row: Awaited<ReturnType<typeof job>>) {
  const r = await t.asOrg(() => createConversion(t.orgAuth, row.id, { expectedSourceDigest: automationSourceDigest(row) }));
  if (!r.ok) throw new Error(`create refused: ${JSON.stringify(r)}`);
  return r.conversion;
}

async function dirtyShadow(conversionId: string) {
  await withSystemDbAccessContext(() => db.update(flowAutomationConversions).set({
    shadowRuns: 4,
    shadowDivergences: 1,
    shadowStartedAt: new Date(Date.now() - 86_400_000),
    shadowLastAt: new Date(),
    shadowLastDivergence: { kind: 'trigger_mismatch', at: new Date().toISOString(), detail: 'x' },
  }).where(eq(flowAutomationConversions.id, conversionId)));
}

describe('flow conversion service (real Postgres, #5221 B1)', () => {
  runDb('create refuses a changed digest and writes nothing', async () => {
    const t = await tenant();
    const row = await job({ orgId: t.orgId, actions: [{ type: 'run_script', scriptId: t.orgScript, whenOffline: 'queue' }] });
    const stale = automationSourceDigest(row);
    await withSystemDbAccessContext(() => db.update(automations)
      .set({ actions: [{ type: 'run_script', scriptId: t.orgScript, whenOffline: 'skip' }] })
      .where(eq(automations.id, row.id)));

    const r = await t.asOrg(() => createConversion(t.orgAuth, row.id, { expectedSourceDigest: stale }));
    expect(r).toEqual({ ok: false, error: 'source_changed' });
    expect(await ledgerFor(row.id)).toEqual([]);
    const orgFlows = await withSystemDbAccessContext(() => db.select({ id: flows.id }).from(flows).where(eq(flows.orgId, t.orgId)));
    expect(orgFlows).toEqual([]);
  });

  runDb("draft is on the automation's axis", async () => {
    const t = await tenant();
    const orgJob = await job({ orgId: t.orgId, actions: [{ type: 'run_script', scriptId: t.orgScript, whenOffline: 'queue' }] });
    const c = await convert(t, orgJob);
    const flow = await flowById(c.flowId);
    expect(flow).toMatchObject({ orgId: t.orgId, partnerId: null, status: 'draft' });
    const [ledger] = await ledgerFor(orgJob.id);
    expect(ledger).toMatchObject({ orgId: t.orgId, partnerId: null, state: 'shadow', flowId: c.flowId, sourceDigest: automationSourceDigest(orgJob) });

    const pwJob = await job({ orgId: null, partnerId: t.partnerId, actions: [{ type: 'run_script', scriptId: t.partnerScript, whenOffline: 'queue' }] });
    const pr = await t.asPartner(() => createConversion(t.partnerAuth, pwJob.id, { expectedSourceDigest: automationSourceDigest(pwJob) }));
    expect(pr.ok).toBe(true);
    if (!pr.ok) return;
    expect(await flowById(pr.conversion.flowId)).toMatchObject({ orgId: null, partnerId: t.partnerId });
    expect((await ledgerFor(pwJob.id))[0]).toMatchObject({ orgId: null, partnerId: t.partnerId });

    // A selected-access partner user cannot convert a partner-wide Job.
    const pw2 = await job({ orgId: null, partnerId: t.partnerId, actions: [{ type: 'run_script', scriptId: t.partnerScript, whenOffline: 'queue' }] });
    const selected = { ...t.partnerAuth, partnerOrgAccess: 'selected' } as typeof t.partnerAuth;
    expect(await t.asPartner(() => createConversion(selected, pw2.id, { expectedSourceDigest: automationSourceDigest(pw2) })))
      .toEqual({ ok: false, error: 'partner_wide_forbidden' });
  });

  runDb('second live conversion is conversion_exists, also when two creates race', async () => {
    const t = await tenant();
    const row = await job({ orgId: t.orgId, actions: [{ type: 'run_script', scriptId: t.orgScript, whenOffline: 'queue' }] });
    const first = await convert(t, row);
    expect(await t.asOrg(() => createConversion(t.orgAuth, row.id, { expectedSourceDigest: automationSourceDigest(row) })))
      .toEqual({ ok: false, error: 'conversion_exists', conversionId: first.id });

    const raced = await job({ orgId: t.orgId, actions: [{ type: 'run_script', scriptId: t.orgScript, whenOffline: 'queue' }] });
    const req = { expectedSourceDigest: automationSourceDigest(raced) };
    const results = await Promise.all([
      t.asOrg(() => createConversion(t.orgAuth, raced.id, req)),
      t.asOrg(() => createConversion(t.orgAuth, raced.id, req)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ ok: false, error: 'conversion_exists' })]);
    expect(await ledgerFor(raced.id)).toHaveLength(1);
  });

  runDb("org token cannot preview a sibling org's automation", async () => {
    const t = await tenant();
    const row = await job({ orgId: t.orgId, actions: [{ type: 'run_script', scriptId: t.orgScript, whenOffline: 'queue' }] });
    expect(await t.asSibling(() => previewConversion(t.siblingAuth, row.id))).toBeNull();
    expect(await t.asSibling(() => createConversion(t.siblingAuth, row.id, { expectedSourceDigest: automationSourceDigest(row) })))
      .toEqual({ ok: false, error: 'automation_not_found' });

    const own = await t.asOrg(() => previewConversion(t.orgAuth, row.id));
    expect(own).toMatchObject({ automationId: row.id, sourceDigest: automationSourceDigest(row) });
    expect(own!.fidelity).not.toBe('unconvertible');

    const c = await convert(t, row);
    expect(await t.asSibling(() => getConversion(t.siblingAuth, c.id))).toBeNull();
    expect((await t.asSibling(() => listConversions(t.siblingAuth, {}))).conversions).toEqual([]);
    expect(await t.asOrg(() => getConversion(t.orgAuth, c.id))).toMatchObject({ id: c.id, state: 'shadow', switchBlockedBy: 'shadow_too_new' });

    // A partner-wide conversion: the partner reads it; an org token in that partner does not.
    const pwJob = await job({ orgId: null, partnerId: t.partnerId, actions: [{ type: 'run_script', scriptId: t.partnerScript, whenOffline: 'queue' }] });
    const pr = await t.asPartner(() => createConversion(t.partnerAuth, pwJob.id, { expectedSourceDigest: automationSourceDigest(pwJob) }));
    if (!pr.ok) throw new Error(JSON.stringify(pr));
    expect(await t.asPartner(() => getConversion(t.partnerAuth, pr.conversion.id))).toMatchObject({ id: pr.conversion.id });
    expect(await t.asOrg(() => getConversion(t.orgAuth, pr.conversion.id))).toBeNull();
    expect((await t.asOrg(() => listConversions(t.orgAuth, {}))).conversions.map((x) => x.id)).toEqual([c.id]);
  });

  runDb('a site-limited user cannot read the conversion of an automation outside their sites', async () => {
    const t = await tenant();
    const siteA = await createSite({ orgId: t.orgId });
    const siteB = await createSite({ orgId: t.orgId });
    const devA = await createDevice({ orgId: t.orgId, siteId: siteA!.id });
    const devB = await createDevice({ orgId: t.orgId, siteId: siteB!.id });
    const inside = await job({ orgId: t.orgId, conditions: { type: 'devices', deviceIds: [devA.id] }, actions: [{ type: 'run_script', scriptId: t.orgScript, whenOffline: 'queue' }] });
    const outside = await job({ orgId: t.orgId, conditions: { type: 'devices', deviceIds: [devB.id] }, actions: [{ type: 'run_script', scriptId: t.orgScript, whenOffline: 'queue' }] });
    const cIn = await convert(t, inside);
    const cOut = await convert(t, outside);

    const limited = { ...t.orgAuth, allowedSiteIds: [siteA!.id] } as typeof t.orgAuth;
    expect(await t.asOrg(() => getConversion(limited, cOut.id))).toBeNull();
    expect(await t.asOrg(() => getConversion(limited, cIn.id))).toMatchObject({ id: cIn.id });
    const listed = await t.asOrg(() => listConversions(limited, {}));
    expect(listed.conversions.map((c) => c.id)).toEqual([cIn.id]);
    expect(listed.total).toBe(1);
    // The unrestricted org user sees both.
    expect((await t.asOrg(() => listConversions(t.orgAuth, {}))).total).toBe(2);
  });

  runDb('editing the automation resets shadow counters', async () => {
    const t = await tenant();
    const row = await job({ orgId: t.orgId, actions: [{ type: 'run_script', scriptId: t.orgScript, whenOffline: 'queue' }] });
    const c = await convert(t, row);
    await dirtyShadow(c.id);

    // A rename leaves the source unchanged: no reset.
    const renamed = await t.asOrg(async () => {
      const [before] = await db.select().from(automations).where(eq(automations.id, row.id));
      await db.update(automations).set({ name: 'renamed' }).where(eq(automations.id, row.id));
      return resetShadowIfChanged(db, { automationId: row.id, previous: before! });
    });
    expect(renamed).toBe(false);
    expect((await ledgerFor(row.id))[0]).toMatchObject({ shadowRuns: 4, shadowDivergences: 1 });

    const reset = await t.asOrg(async () => {
      const [before] = await db.select().from(automations).where(eq(automations.id, row.id));
      await db.update(automations).set({ onFailure: 'continue' }).where(eq(automations.id, row.id));
      return resetShadowIfChanged(db, { automationId: row.id, previous: before! });
    });
    expect(reset).toBe(true);
    const [after] = await ledgerFor(row.id);
    expect(after).toMatchObject({ shadowRuns: 0, shadowDivergences: 0, shadowLastAt: null, shadowLastDivergence: null });
    // The conversion-time source digest is immutable; the switch compares it with the live row (source_changed).
    expect(after!.sourceDigest).toBe(automationSourceDigest(row));
    expect(after!.shadowStartedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  runDb('editing the draft resets shadow counters', async () => {
    const t = await tenant();
    const row = await job({ orgId: t.orgId, actions: [{ type: 'run_script', scriptId: t.orgScript, whenOffline: 'queue' }] });
    const c = await convert(t, row);
    await dirtyShadow(c.id);
    const flow = await flowById(c.flowId);
    const [before] = await ledgerFor(row.id);

    // The same document saved again: the digest is unchanged, the shadow stays.
    const same = await t.asOrg(() => saveDraftFlow(t.orgAuth, { flowId: c.flowId, document: flow!.definition, expectedVersion: 1 }));
    expect(same.saved).toBe(true);
    expect((await ledgerFor(row.id))[0]).toMatchObject({ shadowRuns: 4, documentDigest: before!.documentDigest });

    const edited = { ...(flow!.definition as Record<string, unknown>), name: 'Edited draft' };
    const saved = await t.asOrg(() => saveDraftFlow(t.orgAuth, { flowId: c.flowId, document: edited, expectedVersion: 2 }));
    expect(saved.saved).toBe(true);
    const [after] = await ledgerFor(row.id);
    expect(after).toMatchObject({ shadowRuns: 0, shadowDivergences: 0, shadowLastDivergence: null });
    expect(after!.documentDigest).not.toBe(before!.documentDigest);
    expect(after!.documentDigest).toMatch(/^[0-9a-f]{64}$/);

    // Only this generation's row moved.
    const others = await withSystemDbAccessContext(() => db.select({ id: flowAutomationConversions.id }).from(flowAutomationConversions)
      .where(and(eq(flowAutomationConversions.flowId, c.flowId), eq(flowAutomationConversions.state, 'shadow'))));
    expect(others).toHaveLength(1);
  });
});

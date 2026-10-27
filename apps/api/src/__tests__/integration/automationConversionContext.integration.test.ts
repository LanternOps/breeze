/**
 * Tool Catalog W06 (#5221), plan Task A7 — `loadConversionContext` and the
 * S+R predicate on REAL Postgres: the owner is exactly the Job's owner axis
 * and every ownership answer comes from that owner's rule-6 lookups (a
 * partner-wide Job never owns one org's script); the remediation predicate's
 * SQL matches both consumers (an automation policy and a config-policy
 * compliance rule) within the Job's partner and nothing in another partner.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { automations, scripts } from '../../db/schema';
import { loadConversionContext } from '../../services/flows/conversion/context';
import { isComplianceRemediationTarget } from '../../services/policyEvaluationService';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  await createDevice({ orgId: org.id, siteId: site!.id });
  await createDevice({ orgId: org.id, siteId: site!.id });
  const [orgScript] = await withSystemDbAccessContext(() => db.insert(scripts).values({
    orgId: org.id, partnerId: partner.id, name: `org-${randomUUID().slice(0, 6)}`, language: 'bash', content: 'echo', osTypes: ['windows'], runAs: 'system', timeoutSeconds: 60,
  }).returning({ id: scripts.id }));
  const [partnerScript] = await withSystemDbAccessContext(() => db.insert(scripts).values({
    orgId: null, partnerId: partner.id, name: `pw-${randomUUID().slice(0, 6)}`, language: 'bash', content: 'echo', osTypes: ['windows'], runAs: 'elevated', timeoutSeconds: 60,
  }).returning({ id: scripts.id }));
  return { partnerId: partner.id, orgId: org.id, orgScript: orgScript!.id, partnerScript: partnerScript!.id };
}

async function job(values: Partial<typeof automations.$inferInsert>) {
  const [row] = await withSystemDbAccessContext(() => db.insert(automations).values({
    name: `job-${randomUUID().slice(0, 6)}`, trigger: { type: 'schedule', cronExpression: '0 2 * * *', timezone: 'UTC' },
    actions: [], ...values,
  } as typeof automations.$inferInsert).returning());
  return row!;
}

describe('loadConversionContext (real Postgres, #5221)', () => {
  runDb('owner predicates are explicit: an org Job owns its org and partner scripts', async () => {
    const s = await seed();
    const row = await job({
      orgId: s.orgId,
      actions: [{ type: 'run_script', scriptId: s.orgScript }, { type: 'run_script', scriptId: s.partnerScript }],
      conditions: [],
    });
    const ctx = await loadConversionContext(row);
    expect(ctx.owner).toEqual({ orgId: s.orgId, partnerId: s.partnerId });
    expect(ctx.scripts.get(s.orgScript)).toMatchObject({ ownedByOwner: true, effectiveRunAs: 'system', preApprovable: true });
    expect(ctx.scripts.get(s.partnerScript)).toMatchObject({ ownedByOwner: true, effectiveRunAs: 'elevated' });
    expect(ctx.currentTargets).toMatchObject({ count: 2 });
    expect([...ctx.currentTargets!.osTypes]).toEqual(['windows']);
    expect(ctx.isRemediationTarget).toBe(false);
    expect(ctx.partnerOrgs).toBeNull();
  });

  runDb('partner-wide owner never treats an org script as owned', async () => {
    const s = await seed();
    const row = await job({
      orgId: null, partnerId: s.partnerId,
      actions: [{ type: 'run_script', scriptId: s.orgScript }, { type: 'run_script', scriptId: s.partnerScript }],
      trigger: { type: 'event', eventType: 'alert.triggered' },
    });
    const ctx = await loadConversionContext(row);
    expect(ctx.owner).toEqual({ orgId: null, partnerId: s.partnerId });
    expect(ctx.scripts.get(s.orgScript)!.ownedByOwner).toBe(false);
    expect(ctx.scripts.get(s.partnerScript)!.ownedByOwner).toBe(true);
    expect(ctx.currentTargets).toBeNull();
    expect(ctx.partnerOrgs).toMatchObject({ live: 1, total: 1 });
  });

  runDb('S+R: both remediation consumers match by script within the partner; another partner never does', async () => {
    const s = await seed();
    const other = await seed();
    const row = await job({ orgId: s.orgId, actions: [{ type: 'run_script', scriptId: s.orgScript }] });

    // Another partner's policy naming the same script id never matches.
    await getTestDb().execute(sql`INSERT INTO automation_policies (org_id, name, rules, targets, remediation_script_id)
      VALUES (${other.orgId}, 'other', '[]'::jsonb, '{}'::jsonb, ${s.orgScript})`);
    expect(await withSystemDbAccessContext(() => isComplianceRemediationTarget(db, row, s.partnerId))).toBe(false);

    // Consumer 2: a config-policy compliance rule in the partner.
    const [cp] = await getTestDb().execute<{ id: string }>(sql`INSERT INTO configuration_policies (org_id, name, status) VALUES (${s.orgId}, 'cp', 'active') RETURNING id`);
    const [link] = await getTestDb().execute<{ id: string }>(sql`INSERT INTO config_policy_feature_links (config_policy_id, feature_type) VALUES (${cp!.id}, 'compliance') RETURNING id`);
    await getTestDb().execute(sql`INSERT INTO config_policy_compliance_rules (feature_link_id, name, rules, remediation_script_id)
      VALUES (${link!.id}, 'r', '[]'::jsonb, ${s.orgScript})`);
    expect(await withSystemDbAccessContext(() => isComplianceRemediationTarget(db, row, s.partnerId))).toBe(true);

    // Consumer 1: an automation policy in the partner (a fresh Job and script).
    const s2 = await seed();
    const row2 = await job({ orgId: s2.orgId, actions: [{ type: 'run_script', scriptId: s2.orgScript }] });
    await getTestDb().execute(sql`INSERT INTO automation_policies (org_id, name, rules, targets, remediation_script_id)
      VALUES (${s2.orgId}, 'p', '[]'::jsonb, '{}'::jsonb, ${s2.orgScript})`);
    expect(await withSystemDbAccessContext(() => isComplianceRemediationTarget(db, row2, s2.partnerId))).toBe(true);

    // Explicit: a rule naming the Job.
    const s3 = await seed();
    const row3 = await job({ orgId: s3.orgId, actions: [] });
    await getTestDb().execute(sql`INSERT INTO automation_policies (org_id, name, rules, targets)
      VALUES (${s3.orgId}, 'e', ${JSON.stringify([{ remediationAutomationId: row3.id }])}::jsonb, '{}'::jsonb)`);
    expect(await withSystemDbAccessContext(() => isComplianceRemediationTarget(db, row3, s3.partnerId))).toBe(true);
    expect((await loadConversionContext(row3)).isRemediationTarget).toBe(true);
  });
});

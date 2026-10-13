/**
 * #8598 — device-group targets against real Postgres (breeze_app, forced RLS).
 *
 * Two orgs under one partner, each with a static group. Proves what the unit
 * suites mock away:
 *  - an org-owned automation's group target resolves ONLY its own org's
 *    devices, and a group id from a sibling org is a visible problem, never a
 *    cross-org device (the per-owner-org `eq(devices.orgId, orgId)` predicate);
 *  - a partner-wide `all` target still fans out to every org;
 *  - a stored partner-wide `groups` automation fails its run visibly;
 *  - the script-run resolver and the automation validator, run in a caller's
 *    own DB context, cannot see a group in an org outside that context.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

// publishEvent writes to a Redis stream; nothing here asserts on it.
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return {
    ...actual,
    publishEvent: vi.fn(async () => 'evt-mock'),
    getEventBus: () => ({ subscribe: () => () => undefined }) as never,
  };
});

import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { automationRuns, automations } from '../../db/schema';
import {
  createAutomationRunRecord,
  executeAutomationRun,
  resolveAutomationTargetDeviceIds,
  resolveAutomationTargetsDetailed,
} from '../../services/automationRuntime';
import { resolveDeploymentTargets } from '../../services/deploymentTargetResolver';
import { resolveScriptRunTargets } from '../../services/scriptRunTargets';
import { validateAutomationTargetConditions } from '../../services/automationTargetValidation';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null };
}

const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

type Fixture = {
  partnerId: string;
  orgA: string;
  orgB: string;
  a1: string;
  a2: string;
  b1: string;
  groupA: string;
  groupB: string;
};

async function seedGroup(orgId: string, siteId: string, deviceIds: string[]): Promise<string> {
  const [group] = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO device_groups (org_id, site_id, name, type)
    VALUES (${orgId}, ${siteId}, ${`group-${orgId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`}, 'static')
    RETURNING id
  `);
  for (const deviceId of deviceIds) {
    await getTestDb().execute(sql`
      INSERT INTO device_group_memberships (device_id, group_id, org_id)
      VALUES (${deviceId}, ${group!.id}, ${orgId})
    `);
  }
  return group!.id;
}

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const a1 = await createDevice({ orgId: orgA.id, siteId: siteA!.id });
  const a2 = await createDevice({ orgId: orgA.id, siteId: siteA!.id });
  const b1 = await createDevice({ orgId: orgB.id, siteId: siteB!.id });
  const groupA = await seedGroup(orgA.id, siteA!.id, [a1.id]);
  const groupB = await seedGroup(orgB.id, siteB!.id, [b1.id]);
  return {
    partnerId: partner.id,
    orgA: orgA.id,
    orgB: orgB.id,
    a1: a1.id,
    a2: a2.id,
    b1: b1.id,
    groupA,
    groupB,
  };
}

async function insertAutomation(values: { orgId: string | null; partnerId: string | null; conditions: unknown }) {
  const [row] = await asSystem(() => db.insert(automations).values({
    name: `group-target-${Math.random().toString(36).slice(2, 8)}`,
    trigger: { type: 'manual' },
    actions: [{ type: 'create_alert', alertSeverity: 'medium', alertMessage: 'x' }],
    enabled: true,
    ...values,
  }).returning());
  return row!;
}

let f: Fixture;

beforeEach(async () => {
  f = await seed();
});

describe('automation group targets — per-owner-org resolution', () => {
  it("an org-owned groups target resolves only the owner org's members", async () => {
    const automation = await insertAutomation({
      orgId: f.orgA,
      partnerId: null,
      conditions: { type: 'groups', groupIds: [f.groupA] },
    });

    const r = await asSystem(() => resolveAutomationTargetsDetailed(automation));

    expect(r).toEqual({ deviceIds: [f.a1], warnings: [], problems: [] });
  });

  it("a sibling org's group id is a named problem, never a cross-org device", async () => {
    const automation = await insertAutomation({
      orgId: f.orgA,
      partnerId: null,
      conditions: { type: 'groups', groupIds: [f.groupA, f.groupB] },
    });

    const r = await asSystem(() => resolveAutomationTargetsDetailed(automation));

    expect(r.deviceIds).toEqual([f.a1]);
    expect(r.deviceIds).not.toContain(f.b1);
    expect(r.problems.join(' ')).toContain(f.groupB);
  });

  it('the shared resolver called per owner org never returns another org\'s devices', async () => {
    const ids = await asSystem(() => resolveDeploymentTargets({
      orgId: f.orgA,
      targetConfig: { type: 'groups', groupIds: [f.groupB] },
    }));

    expect(ids).toEqual([]);
  });

  it('a partner-wide all target still fans out to every org under the partner', async () => {
    const automation = await insertAutomation({ orgId: null, partnerId: f.partnerId, conditions: { type: 'all' } });

    const ids = await asSystem(() => resolveAutomationTargetDeviceIds(automation));

    expect(new Set(ids)).toEqual(new Set([f.a1, f.a2, f.b1]));
  });

  it('a stored partner-wide groups automation fails its run visibly and dispatches nothing', async () => {
    const automation = await insertAutomation({
      orgId: null,
      partnerId: f.partnerId,
      conditions: { type: 'groups', groupIds: [f.groupA] },
    });

    const { run, targetDeviceIds } = await asSystem(() => createAutomationRunRecord({
      automation,
      triggeredBy: 'manual:test',
    }));
    expect(targetDeviceIds).toEqual([]);

    const outcome = await executeAutomationRun(run.id, targetDeviceIds);
    expect(outcome.status).toBe('failed');

    const [stored] = await asSystem(() => db.select().from(automationRuns).where(eq(automationRuns.id, run.id)));
    expect(stored?.status).toBe('failed');
    expect(stored?.completedAt).not.toBeNull();
    expect(stored?.devicesTargeted).toBe(0);
    expect(JSON.stringify(stored?.logs)).toMatch(/not supported on partner-wide/);
  });

  it('a deleted group fails an org-owned run visibly instead of completing empty', async () => {
    const automation = await insertAutomation({
      orgId: f.orgA,
      partnerId: null,
      conditions: { type: 'groups', groupIds: [f.groupA] },
    });
    await getTestDb().execute(sql`DELETE FROM device_group_memberships WHERE group_id = ${f.groupA}`);
    await getTestDb().execute(sql`DELETE FROM device_groups WHERE id = ${f.groupA}`);

    const { run } = await asSystem(() => createAutomationRunRecord({ automation, triggeredBy: 'manual:test' }));

    const [stored] = await asSystem(() => db.select().from(automationRuns).where(eq(automationRuns.id, run.id)));
    expect(stored?.status).toBe('failed');
    expect(JSON.stringify(stored?.logs)).toContain(f.groupA);
  });
});

describe('caller-context resolution cannot see another org\'s group', () => {
  it('script-run resolution: a group outside the caller\'s orgs is GROUP_NOT_FOUND, not a smaller run', async () => {
    const r = await withDbAccessContext(partnerContext(f.partnerId, [f.orgA]), () => resolveScriptRunTargets({
      auth: { canAccessOrg: (orgId: string) => orgId === f.orgA },
      permissions: undefined,
      target: { type: 'groups', groupIds: [f.groupA, f.groupB] },
    }));

    expect(r).toMatchObject({ ok: false, code: 'GROUP_NOT_FOUND', groupIds: [f.groupB] });
  });

  it('script-run resolution: a partner caller with both orgs gets exactly both groups\' members', async () => {
    const r = await withDbAccessContext(partnerContext(f.partnerId, [f.orgA, f.orgB]), () => resolveScriptRunTargets({
      auth: { canAccessOrg: (orgId: string) => orgId === f.orgA || orgId === f.orgB },
      permissions: undefined,
      target: { type: 'groups', groupIds: [f.groupA, f.groupB] },
    }));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new Set(r.deviceIds)).toEqual(new Set([f.a1, f.b1]));
    expect(r.resolvedGroups).toEqual([
      { id: f.groupA, orgId: f.orgA, memberCount: 1, refused: false },
      { id: f.groupB, orgId: f.orgB, memberCount: 1, refused: false },
    ]);
  });

  it("automation validation in an org's context rejects a sibling org's group", async () => {
    const r = await withDbAccessContext(orgContext(f.orgA), () => validateAutomationTargetConditions({
      owner: { orgId: f.orgA, partnerId: null },
      conditions: { type: 'groups', groupIds: [f.groupA, f.groupB] },
    }));

    expect(r).toMatchObject({ ok: false, code: 'INVALID_TARGET', groupIds: [f.groupB] });
  });
});

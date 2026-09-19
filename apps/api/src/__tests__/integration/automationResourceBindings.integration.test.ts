/**
 * Real-Postgres contract for automation_resource_bindings.
 *
 * Breaks caught here:
 * - weakening dual-axis RLS permits an org/partner to forge another tenant's binding;
 * - a hidden parent automation is never treated as missing by the invoker-rights
 *   child trigger, because FK checks bypass RLS while the trigger does not;
 * - removing the owner/expected-owner checks permits a binding to disagree with
 *   its parent automation or to pin a foreign resource owner;
 * - removing the parent FK cascade strands bindings after automation deletion;
 * - changing the bounded migration backfill admits foreign references or creates
 *   execution rows while reconciling legacy automation JSON.
 */
import './setup';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { automations, automationRuns } from '../../db/schema/automations';
import { notificationChannels } from '../../db/schema/alerts';
import { scripts } from '../../db/schema/scripts';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-09-25-a-automation-resource-bindings.sql';
const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test', {
  max: 1,
  onnotice: (notice) => notices.push(String(notice.message)),
});

afterAll(async () => {
  await adminSql.end({ timeout: 5 });
});

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

async function seedFixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgA2 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  const orgB2 = await createOrganization({ partnerId: partnerB.id });

  const [orgAutomationA, orgAutomationB, partnerAutomationA, partnerAutomationB] =
    await getTestDb().insert(automations).values([
      { orgId: orgA1.id, partnerId: null, name: 'Org A automation', trigger: { type: 'manual' }, actions: [] },
      { orgId: orgB1.id, partnerId: null, name: 'Org B automation', trigger: { type: 'manual' }, actions: [] },
      { orgId: null, partnerId: partnerA.id, name: 'Partner A automation', trigger: { type: 'manual' }, actions: [] },
      { orgId: null, partnerId: partnerB.id, name: 'Partner B automation', trigger: { type: 'manual' }, actions: [] },
    ]).returning({ id: automations.id });

  const [orgScriptA, orgScriptB, partnerScriptA, partnerScriptB] =
    await getTestDb().insert(scripts).values([
      {
        orgId: orgA1.id,
        partnerId: partnerA.id,
        name: 'Org A script',
        osTypes: ['windows'],
        language: 'powershell',
        content: 'Get-Date',
      },
      {
        orgId: orgB1.id,
        partnerId: partnerB.id,
        name: 'Org B script',
        osTypes: ['windows'],
        language: 'powershell',
        content: 'Get-Date',
      },
      {
        orgId: null,
        partnerId: partnerA.id,
        name: 'Partner A script',
        osTypes: ['windows'],
        language: 'powershell',
        content: 'Get-Date',
      },
      {
        orgId: null,
        partnerId: partnerB.id,
        name: 'Partner B script',
        osTypes: ['windows'],
        language: 'powershell',
        content: 'Get-Date',
      },
    ]).returning({ id: scripts.id });

  const [orgChannelA] = await getTestDb().insert(notificationChannels).values({
    orgId: orgA1.id,
    partnerId: null,
    name: 'Org A notification channel',
    type: 'webhook',
    config: { url: 'https://example.invalid/hook' },
  }).returning({ id: notificationChannels.id });

  return {
    partnerA,
    partnerB,
    orgA1,
    orgA2,
    orgB1,
    orgB2,
    orgAutomationA: orgAutomationA!,
    orgAutomationB: orgAutomationB!,
    partnerAutomationA: partnerAutomationA!,
    partnerAutomationB: partnerAutomationB!,
    orgScriptA: orgScriptA!,
    orgScriptB: orgScriptB!,
    partnerScriptA: partnerScriptA!,
    partnerScriptB: partnerScriptB!,
    orgChannelA: orgChannelA!,
  };
}

async function causeOf(work: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { cause?: { code?: string; message?: string } }).cause
      ?? (error as { code?: string; message?: string });
  }
}

async function insertBinding(input: {
  automationId: string;
  orgId: string | null;
  partnerId: string | null;
  resourceId: string;
  expectedOrgId: string | null;
  expectedPartnerId: string | null;
  expectedSystem?: boolean;
  state?: 'active' | 'quarantined';
  reason?: string | null;
}) {
  return db.execute(sql`
    INSERT INTO automation_resource_bindings (
      automation_id,
      org_id,
      partner_id,
      resource_kind,
      resource_id,
      expected_resource_org_id,
      expected_resource_partner_id,
      expected_resource_is_system,
      state,
      reason
    ) VALUES (
      ${input.automationId}::uuid,
      ${input.orgId}::uuid,
      ${input.partnerId}::uuid,
      'script',
      ${input.resourceId}::uuid,
      ${input.expectedOrgId}::uuid,
      ${input.expectedPartnerId}::uuid,
      ${input.expectedSystem ?? false},
      ${input.state ?? 'active'},
      ${input.reason ?? null}
    )
    RETURNING id, automation_id, org_id, partner_id, state
  `);
}

describe.runIf(RUN)('automation_resource_bindings tenancy and quarantine', () => {
  it('allows an org binding but prevents organization A from forging organization B ownership', async () => {
    const f = await seedFixture();

    const own = await withDbAccessContext(orgContext(f.orgA1.id), () => insertBinding({
      automationId: f.orgAutomationA.id,
      orgId: f.orgA1.id,
      partnerId: null,
      resourceId: f.orgScriptA.id,
      expectedOrgId: f.orgA1.id,
      expectedPartnerId: f.partnerA.id,
    }));
    expect(own).toHaveLength(1);

    const cause = await causeOf(() =>
      withDbAccessContext(orgContext(f.orgA1.id), () => insertBinding({
        automationId: f.orgAutomationB.id,
        orgId: f.orgB1.id,
        partnerId: null,
        resourceId: f.orgScriptB.id,
        expectedOrgId: f.orgB1.id,
        expectedPartnerId: f.partnerB.id,
      })),
    );
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(/row-level security/i);
  });

  it('fails closed instead of binding to an automation hidden by organization RLS', async () => {
    const f = await seedFixture();

    const cause = await causeOf(() =>
      withDbAccessContext(orgContext(f.orgA1.id), () => insertBinding({
        automationId: f.orgAutomationB.id,
        orgId: f.orgA1.id,
        partnerId: null,
        resourceId: f.orgScriptA.id,
        expectedOrgId: f.orgA1.id,
        expectedPartnerId: f.partnerA.id,
      })),
    );
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT id FROM automation_resource_bindings
      WHERE automation_id = ${f.orgAutomationB.id}::uuid
        AND resource_id = ${f.orgScriptA.id}::text
    `));

    expect(cause?.code).toBe('23503');
    expect(cause?.message).toMatch(/automation_resource_bindings_automation_id_fkey/i);
    expect(rows).toHaveLength(0);
  });

  it('prevents partner A from binding a partner B resource owner', async () => {
    const f = await seedFixture();

    const cause = await causeOf(() =>
      withDbAccessContext(
        partnerContext(f.partnerA.id, [f.orgA1.id, f.orgA2.id]),
        () => insertBinding({
          automationId: f.partnerAutomationA.id,
          orgId: null,
          partnerId: f.partnerA.id,
          resourceId: f.partnerScriptB.id,
          expectedOrgId: null,
          expectedPartnerId: f.partnerB.id,
        }),
      ),
    );
    expect(cause?.code).toBe('23514');
    expect(cause?.message).toMatch(/expected resource owner/i);
  });

  it('rejects binding-owner drift from the parent, malformed XOR axes, and malformed expected-owner axes', async () => {
    const f = await seedFixture();

    const ownerDrift = await causeOf(() => withSystemDbAccessContext(() => insertBinding({
      automationId: f.orgAutomationA.id,
      orgId: f.orgB1.id,
      partnerId: null,
      resourceId: f.orgScriptA.id,
      expectedOrgId: f.orgB1.id,
      expectedPartnerId: f.partnerB.id,
    })));
    expect(ownerDrift?.code).toBe('23514');
    expect(ownerDrift?.message).toMatch(/parent automation owner/i);

    const bothAxes = await causeOf(() => withSystemDbAccessContext(() => insertBinding({
      automationId: f.orgAutomationA.id,
      orgId: f.orgA1.id,
      partnerId: f.partnerA.id,
      resourceId: f.orgScriptA.id,
      expectedOrgId: f.orgA1.id,
      expectedPartnerId: f.partnerA.id,
    })));
    expect(bothAxes?.code).toBe('23514');

    const neitherAxis = await causeOf(() => withSystemDbAccessContext(() => insertBinding({
      automationId: f.orgAutomationA.id,
      orgId: null,
      partnerId: null,
      resourceId: f.orgScriptA.id,
      expectedOrgId: f.orgA1.id,
      expectedPartnerId: f.partnerA.id,
    })));
    expect(neitherAxis?.code).toBe('23514');

    const contradictorySystemOwner = await causeOf(() => withSystemDbAccessContext(() => insertBinding({
      automationId: f.orgAutomationA.id,
      orgId: f.orgA1.id,
      partnerId: null,
      resourceId: f.orgScriptA.id,
      expectedOrgId: f.orgA1.id,
      expectedPartnerId: null,
      expectedSystem: true,
    })));
    expect(contradictorySystemOwner?.code).toBe('23514');
  });

  it('enforces automation/resource identity uniqueness and cascades bindings with the automation', async () => {
    const f = await seedFixture();
    const values = {
      automationId: f.orgAutomationA.id,
      orgId: f.orgA1.id,
      partnerId: null,
      resourceId: f.orgScriptA.id,
      expectedOrgId: f.orgA1.id,
      expectedPartnerId: f.partnerA.id,
    };

    await withDbAccessContext(orgContext(f.orgA1.id), () => insertBinding(values));
    const duplicate = await causeOf(() =>
      withDbAccessContext(orgContext(f.orgA1.id), () => insertBinding(values)),
    );
    expect(duplicate?.code).toBe('23505');

    await getTestDb().delete(automations).where(eq(automations.id, f.orgAutomationA.id));
    const remaining = await getTestDb().execute(sql`
      SELECT id FROM automation_resource_bindings WHERE automation_id = ${f.orgAutomationA.id}::uuid
    `);
    expect(remaining).toHaveLength(0);
  });

  it('bounded backfill activates an owned reference, quarantines a foreign one, reports both counts, and creates no execution rows', async () => {
    const f = await seedFixture();
    const [legacy] = await getTestDb().insert(automations).values({
      orgId: f.orgA1.id,
      partnerId: null,
      name: 'Legacy mixed ownership automation',
      trigger: { type: 'manual' },
      actions: [
        { type: 'run_script', scriptId: f.orgScriptA.id },
        { type: 'run_script', scriptId: f.orgScriptB.id },
      ],
      notificationTargets: { channelIds: [f.orgChannelA.id] },
    }).returning({ id: automations.id });

    notices.length = 0;
    const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
    await adminSql.unsafe(migrationSql);

    const rows = await getTestDb().execute(sql`
      SELECT resource_id, state, reason,
             expected_resource_org_id, expected_resource_partner_id
      FROM automation_resource_bindings
      WHERE automation_id = ${legacy!.id}::uuid
      ORDER BY resource_id
    `) as unknown as Array<{
      resource_id: string;
      state: 'active' | 'quarantined';
      reason: string | null;
      expected_resource_org_id: string | null;
      expected_resource_partner_id: string | null;
    }>;

    expect(rows).toEqual([
      {
        resource_id: f.orgScriptA.id,
        state: 'active',
        reason: null,
        expected_resource_org_id: f.orgA1.id,
        expected_resource_partner_id: f.partnerA.id,
      },
      {
        resource_id: f.orgScriptB.id,
        state: 'quarantined',
        reason: 'unknown_or_unauthorized_reference',
        expected_resource_org_id: f.orgA1.id,
        expected_resource_partner_id: f.partnerA.id,
      },
      {
        resource_id: f.orgChannelA.id,
        state: 'active',
        reason: null,
        expected_resource_org_id: f.orgA1.id,
        expected_resource_partner_id: null,
      },
    ].sort((a, b) => a.resource_id.localeCompare(b.resource_id)));

    expect(notices.filter((message) => message.startsWith('automation-resource-bindings:'))).toEqual([
      'automation-resource-bindings: backfilled 2 active binding(s)',
      'automation-resource-bindings: quarantined 1 binding(s)',
    ]);
    const executionRows = await getTestDb().select({ id: automationRuns.id })
      .from(automationRuns)
      .where(eq(automationRuns.automationId, legacy!.id));
    expect(executionRows).toHaveLength(0);
  });
});

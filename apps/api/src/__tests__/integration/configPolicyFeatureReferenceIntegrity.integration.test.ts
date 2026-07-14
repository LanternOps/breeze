import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyBackupSettings,
  configPolicyFeatureLinks,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null,
  accessiblePartnerIds: null, userId: null,
};

const createdPolicies: string[] = [];
const createdReferences: Array<{ table: string; id: string }> = [];
const referenceTables = {
  patch: 'patch_policies',
  software_policy: 'software_policies',
  security: 'security_policies',
  alert_rule: 'alert_rules',
  compliance: 'automation_policies',
  sensitive_data: 'sensitive_data_policies',
  peripheral_control: 'peripheral_policies',
  maintenance: 'maintenance_windows',
  backup: 'backup_profiles',
} as const;

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId], userId: null,
  };
}

async function insertRaw(query: ReturnType<typeof sql>): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () => db.execute(query));
  const id = String((rows[0] as { id: string }).id);
  return id;
}

async function trackReference(table: string, query: ReturnType<typeof sql>): Promise<string> {
  const id = await insertRaw(query);
  createdReferences.push({ table, id });
  return id;
}

async function seedPolicy(orgId: string): Promise<string> {
  const [policy] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
    name: `Reference integrity ${randomUUID()}`, orgId, partnerId: null, status: 'active',
  }).returning());
  createdPolicies.push(policy!.id);
  return policy!.id;
}

async function seedPartnerPolicy(partnerId: string): Promise<string> {
  const [policy] = await withDbAccessContext(SYSTEM_CTX, () => db.insert(configurationPolicies).values({
    name: `Partner reference integrity ${randomUUID()}`,
    orgId: null, partnerId, status: 'active',
  }).returning());
  createdPolicies.push(policy!.id);
  return policy!.id;
}

async function insertValidFeatureReference(
  ctx: DbAccessContext,
  configPolicyId: string,
  featureType: keyof typeof referenceTables,
  featurePolicyId: string,
  owner: { orgId: string | null; partnerId: string },
) {
  return withDbAccessContext(ctx, async () => {
    const rows = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId, featureType, featurePolicyId,
    }).returning();
    if (featureType === 'backup') {
      await db.insert(configPolicyBackupSettings).values({
        featureLinkId: rows[0]!.id,
        orgId: owner.orgId,
        partnerId: owner.orgId ? null : owner.partnerId,
        backupProfileId: featurePolicyId,
        schedule: {},
        retention: {},
      });
    }
    return rows;
  });
}

async function seedActualReference(
  featureType: string,
  owner: { orgId: string; partnerId: string },
): Promise<string> {
  const suffix = randomUUID();
  switch (featureType) {
    case 'patch':
      return trackReference('patch_policies', sql`
        INSERT INTO patch_policies (partner_id, kind, name)
        VALUES (${owner.partnerId}, 'ring', ${`Ring ${suffix}`}) RETURNING id`);
    case 'software_policy':
      return trackReference('software_policies', sql`
        INSERT INTO software_policies (org_id, partner_id, name, mode, rules)
        VALUES (${owner.orgId}, NULL, ${`Software ${suffix}`}, 'audit', '{"software":[]}'::jsonb) RETURNING id`);
    case 'security':
      return trackReference('security_policies', sql`
        INSERT INTO security_policies (org_id, partner_id, name)
        VALUES (${owner.orgId}, NULL, ${`Security ${suffix}`}) RETURNING id`);
    case 'alert_rule': {
      const templateId = await trackReference('alert_templates', sql`
        INSERT INTO alert_templates (name, conditions, severity, title_template, message_template)
        VALUES (${`Template ${suffix}`}, '{}'::jsonb, 'medium', 'title', 'message') RETURNING id`);
      return trackReference('alert_rules', sql`
        INSERT INTO alert_rules (org_id, partner_id, template_id, name, target_type, target_id)
        VALUES (${owner.orgId}, NULL, ${templateId}, ${`Alert ${suffix}`}, 'organization', ${owner.orgId}) RETURNING id`);
    }
    case 'compliance':
      return trackReference('automation_policies', sql`
        INSERT INTO automation_policies (org_id, partner_id, name, targets, rules)
        VALUES (${owner.orgId}, NULL, ${`Compliance ${suffix}`}, '{}'::jsonb, '{}'::jsonb) RETURNING id`);
    case 'sensitive_data':
      return trackReference('sensitive_data_policies', sql`
        INSERT INTO sensitive_data_policies (org_id, partner_id, name)
        VALUES (${owner.orgId}, NULL, ${`Sensitive ${suffix}`}) RETURNING id`);
    case 'peripheral_control':
      return trackReference('peripheral_policies', sql`
        INSERT INTO peripheral_policies (org_id, partner_id, name, device_class, action, target_type)
        VALUES (${owner.orgId}, NULL, ${`Peripheral ${suffix}`}, 'storage', 'block', 'organization') RETURNING id`);
    case 'maintenance':
      return trackReference('maintenance_windows', sql`
        INSERT INTO maintenance_windows (org_id, partner_id, name, start_time, end_time, target_type)
        VALUES (${owner.orgId}, NULL, ${`Maintenance ${suffix}`}, now(), now() + interval '1 hour', 'organization') RETURNING id`);
    case 'backup':
      return trackReference('backup_profiles', sql`
        INSERT INTO backup_profiles (org_id, partner_id, name, selections)
        VALUES (${owner.orgId}, NULL, ${`Backup ${suffix}`}, '{}'::jsonb) RETURNING id`);
    default:
      throw new Error(`unsupported reference seed: ${featureType}`);
  }
}

afterEach(async () => {
  for (const id of createdPolicies.reverse()) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(configurationPolicies).where(eq(configurationPolicies.id, id)));
  }
  for (const { table, id } of createdReferences.reverse()) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.execute(sql.raw(`DELETE FROM public.${table} WHERE id = '${id}'::uuid`)));
  }
  createdPolicies.length = 0;
  createdReferences.length = 0;
});

describe('config_policy_feature_links feature_policy_id tenant integrity', () => {
  it.each([
    'patch', 'software_policy', 'security', 'alert_rule', 'compliance',
    'sensitive_data', 'peripheral_control', 'maintenance', 'backup',
  ] as const)('%s accepts its mapped same-tenant row and rejects the mapped cross-tenant row', async (featureType) => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const referenceA = await seedActualReference(featureType, { orgId: orgA.id, partnerId: partnerA.id });
    const referenceB = await seedActualReference(featureType, { orgId: orgB.id, partnerId: partnerB.id });
    const validPolicy = await seedPolicy(orgA.id);
    const forgedPolicy = await seedPolicy(orgA.id);
    const ctx = partnerContext(partnerA.id, [orgA.id]);

    await expect(insertValidFeatureReference(
      ctx, validPolicy, featureType, referenceA, { orgId: orgA.id, partnerId: partnerA.id },
    )).resolves.toHaveLength(1);
    await expect(withDbAccessContext(ctx, () => db.insert(configPolicyFeatureLinks).values({
      configPolicyId: forgedPolicy, featureType, featurePolicyId: referenceB,
    }).returning())).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('rejects a same-tenant UUID from the wrong mapped feature table', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const securityReference = await seedActualReference('security', {
      orgId: org.id, partnerId: partner.id,
    });
    const softwareParent = await seedPolicy(org.id);

    await expect(withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.insert(configPolicyFeatureLinks).values({
        configPolicyId: softwareParent,
        featureType: 'software_policy',
        featurePolicyId: securityReference,
      }).returning(),
    )).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it.each(Object.keys(referenceTables) as Array<keyof typeof referenceTables>)(
    '%s accepts its mapped partner-owned reference on a partner-owned parent',
    async (featureType) => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const reference = await seedActualReference(featureType, {
        orgId: org.id, partnerId: partner.id,
      });
      if (featureType !== 'patch') {
        const table = referenceTables[featureType];
        await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql.raw(
          `UPDATE public.${table} SET org_id = NULL, partner_id = '${partner.id}'::uuid WHERE id = '${reference}'::uuid`,
        )));
      }
      const parent = await seedPartnerPolicy(partner.id);

      await expect(insertValidFeatureReference(
        partnerContext(partner.id, [org.id]),
        parent,
        featureType,
        reference,
        { orgId: null, partnerId: partner.id },
      )).resolves.toHaveLength(1);
    },
  );

  it.each([
    ['patch', 'patch_policies'],
    ['software_policy', 'software_policies'],
    ['security', 'security_policies'],
    ['alert_rule', 'alert_rules'],
    ['compliance', 'automation_policies'],
    ['sensitive_data', 'sensitive_data_policies'],
    ['peripheral_control', 'peripheral_policies'],
    ['maintenance', 'maintenance_windows'],
    ['backup', 'backup_profiles'],
  ] as const)('%s reverse-validates target owner mutations', async (featureType, table) => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const reference = await seedActualReference(featureType, { orgId: orgA.id, partnerId: partnerA.id });
    const policy = await seedPolicy(orgA.id);
    await insertValidFeatureReference(
      partnerContext(partnerA.id, [orgA.id]),
      policy,
      featureType,
      reference,
      { orgId: orgA.id, partnerId: partnerA.id },
    );

    const mutation = featureType === 'patch'
      ? sql.raw(`UPDATE public.${table} SET partner_id = '${partnerB.id}'::uuid WHERE id = '${reference}'::uuid`)
      : sql.raw(`UPDATE public.${table} SET org_id = '${orgB.id}'::uuid WHERE id = '${reference}'::uuid`);
    await expect(withDbAccessContext(SYSTEM_CTX, () => db.execute(mutation)))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('patch reverse-validates the ring kind discriminator', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const reference = await seedActualReference('patch', { orgId: org.id, partnerId: partner.id });
    const policy = await seedPolicy(org.id);
    await withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.insert(configPolicyFeatureLinks).values({
        configPolicyId: policy, featureType: 'patch', featurePolicyId: reference,
      }));

    await expect(withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
      UPDATE patch_policies SET kind = 'legacy' WHERE id = ${reference}
    `))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('sensitive_data accepts a partner-owned configuration-policy fallback for an org parent', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const partnerTemplate = await seedPartnerPolicy(partner.id);
    const parentPolicy = await seedPolicy(org.id);

    await expect(withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
      db.insert(configPolicyFeatureLinks).values({
        configPolicyId: parentPolicy,
        featureType: 'sensitive_data',
        featurePolicyId: partnerTemplate,
      }).returning(),
    )).resolves.toHaveLength(1);
  });

  it.each([
    'automation', 'helper', 'remote_access', 'pam', 'warranty',
  ] as const)('%s accepts a same-org configuration policy and rejects a cross-org policy', async (featureType) => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const referenceA = await seedPolicy(orgA.id);
    const referenceB = await seedPolicy(orgB.id);
    const validPolicy = await seedPolicy(orgA.id);
    const forgedPolicy = await seedPolicy(orgA.id);
    const ctx = partnerContext(partnerA.id, [orgA.id]);

    await expect(withDbAccessContext(ctx, () => db.insert(configPolicyFeatureLinks).values({
      configPolicyId: validPolicy, featureType, featurePolicyId: referenceA,
    }).returning())).resolves.toHaveLength(1);
    await expect(withDbAccessContext(ctx, () => db.insert(configPolicyFeatureLinks).values({
      configPolicyId: forgedPolicy, featureType, featurePolicyId: referenceB,
    }).returning())).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it.each([
    'automation', 'helper', 'remote_access', 'pam', 'warranty',
  ] as const)('%s reverse-validates referenced configuration-policy owner mutations', async (featureType) => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const reference = await seedPolicy(orgA.id);
    const parent = await seedPolicy(orgA.id);
    await withDbAccessContext(partnerContext(partner.id, [orgA.id]), () =>
      db.insert(configPolicyFeatureLinks).values({
        configPolicyId: parent, featureType, featurePolicyId: reference,
      }));

    await expect(withDbAccessContext(SYSTEM_CTX, () => db.update(configurationPolicies)
      .set({ orgId: orgB.id })
      .where(eq(configurationPolicies.id, reference))))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it.each([
    'monitoring', 'event_log', 'onedrive_helper', 'vulnerability',
  ] as const)('%s requires a NULL feature_policy_id', async (featureType) => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const validPolicy = await seedPolicy(org.id);
    const forgedPolicy = await seedPolicy(org.id);
    const ctx = partnerContext(partner.id, [org.id]);

    await expect(withDbAccessContext(ctx, () => db.insert(configPolicyFeatureLinks).values({
      configPolicyId: validPolicy, featureType, featurePolicyId: null, inlineSettings: {},
    }).returning())).resolves.toHaveLength(1);
    await expect(withDbAccessContext(ctx, () => db.insert(configPolicyFeatureLinks).values({
      configPolicyId: forgedPolicy, featureType, featurePolicyId: randomUUID(),
    }).returning())).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});

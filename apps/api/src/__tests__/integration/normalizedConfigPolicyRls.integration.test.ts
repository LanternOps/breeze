/**
 * Configuration-policy child RLS — parent-derived dual-axis
 * enforcement (2026-07-26-a-normalized-policy-tenant-integrity.sql).
 *
 * These tables do not carry org_id / partner_id columns. Their tenant is
 * derived through a parent configuration policy: feature links and assignments
 * point there directly, while the six normalized settings tables resolve
 * through feature_link_id. Catalog coverage proves that RLS is enabled and
 * forced; this suite proves that the policies work through the real
 * non-BYPASSRLS breeze_app connection for all eight tables.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql, type SQL } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configFeatureTypeEnum,
} from '../../db/schema';
import { createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdPolicyIds: string[] = [];

afterEach(async () => {
  // Policy deletion cascades through feature links and normalized children.
  // Delete one policy per transaction so export-clock locks retain the same
  // ordering as the production single-policy deletion path.
  for (const id of createdPolicyIds) {
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.delete(configurationPolicies).where(eq(configurationPolicies.id, id)),
    );
  }
  createdPolicyIds.length = 0;
});

function partnerContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

type FeatureType = (typeof configFeatureTypeEnum.enumValues)[number];

interface ParentDerivedTableCase {
  label: string;
  tableName: string;
  featureType: FeatureType;
  requiresFeatureLink: boolean;
  insertStatement: (anchors: PolicyAnchors, marker: string, actorPartnerId: string) => SQL;
  updateStatement: (rowId: string) => SQL;
}

const PARENT_DERIVED_TABLE_CASES: ParentDerivedTableCase[] = [
  {
    label: 'feature links',
    tableName: 'config_policy_feature_links',
    featureType: 'patch',
    requiresFeatureLink: false,
    insertStatement: ({ policyId }, marker) => sql`
      INSERT INTO config_policy_feature_links
        (config_policy_id, feature_type, inline_settings)
      VALUES (${policyId}, 'patch', ${JSON.stringify({ marker })}::jsonb)
      RETURNING id
    `,
    updateStatement: (rowId) => sql`
      UPDATE config_policy_feature_links
      SET updated_at = updated_at + interval '1 millisecond'
      WHERE id = ${rowId}
      RETURNING id
    `,
  },
  {
    label: 'assignments',
    tableName: 'config_policy_assignments',
    featureType: 'patch',
    requiresFeatureLink: false,
    insertStatement: ({ policyId }, _marker, actorPartnerId) => sql`
      INSERT INTO config_policy_assignments
        (config_policy_id, level, target_id)
      VALUES (${policyId}, 'partner', ${actorPartnerId})
      RETURNING id
    `,
    updateStatement: (rowId) => sql`
      UPDATE config_policy_assignments
      SET priority = priority + 1
      WHERE id = ${rowId}
      RETURNING id
    `,
  },
  {
    label: 'alert rules',
    tableName: 'config_policy_alert_rules',
    featureType: 'alert_rule',
    requiresFeatureLink: true,
    insertStatement: ({ featureLinkId }, marker) => sql`
      INSERT INTO config_policy_alert_rules
        (feature_link_id, name, severity, conditions)
      VALUES (${featureLinkId!}, ${marker}, 'medium', ${JSON.stringify({ kind: 'threshold' })}::jsonb)
      RETURNING id
    `,
    updateStatement: timestampUpdate('config_policy_alert_rules'),
  },
  {
    label: 'automations',
    tableName: 'config_policy_automations',
    featureType: 'automation',
    requiresFeatureLink: true,
    insertStatement: ({ featureLinkId }, marker) => sql`
      INSERT INTO config_policy_automations
        (feature_link_id, name, trigger_type, actions)
      VALUES (${featureLinkId!}, ${marker}, 'schedule', ${JSON.stringify([])}::jsonb)
      RETURNING id
    `,
    updateStatement: timestampUpdate('config_policy_automations'),
  },
  {
    label: 'compliance rules',
    tableName: 'config_policy_compliance_rules',
    featureType: 'compliance',
    requiresFeatureLink: true,
    insertStatement: ({ featureLinkId }, marker) => sql`
      INSERT INTO config_policy_compliance_rules
        (feature_link_id, name, rules)
      VALUES (${featureLinkId!}, ${marker}, ${JSON.stringify([])}::jsonb)
      RETURNING id
    `,
    updateStatement: timestampUpdate('config_policy_compliance_rules'),
  },
  {
    label: 'patch settings',
    tableName: 'config_policy_patch_settings',
    featureType: 'patch',
    requiresFeatureLink: true,
    insertStatement: ({ featureLinkId }) => sql`
      INSERT INTO config_policy_patch_settings (feature_link_id)
      VALUES (${featureLinkId!})
      RETURNING id
    `,
    updateStatement: timestampUpdate('config_policy_patch_settings'),
  },
  {
    label: 'maintenance settings',
    tableName: 'config_policy_maintenance_settings',
    featureType: 'maintenance',
    requiresFeatureLink: true,
    insertStatement: ({ featureLinkId }) => sql`
      INSERT INTO config_policy_maintenance_settings (feature_link_id)
      VALUES (${featureLinkId!})
      RETURNING id
    `,
    updateStatement: timestampUpdate('config_policy_maintenance_settings'),
  },
  {
    label: 'event-log settings',
    tableName: 'config_policy_event_log_settings',
    featureType: 'event_log',
    requiresFeatureLink: true,
    insertStatement: ({ featureLinkId }) => sql`
      INSERT INTO config_policy_event_log_settings (feature_link_id)
      VALUES (${featureLinkId!})
      RETURNING id
    `,
    updateStatement: timestampUpdate('config_policy_event_log_settings'),
  },
];

interface PolicyAnchors {
  policyId: string;
  featureLinkId: string | null;
}

function timestampUpdate(tableName: string): (rowId: string) => SQL {
  return (rowId) => sql`
    UPDATE ${sql.raw(tableName)}
    SET updated_at = updated_at + interval '1 millisecond'
    WHERE id = ${rowId}
    RETURNING id
  `;
}

async function seedPartnerAnchors(
  partnerId: string,
  featureType: FeatureType,
  requiresFeatureLink: boolean,
): Promise<PolicyAnchors> {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        name: `Normalized ${featureType} RLS policy`,
        orgId: null,
        partnerId,
        status: 'active',
      })
      .returning({ id: configurationPolicies.id });
    createdPolicyIds.push(policy!.id);

    if (!requiresFeatureLink) {
      return { policyId: policy!.id, featureLinkId: null };
    }

    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType })
      .returning({ id: configPolicyFeatureLinks.id });
    return { policyId: policy!.id, featureLinkId: link!.id };
  });
}

function rows<T>(result: unknown): T[] {
  return result as T[];
}

describe('configuration-policy parent-derived child RLS (2026-07-26-a)', () => {
  it('runs through breeze_app with BYPASSRLS disabled', async () => {
    const partner = await createPartner();
    const result = await withDbAccessContext(partnerContext(partner.id), () =>
      db.execute(sql`
        SELECT current_user AS who, rolbypassrls
        FROM pg_roles
        WHERE rolname = current_user
      `),
    );

    expect(rows<{ who: string; rolbypassrls: boolean }>(result)[0]).toEqual({
      who: 'breeze_app',
      rolbypassrls: false,
    });
  });

  it.each(PARENT_DERIVED_TABLE_CASES)(
    '$label permits same-owner CRUD and denies cross-partner reads/writes',
    async (tableCase) => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const contextA = partnerContext(partnerA.id);
      const contextB = partnerContext(partnerB.id);
      const ownAnchors = await seedPartnerAnchors(
        partnerA.id,
        tableCase.featureType,
        tableCase.requiresFeatureLink,
      );
      // A separate Partner-A parent ensures that uniqueness constraints cannot
      // mask the RLS result of Partner B's attempted INSERT.
      const forgeAnchors = await seedPartnerAnchors(
        partnerA.id,
        tableCase.featureType,
        tableCase.requiresFeatureLink,
      );

      const inserted = await withDbAccessContext(contextA, () =>
        db.execute(tableCase.insertStatement(ownAnchors, `${tableCase.label} owned by A`, partnerA.id)),
      );
      const rowId = rows<{ id: string }>(inserted)[0]!.id;

      const ownRead = await withDbAccessContext(contextA, () =>
        db.execute(sql`
          SELECT id
          FROM ${sql.raw(tableCase.tableName)}
          WHERE id = ${rowId}
        `),
      );
      expect(rows<{ id: string }>(ownRead).map((row) => row.id)).toEqual([rowId]);

      const ownUpdate = await withDbAccessContext(contextA, () =>
        db.execute(tableCase.updateStatement(rowId)),
      );
      expect(rows<{ id: string }>(ownUpdate).map((row) => row.id)).toEqual([rowId]);

      const foreignRead = await withDbAccessContext(contextB, () =>
        db.execute(sql`
          SELECT id
          FROM ${sql.raw(tableCase.tableName)}
          WHERE id = ${rowId}
        `),
      );
      expect(rows<{ id: string }>(foreignRead)).toEqual([]);

      await expect(
        withDbAccessContext(contextB, () =>
          db.execute(tableCase.insertStatement(forgeAnchors, `${tableCase.label} forged by B`, partnerB.id)),
        ),
      ).rejects.toMatchObject({ cause: { code: '42501' } });

      const foreignUpdate = await withDbAccessContext(contextB, () =>
        db.execute(tableCase.updateStatement(rowId)),
      );
      expect(rows<{ id: string }>(foreignUpdate)).toEqual([]);

      const foreignDelete = await withDbAccessContext(contextB, () =>
        db.execute(sql`
          DELETE FROM ${sql.raw(tableCase.tableName)}
          WHERE id = ${rowId}
          RETURNING id
        `),
      );
      expect(rows<{ id: string }>(foreignDelete)).toEqual([]);

      const ownDelete = await withDbAccessContext(contextA, () =>
        db.execute(sql`
          DELETE FROM ${sql.raw(tableCase.tableName)}
          WHERE id = ${rowId}
          RETURNING id
        `),
      );
      expect(rows<{ id: string }>(ownDelete).map((row) => row.id)).toEqual([rowId]);
    },
  );
});

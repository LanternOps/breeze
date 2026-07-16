import './setup';
import { eq, sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { db as appDb, withDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
} from '../../db/schema';
import { partnerConfigurationRoutes } from '../../routes/partnerApi/configuration';
import { tryNormalizePatchInlineSettings } from '../../services/configPolicyPatching';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const appRule = {
  source: 'third_party',
  packageId: 'Example.App',
  action: 'block',
} as const;

const meaningfulMirror = {
  autoApproveDeferralDays: 7,
  apps: [appRule],
};

const parityCases: Array<{ name: string; mirror: unknown; serializedMirror?: string }> = [
  { name: 'null uses schema defaults', mirror: null },
  { name: 'empty object uses schema defaults', mirror: {} },
  {
    name: 'unknown keys are stripped without invalidating the document',
    mirror: { ...meaningfulMirror, unknown: 'discard me' },
  },
  {
    name: 'JSON 2.0 satisfies the integer constraint',
    mirror: { ...meaningfulMirror, autoApproveDeferralDays: 2.0 },
    serializedMirror: JSON.stringify({ ...meaningfulMirror }).replace(
      '"autoApproveDeferralDays":7',
      '"autoApproveDeferralDays":2.0',
    ),
  },
  {
    name: 'valid optional app fields survive projection',
    mirror: {
      apps: [{ ...appRule, displayName: '', pinnedVersion: 'unused-but-valid' }],
    },
  },
  {
    name: 'a provider-backed source may be combined with a providerless source',
    mirror: { ...meaningfulMirror, sources: ['os', 'drivers'] },
  },
  {
    name: 'enabled auto-approval accepts a non-empty valid severity list',
    mirror: {
      ...meaningfulMirror,
      autoApprove: true,
      autoApproveSeverities: ['critical'],
    },
  },
  {
    name: 'a valid pin rule retains its pinned version',
    mirror: {
      ...meaningfulMirror,
      apps: [{ ...appRule, action: 'pin', pinnedVersion: '2.0' }],
    },
  },
  {
    name: 'inclusive numeric and collection boundaries remain valid',
    mirror: {
      autoApproveDeferralDays: 60,
      scheduleDayOfMonth: 28,
      apps: Array.from({ length: 200 }, (_, index) => ({
        ...appRule,
        packageId: `Example.App.${index}`,
      })),
    },
  },
  { name: 'a non-object document is invalid', mirror: [] },
  { name: 'sources must be an array', mirror: { ...meaningfulMirror, sources: 'os' } },
  { name: 'sources cannot be empty', mirror: { ...meaningfulMirror, sources: [] } },
  { name: 'sources reject unknown values', mirror: { ...meaningfulMirror, sources: ['unknown'] } },
  {
    name: 'providerless-only sources fail whole-document refinement',
    mirror: { ...meaningfulMirror, sources: ['firmware', 'drivers'] },
  },
  { name: 'autoApprove must be boolean', mirror: { ...meaningfulMirror, autoApprove: 'true' } },
  {
    name: 'autoApproveSeverities must be an array',
    mirror: { ...meaningfulMirror, autoApproveSeverities: null },
  },
  {
    name: 'autoApproveSeverities reject unknown values',
    mirror: { ...meaningfulMirror, autoApproveSeverities: ['urgent'] },
  },
  {
    name: 'enabled auto-approval without severities fails whole-document refinement',
    mirror: { ...meaningfulMirror, autoApprove: true, autoApproveSeverities: [] },
  },
  {
    name: 'autoApproveDeferralDays must be numeric',
    mirror: { ...meaningfulMirror, autoApproveDeferralDays: '2' },
  },
  {
    name: 'autoApproveDeferralDays must be integral',
    mirror: { ...meaningfulMirror, autoApproveDeferralDays: 2.5 },
  },
  {
    name: 'autoApproveDeferralDays rejects values below zero',
    mirror: { ...meaningfulMirror, autoApproveDeferralDays: -1 },
  },
  {
    name: 'autoApproveDeferralDays rejects values above sixty',
    mirror: { ...meaningfulMirror, autoApproveDeferralDays: 61 },
  },
  { name: 'apps must be an array', mirror: { ...meaningfulMirror, apps: {} } },
  {
    name: 'apps reject more than two hundred entries',
    mirror: {
      ...meaningfulMirror,
      apps: Array.from({ length: 201 }, (_, index) => ({
        ...appRule,
        packageId: `Example.App.${index}`,
      })),
    },
  },
  { name: 'app entries must be objects', mirror: { ...meaningfulMirror, apps: ['bad'] } },
  {
    name: 'app source rejects unknown values',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, source: 'os' }] },
  },
  {
    name: 'app packageId cannot be empty',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, packageId: '' }] },
  },
  {
    name: 'app packageId rejects more than 256 characters',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, packageId: 'x'.repeat(257) }] },
  },
  {
    name: 'app displayName must be a string when present',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, displayName: null }] },
  },
  {
    name: 'app displayName rejects more than 255 characters',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, displayName: 'x'.repeat(256) }] },
  },
  {
    name: 'app action rejects unknown values',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, action: 'allow' }] },
  },
  {
    name: 'pin action requires pinnedVersion',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, action: 'pin' }] },
  },
  {
    name: 'pinnedVersion must be a string even for block rules',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, pinnedVersion: 1 }] },
  },
  {
    name: 'pinnedVersion cannot be empty even for block rules',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, pinnedVersion: '' }] },
  },
  {
    name: 'pinnedVersion rejects more than 64 characters even for block rules',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, pinnedVersion: 'x'.repeat(65) }] },
  },
  {
    name: 'scheduleFrequency rejects unknown values',
    mirror: { ...meaningfulMirror, scheduleFrequency: 'hourly' },
  },
  {
    name: 'scheduleFrequency must be a string',
    mirror: { ...meaningfulMirror, scheduleFrequency: null },
  },
  {
    name: 'scheduleTime must match the HH:mm contract',
    mirror: { ...meaningfulMirror, scheduleTime: '2:00' },
  },
  {
    name: 'scheduleTime must be a string',
    mirror: { ...meaningfulMirror, scheduleTime: 200 },
  },
  {
    name: 'scheduleDayOfWeek rejects unknown values',
    mirror: { ...meaningfulMirror, scheduleDayOfWeek: 'monday' },
  },
  {
    name: 'scheduleDayOfWeek must be a string',
    mirror: { ...meaningfulMirror, scheduleDayOfWeek: null },
  },
  {
    name: 'scheduleDayOfMonth must be numeric',
    mirror: { ...meaningfulMirror, scheduleDayOfMonth: '2' },
  },
  {
    name: 'scheduleDayOfMonth must be integral',
    mirror: { ...meaningfulMirror, scheduleDayOfMonth: 2.5 },
  },
  {
    name: 'scheduleDayOfMonth rejects values below one',
    mirror: { ...meaningfulMirror, scheduleDayOfMonth: 0 },
  },
  {
    name: 'scheduleDayOfMonth rejects values above twenty-eight',
    mirror: { ...meaningfulMirror, scheduleDayOfMonth: 29 },
  },
  {
    name: 'rebootPolicy rejects unknown values',
    mirror: { ...meaningfulMirror, rebootPolicy: 'sometimes' },
  },
  {
    name: 'rebootPolicy must be a string',
    mirror: { ...meaningfulMirror, rebootPolicy: null },
  },
  {
    name: 'exclusiveWindowsUpdate must be boolean',
    mirror: { ...meaningfulMirror, exclusiveWindowsUpdate: 1 },
  },
  {
    name: 'exact duplicate app identities fail whole-document refinement',
    mirror: { ...meaningfulMirror, apps: [appRule, appRule] },
  },
  {
    name: 'custom and third_party share a case-insensitive canonical app identity',
    mirror: {
      ...meaningfulMirror,
      apps: [
        appRule,
        { source: 'custom', packageId: 'example.app', action: 'pin', pinnedVersion: '2.0' },
      ],
    },
  },
  {
    name: 'packageId counts UTF-16 code units at the inclusive boundary',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, packageId: '😀'.repeat(128) }] },
  },
  {
    name: 'packageId rejects 258 UTF-16 code units even when PostgreSQL sees 129 characters',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, packageId: '😀'.repeat(129) }] },
  },
  {
    name: 'displayName counts UTF-16 code units at the inclusive boundary',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, displayName: `${'😀'.repeat(127)}a` }] },
  },
  {
    name: 'displayName rejects 256 UTF-16 code units even when PostgreSQL sees 128 characters',
    mirror: { ...meaningfulMirror, apps: [{ ...appRule, displayName: '😀'.repeat(128) }] },
  },
  {
    name: 'pinnedVersion counts UTF-16 code units at the inclusive boundary',
    mirror: {
      ...meaningfulMirror,
      apps: [{ ...appRule, action: 'pin', pinnedVersion: '😀'.repeat(32) }],
    },
  },
  {
    name: 'pinnedVersion rejects 66 UTF-16 code units even when PostgreSQL sees 33 characters',
    mirror: {
      ...meaningfulMirror,
      apps: [{ ...appRule, action: 'pin', pinnedVersion: '😀'.repeat(33) }],
    },
  },
  {
    name: 'JavaScript lowercasing keeps Turkish dotted capital I distinct from ASCII i',
    mirror: {
      ...meaningfulMirror,
      apps: [
        { ...appRule, packageId: 'İ' },
        { ...appRule, source: 'custom', packageId: 'i' },
      ],
    },
  },
  {
    name: 'raw JSON underflow follows JavaScript IEEE-754 semantics',
    mirror: { ...meaningfulMirror, autoApproveDeferralDays: 0 },
    serializedMirror: JSON.stringify(meaningfulMirror).replace(
      '"autoApproveDeferralDays":7',
      '"autoApproveDeferralDays":1e-400',
    ),
  },
  {
    name: 'raw JSON precision rounds before integer validation like JavaScript',
    mirror: { ...meaningfulMirror, autoApproveDeferralDays: 1 },
    serializedMirror: JSON.stringify(meaningfulMirror).replace(
      '"autoApproveDeferralDays":7',
      '"autoApproveDeferralDays":1.0000000000000001',
    ),
  },
  {
    name: 'unknown forbidden keys are stripped before the final DTO',
    mirror: { ...meaningfulMirror, password: 'hunter2' },
  },
  {
    name: 'forbidden keys in an invalid document disappear with whole-document fallback',
    mirror: { ...meaningfulMirror, apps: [{ action: 'block' }], apiKey: 'sk-live-never-export' },
  },
];

runDb('final partner HTTP export matches tryNormalizePatchInlineSettings without leaking the raw mirror', async () => {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [policy] = await db.insert(configurationPolicies).values({
    orgId: org.id,
    name: 'Patch canonical export parity',
    status: 'active',
  }).returning();
  if (!policy) throw new Error('patch parity policy insert failed');
  const [link] = await db.insert(configPolicyFeatureLinks).values({
    configPolicyId: policy.id,
    featureType: 'patch',
    inlineSettings: {},
  }).returning();
  if (!link) throw new Error('patch parity link insert failed');
  await db.insert(configPolicyAssignments).values({
    configPolicyId: policy.id,
    level: 'organization',
    targetId: org.id,
  });
  await db.execute(sql`
    INSERT INTO public.config_policy_patch_settings (feature_link_id)
    VALUES (${link.id}::uuid)
  `);

  const app = configurationExportApp(partner.id, org.id);

  for (const testCase of parityCases) {
    const serialized = testCase.serializedMirror ?? JSON.stringify(testCase.mirror);
    await db.execute(sql`
      UPDATE public.config_policy_feature_links
      SET inline_settings = ${serialized}::jsonb
      WHERE id = ${link.id}::uuid
    `);
    const response = await app.request('/configuration-policies');
    expect(response.status, `${testCase.name}: ${await response.clone().text()}`).toBe(200);
    const body = await response.json() as {
      data: Array<{ features: Array<{ type: string; settings: Record<string, unknown> }> }>;
    };
    const actual = body.data[0]?.features.find((feature) => feature.type === 'patch')?.settings;
    const expected = tryNormalizePatchInlineSettings(JSON.parse(serialized)).settings;
    expect.soft(
      {
        autoApproveDeferralDays: actual?.autoApproveDeferralDays,
        apps: actual?.apps,
      },
      testCase.name,
    ).toEqual({
      autoApproveDeferralDays: expected.autoApproveDeferralDays,
      apps: expected.apps,
    });
    const dto = JSON.stringify(body);
    expect.soft(dto, `${testCase.name}: raw mirror key`).not.toContain('__breezePatchInlineMirror');
    expect.soft(dto, `${testCase.name}: raw forbidden values`).not.toMatch(/hunter2|sk-live-never-export/u);
  }
});

runDb('existing reserved-marker collisions and incomplete patch material fail closed before export', async () => {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [policy] = await db.insert(configurationPolicies).values({
    orgId: org.id,
    name: 'Reserved marker export containment',
    status: 'active',
  }).returning();
  if (!policy) throw new Error('reserved marker policy insert failed');
  await db.insert(configPolicyAssignments).values({
    configPolicyId: policy.id,
    level: 'organization',
    targetId: org.id,
  });

  const app = configurationExportApp(partner.id, org.id);
  const expectBlocked = async (forbiddenValue?: string) => {
    const response = await app.request('/configuration-policies');
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.json() as {
      data: unknown[];
      blocked?: Array<Record<string, unknown>>;
    };
    expect(body.data).toEqual([]);
    expect(body.blocked).toEqual([{
      resource: 'configuration-policies',
      id: policy.id,
      orgId: org.id,
      reason: 'secret_detected',
      fieldPaths: ['features'],
    }]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('__breezePatchInlineMirror');
    if (forbiddenValue) expect(serialized).not.toContain(forbiddenValue);
  };

  for (const featureType of [
    'security', 'software_policy', 'peripheral_control',
    'warranty', 'helper', 'vulnerability',
  ] as const) {
    const [link] = await db.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy.id,
      featureType,
      inlineSettings: {
        nested: { __breezePatchInlineMirror: `attacker-${featureType}` },
      },
    }).returning();
    if (!link) throw new Error(`${featureType} marker link insert failed`);
    await expectBlocked(`attacker-${featureType}`);
    await db.delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, link.id));
  }

  const [collisionLink] = await db.insert(configPolicyFeatureLinks).values({
    configPolicyId: policy.id,
    featureType: 'patch',
    inlineSettings: {
      nested: { __breezePatchInlineMirror: 'patch-collision-secret' },
    },
  }).returning();
  if (!collisionLink) throw new Error('patch collision link insert failed');
  await db.execute(sql`
    INSERT INTO public.config_policy_patch_settings (feature_link_id)
    VALUES (${collisionLink.id}::uuid)
  `);
  await expectBlocked('patch-collision-secret');
  await db.delete(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, collisionLink.id));

  const [incompleteLink] = await db.insert(configPolicyFeatureLinks).values({
    configPolicyId: policy.id,
    featureType: 'patch',
    inlineSettings: {},
  }).returning();
  if (!incompleteLink) throw new Error('incomplete patch link insert failed');
  await expectBlocked();
});

function configurationExportApp(partnerId: string, orgId: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('partnerApiPrincipal', {
      partnerServicePrincipalId: crypto.randomUUID(),
      keyId: crypto.randomUUID(),
      partnerId,
      name: 'Patch export parity integration test',
      scopes: ['configuration:read'],
      accessibleOrgIds: [orgId],
      rateLimit: 600,
    });
    await withDbAccessContext({
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [partnerId],
      currentPartnerId: partnerId,
      userId: null,
    }, async () => {
      await appDb.execute(sql`
        SELECT public.breeze_partner_export_lock_partners_shared(ARRAY[${partnerId}::uuid])
      `);
      await next();
    });
  });
  app.route('/', partnerConfigurationRoutes);
  return app;
}

import './setup';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import {
  configPolicyFeatureLinks,
  configurationPolicies,
} from '../../db/schema';
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
];

runDb('partner export patch projection matches tryNormalizePatchInlineSettings', async () => {
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
  await db.execute(sql`
    INSERT INTO public.config_policy_patch_settings (feature_link_id)
    VALUES (${link.id}::uuid)
  `);

  for (const testCase of parityCases) {
    const serialized = testCase.serializedMirror ?? JSON.stringify(testCase.mirror);
    const [row] = await db.execute<{ settings: Record<string, unknown> }>(sql`
      SELECT public.breeze_partner_export_effective_policy_settings(
        ${link.id}::uuid,
        'patch',
        ${serialized}::jsonb
      ) AS settings
    `);
    const expected = tryNormalizePatchInlineSettings(testCase.mirror).settings;
    expect.soft(
      {
        autoApproveDeferralDays: row?.settings.autoApproveDeferralDays,
        apps: row?.settings.apps,
      },
      testCase.name,
    ).toEqual({
      autoApproveDeferralDays: expected.autoApproveDeferralDays,
      apps: expected.apps,
    });
  }
});

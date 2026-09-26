/**
 * Replays 2026-10-23-100000-delivery-routing-default-rows.sql against a
 * fixture partner and asserts the rows it writes equal the PRE-migration
 * all-enabled-channels fallback (notificationDispatcher.ts:362-371 on main
 * at b8dd148bd8): org's enabled channels + its partner's enabled partner-wide
 * channels, `enabled = true` on both axes. This is the "day one is
 * behavior-identical" half of the W05b spec gate.
 *
 * CI databases are migrated schema-fresh in globalSetup, so the file's
 * data-moving DO blocks otherwise run against zero rows; this suite seeds
 * the real pre-migration shape and re-runs the file from disk.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { notificationChannels, notificationRoutingRules } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-23-100000-delivery-routing-default-rows.sql',
);
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function replayMigration() {
  // Superuser client: the file elects breeze.scope=system itself.
  await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
}

const created = { channels: [] as string[], rules: [] as string[] };

afterEach(async () => {
  const db = getTestDb();
  for (const id of created.rules) await db.delete(notificationRoutingRules).where(eq(notificationRoutingRules.id, id));
  for (const id of created.channels) await db.delete(notificationChannels).where(eq(notificationChannels.id, id));
  created.rules.length = 0;
  created.channels.length = 0;
});

async function seedChannel(owner: { orgId: string | null; partnerId: string | null }, name: string, enabled: boolean) {
  // `config` lives in notification_channel_configs now (#6379); this fixture
  // only exercises channel id/enabled/ownership, never reads config back.
  const [row] = await getTestDb()
    .insert(notificationChannels)
    .values({ ...owner, name, type: 'slack', enabled })
    .returning({ id: notificationChannels.id });
  created.channels.push(row!.id);
  return row!.id;
}

async function defaultRowFor(where: ReturnType<typeof and>) {
  const rows = await getTestDb()
    .select()
    .from(notificationRoutingRules)
    .where(and(where, eq(notificationRoutingRules.isDefault, true)));
  for (const r of rows) if (!created.rules.includes(r.id)) created.rules.push(r.id);
  return rows;
}

describe('2026-10-23-100000-delivery-routing-default-rows.sql', () => {
  runDb('writes one partner row with the enabled partner-wide channels and one org row equal to the old fallback set', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const orgNoChannels = await createOrganization({ partnerId: partner.id });

    const partnerOn = await seedChannel({ orgId: null, partnerId: partner.id }, 'Partner NOC', true);
    await seedChannel({ orgId: null, partnerId: partner.id }, 'Partner disabled', false);
    const orgOn = await seedChannel({ orgId: org.id, partnerId: null }, 'Org email', true);
    await seedChannel({ orgId: org.id, partnerId: null }, 'Org disabled', false);

    await replayMigration();

    const [partnerRow] = await defaultRowFor(and(eq(notificationRoutingRules.partnerId, partner.id), isNull(notificationRoutingRules.orgId))!);
    expect(partnerRow).toBeDefined();
    expect(partnerRow!.name).toBe('Everything else');
    expect(partnerRow!.enabled).toBe(true);
    expect(partnerRow!.conditions).toEqual({});
    expect([...(partnerRow!.channelIds as string[])].sort()).toEqual([partnerOn].sort());

    const [orgRow] = await defaultRowFor(eq(notificationRoutingRules.orgId, org.id)!);
    expect(orgRow).toBeDefined();
    // Exactly the old fallback: org enabled channels + partner enabled partner-wide channels.
    expect([...(orgRow!.channelIds as string[])].sort()).toEqual([orgOn, partnerOn].sort());

    // An org with no enabled org-owned channel gets NO org row (the partner row covers it).
    expect(await defaultRowFor(eq(notificationRoutingRules.orgId, orgNoChannels.id)!)).toHaveLength(0);
  });

  runDb('is a no-op on replay and never duplicates a default row', async () => {
    const partner = await createPartner();
    await seedChannel({ orgId: null, partnerId: partner.id }, 'Partner NOC', true);
    await replayMigration();
    await replayMigration();
    const rows = await defaultRowFor(and(eq(notificationRoutingRules.partnerId, partner.id), isNull(notificationRoutingRules.orgId))!);
    expect(rows).toHaveLength(1);
  });

  runDb('a partner with only DISABLED partner-wide channels gets no partner row', async () => {
    const partner = await createPartner();
    await seedChannel({ orgId: null, partnerId: partner.id }, 'Partner disabled', false);
    await replayMigration();
    expect(await defaultRowFor(and(eq(notificationRoutingRules.partnerId, partner.id), isNull(notificationRoutingRules.orgId))!)).toHaveLength(0);
  });

  runDb.each(['partner', 'org'] as const)('the partial unique index rejects a second %s default row', async (axis) => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const owner = axis === 'partner'
      ? { orgId: null, partnerId: partner.id }
      : { orgId: org.id, partnerId: null };
    await seedChannel(owner, 'NOC', true);
    await replayMigration();
    await defaultRowFor(axis === 'partner'
      ? and(eq(notificationRoutingRules.partnerId, partner.id), isNull(notificationRoutingRules.orgId))
      : eq(notificationRoutingRules.orgId, org.id));
    await expect(
      getTestDb().insert(notificationRoutingRules).values({
        ...owner, name: 'dup', priority: 1, conditions: {}, channelIds: [], enabled: true, isDefault: true,
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});

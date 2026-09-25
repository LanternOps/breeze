/**
 * Notification channel config confidentiality at the DB layer (#6379).
 *
 * Migration under test: 2026-10-31-101100-notification-channel-configs.sql.
 *
 * `notification_channels` carries a SELECT-only partner-wide read branch
 * (2026-10-10-120000), so an ORG session can read its MSP's partner-wide
 * channel rows. Before this change the row carried `config` — webhook URLs,
 * bot tokens, routing keys — and RLS cannot hide a column, so confidentiality
 * toward org users rested on API redaction alone. `config` now lives in
 * `notification_channel_configs`, whose policy is parent OWNERSHIP, never
 * parent visibility.
 *
 * Every probe below runs through the real postgres.js driver as `breeze_app`
 * (NOSUPERUSER NOBYPASSRLS, FORCE ROW LEVEL SECURITY), which is what `db` is
 * bound to in this suite. The org-session case first proves the partner-wide
 * PARENT row is visible to it, so "config not visible" cannot pass vacuously
 * because the whole channel was hidden.
 *
 * EXPAND/CONTRACT: the legacy `notification_channels.config` column is kept for
 * one release so an image rollback keeps delivering. The rollback-path cases
 * prove the new image mirrors config into it and that an OLD image's write of it
 * reaches the child table through the sync trigger. Until the contract step
 * drops the column, an org session can still read that legacy column of a
 * partner-wide row at the DB layer — this change closes that gap fully only
 * once the column is gone.
 *
 * The replay case re-creates the pre-migration shape (config NOT NULL on the
 * parent, no trigger, child empty) inside a transaction that is always rolled back, hands
 * both tables to a NOSUPERUSER NOBYPASSRLS owner, and replays the migration as
 * that owner — the managed-Postgres shape where a missing
 * `set_config('breeze.scope','system')` would silently backfill zero rows.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { notificationChannelConfigs, notificationChannels } from '../../db/schema';
import {
  getNotificationChannelWithConfig,
  writeNotificationChannelConfig,
} from '../../services/notificationChannelConfig';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION_SQL = readFileSync(
  join(__dirname, '../../../migrations/2026-10-31-101100-notification-channel-configs.sql'),
  'utf8',
);

function partnerContext(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/** Org token: currentPartnerId is populated (the read branch keys on it); accessiblePartnerIds stays empty. */
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

const PARTNER_SECRET = { webhookUrl: 'https://hooks.slack.example/partner-wide-secret' };
const ORG_SECRET = { webhookUrl: 'https://hooks.slack.example/org-own-secret' };

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });

    const [partnerWide] = await db.insert(notificationChannels)
      .values({ orgId: null, partnerId: partner.id, name: 'msp-shared', type: 'slack' })
      .returning({ id: notificationChannels.id });
    const [orgOwned] = await db.insert(notificationChannels)
      .values({ orgId: org.id, partnerId: null, name: 'org-own', type: 'slack' })
      .returning({ id: notificationChannels.id });
    // A partner-wide channel with NO config row yet — the INSERT-forge target.
    const [partnerWideBare] = await db.insert(notificationChannels)
      .values({ orgId: null, partnerId: partner.id, name: 'msp-bare', type: 'slack' })
      .returning({ id: notificationChannels.id });

    await writeNotificationChannelConfig(partnerWide!.id, PARTNER_SECRET);
    await writeNotificationChannelConfig(orgOwned!.id, ORG_SECRET);

    return {
      partner, org, otherPartner, otherOrg,
      partnerWideId: partnerWide!.id,
      orgOwnedId: orgOwned!.id,
      partnerWideBareId: partnerWideBare!.id,
    };
  });
}

function readConfigs(ids: string[]) {
  return db.select({ channelId: notificationChannelConfigs.channelId, config: notificationChannelConfigs.config })
    .from(notificationChannelConfigs)
    .where(inArray(notificationChannelConfigs.channelId, ids));
}

describe('notification_channel_configs RLS (#6379)', () => {
  runDb('writeNotificationChannelConfig mirrors config into the legacy parent column (image-rollback path)', async () => {
    const f = await seed();
    const rows = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT id::text AS id, config FROM notification_channels
      WHERE id IN (${f.partnerWideId}, ${f.orgOwnedId}, ${f.partnerWideBareId})`)) as unknown as Array<{ id: string; config: unknown }>;
    expect(new Map(rows.map((r) => [r.id, r.config]))).toEqual(new Map<string, unknown>([
      [f.partnerWideBareId, null],
      [f.partnerWideId, PARTNER_SECRET],
      [f.orgOwnedId, ORG_SECRET],
    ]));

    // An owner's update reaches both copies.
    const next = { webhookUrl: 'https://hooks.slack.example/partner-rotated' };
    await withDbAccessContext(partnerContext(f.partner.id), () => writeNotificationChannelConfig(f.partnerWideId, next));
    const after = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT config FROM notification_channels WHERE id = ${f.partnerWideId}`)) as unknown as Array<{ config: unknown }>;
    expect(after[0]?.config).toEqual(next);
    const child = await withSystemDbAccessContext(() => readConfigs([f.partnerWideId]));
    expect(child).toEqual([{ channelId: f.partnerWideId, config: next }]);
  });

  runDb('an OLD-image write of only the legacy column reaches the child table (sync trigger) under the writer RLS', async () => {
    const f = await seed();
    const oldImageConfig = { webhookUrl: 'https://hooks.slack.example/written-by-old-image' };

    // Old image, org session: INSERT a channel with config on the parent only.
    const inserted = await withDbAccessContext(orgContext(f.org.id, f.partner.id), () => db.execute(sql`
      INSERT INTO notification_channels (org_id, name, type, config)
      VALUES (${f.org.id}, 'old-image-org', 'slack', ${JSON.stringify(oldImageConfig)}::jsonb)
      RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    const newId = inserted[0]!.id;

    // Old image, partner session: UPDATE a partner-wide channel's legacy config.
    await withDbAccessContext(partnerContext(f.partner.id), () => db.execute(sql`
      UPDATE notification_channels SET config = ${JSON.stringify(oldImageConfig)}::jsonb
      WHERE id = ${f.partnerWideId}`));

    const child = await withSystemDbAccessContext(() => readConfigs([newId, f.partnerWideId]));
    expect(new Map(child.map((r) => [r.channelId, r.config]))).toEqual(new Map([
      [newId, oldImageConfig],
      [f.partnerWideId, oldImageConfig],
    ]));

    // The org session still cannot read the partner-wide child row.
    await withDbAccessContext(orgContext(f.org.id, f.partner.id), async () => {
      expect(await readConfigs([f.partnerWideId])).toEqual([]);
      expect(await readConfigs([newId])).toEqual([{ channelId: newId, config: oldImageConfig }]);
    });
  });

  runDb('an org session sees the partner-wide channel row but NOT its config; it still reads its own org channel config', async () => {
    const f = await seed();

    await withDbAccessContext(orgContext(f.org.id, f.partner.id), async () => {
      // Non-vacuity: the parent row IS visible through the partner-wide branch.
      const parent = await db.select({ id: notificationChannels.id })
        .from(notificationChannels).where(eq(notificationChannels.id, f.partnerWideId));
      expect(parent).toEqual([{ id: f.partnerWideId }]);

      const rows = await readConfigs([f.partnerWideId, f.orgOwnedId]);
      expect(rows).toEqual([{ channelId: f.orgOwnedId, config: ORG_SECRET }]);

      // The joined reader returns the row with config null.
      const joined = await getNotificationChannelWithConfig(f.partnerWideId);
      expect(joined?.id).toBe(f.partnerWideId);
      expect(joined?.config).toBeNull();
    });
  });

  runDb('an org session cannot write a partner-wide channel config (UPDATE/DELETE hit 0 rows, INSERT/upsert raise 42501)', async () => {
    const f = await seed();

    await withDbAccessContext(orgContext(f.org.id, f.partner.id), async () => {
      const updated = await db.update(notificationChannelConfigs)
        .set({ config: { webhookUrl: 'https://attacker.example/x' } })
        .where(eq(notificationChannelConfigs.channelId, f.partnerWideId))
        .returning({ channelId: notificationChannelConfigs.channelId });
      expect(updated).toEqual([]);

      const deleted = await db.delete(notificationChannelConfigs)
        .where(eq(notificationChannelConfigs.channelId, f.partnerWideId))
        .returning({ channelId: notificationChannelConfigs.channelId });
      expect(deleted).toEqual([]);
    });

    await expectSqlState(
      () => withDbAccessContext(orgContext(f.org.id, f.partner.id), () =>
        writeNotificationChannelConfig(f.partnerWideBareId, { webhookUrl: 'https://attacker.example/y' })),
      '42501',
    );
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.org.id, f.partner.id), () =>
        writeNotificationChannelConfig(f.partnerWideId, { webhookUrl: 'https://attacker.example/z' })),
      '42501',
    );

    const intact = await withSystemDbAccessContext(() => readConfigs([f.partnerWideId, f.partnerWideBareId]));
    expect(intact).toEqual([{ channelId: f.partnerWideId, config: PARTNER_SECRET }]);
  });

  runDb('the owning partner and system read the partner-wide config; another partner and its orgs read neither', async () => {
    const f = await seed();

    const asOwner = await withDbAccessContext(partnerContext(f.partner.id), () => readConfigs([f.partnerWideId]));
    expect(asOwner).toEqual([{ channelId: f.partnerWideId, config: PARTNER_SECRET }]);

    // System scope is the dispatcher / automation send path: an org alert
    // delivered to an inherited partner-wide channel still gets its config.
    const asSystem = await withSystemDbAccessContext(() => getNotificationChannelWithConfig(f.partnerWideId));
    expect(asSystem?.config).toEqual(PARTNER_SECRET);

    const asOtherPartner = await withDbAccessContext(partnerContext(f.otherPartner.id), () =>
      readConfigs([f.partnerWideId, f.orgOwnedId]));
    expect(asOtherPartner).toEqual([]);

    const asOtherOrg = await withDbAccessContext(orgContext(f.otherOrg.id, f.otherPartner.id), () =>
      readConfigs([f.partnerWideId, f.orgOwnedId]));
    expect(asOtherOrg).toEqual([]);
  });

  runDb('deleting a channel removes its config row (ON DELETE CASCADE)', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() =>
      db.delete(notificationChannels).where(eq(notificationChannels.id, f.orgOwnedId)));
    const left = await withSystemDbAccessContext(() => readConfigs([f.orgOwnedId]));
    expect(left).toEqual([]);
  });
});

describe('2026-10-31-101100 migration replay (#6379)', () => {
  const notices: string[] = [];
  const admin = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    onnotice: (notice) => notices.push(String(notice.message ?? '')),
  });
  afterAll(async () => admin.end({ timeout: 5 }));

  class Rollback extends Error {}

  runDb('backfills config verbatim and keeps the legacy column (nullable, synced) when replayed by a NOSUPERUSER NOBYPASSRLS owner; re-applying is a no-op', async () => {
    const f = await seed();
    // An opaque ciphertext-shaped value: the backfill must copy it byte-for-byte,
    // never decrypt/re-encrypt it.
    const sealed = { webhookUrl: 'enc:v3:test-key:AAAA:BBBB:CCCC' };
    await withSystemDbAccessContext(() => writeNotificationChannelConfig(f.partnerWideId, sealed));

    const role = `mig_6379_${Date.now()}`;
    let checked = false;
    try {
      await admin.begin(async (tx) => {
        // Re-create the pre-migration shape: config on the parent (NOT NULL),
        // no sync trigger, child table empty.
        await tx.unsafe('DROP FUNCTION public.notification_channels_sync_legacy_config() CASCADE');
        await tx.unsafe(`UPDATE notification_channels nc SET config = COALESCE(c.config, nc.config, '{}'::jsonb)
          FROM notification_channels n2 LEFT JOIN notification_channel_configs c ON c.channel_id = n2.id
          WHERE n2.id = nc.id`);
        await tx.unsafe('ALTER TABLE notification_channels ALTER COLUMN config SET NOT NULL');
        await tx.unsafe('DELETE FROM notification_channel_configs');
        const [{ total }] = await tx.unsafe<[{ total: number }]>(
          'SELECT count(*)::int AS total FROM notification_channels');

        // A migrator that is neither superuser nor BYPASSRLS, owning both tables.
        await tx.unsafe(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
        await tx.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
        await tx.unsafe(`ALTER TABLE notification_channels OWNER TO ${role}`);
        await tx.unsafe(`ALTER TABLE notification_channel_configs OWNER TO ${role}`);
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        const [who] = await tx.unsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
        expect(who).toEqual({ rolsuper: false, rolbypassrls: false });

        notices.length = 0;
        await tx.unsafe(MIGRATION_SQL);
        expect(notices).toContain(`notification_channel_configs: backfilled ${total} channel config row(s)`);

        // Re-apply: nothing left to backfill, no error.
        notices.length = 0;
        await tx.unsafe(MIGRATION_SQL);
        expect(notices).toContain('notification_channel_configs: backfilled 0 channel config row(s)');

        await tx.unsafe('RESET ROLE');
        // Expand step: the legacy column stays, now nullable, with the sync trigger.
        const cols = await tx.unsafe<{ is_nullable: string }[]>(`
          SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'notification_channels' AND column_name = 'config'`);
        expect(cols).toEqual([{ is_nullable: 'YES' }]);
        const triggers = await tx.unsafe<{ tgname: string }[]>(`
          SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'public.notification_channels'::regclass AND NOT tgisinternal
            AND tgname = 'notification_channels_sync_legacy_config'`);
        expect(triggers).toHaveLength(1);

        const copied = await tx.unsafe<{ channel_id: string; config: unknown }[]>(
          'SELECT channel_id, config FROM notification_channel_configs WHERE channel_id IN ($1, $2) ORDER BY channel_id',
          [f.partnerWideId, f.orgOwnedId],
        );
        expect(new Map(copied.map((r) => [r.channel_id, r.config]))).toEqual(new Map([
          [f.partnerWideId, sealed],
          [f.orgOwnedId, ORG_SECRET],
        ]));
        const [{ n }] = await tx.unsafe<[{ n: number }]>(
          'SELECT count(*)::int AS n FROM notification_channel_configs');
        expect(n).toBe(total);
        checked = true;
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    expect(checked).toBe(true);
  });
});

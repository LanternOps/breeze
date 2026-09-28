/**
 * Notification channel config confidentiality at the DB layer (#6379).
 *
 * Migration under test: 2026-11-02-100600-notification-channel-configs.sql.
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
 * CONTRACT (#7028): the legacy `notification_channels.config` column, kept for
 * one release as a write-only rollback mirror, is dropped by
 * 2026-11-06-100100-drop-notification-channels-config.sql together with its
 * sync trigger. Only then can an org session no longer read a partner-wide
 * row's config at the DB layer; the first case below proves the column is gone.
 *
 * The replay case re-creates the expand-step shape (legacy column + sync
 * trigger, one channel whose child row is missing — the race window between the
 * expand step's backfill and its CREATE TRIGGER) inside a transaction that is
 * always rolled back, hands both tables to a NOSUPERUSER NOBYPASSRLS owner, and
 * replays the contract migration as that owner — the managed-Postgres shape
 * where a missing `set_config('breeze.scope','system')` would silently backfill
 * zero rows.
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

const EXPAND_MIGRATION_SQL = readFileSync(
  join(__dirname, '../../../migrations/2026-11-02-100600-notification-channel-configs.sql'),
  'utf8',
);
const CONTRACT_MIGRATION_SQL = readFileSync(
  join(__dirname, '../../../migrations/2026-11-06-100100-drop-notification-channels-config.sql'),
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
  runDb('the legacy notification_channels.config column and its sync trigger are gone (42703 for an org session)', async () => {
    const f = await seed();

    await withDbAccessContext(orgContext(f.org.id, f.partner.id), async () => {
      // Non-vacuity: the partner-wide parent row IS visible to the org session,
      // so the 42703 below is the column being gone, not the row being hidden.
      const parent = await db.select({ id: notificationChannels.id })
        .from(notificationChannels).where(eq(notificationChannels.id, f.partnerWideId));
      expect(parent).toEqual([{ id: f.partnerWideId }]);
    });
    await expectSqlState(
      () => withDbAccessContext(orgContext(f.org.id, f.partner.id), () => db.execute(sql`
        SELECT config FROM notification_channels WHERE id = ${f.partnerWideId}`)),
      '42703',
    );

    const leftovers = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT 'column' AS kind FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'notification_channels' AND column_name = 'config'
      UNION ALL
      SELECT 'trigger' FROM pg_trigger
        WHERE tgrelid = 'public.notification_channels'::regclass AND tgname = 'notification_channels_sync_legacy_config'
      UNION ALL
      SELECT 'function' FROM pg_proc
        WHERE proname = 'notification_channels_sync_legacy_config'`)) as unknown as Array<{ kind: string }>;
    expect(leftovers).toEqual([]);
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

describe('2026-11-06-100100 contract migration replay (#7028)', () => {
  const notices: string[] = [];
  const admin = postgres(process.env.DATABASE_URL ?? '', {
    max: 1,
    onnotice: (notice) => notices.push(String(notice.message ?? '')),
  });
  afterAll(async () => admin.end({ timeout: 5 }));

  class Rollback extends Error {}

  runDb('backfills a missing child row, never overwrites an existing one, drops trigger + column as a NOSUPERUSER NOBYPASSRLS owner; re-applying is a no-op', async () => {
    const f = await seed();
    // Opaque ciphertext-shaped values: the backfill must copy byte-for-byte.
    const orphanLegacy = { webhookUrl: 'enc:v3:test-key:ORPHAN:AAAA:BBBB' };
    const childAuthoritative = { webhookUrl: 'enc:v3:test-key:CHILD:CCCC:DDDD' };

    const role = `mig_7028_${Date.now()}`;
    let checked = false;
    try {
      await admin.begin(async (tx) => {
        // Re-create the expand-step shape: legacy column populated from the
        // child table, then the expand migration replayed for its sync trigger.
        await tx.unsafe('ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS config jsonb');
        await tx.unsafe(`UPDATE notification_channels nc SET config = c.config
          FROM notification_channel_configs c WHERE c.channel_id = nc.id`);
        await tx.unsafe(EXPAND_MIGRATION_SQL);

        // Race-window row: legacy value, no child row (an old image wrote it
        // between the expand step's backfill and its CREATE TRIGGER).
        await tx.unsafe('UPDATE notification_channels SET config = $1::text::jsonb WHERE id = $2',
          [JSON.stringify(orphanLegacy), f.orgOwnedId]);
        await tx.unsafe('DELETE FROM notification_channel_configs WHERE channel_id = $1', [f.orgOwnedId]);
        // Diverged row: the child (authoritative) differs from the legacy copy.
        await tx.unsafe('UPDATE notification_channel_configs SET config = $1::text::jsonb WHERE channel_id = $2',
          [JSON.stringify(childAuthoritative), f.partnerWideId]);

        // A migrator that is neither superuser nor BYPASSRLS, owning both tables
        // and the trigger function.
        await tx.unsafe(`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
        await tx.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
        await tx.unsafe(`ALTER TABLE notification_channels OWNER TO ${role}`);
        await tx.unsafe(`ALTER TABLE notification_channel_configs OWNER TO ${role}`);
        await tx.unsafe(`ALTER FUNCTION public.notification_channels_sync_legacy_config() OWNER TO ${role}`);
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        const [who] = await tx.unsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
        expect(who).toEqual({ rolsuper: false, rolbypassrls: false });

        notices.length = 0;
        await tx.unsafe(CONTRACT_MIGRATION_SQL);
        expect(notices).toContain(
          'notification_channel_configs: backfilled 1 channel config row(s) missing before dropping notification_channels.config');

        // Re-apply: the column is gone, so the backfill is skipped; no error.
        notices.length = 0;
        await tx.unsafe(CONTRACT_MIGRATION_SQL);
        expect(notices.filter((n) => n.includes('backfilled'))).toEqual([]);

        await tx.unsafe('RESET ROLE');
        const cols = await tx.unsafe(`
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'notification_channels' AND column_name = 'config'`);
        expect(cols).toHaveLength(0);
        const triggers = await tx.unsafe(`
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = 'public.notification_channels'::regclass
            AND tgname = 'notification_channels_sync_legacy_config'`);
        expect(triggers).toHaveLength(0);
        const fns = await tx.unsafe(
          `SELECT 1 FROM pg_proc WHERE proname = 'notification_channels_sync_legacy_config'`);
        expect(fns).toHaveLength(0);

        const copied = await tx.unsafe<{ channel_id: string; config: unknown }[]>(
          'SELECT channel_id, config FROM notification_channel_configs WHERE channel_id IN ($1, $2, $3)',
          [f.partnerWideId, f.orgOwnedId, f.partnerWideBareId],
        );
        expect(new Map(copied.map((r) => [r.channel_id, r.config]))).toEqual(new Map([
          [f.partnerWideId, childAuthoritative],
          [f.orgOwnedId, orphanLegacy],
        ]));
        checked = true;
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    expect(checked).toBe(true);
  });
});

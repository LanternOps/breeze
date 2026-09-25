import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { notificationChannels } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const migrationSql = readFileSync(join(
  __dirname,
  '../../../migrations/2026-10-15-150001-bound-webhook-retries.sql',
), 'utf8');
const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', {
  max: 1,
  onnotice: (notice) => notices.push(String(notice.message)),
});
afterAll(async () => adminSql.end({ timeout: 5 }));

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId],
    accessiblePartnerIds: [], userId: null,
  };
}

class Rollback extends Error {}

describe('webhook retry migration and tenant boundary', () => {
  // The migration under test UPDATEs notification_channels.config, a column
  // that 2026-10-31-100500-notification-channel-configs.sql later moved into
  // notification_channel_configs (#6379). On every real database it ran while
  // the column still existed. To keep proving its normalization + idempotency,
  // the replay re-adds the column inside a transaction that is always rolled
  // back, so the live schema is never touched.
  runDb('normalizes legacy outliers idempotently (replayed against the pre-#6379 column shape)', async () => {
    const fixture = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const ownOrg = await createOrganization({ partnerId: partner.id });
      const rows = await db.insert(notificationChannels).values([
        { orgId: ownOrg.id, name: 'negative', type: 'webhook' },
        { orgId: ownOrg.id, name: 'fractional', type: 'webhook' },
        { orgId: ownOrg.id, name: 'huge', type: 'webhook' },
        { orgId: ownOrg.id, name: 'string', type: 'webhook' },
        { orgId: ownOrg.id, name: 'in-range', type: 'webhook' },
      ]).returning({ id: notificationChannels.id, name: notificationChannels.name });
      return new Map(rows.map((row) => [row.name, row.id]));
    });
    const legacy: Record<string, unknown> = {
      negative: { url: 'https://example.com/a', retryCount: -5 },
      fractional: { url: 'https://example.com/b', retryCount: 1.8 },
      huge: { url: 'https://example.com/c', retryCount: 1_000_000 },
      string: { url: 'https://example.com/d', retryCount: '1000' },
      'in-range': { url: 'https://example.com/e', retryCount: 1 },
    };

    let checked = false;
    try {
      await adminSql.begin(async (tx) => {
        await tx.unsafe('ALTER TABLE notification_channels ADD COLUMN config jsonb');
        for (const [name, config] of Object.entries(legacy)) {
          await tx.unsafe('UPDATE notification_channels SET config = $1::text::jsonb WHERE id = $2', [
            JSON.stringify(config), fixture.get(name)!,
          ]);
        }

        const readBack = async () => {
          const rows = await tx.unsafe<{ name: string; retry: unknown }[]>(
            `SELECT name, config -> 'retryCount' AS retry FROM notification_channels
             WHERE id = ANY($1::uuid[]) ORDER BY name`,
            [[...fixture.values()]],
          );
          return rows.map((row) => [row.name, row.retry]);
        };

        notices.length = 0;
        await tx.unsafe(migrationSql);
        expect(notices).toContain('normalized 4 notification channel webhook retryCount value(s) to the supported 0..2 range');
        const first = await readBack();
        expect(first).toEqual([
          ['fractional', 1], ['huge', 2], ['in-range', 1], ['negative', 0], ['string', 2],
        ]);

        notices.length = 0;
        await tx.unsafe(migrationSql);
        expect(notices).not.toEqual(expect.arrayContaining([
          expect.stringContaining('notification channel webhook retryCount'),
        ]));
        expect(await readBack()).toEqual(first);
        checked = true;
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    expect(checked).toBe(true);
  });

  runDb('breeze_app org isolation on notification_channels holds', async () => {
    const fixture = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const ownOrg = await createOrganization({ partnerId: partner.id });
      const foreignOrg = await createOrganization({ partnerId: partner.id });
      await db.insert(notificationChannels).values([
        { orgId: ownOrg.id, name: 'own', type: 'webhook' },
        { orgId: foreignOrg.id, name: 'foreign', type: 'webhook' },
      ]);
      return { ownOrg, foreignOrg };
    });

    const hidden = await withDbAccessContext(orgContext(fixture.ownOrg.id), () => db
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(eq(notificationChannels.orgId, fixture.foreignOrg.id)));
    expect(hidden).toEqual([]);

    const own = await withDbAccessContext(orgContext(fixture.ownOrg.id), () => db
      .select({ name: notificationChannels.name })
      .from(notificationChannels)
      .where(eq(notificationChannels.orgId, fixture.ownOrg.id)));
    expect(own).toEqual([{ name: 'own' }]);
  });
});

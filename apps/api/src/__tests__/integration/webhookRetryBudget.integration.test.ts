import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
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

describe('webhook retry migration and tenant boundary', () => {
  runDb('normalizes legacy outliers idempotently and preserves breeze_app isolation', async () => {
    const fixture = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const ownOrg = await createOrganization({ partnerId: partner.id });
      const foreignOrg = await createOrganization({ partnerId: partner.id });
      await db.insert(notificationChannels).values([
        { orgId: ownOrg.id, name: 'negative', type: 'webhook', config: { url: 'https://example.com/a', retryCount: -5 } },
        { orgId: ownOrg.id, name: 'fractional', type: 'webhook', config: { url: 'https://example.com/b', retryCount: 1.8 } },
        { orgId: ownOrg.id, name: 'huge', type: 'webhook', config: { url: 'https://example.com/c', retryCount: 1_000_000 } },
        { orgId: ownOrg.id, name: 'string', type: 'webhook', config: { url: 'https://example.com/d', retryCount: '1000' } },
        { orgId: foreignOrg.id, name: 'foreign', type: 'webhook', config: { url: 'https://example.com/e', retryCount: 1_000_000 } },
      ]);
      return { ownOrg, foreignOrg };
    });

    notices.length = 0;
    await adminSql.unsafe(migrationSql);
    expect(notices).toContain('normalized 5 notification channel webhook retryCount value(s) to the supported 0..2 range');
    const first = await withDbAccessContext(orgContext(fixture.ownOrg.id), () => db
      .select({ name: notificationChannels.name, config: notificationChannels.config })
      .from(notificationChannels)
      .orderBy(asc(notificationChannels.name)));
    expect(first.map((row) => [row.name, (row.config as Record<string, unknown>).retryCount])).toEqual([
      ['fractional', 1], ['huge', 2], ['negative', 0], ['string', 2],
    ]);

    const hidden = await withDbAccessContext(orgContext(fixture.ownOrg.id), () => db
      .select({ id: notificationChannels.id })
      .from(notificationChannels)
      .where(eq(notificationChannels.orgId, fixture.foreignOrg.id)));
    expect(hidden).toEqual([]);

    notices.length = 0;
    await adminSql.unsafe(migrationSql);
    expect(notices).not.toEqual(expect.arrayContaining([
      expect.stringContaining('notification channel webhook retryCount'),
    ]));
    const second = await withDbAccessContext(orgContext(fixture.ownOrg.id), () => db
      .select({ name: notificationChannels.name, config: notificationChannels.config })
      .from(notificationChannels)
      .orderBy(asc(notificationChannels.name)));
    expect(second).toEqual(first);
  });
});

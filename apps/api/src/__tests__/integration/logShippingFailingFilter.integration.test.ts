/**
 * Integration test — the `logShippingFailing` fleet filter and the
 * `/devices/stats` `logShippingFailingCount` against real Postgres (#8611,
 * feature #8607).
 *
 * The SQL predicate (`logShippingFailingPredicate`) is a hand-written twin of
 * `deriveLogShipping(...).state === 'failing'`. A rendered-SQL assertion cannot
 * prove the two agree on real rows (NULL semantics, timestamptz arithmetic
 * against NOW()), so this file seeds one device per row of the derive table and
 * checks that the filter (yes and no), the stats count and `deriveLogShipping`
 * classify every row identically.
 *
 * Episode ages stay a minute clear of the 30-minute boundary: the API process
 * clock and the database's NOW() are not the same instant, and the exact
 * boundary is pinned by the pure derive test in logShippingHealth.test.ts.
 *
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/logShippingFailingFilter.integration.test.ts
 */
import './setup';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';
import { withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { evaluateFilter } from '../../services/filterEngine';
import { queryDeviceStats } from '../../services/deviceStats';
import { deriveLogShipping, LOG_SHIPPING_SUSTAINED_MS } from '../../services/logShippingHealth';

const MIN = 60_000;

type Row = {
  name: string;
  status: 'online' | 'offline' | 'maintenance';
  logShippingState: 'ok' | 'quiet' | 'failing' | null;
  /** Episode age in ms, or null for no started_at. */
  ageMs: number | null;
  /** What the derive table says, asserted so a fixture typo cannot pass vacuously. */
  expectFailing: boolean;
};

// Mirrors the deriveLogShipping cases in services/logShippingHealth.test.ts.
const TABLE: Row[] = [
  { name: 'never reported (NULL)', status: 'online', logShippingState: null, ageMs: null, expectFailing: false },
  { name: 'ok', status: 'online', logShippingState: 'ok', ageMs: null, expectFailing: false },
  { name: 'quiet', status: 'online', logShippingState: 'quiet', ageMs: null, expectFailing: false },
  { name: 'failing, online, sustained', status: 'online', logShippingState: 'failing', ageMs: LOG_SHIPPING_SUSTAINED_MS + MIN, expectFailing: true },
  { name: 'failing, online, long-running', status: 'online', logShippingState: 'failing', ageMs: 24 * 60 * MIN, expectFailing: true },
  { name: 'failing, online, younger than 30 min', status: 'online', logShippingState: 'failing', ageMs: LOG_SHIPPING_SUSTAINED_MS - MIN, expectFailing: false },
  { name: 'failing, online, just started', status: 'online', logShippingState: 'failing', ageMs: 0, expectFailing: false },
  { name: 'failing, offline, sustained', status: 'offline', logShippingState: 'failing', ageMs: LOG_SHIPPING_SUSTAINED_MS + MIN, expectFailing: false },
  { name: 'failing, maintenance, sustained', status: 'maintenance', logShippingState: 'failing', ageMs: LOG_SHIPPING_SUSTAINED_MS + MIN, expectFailing: false },
  { name: 'failing, online, no started_at', status: 'online', logShippingState: 'failing', ageMs: null, expectFailing: false },
  // Broken invariant (started_at left behind on a non-failing state): the SQL
  // predicate is FALSE here, and the negative form must still count it as "no".
  { name: 'ok with a stale started_at', status: 'online', logShippingState: 'ok', ageMs: LOG_SHIPPING_SUSTAINED_MS + MIN, expectFailing: false },
];

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const now = Date.now();

  const seeded: Array<Row & { id: string; startedAt: Date | null }> = [];
  for (const [i, row] of TABLE.entries()) {
    const startedAt = row.ageMs === null ? null : new Date(now - row.ageMs);
    const [inserted] = await getTestDb()
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `agent-${org.id}-${i}`,
        hostname: `ls-${org.id.slice(0, 8)}-${i}`,
        osType: 'linux',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: row.status,
        logShippingState: row.logShippingState,
        logShippingFailureStartedAt: startedAt,
        logShippingLastError: row.logShippingState === 'failing' ? 'http 503' : null,
      })
      .returning();
    if (!inserted) throw new Error('seed: device insert returned no row');
    seeded.push({ ...row, id: inserted.id, startedAt });
  }
  return { org, seeded };
}

describe('logShippingFailing filter + stats count — real Postgres (#8611)', () => {
  it('the derive table says what the fixture claims (guards against a vacuous pass)', () => {
    const now = new Date();
    for (const row of TABLE) {
      const startedAt = row.ageMs === null ? null : new Date(now.getTime() - row.ageMs);
      const derived = deriveLogShipping(
        {
          status: row.status,
          logShippingState: row.logShippingState,
          logShippingFailureStartedAt: startedAt,
          logShippingLastError: null,
        },
        now,
      );
      expect(derived.state === 'failing', row.name).toBe(row.expectFailing);
    }
  });

  it('filter yes/no, stats count and deriveLogShipping classify every row identically', async () => {
    const { org, seeded } = await seed();
    const now = new Date();

    const derivedFailing = seeded
      .filter((d) =>
        deriveLogShipping(
          {
            status: d.status,
            logShippingState: d.logShippingState,
            logShippingFailureStartedAt: d.startedAt,
            logShippingLastError: null,
          },
          now,
        ).state === 'failing',
      )
      .map((d) => d.id)
      .sort();
    const derivedNotFailing = seeded
      .map((d) => d.id)
      .filter((id) => !derivedFailing.includes(id))
      .sort();

    // Sanity: both sides of the table are populated.
    expect(derivedFailing).toHaveLength(2);
    expect(derivedNotFailing).toHaveLength(TABLE.length - 2);

    const run = (value: 'yes' | 'no', operator: 'equals' | 'notEquals' = 'equals') =>
      withSystemDbAccessContext(() =>
        evaluateFilter(
          { operator: 'AND', conditions: [{ field: 'logShippingFailing', operator, value }] },
          { orgId: org.id },
        ),
      ).then((r) => [...r.deviceIds].sort());

    expect(await run('yes')).toEqual(derivedFailing);
    expect(await run('no')).toEqual(derivedNotFailing);
    expect(await run('yes', 'notEquals')).toEqual(derivedNotFailing);
    expect(await run('no', 'notEquals')).toEqual(derivedFailing);

    const stats = await withSystemDbAccessContext(() => queryDeviceStats(eq(devices.orgId, org.id)));
    expect(stats.total).toBe(TABLE.length);
    expect(stats.logShippingFailingCount).toBe(derivedFailing.length);
  });
});

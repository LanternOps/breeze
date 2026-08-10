/**
 * Integration test — JS `Date` values bound into hand-written Drizzle `sql`
 * templates, against real Postgres (regression guard for #3369).
 *
 * A bare value inside a `sql` template is wrapped in a `Param` carrying the
 * NOOP encoder, so the untouched JS object is handed to postgres.js and its
 * Bind step throws `ERR_INVALID_ARG_TYPE ... Received an instance of Date`.
 * **No mock reproduces this** — the failure lives in the driver's own type
 * coercion, not in Drizzle's query building or in application logic. The unit
 * guards alongside each fixed site assert "no param is a `Date`"; only this
 * file proves the statements Postgres actually receives are well-typed and
 * return the right rows.
 *
 * Two things are proven here that a rendered-SQL assertion cannot:
 *
 *   1. `filterEngine` — the uncast ISO parameter compares *correctly* against
 *      `devices.last_seen_at`, which is `timestamp` WITHOUT time zone. This is
 *      the half that a blanket `::timestamptz` cast would have broken far more
 *      quietly than the original bug: Postgres would reinterpret the naive
 *      column in the session time zone and shift every boundary. The test runs
 *      the same assertions under a deliberately non-UTC session `TimeZone` to
 *      catch exactly that.
 *   2. `oauth/revocationRetry` — the `ON CONFLICT DO UPDATE` branch, which only
 *      fires when a retry row already exists, really executes: `$1::timestamptz
 *      + (LEAST(300, POWER(2, attempts)) * interval '1 second')` and
 *      `GREATEST(expires_at, $2::timestamptz)` both resolve, and the backoff
 *      and lifetime-extension semantics hold.
 *
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/sqlTemplateDateBinding.integration.test.ts
 */
import './setup';

import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { withSystemDbAccessContext } from '../../db';
import { devices, oauthRevocationRetries } from '../../db/schema';
import { evaluateFilter } from '../../services/filterEngine';
import { buildRetryConflictUpdate } from '../../oauth/revocationRetry';

// Deliberately spread across a day so a session-time-zone shift of a few hours
// moves at least one device across the `between` boundary.
const T0 = new Date('2026-03-15T02:00:00.000Z');
const T1 = new Date('2026-03-15T12:00:00.000Z');
const T2 = new Date('2026-03-15T22:00:00.000Z');
const T3 = new Date('2026-03-16T09:00:00.000Z');

async function seedOrgWithDevices() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const seeded: Array<{ id: string; lastSeenAt: Date }> = [];
  for (const [i, lastSeenAt] of [T0, T1, T2, T3].entries()) {
    const [row] = await getTestDb()
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `agent-${org.id}-${i}`,
        hostname: `host-${org.id.slice(0, 8)}-${i}`,
        osType: 'linux',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        lastSeenAt,
      })
      .returning();
    if (!row) throw new Error('seedOrgWithDevices: device insert returned no row');
    seeded.push({ id: row.id, lastSeenAt });
  }
  return { org, seeded };
}

const idsFor = (seeded: Array<{ id: string; lastSeenAt: Date }>, times: Date[]) =>
  seeded.filter((d) => times.some((t) => t.getTime() === d.lastSeenAt.getTime()))
    .map((d) => d.id)
    .sort();

describe('filterEngine datetime predicates — real Postgres (#3369)', () => {
  it('resolves a between filter carrying real Date bounds, and returns exactly the devices inside the range', async () => {
    const { org, seeded } = await seedOrgWithDevices();

    // THE regression: on the pre-fix code this rejects with
    // ERR_INVALID_ARG_TYPE from postgres.js's Bind step before Postgres ever
    // sees the statement.
    const result = await withSystemDbAccessContext(() =>
      evaluateFilter(
        {
          operator: 'AND',
          conditions: [
            {
              field: 'lastSeenAt',
              operator: 'between',
              // Bounds chosen to sit strictly between seeded values so the
              // inclusive/exclusive edge is not what the assertion depends on.
              value: {
                from: new Date('2026-03-15T06:00:00.000Z'),
                to: new Date('2026-03-16T00:00:00.000Z'),
              },
            },
          ],
        },
        { orgId: org.id },
      ),
    );

    expect([...result.deviceIds].sort()).toEqual(idsFor(seeded, [T1, T2]));
  });

  it.each([
    ['before', new Date('2026-03-15T12:00:00.001Z'), [T0, T1]],
    ['after', new Date('2026-03-15T12:00:00.000Z'), [T2, T3]],
  ] as const)('resolves a %s filter and selects the right side of the boundary', async (operator, value, expected) => {
    const { org, seeded } = await seedOrgWithDevices();

    const result = await withSystemDbAccessContext(() =>
      evaluateFilter(
        { operator: 'AND', conditions: [{ field: 'lastSeenAt', operator, value: new Date(value) }] },
        { orgId: org.id },
      ),
    );

    expect([...result.deviceIds].sort()).toEqual(idsFor(seeded, [...expected]));
  });

  it('matches an exact stored instant, proving millisecond fidelity survives the round trip', async () => {
    const { org, seeded } = await seedOrgWithDevices();

    const result = await withSystemDbAccessContext(() =>
      evaluateFilter(
        { operator: 'AND', conditions: [{ field: 'lastSeenAt', operator: 'equals', value: new Date(T1) }] },
        { orgId: org.id },
      ),
    );

    expect(result.deviceIds).toEqual(idsFor(seeded, [T1]));
  });

  it('gives identical results under a non-UTC session time zone', async () => {
    // `devices.last_seen_at` is `timestamp` WITHOUT time zone, holding UTC wall
    // clock by Drizzle convention. Had the parameter been cast `::timestamptz`,
    // Postgres would coerce the naive column *in the session zone* — under
    // Pacific/Kiritimati (UTC+14) the T2 device (22:00Z) would fall outside the
    // window below and this assertion would drop it. A silent, deployment-
    // dependent wrong answer is worse than the TypeError being fixed, so it
    // gets its own guard.
    const { org, seeded } = await seedOrgWithDevices();

    const run = () =>
      evaluateFilter(
        {
          operator: 'AND',
          conditions: [
            {
              field: 'lastSeenAt',
              operator: 'between',
              value: {
                from: new Date('2026-03-15T06:00:00.000Z'),
                to: new Date('2026-03-16T00:00:00.000Z'),
              },
            },
          ],
        },
        { orgId: org.id },
      );

    const db = getTestDb();
    const previous = (await db.execute(`SHOW TimeZone`)) as unknown as Array<{ TimeZone: string }>;
    try {
      await db.execute(`SET TimeZone = 'Pacific/Kiritimati'`);
      const shifted = await withSystemDbAccessContext(run);
      expect([...shifted.deviceIds].sort()).toEqual(idsFor(seeded, [T1, T2]));
    } finally {
      await db.execute(`SET TimeZone = '${previous[0]?.TimeZone ?? 'UTC'}'`);
    }
  });
});

describe('oauth revocation retry conflict branch — real Postgres (#3369)', () => {
  async function seedRetryRow(opts: { attempts: number; expiresAt: Date; nextAttemptAt: Date }) {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const markerId = `grant-${user.id}`;

    await getTestDb().insert(oauthRevocationRetries).values({
      userId: user.id,
      markerType: 'grant',
      markerId,
      expiresAt: opts.expiresAt,
      attempts: opts.attempts,
      nextAttemptAt: opts.nextAttemptAt,
      lastErrorCode: 'redis_unavailable',
      updatedAt: new Date(),
    });

    return { user, markerId };
  }

  const readRow = (userId: string, markerId: string) =>
    getTestDb()
      .select()
      .from(oauthRevocationRetries)
      .where(and(
        eq(oauthRevocationRetries.userId, userId),
        eq(oauthRevocationRetries.markerId, markerId),
      ));

  it('executes the backoff arithmetic and extends the deadline, rather than throwing at Bind', async () => {
    const attemptedAt = new Date('2026-03-15T12:00:00.000Z');
    const existingExpiry = new Date('2026-03-15T13:00:00.000Z');
    const { user, markerId } = await seedRetryRow({
      attempts: 3,
      expiresAt: existingExpiry,
      nextAttemptAt: new Date('2026-03-15T11:00:00.000Z'),
    });

    // The whole point of this branch: it only ever runs on a row that already
    // exists, i.e. only after a Redis write has already failed. On the pre-fix
    // code the raw Dates threw at Bind, rolling back the worker's entire batch
    // and leaving the queue permanently undrained during a Redis outage.
    await getTestDb()
      .insert(oauthRevocationRetries)
      .values({
        userId: user.id,
        markerType: 'grant',
        markerId,
        expiresAt: new Date('2026-03-15T14:00:00.000Z'),
        attempts: 1,
        nextAttemptAt: new Date(attemptedAt.getTime() + 1_000),
        lastErrorCode: 'redis_write_failed',
        updatedAt: attemptedAt,
      })
      .onConflictDoUpdate({
        target: [oauthRevocationRetries.markerType, oauthRevocationRetries.markerId],
        set: buildRetryConflictUpdate({
          attemptedAt,
          expiresAt: new Date('2026-03-15T14:00:00.000Z'),
          errorCode: 'redis_write_failed',
        }),
      });

    const [row] = await readRow(user.id, markerId);
    expect(row).toBeDefined();
    expect(row!.attempts).toBe(4);
    // Backoff is computed off the PRE-increment attempts (3) => 2^3 = 8s.
    expect(row!.nextAttemptAt.toISOString()).toBe('2026-03-15T12:00:08.000Z');
    // GREATEST picked the later of the two deadlines.
    expect(row!.expiresAt.toISOString()).toBe('2026-03-15T14:00:00.000Z');
    expect(row!.lastErrorCode).toBe('redis_write_failed');
  });

  it('caps the backoff at 300 seconds and never shortens an existing deadline', async () => {
    const attemptedAt = new Date('2026-03-15T12:00:00.000Z');
    const existingExpiry = new Date('2026-03-15T20:00:00.000Z');
    const { user, markerId } = await seedRetryRow({
      attempts: 20, // 2^20s would be ~12 days without the LEAST(300, ...) cap
      expiresAt: existingExpiry,
      nextAttemptAt: new Date('2026-03-15T11:00:00.000Z'),
    });

    await getTestDb()
      .insert(oauthRevocationRetries)
      .values({
        userId: user.id,
        markerType: 'grant',
        markerId,
        expiresAt: new Date('2026-03-15T15:00:00.000Z'), // EARLIER than existing
        attempts: 1,
        nextAttemptAt: new Date(attemptedAt.getTime() + 1_000),
        lastErrorCode: 'redis_unavailable',
        updatedAt: attemptedAt,
      })
      .onConflictDoUpdate({
        target: [oauthRevocationRetries.markerType, oauthRevocationRetries.markerId],
        set: buildRetryConflictUpdate({
          attemptedAt,
          expiresAt: new Date('2026-03-15T15:00:00.000Z'),
          errorCode: 'redis_unavailable',
        }),
      });

    const [row] = await readRow(user.id, markerId);
    expect(row!.nextAttemptAt.toISOString()).toBe('2026-03-15T12:05:00.000Z');
    // A defense-in-depth revocation marker must never expire earlier than an
    // attempt already promised.
    expect(row!.expiresAt.toISOString()).toBe(existingExpiry.toISOString());
  });
});

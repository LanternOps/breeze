/**
 * #8971 A1: the 'withdrawn' elevation status and its columns, against a real
 * Postgres.
 *
 * The enum value alone is not enough: elevation_requests_status_timestamps_chk
 * lists the statuses a row may take. 'actuating' shipped once without widening
 * it, which made its transition impossible until 2026-09-16 fixed the CHECK.
 * This suite pins that a withdrawn row is accepted only with its timestamp
 * and a known reason, so the agent's withdraw route can actually write it.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/pamElevationWithdrawnSchema.integration.test.ts
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { devices, organizations, partners, sites } from '../../db/schema';
import { elevationAudit, elevationRequests, PAM_WITHDRAW_REASONS } from '../../db/schema/elevations';
import { currentOwnershipEpochSql } from '../../services/deviceOwnershipEpoch';
import { getTestDb } from './setup';

let orgId: string;
let requestId: string;

beforeEach(async () => {
  const tdb = getTestDb();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [p] = await tdb.insert(partners)
    .values({ name: '8971 MSP', slug: `msp-8971-${stamp}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  const [o] = await tdb.insert(organizations)
    .values({ currencyCode: 'USD', partnerId: p!.id, name: '8971 Org', slug: `org-8971-${stamp}`, type: 'customer', status: 'active' })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [s] = await tdb.insert(sites).values({ orgId, name: '8971 Site', timezone: 'UTC' }).returning({ id: sites.id });
  const [d] = await tdb.insert(devices).values({
    orgId,
    siteId: s!.id,
    agentId: `agent-8971-schema-${stamp}`,
    hostname: 'ws-8971-schema',
    osType: 'windows',
    osVersion: '10.0',
    architecture: 'amd64',
    agentVersion: '1.0.0',
    status: 'online',
  }).returning({ id: devices.id });
  const [r] = await tdb.insert(elevationRequests).values({
    orgId,
    siteId: s!.id,
    partnerId: p!.id,
    deviceId: d!.id,
    deviceEpoch: currentOwnershipEpochSql(d!.id),
    flowType: 'uac_intercept',
    subjectUsername: 'WS\\enduser',
    reason: 'UAC consent UI observed for C:\\Temp\\setup.exe',
    targetExecutablePath: 'C:\\Temp\\setup.exe',
    status: 'pending',
  }).returning({ id: elevationRequests.id });
  requestId = r!.id;
});

/** drizzle wraps the driver error; the constraint name is on the cause. */
async function expectConstraint(query: Promise<unknown>, constraint: string): Promise<void> {
  const err = await query.then(
    () => null,
    (e: unknown) => e as { cause?: { constraint_name?: string; message?: string }; message?: string },
  );
  expect(err, `expected ${constraint} to reject the write`).not.toBeNull();
  expect(err?.cause?.constraint_name ?? err?.cause?.message ?? err?.message).toMatch(new RegExp(constraint));
}

describe('elevation status withdrawn (#8971)', () => {
  it('the reason list matches the agent constants byte for byte', () => {
    // #10190 W07 appends user_cancelled (the end user's "Cancel request"
    // on the waiting card); Go pamdecline.ReasonUserCancelled.
    expect([...PAM_WITHDRAW_REASONS]).toEqual(['user_denied', 'user_timeout', 'dialog_error', 'user_cancelled']);
  });

  it('the CHECK admits exactly the reason list (#10190 W07)', async () => {
    const result = await getTestDb().execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'elevation_requests_withdrawn_reason_chk'
    `);
    const rows = (result as unknown as { rows?: Array<{ def: string }> }).rows ?? (result as unknown as Array<{ def: string }>);
    expect(rows).toHaveLength(1);
    const listed = [...rows[0]!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...PAM_WITHDRAW_REASONS]);
  });

  it('accepts user_cancelled and still rejects an unknown reason (#10190 W07)', async () => {
    const tdb = getTestDb();
    await tdb.execute(sql`UPDATE elevation_requests SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = 'user_cancelled' WHERE id = ${requestId}`);
    const [row] = await tdb.select().from(elevationRequests).where(eq(elevationRequests.id, requestId));
    expect(row?.withdrawnReason).toBe('user_cancelled');
    await tdb.execute(sql`UPDATE elevation_requests SET status = 'pending', withdrawn_at = NULL, withdrawn_reason = NULL WHERE id = ${requestId}`);
    await expectConstraint(
      tdb.execute(sql`UPDATE elevation_requests SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = 'user_canceled' WHERE id = ${requestId}`),
      'elevation_requests_withdrawn_reason_chk',
    );
  });

  it('withdrawn row requires withdrawn_at and a valid reason', async () => {
    const tdb = getTestDb();

    await expectConstraint(
      tdb.execute(sql`UPDATE elevation_requests SET status = 'withdrawn', withdrawn_reason = 'user_denied' WHERE id = ${requestId}`),
      'elevation_requests_status_timestamps_chk',
    );
    await expectConstraint(
      tdb.execute(sql`UPDATE elevation_requests SET status = 'withdrawn', withdrawn_at = now() WHERE id = ${requestId}`),
      'elevation_requests_status_timestamps_chk',
    );
    await expectConstraint(
      tdb.execute(sql`UPDATE elevation_requests SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = 'nope' WHERE id = ${requestId}`),
      'elevation_requests_withdrawn_reason_chk',
    );

    for (const reason of PAM_WITHDRAW_REASONS) {
      await tdb.execute(sql`UPDATE elevation_requests SET status = 'pending', withdrawn_at = NULL, withdrawn_reason = NULL WHERE id = ${requestId}`);
      await tdb.execute(sql`UPDATE elevation_requests SET status = 'withdrawn', withdrawn_at = now(), withdrawn_reason = ${reason} WHERE id = ${requestId}`);
      const [row] = await tdb.select().from(elevationRequests).where(eq(elevationRequests.id, requestId));
      expect(row?.status).toBe('withdrawn');
      expect(row?.withdrawnReason).toBe(reason);
      expect(row?.withdrawnAt).toBeInstanceOf(Date);
    }
  });

  it('keeps the existing status clauses', async () => {
    const tdb = getTestDb();
    // A sample of the five clauses copied from 2026-09-16: approved still
    // needs approved_at, expired still needs expired_at.
    await expectConstraint(
      tdb.execute(sql`UPDATE elevation_requests SET status = 'approved' WHERE id = ${requestId}`),
      'elevation_requests_status_timestamps_chk',
    );
    await expectConstraint(
      tdb.execute(sql`UPDATE elevation_requests SET status = 'expired' WHERE id = ${requestId}`),
      'elevation_requests_status_timestamps_chk',
    );
    await expectConstraint(
      tdb.execute(sql`UPDATE elevation_requests SET status = 'denied' WHERE id = ${requestId}`),
      'elevation_requests_status_timestamps_chk',
    );
    await expectConstraint(
      tdb.execute(sql`UPDATE elevation_requests SET status = 'revoked' WHERE id = ${requestId}`),
      'elevation_requests_status_timestamps_chk',
    );
    // Each clause still admits its own well-formed row.
    for (const set of [
      sql`status = 'approved', approved_at = now()`,
      sql`status = 'auto_approved', approved_at = now()`,
      sql`status = 'actuating', approved_at = now()`,
      sql`status = 'denied', denial_reason = 'no'`,
      sql`status = 'expired', expired_at = now()`,
      sql`status = 'revoked', revoked_at = now()`,
    ]) {
      await tdb.execute(sql`UPDATE elevation_requests SET ${set} WHERE id = ${requestId}`);
      await tdb.execute(sql`UPDATE elevation_requests SET status = 'pending', approved_at = NULL, denial_reason = NULL, expired_at = NULL, revoked_at = NULL WHERE id = ${requestId}`);
    }
  });

  it('accepts a withdrawn audit event', async () => {
    await getTestDb().insert(elevationAudit).values({
      orgId,
      elevationRequestId: requestId,
      eventType: 'withdrawn',
      actor: 'end_user',
      details: { cause: 'user_denied', agent_declined_at: null },
      occurredAt: new Date(),
    });
    const rows = await getTestDb().select({ eventType: elevationAudit.eventType })
      .from(elevationAudit).where(eq(elevationAudit.elevationRequestId, requestId));
    expect(rows.map((r) => r.eventType)).toEqual(['withdrawn']);
  });
});

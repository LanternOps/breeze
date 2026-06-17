/**
 * Integration test for issue #1372 — storage-side mirror of the assurance
 * decision invariants on `approval_requests` + `elevation_requests`.
 *
 * The four factor-recording columns (`decided_assurance_level`, `decided_via`,
 * `authenticator_device_id`, and the transitional `pin_verified`) are a
 * forensic record. The application guards their consistency at write time via
 * `assertDecisionConsistent` (authenticatorAssurance.ts), but the DB itself
 * accepted self-contradictory tuples until the CHECK constraints added by
 * `2026-06-17-authenticator-assurance-check-constraints.sql`.
 *
 * These assertions run against a real DB. CHECK constraints fire regardless of
 * the connection role, so the superuser test connection (`getTestDb`) is used
 * directly — the RLS role is irrelevant to what this test proves. They fail
 * (RED) until the constraint migration ships.
 *
 * Invariants enforced (matching assertDecisionConsistent):
 *   - decided_assurance_level, when set, is 1..4.
 *   - session_tap  <=>  no authenticator device  (an L2+ factor records one).
 *   - session_tap  <=>  level 1                   (a proof factor is never L1).
 *   - pin_verified implies level >= 3             (legacy approver-PIN gate).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import { createPartner, createUser } from './db-utils';

/** Postgres SQLSTATE for a CHECK constraint violation. */
const CHECK_VIOLATION = '23514';

let userId: string;
let deviceId: string;

beforeEach(async () => {
  // setup.ts's beforeEach TRUNCATEs users CASCADE, so the authenticator device
  // and any forged approval rows are cleared transitively each test.
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id });
  userId = user.id;

  const tdb = getTestDb();
  const rows = (await tdb.execute(sql`
    INSERT INTO authenticator_devices (user_id, kind, public_key, is_platform_bound)
    VALUES (${userId}, 'webauthn_platform', 'test-public-key', true)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  deviceId = rows[0]!.id;
});

/** Forge an approval_requests row with explicit factor-recording fields. */
function insertApproval(fields: {
  decidedVia?: string | null;
  level?: number | null;
  deviceId?: string | null;
}) {
  const tdb = getTestDb();
  return tdb.execute(sql`
    INSERT INTO approval_requests
      (user_id, requesting_client_label, action_label, action_tool_name,
       risk_tier, risk_summary, expires_at,
       decided_via, decided_assurance_level, authenticator_device_id)
    VALUES
      (${userId}, 'chk-test', 'chk.action', 'chk.tool',
       'low', 'check-constraint test', now() + interval '5 minutes',
       ${fields.decidedVia ?? null}::approval_factor,
       ${fields.level ?? null}::smallint,
       ${fields.deviceId ?? null}::uuid)
  `);
}

describe('#1372 — assurance CHECK constraints accept every legitimate row', () => {
  it('accepts a pending (undecided) row where all factor fields are NULL', async () => {
    await expect(insertApproval({})).resolves.toBeDefined();
  });

  it('accepts a session_tap decision at L1 with no device', async () => {
    await expect(
      insertApproval({ decidedVia: 'session_tap', level: 1, deviceId: null }),
    ).resolves.toBeDefined();
  });

  it('accepts an L2 proof factor that records a device', async () => {
    await expect(
      insertApproval({ decidedVia: 'webauthn_platform', level: 2, deviceId }),
    ).resolves.toBeDefined();
  });
});

describe('#1372 — assurance CHECK constraints reject self-contradictory rows', () => {
  it('rejects an out-of-range assurance level (> 4)', async () => {
    await expect(insertApproval({ level: 7 })).rejects.toMatchObject({
      cause: { code: CHECK_VIOLATION },
    });
  });

  it('rejects an out-of-range assurance level (0)', async () => {
    await expect(insertApproval({ level: 0 })).rejects.toMatchObject({
      cause: { code: CHECK_VIOLATION },
    });
  });

  it('rejects session_tap carrying an authenticator device', async () => {
    await expect(
      insertApproval({ decidedVia: 'session_tap', level: 1, deviceId }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it('rejects session_tap recorded above L1', async () => {
    await expect(
      insertApproval({ decidedVia: 'session_tap', level: 2, deviceId: null }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it('rejects an L2+ proof factor with no device id', async () => {
    await expect(
      insertApproval({ decidedVia: 'webauthn_platform', level: 2, deviceId: null }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it('rejects a proof factor recorded at L1', async () => {
    await expect(
      insertApproval({ decidedVia: 'webauthn_platform', level: 1, deviceId }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });
});

describe('#1372 — pin_verified gate (only while the transitional column exists)', () => {
  it('rejects pin_verified=true below L3 (or self-skips once the column is dropped)', async () => {
    const tdb = getTestDb();
    const present = (await tdb.execute(sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'approval_requests' AND column_name = 'pin_verified'
    `)) as unknown as unknown[];

    if (present.length === 0) {
      // pin_verified removed by #1433 — the dependent CHECK is gone too; nothing
      // to assert. Kept as a passing no-op so the suite survives that merge.
      return;
    }

    await expect(
      tdb.execute(sql`
        INSERT INTO approval_requests
          (user_id, requesting_client_label, action_label, action_tool_name,
           risk_tier, risk_summary, expires_at,
           decided_via, decided_assurance_level, pin_verified)
        VALUES
          (${userId}, 'chk-test', 'chk.action', 'chk.tool',
           'low', 'check-constraint test', now() + interval '5 minutes',
           'session_tap'::approval_factor, 1::smallint, true)
      `),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });
});

describe('#1372 — elevation_requests carries the identical constraints', () => {
  it('mirrors every stable assurance CHECK predicate onto elevation_requests', async () => {
    const tdb = getTestDb();
    const rows = (await tdb.execute(sql`
      SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE contype = 'c'
        AND conrelid IN ('approval_requests'::regclass, 'elevation_requests'::regclass)
        AND conname LIKE '%_chk'
    `)) as unknown as Array<{ tbl: string; conname: string; def: string }>;

    const byName = new Map(rows.map((r) => [r.conname, r.def]));

    for (const suffix of ['decided_level_range_chk', 'factor_device_chk', 'factor_level_chk']) {
      const approvalDef = byName.get(`approval_requests_${suffix}`);
      const elevationDef = byName.get(`elevation_requests_${suffix}`);
      expect(approvalDef, `approval_requests_${suffix} missing`).toBeDefined();
      expect(elevationDef, `elevation_requests_${suffix} missing`).toBeDefined();
      // pg_get_constraintdef omits the table name, so identical invariants yield
      // byte-identical defs.
      expect(elevationDef).toBe(approvalDef);
    }
  });
});

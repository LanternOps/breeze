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

/** Forge an approval_requests row that also sets the transitional pin_verified flag. */
function insertApprovalWithPin(fields: {
  decidedVia: string;
  level: number;
  deviceId: string | null;
  pinVerified: boolean;
}) {
  const tdb = getTestDb();
  return tdb.execute(sql`
    INSERT INTO approval_requests
      (user_id, requesting_client_label, action_label, action_tool_name,
       risk_tier, risk_summary, expires_at,
       decided_via, decided_assurance_level, authenticator_device_id, pin_verified)
    VALUES
      (${userId}, 'chk-test', 'chk.action', 'chk.tool',
       'low', 'check-constraint test', now() + interval '5 minutes',
       ${fields.decidedVia}::approval_factor, ${fields.level}::smallint,
       ${fields.deviceId}::uuid, ${fields.pinVerified})
  `);
}

/** pin_verified is removed by PR #1433; its constraint + tests gate on this. */
async function pinColumnPresent(): Promise<boolean> {
  const rows = (await getTestDb().execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_requests' AND column_name = 'pin_verified'
  `)) as unknown as unknown[];
  return rows.length > 0;
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

  it('accepts a proof factor at L4 (the valid upper bound)', async () => {
    await expect(
      insertApproval({ decidedVia: 'webauthn_platform', level: 4, deviceId }),
    ).resolves.toBeDefined();
  });
});

describe('#1372 — assurance CHECK constraints reject self-contradictory rows', () => {
  // Range cases use a coherent proof tuple (factor + device) so the ONLY
  // violation is the range check — otherwise co-presence (a level with a NULL
  // factor) would fire first and the test would pass for the wrong reason.
  it('rejects level 5 (one past the valid upper bound)', async () => {
    await expect(
      insertApproval({ decidedVia: 'webauthn_platform', level: 5, deviceId }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it('rejects an out-of-range assurance level (0)', async () => {
    await expect(
      insertApproval({ decidedVia: 'webauthn_platform', level: 0, deviceId }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
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

describe('#1372 — co-presence: a half-recorded decision is rejected', () => {
  // These are the three-valued-logic holes the biconditionals alone leave open
  // (`(a) = (b)` is NULL → satisfied when a component is NULL). The app never
  // writes them, but the storage boundary must still reject them.
  it('rejects a recorded factor with a NULL level', async () => {
    await expect(
      insertApproval({ decidedVia: 'webauthn_platform', level: null, deviceId }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it('rejects a recorded level with a NULL factor', async () => {
    await expect(
      insertApproval({ decidedVia: null, level: 2, deviceId: null }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });
});

describe('#1372 — pin_verified gate (only while the transitional column exists)', () => {
  // authenticator_device_id carries no FK (see approvals.ts) — the device seeded
  // in beforeEach is only a realistic UUID, so each rejection below provably
  // trips the CHECK (23514), never an FK trigger.
  it('rejects pin_verified=true at L1', async (ctx) => {
    if (!(await pinColumnPresent())) return ctx.skip();
    await expect(
      insertApprovalWithPin({ decidedVia: 'session_tap', level: 1, deviceId: null, pinVerified: true }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it('rejects pin_verified=true at L2 (boundary — gate is level >= 3)', async (ctx) => {
    if (!(await pinColumnPresent())) return ctx.skip();
    await expect(
      insertApprovalWithPin({ decidedVia: 'webauthn_platform', level: 2, deviceId, pinVerified: true }),
    ).rejects.toMatchObject({ cause: { code: CHECK_VIOLATION } });
  });

  it('accepts pin_verified=true at L3 (boundary — first valid level)', async (ctx) => {
    if (!(await pinColumnPresent())) return ctx.skip();
    await expect(
      insertApprovalWithPin({ decidedVia: 'webauthn_platform', level: 3, deviceId, pinVerified: true }),
    ).resolves.toBeDefined();
  });
});

describe('#1372 — elevation_requests carries the identical constraints', () => {
  it('mirrors every stable assurance CHECK predicate onto elevation_requests', async () => {
    const tdb = getTestDb();
    const rows = (await tdb.execute(sql`
      SELECT conname, pg_get_constraintdef(oid) AS def, convalidated
      FROM pg_constraint
      WHERE contype = 'c'
        AND conrelid IN ('approval_requests'::regclass, 'elevation_requests'::regclass)
        AND conname LIKE '%\_chk'
    `)) as unknown as Array<{ conname: string; def: string; convalidated: boolean }>;

    const byName = new Map(rows.map((r) => [r.conname, r]));

    const stable = [
      'decided_level_range_chk',
      'decision_copresence_chk',
      'factor_device_chk',
      'factor_level_chk',
    ];
    for (const suffix of stable) {
      const approval = byName.get(`approval_requests_${suffix}`);
      const elevation = byName.get(`elevation_requests_${suffix}`);
      expect(approval, `approval_requests_${suffix} missing`).toBeDefined();
      expect(elevation, `elevation_requests_${suffix} missing`).toBeDefined();
      // pg_get_constraintdef omits the table name, so identical invariants yield
      // byte-identical defs.
      expect(elevation!.def).toBe(approval!.def);
      // Guard against a future copy-paste shipping the constraint NOT VALID,
      // which would advertise an invariant the DB does not actually enforce.
      expect(approval!.convalidated, `${suffix} on approval not validated`).toBe(true);
      expect(elevation!.convalidated, `${suffix} on elevation not validated`).toBe(true);
    }
  });

  it('mirrors the transitional pin_verified gate while the column exists', async () => {
    if (!(await pinColumnPresent())) return; // dropped by #1433 — nothing to mirror
    const tdb = getTestDb();
    const rows = (await tdb.execute(sql`
      SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE contype = 'c'
        AND conrelid IN ('approval_requests'::regclass, 'elevation_requests'::regclass)
        AND conname LIKE '%pin_level_chk'
    `)) as unknown as Array<{ conname: string; def: string }>;
    const byName = new Map(rows.map((r) => [r.conname, r.def]));
    expect(byName.get('approval_requests_pin_level_chk')).toBeDefined();
    expect(byName.get('elevation_requests_pin_level_chk')).toBe(
      byName.get('approval_requests_pin_level_chk'),
    );
  });
});

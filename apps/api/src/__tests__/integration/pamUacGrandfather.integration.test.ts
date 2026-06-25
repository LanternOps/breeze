import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createPartner, createOrganization, createSite } from './db-utils';

// The data backfill from migration 2026-07-01-pam-uac-opt-in-grandfathering.sql,
// inlined verbatim so this test guards the real grandfather criteria. The
// migration's `ALTER TABLE ... ADD COLUMN` is omitted — the column already
// exists once migrations have run against the test DB.
//
// The load-bearing invariant: grandfather orgs with DELIBERATE PAM config
// (pam_rules / pam_signer_groups / changed default_unmatched_verdict), and
// EXCLUDE orgs whose only PAM footprint is elevation_requests history. A
// regression that lets elevation_requests grandfather an org would silently
// re-enable UAC prompts for exactly the population the opt-in switch protects.
const BACKFILL = sql`
  WITH active_pam_orgs AS (
    SELECT org_id FROM pam_rules
    UNION SELECT org_id FROM pam_signer_groups
    UNION SELECT org_id FROM pam_org_config WHERE default_unmatched_verdict <> 'require_approval'
  )
  INSERT INTO pam_org_config (org_id, uac_interception_enabled)
  SELECT org_id, true FROM active_pam_orgs
  ON CONFLICT (org_id) DO UPDATE
    SET uac_interception_enabled = true, updated_at = now()
  WHERE pam_org_config.uac_interception_enabled IS NULL;
`;

/** Returns the org's flag, or `undefined` when no pam_org_config row exists. */
async function uacFlag(
  db: ReturnType<typeof getTestDb>,
  orgId: string,
): Promise<boolean | null | undefined> {
  const rows = await db.execute(sql`
    SELECT uac_interception_enabled AS f FROM pam_org_config WHERE org_id = ${orgId} LIMIT 1;
  `);
  const typed = rows as unknown as Array<{ f: boolean | null }>;
  const row = typed[0];
  return row ? row.f : undefined;
}

describe('PAM UAC opt-in grandfathering migration', () => {
  it('grandfathers deliberate-config orgs and spares elevation-history-only / pristine orgs', async () => {
    const db = getTestDb();
    const partner = await createPartner({});

    // Deliberate config → should be grandfathered to true.
    const rulesOrg = await createOrganization({ partnerId: partner.id });
    await db.execute(
      sql`INSERT INTO pam_rules (org_id, name, verdict) VALUES (${rulesOrg.id}, 'r', 'require_approval')`,
    );

    const signerOrg = await createOrganization({ partnerId: partner.id });
    await db.execute(
      sql`INSERT INTO pam_signer_groups (org_id, name) VALUES (${signerOrg.id}, 'g')`,
    );

    const verdictOrg = await createOrganization({ partnerId: partner.id });
    await db.execute(
      sql`INSERT INTO pam_org_config (org_id, default_unmatched_verdict) VALUES (${verdictOrg.id}, 'auto_deny')`,
    );

    // ONLY elevation_requests history (the symptom of the old default-ON
    // behavior) → must NOT be grandfathered. Requires a real device (FK).
    const elevOrg = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: elevOrg.id });
    const deviceRows = (await db.execute(sql`
      INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
      VALUES (${elevOrg.id}, ${site.id}, ${`agent-${elevOrg.id}`}, 'host', 'windows', '11', 'amd64', '0.65.0')
      RETURNING id;
    `)) as unknown as Array<{ id: string }>;
    const device = deviceRows[0];
    if (!device) throw new Error('device seed returned no row');
    // uac_intercept rows must carry target_executable_path (flow_shape_chk).
    await db.execute(sql`
      INSERT INTO elevation_requests (org_id, device_id, flow_type, subject_username, reason, target_executable_path)
      VALUES (${elevOrg.id}, ${device.id}, 'uac_intercept', 'someuser', 'test', 'C:\\Windows\\System32\\cmd.exe');
    `);

    // No PAM footprint at all → untouched (opt-in default off).
    const pristineOrg = await createOrganization({ partnerId: partner.id });

    await db.execute(BACKFILL);

    expect(await uacFlag(db, rulesOrg.id)).toBe(true);
    expect(await uacFlag(db, signerOrg.id)).toBe(true);
    expect(await uacFlag(db, verdictOrg.id)).toBe(true);
    // The whole point of the change: elevation-history-only org is spared.
    expect(await uacFlag(db, elevOrg.id)).toBeUndefined();
    expect(await uacFlag(db, pristineOrg.id)).toBeUndefined();
  });

  it('is idempotent on re-run (no duplicate rows, value stays true)', async () => {
    const db = getTestDb();
    const partner = await createPartner({});
    const org = await createOrganization({ partnerId: partner.id });
    await db.execute(
      sql`INSERT INTO pam_rules (org_id, name, verdict) VALUES (${org.id}, 'r', 'require_approval')`,
    );

    await db.execute(BACKFILL);
    await db.execute(BACKFILL);

    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pam_org_config WHERE org_id = ${org.id};
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(1);
    expect(await uacFlag(db, org.id)).toBe(true);
  });

  it('never clobbers an explicit admin opt-out (IS NULL guard)', async () => {
    // Org has deliberate config (so it is in active_pam_orgs) AND an admin has
    // already set uac_interception_enabled=false. A re-run must leave it false.
    const db = getTestDb();
    const partner = await createPartner({});
    const org = await createOrganization({ partnerId: partner.id });
    await db.execute(
      sql`INSERT INTO pam_rules (org_id, name, verdict) VALUES (${org.id}, 'r', 'require_approval')`,
    );
    await db.execute(
      sql`INSERT INTO pam_org_config (org_id, uac_interception_enabled) VALUES (${org.id}, false)`,
    );

    await db.execute(BACKFILL);

    expect(await uacFlag(db, org.id)).toBe(false);
  });
});

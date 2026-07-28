import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import JSZip from 'jszip';
import { getTestDb } from './setup';
import { buildOrgExportZip } from '../../services/tenantExport';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

/**
 * End-to-end proof for the GDPR export + erasure round-trip (Task 30,
 * Tier-2 launch gate "tenant data export + delete proven end-to-end").
 *
 * The sibling `tenantCascade.integration.test.ts` is a *structural*
 * contract test (the cascade list matches the schema + FK topology). It
 * never seeds real rows. This test closes that gap: it seeds two orgs
 * with real org-scoped rows, then exercises the actual service functions
 * against the live `breeze_app` pool to prove:
 *
 *   1. buildOrgExportZip() emits a real ZIP whose manifest row-counts
 *      reflect ONLY the requested org's rows (cross-tenant isolation on
 *      the read path).
 *   2. cascadeDeleteOrg() removes every org-scoped row + the org itself
 *      for the target org, and leaves a second org's rows untouched
 *      (cross-tenant isolation on the delete path).
 *
 * Seeding goes through getTestDb() (superuser, RLS-bypassing). The code
 * under test imports `db` (breeze_app pool) where RLS is enforced.
 */

const PERFORMED_BY = '00000000-0000-0000-0000-0000000000aa';
const PERFORMED_EMAIL = 'platform-admin@breeze.test';

interface SeededOrgs {
  partnerId: string;
  orgA: string;
  orgB: string;
  prohibitedSentinels: string[];
}

async function seedTwoOrgs(): Promise<SeededOrgs> {
  const db = getTestDb();
  const partnerId = crypto.randomUUID();
  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();
  const suffix = partnerId.slice(0, 8);

  await db.execute(sql`
    INSERT INTO partners (id, name, slug)
    VALUES (${partnerId}, ${'RoundtripCo ' + suffix}, ${'roundtrip-' + suffix})
  `);
  await db.execute(sql`
    INSERT INTO organizations (id, partner_id, name, slug) VALUES
      (${orgA}, ${partnerId}, ${'Org A ' + suffix}, ${'org-a-' + suffix}),
      (${orgB}, ${partnerId}, ${'Org B ' + suffix}, ${'org-b-' + suffix})
  `);

  const userId = crypto.randomUUID();
  const prohibitedSentinels = [
    `PASSWORD-HASH-${suffix}`,
    `MFA-SEED-${suffix}`,
    `MFA-RECOVERY-${suffix}`,
    `API-KEY-HASH-${suffix}`,
    // device_mtls_certificates (Wave 5 Task 2): provider id, serial,
    // fingerprint, SPKI, and sanitized revoke error must never appear in a
    // tenant archive — only non-secret lifecycle metadata is exported.
    `MTLS-PROVIDER-ID-${suffix}`,
    `MTLS-SERIAL-${suffix}`,
    `MTLS-SPKI-${suffix}`,
    `MTLS-REVOKE-ERROR-${suffix}`,
  ];
  const mtlsFingerprintSentinel = `MTLSFINGERPRINT${suffix}`.padEnd(64, '0');
  prohibitedSentinels.push(mtlsFingerprintSentinel);
  await db.execute(sql`
    INSERT INTO users (
      id, partner_id, org_id, email, name,
      password_hash, mfa_secret, mfa_recovery_codes
    ) VALUES (
      ${userId}, ${partnerId}, ${orgA},
      ${'roundtrip-' + suffix + '@breeze.test'}, 'Roundtrip User',
      ${prohibitedSentinels[0]}, ${prohibitedSentinels[1]},
      jsonb_build_array(${prohibitedSentinels[2]}::text)
    )
  `);
  await db.execute(sql`
    INSERT INTO api_keys (
      org_id, name, key_hash, key_prefix, created_by
    ) VALUES (
      ${orgA}, 'Roundtrip API Key', ${prohibitedSentinels[3]},
      'brz_roundtri', ${userId}
    )
  `);

  // Org A: 2 sites + 2 device_groups. Org B: 1 site + 1 device_group.
  const siteA1 = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO sites (id, org_id, name) VALUES
      (${siteA1}, ${orgA}, 'A-Site-1'),
      (${crypto.randomUUID()}, ${orgA}, 'A-Site-2'),
      (${crypto.randomUUID()}, ${orgB}, 'B-Site-1')
  `);
  await db.execute(sql`
    INSERT INTO device_groups (id, org_id, name) VALUES
      (${crypto.randomUUID()}, ${orgA}, 'A-Group-1'),
      (${crypto.randomUUID()}, ${orgA}, 'A-Group-2'),
      (${crypto.randomUUID()}, ${orgB}, 'B-Group-1')
  `);

  // device_mtls_certificates (Wave 5 Task 2): a device + one certificate
  // history row carrying sentinel provider id, serial, fingerprint, SPKI,
  // and a sanitized revoke error — proves the export excludes them and
  // cascadeDeleteOrg removes the row.
  const deviceId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${deviceId}, ${orgA}, ${siteA1}, ${'roundtrip-agent-' + suffix}, 'roundtrip-host', 'windows', '11', 'amd64', '1.0.0')
  `);
  await db.execute(sql`
    INSERT INTO device_mtls_certificates (
      org_id, device_id, provider_certificate_id, serial_number,
      fingerprint_sha256, public_key_spki, state, issued_at, expires_at,
      activated_at, revoke_attempts, last_revoke_error
    ) VALUES (
      ${orgA}, ${deviceId}, ${'MTLS-PROVIDER-ID-' + suffix}, ${'MTLS-SERIAL-' + suffix},
      ${mtlsFingerprintSentinel}, ${'MTLS-SPKI-' + suffix}, 'active', now(), now() + interval '1 year',
      now(), 2, ${'MTLS-REVOKE-ERROR-' + suffix}
    )
  `);

  return { partnerId, orgA, orgB, prohibitedSentinels };
}

function rowCount(db: ReturnType<typeof getTestDb>, table: string, orgId: string) {
  return db
    .execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${table}"`)} WHERE org_id = ${orgId}`)
    .then((r) => (r as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

describe('tenant export + erasure round-trip (live DB)', () => {
  beforeEach(async () => {
    // cleanupDatabase() in setup.ts already TRUNCATEs sites/device_groups/
    // organizations/partners before each test.
  });

  it('export manifest reflects only the target org rows', async () => {
    const { orgA, prohibitedSentinels } = await seedTwoOrgs();

    const { manifest, zipBuffer } = await buildOrgExportZip(orgA, PERFORMED_BY, PERFORMED_EMAIL);

    // It's a real, non-empty ZIP (local-file-header magic "PK\x03\x04").
    expect(zipBuffer.length).toBeGreaterThan(0);
    expect(zipBuffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const byName = new Map(manifest.files.map((f) => [f.name, f]));
    // Org A has exactly 2 sites + 2 device_groups; Org B's rows must not leak.
    expect(byName.get('sites.json')?.rowCount).toBe(2);
    expect(byName.get('device_groups.json')?.rowCount).toBe(2);
    // organizations.json is the org's own id-keyed row.
    expect(byName.get('organizations.json')?.rowCount).toBe(1);
    // device_mtls_certificates.json carries the one certificate history row.
    expect(byName.get('device_mtls_certificates.json')?.rowCount).toBe(1);
    // Every manifest entry carries a sha256.
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest.orgId).toBe(orgA);

    const zip = await JSZip.loadAsync(zipBuffer);
    const serializedZip = await Promise.all(
      Object.values(zip.files).map((entry) => entry.async('string')),
    ).then((entries) => entries.join('\n'));
    for (const prohibitedKey of [
      'password_hash',
      'mfa_secret',
      'mfa_recovery_codes',
      'key_hash',
      // device_mtls_certificates excluded columns (Wave 5 Task 2) — checked
      // by key name too, not just sentinel value, so the assertion still
      // catches a future policy edit that flips one of these back to
      // include. serial_number is deliberately NOT checked by key name here:
      // device_hardware/device_warranty legitimately export their OWN
      // serial_number column, so the bare key name collides across tables —
      // the sentinel-value loop below is what proves the mTLS serial itself
      // never leaks.
      'provider_certificate_id',
      'fingerprint_sha256',
      'public_key_spki',
      'last_revoke_error',
      'next_revoke_attempt_at',
    ]) {
      expect(serializedZip).not.toContain(prohibitedKey);
    }
    for (const sentinel of prohibitedSentinels) {
      expect(serializedZip).not.toContain(sentinel);
    }
  });

  it('cascade erases the target org and leaves the other org intact', async () => {
    const db = getTestDb();
    const { orgA, orgB } = await seedTwoOrgs();

    // Sanity: both orgs populated before erasure.
    expect(await rowCount(db, 'sites', orgA)).toBe(2);
    expect(await rowCount(db, 'sites', orgB)).toBe(1);
    expect(await rowCount(db, 'device_mtls_certificates', orgA)).toBe(1);

    const stats = await cascadeDeleteOrg(orgA, PERFORMED_BY, PERFORMED_EMAIL);

    // Target org fully wiped.
    expect(await rowCount(db, 'sites', orgA)).toBe(0);
    expect(await rowCount(db, 'device_groups', orgA)).toBe(0);
    expect(await rowCount(db, 'device_mtls_certificates', orgA)).toBe(0);
    const orgARows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM organizations WHERE id = ${orgA}`,
    )) as unknown as Array<{ n: number }>;
    expect(orgARows[0]?.n).toBe(0);

    // Cross-tenant rows untouched.
    expect(await rowCount(db, 'sites', orgB)).toBe(1);
    expect(await rowCount(db, 'device_groups', orgB)).toBe(1);
    const orgBRows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM organizations WHERE id = ${orgB}`,
    )) as unknown as Array<{ n: number }>;
    expect(orgBRows[0]?.n).toBe(1);

    // Stats account for at least the 7 rows we seeded into org A (the
    // original 5 plus the device + device_mtls_certificates row added for
    // Wave 5 Task 2).
    expect(stats.totalRowsDeleted).toBeGreaterThanOrEqual(7);
    expect(stats.tablesDeleted['sites']).toBe(2);
    expect(stats.tablesDeleted['device_groups']).toBe(2);
    expect(stats.tablesDeleted['organizations']).toBe(1);
    // device_mtls_certificates is deleted explicitly (via its cascade-list
    // registration), not merely as a side effect of the devices row's
    // ON DELETE CASCADE — proves the table is genuinely wired into the walk.
    expect(stats.tablesDeleted['device_mtls_certificates']).toBe(1);
    expect(stats.tablesDeleted['devices']).toBe(1);
  });
});

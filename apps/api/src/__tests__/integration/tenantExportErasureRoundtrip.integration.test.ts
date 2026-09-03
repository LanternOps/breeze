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
  groupId: string;
  groupName: string;
  quoteId: string;
  siteId: string;
  siteName: string;
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
    INSERT INTO organizations (id, partner_id, name, slug, currency_code) VALUES
      (${orgA}, ${partnerId}, ${'Org A ' + suffix}, ${'org-a-' + suffix}, 'USD'),
      (${orgB}, ${partnerId}, ${'Org B ' + suffix}, ${'org-b-' + suffix}, 'USD')
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

  // Base rows: Org A has 2 sites + 2 device_groups; Org B has 1 of each.
  const siteA1 = crypto.randomUUID();
  const siteA1Name = 'A-Site-1';
  await db.execute(sql`
    INSERT INTO sites (id, org_id, name) VALUES
      (${siteA1}, ${orgA}, ${siteA1Name}),
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

  await db.execute(sql`
    INSERT INTO portal_branding (
      org_id,
      enable_dashboard,
      enable_security,
      enable_backups,
      enable_reports,
      enable_support_usage
    ) VALUES
      (${orgA}, true, true, false, true, false),
      (${orgB}, false, false, true, false, true)
  `);

  // #3205: a per_device_role allowance line, so contract_lines.json is
  // exercised with the text[] and all three allowance columns populated.
  const contractId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO contracts (id, partner_id, org_id, name, interval_months, start_date, currency_code)
    VALUES (${contractId}, ${partnerId}, ${orgA}, ${'Roundtrip contract ' + suffix}, 1, '2026-07-01', 'USD')
  `);
  await db.execute(sql`
    INSERT INTO contract_lines (
      contract_id, org_id, line_type, description, unit_price, taxable, device_roles,
      included_quantity, overage_mode, overage_unit_price
    ) VALUES (
      ${contractId}, ${orgA}, 'per_device_role', 'Network gear', 25.00, false,
      ARRAY['switch','router','firewall']::text[], 25.00, 'bill', 12.00
    )
  `);

  // #3205 W02: a per_device_group line, so contract_lines.json carries
  // device_group_id + device_group_name and erasure has to remove the line,
  // the group and the contract in FK order.
  const groupId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO device_groups (id, org_id, name, type) VALUES (${groupId}, ${orgA}, ${'Roundtrip group ' + suffix}, 'static')
  `);
  await db.execute(sql`
    INSERT INTO contract_lines (contract_id, org_id, line_type, description, unit_price, taxable, device_group_id, device_group_name)
    VALUES (${contractId}, ${orgA}, 'per_device_group', 'VIP', 40.00, false, ${groupId}, ${'Roundtrip group ' + suffix})
  `);

  // #3205 W05: quote_lines exports the complete device-set descriptor. Group
  // and site/role selectors are mutually exclusive under the CHECK, so the
  // group line carries the bill allowance and a companion line exercises the
  // site + device_roles stamps.
  const quoteId = crypto.randomUUID();
  const quoteBlockId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO quotes (id, partner_id, org_id, currency_code)
    VALUES (${quoteId}, ${partnerId}, ${orgA}, 'USD')
  `);
  await db.execute(sql`
    INSERT INTO quote_blocks (id, quote_id, org_id, block_type, content)
    VALUES (${quoteBlockId}, ${quoteId}, ${orgA}, 'line_items', '{}'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO quote_lines (
      quote_id, block_id, org_id, source_type, name, quantity, unit_price,
      taxable, recurrence, contract_line_type, device_group_id,
      device_group_name, included_quantity, overage_mode, overage_unit_price
    ) VALUES (
      ${quoteId}, ${quoteBlockId}, ${orgA}, 'manual', 'Quoted VIP endpoints',
      3.00, 40.00, false, 'monthly', 'per_device_group', ${groupId},
      ${'Roundtrip group ' + suffix}, 25.00, 'bill', 12.00
    )
  `);
  await db.execute(sql`
    INSERT INTO quote_lines (
      quote_id, block_id, org_id, source_type, name, quantity, unit_price,
      taxable, recurrence, contract_line_type, device_roles, site_id, site_name
    ) VALUES (
      ${quoteId}, ${quoteBlockId}, ${orgA}, 'manual', 'Quoted site network gear',
      3.00, 25.00, false, 'monthly', 'per_device_role',
      ARRAY['switch','router','firewall']::text[], ${siteA1}, ${siteA1Name}
    )
  `);
  // #3205 W07: one billed-device evidence row plus its claimed-period outcome.
  // The export must retain the scalar evidence while deliberately omitting the
  // outcome's two open jsonb containers; erasure must remove both rows.
  const invoiceId = crypto.randomUUID();
  const invoiceLineId = crypto.randomUUID();
  const billingPeriodId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO invoices (id, partner_id, org_id, status, currency_code, device_appendix, evidence_version)
    VALUES (${invoiceId}, ${partnerId}, ${orgA}, 'draft', 'USD', true, 1)
  `);
  await db.execute(sql`
    INSERT INTO invoice_lines (
      id, invoice_id, org_id, source_type, source_contract_id, description,
      quantity, unit_price, line_total
    ) VALUES (
      ${invoiceLineId}, ${invoiceId}, ${orgA}, 'contract', ${contractId},
      'Endpoints', 1.00, 10.00, 10.00
    )
  `);
  await db.execute(sql`
    INSERT INTO invoice_line_devices (
      invoice_line_id, invoice_id, org_id, device_id, hostname, device_role,
      site_id, counted_as
    ) VALUES (
      ${invoiceLineId}, ${invoiceId}, ${orgA}, ${deviceId}, 'roundtrip-01',
      'server', ${siteA1}, 'included'
    )
  `);
  await db.execute(sql`
    INSERT INTO contract_billing_periods (
      id, contract_id, org_id, period_start, period_end, invoice_id
    ) VALUES (
      ${billingPeriodId}, ${contractId}, ${orgA}, '2026-07-01', '2026-07-31', ${invoiceId}
    )
  `);
  await db.execute(sql`
    INSERT INTO contract_billing_period_outcomes (
      contract_billing_period_id, org_id, contract_id, invoice_id,
      snapshot_device_total, uncovered_total, flagged_total, billed_overage_total,
      uncovered_by_role, overages
    ) VALUES (
      ${billingPeriodId}, ${orgA}, ${contractId}, ${invoiceId},
      3, 2, 0, 0, '{"server":2}'::jsonb, '[]'::jsonb
    )
  `);

  return {
    partnerId,
    orgA,
    orgB,
    groupId,
    groupName: 'Roundtrip group ' + suffix,
    quoteId,
    siteId: siteA1,
    siteName: siteA1Name,
    prohibitedSentinels,
  };
}

function rowCount(db: ReturnType<typeof getTestDb>, table: string, orgId: string) {
  return db
    .execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${table}"`)} WHERE org_id = ${orgId}`)
    .then((r) => (r as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

async function archiveTable(archive: JSZip, table: string): Promise<Array<Record<string, unknown>>> {
  const entry = archive.file(`${table}.json`);
  expect(entry, `${table}.json must be present in the tenant archive`).toBeTruthy();
  return JSON.parse(await entry!.async('string')) as Array<Record<string, unknown>>;
}

describe('tenant export + erasure round-trip (live DB)', () => {
  beforeEach(async () => {
    // cleanupDatabase() in setup.ts already TRUNCATEs sites/device_groups/
    // organizations/partners before each test.
  });

  it('export manifest reflects only the target org rows', async () => {
    const { orgA, groupId, groupName, quoteId, siteId, siteName, prohibitedSentinels } = await seedTwoOrgs();

    const { manifest, zipBuffer } = await buildOrgExportZip(orgA, PERFORMED_BY, PERFORMED_EMAIL);

    // It's a real, non-empty ZIP (local-file-header magic "PK\x03\x04").
    expect(zipBuffer.length).toBeGreaterThan(0);
    expect(zipBuffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const byName = new Map(manifest.files.map((f) => [f.name, f]));
    // Org A has exactly 2 sites + 3 device_groups; Org B's rows must not leak.
    expect(byName.get('sites.json')?.rowCount).toBe(2);
    expect(byName.get('contracts.json')?.rowCount).toBe(1);
    expect(byName.get('contract_lines.json')?.rowCount).toBe(2);
    expect(byName.get('device_groups.json')?.rowCount).toBe(3);
    expect(byName.get('quotes.json')?.rowCount).toBe(1);
    expect(byName.get('quote_lines.json')?.rowCount).toBe(2);
    // organizations.json is the org's own id-keyed row.
    expect(byName.get('organizations.json')?.rowCount).toBe(1);
    // device_mtls_certificates.json carries the one certificate history row.
    expect(byName.get('device_mtls_certificates.json')?.rowCount).toBe(1);
    // portal_branding.json carries the one portal-visibility-flags row.
    expect(byName.get('portal_branding.json')?.rowCount).toBe(1);
    // Every manifest entry carries a sha256.
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest.orgId).toBe(orgA);

    const archive = await JSZip.loadAsync(zipBuffer);
    const portalBrandingRows = JSON.parse(
      await archive.file('portal_branding.json')!.async('string'),
    ) as Array<Record<string, unknown>>;
    expect(portalBrandingRows).toEqual([
      expect.objectContaining({
        org_id: orgA,
        enable_dashboard: true,
        enable_security: true,
        enable_backups: false,
        enable_reports: true,
        enable_support_usage: false,
      }),
    ]);

    const contractLines = JSON.parse(
      await archive.file('contract_lines.json')!.async('string'),
    ) as Array<Record<string, unknown>>;
    const allowanceLine = contractLines.find((line) => line.description === 'Network gear');
    expect(allowanceLine).toMatchObject({
      included_quantity: '25.00',
      overage_mode: 'bill',
      overage_unit_price: '12.00',
    });
    const groupLine = contractLines.find((line) => line.device_group_id === groupId);
    expect(groupLine?.device_group_id).toBe(groupId);
    expect(groupLine?.device_group_name).toBe(groupName);

    const quoteLines = JSON.parse(
      await archive.file('quote_lines.json')!.async('string'),
    ) as Array<Record<string, unknown>>;
    const quotedGroupLine = quoteLines.find((line) => line.name === 'Quoted VIP endpoints');
    expect(quotedGroupLine).toMatchObject({
      quote_id: quoteId,
      contract_line_type: 'per_device_group',
      device_roles: null,
      device_group_id: groupId,
      device_group_name: groupName,
      site_id: null,
      site_name: null,
      included_quantity: '25.00',
      overage_mode: 'bill',
      overage_unit_price: '12.00',
    });
    const quotedSiteLine = quoteLines.find((line) => line.name === 'Quoted site network gear');
    expect(quotedSiteLine).toMatchObject({
      contract_line_type: 'per_device_role',
      device_roles: ['switch', 'router', 'firewall'],
      device_group_id: null,
      device_group_name: null,
      site_id: siteId,
      site_name: siteName,
      included_quantity: null,
      overage_mode: null,
      overage_unit_price: null,
    });
    // #3205 W07: evidence is ordinary exported customer data...
    const evidence = await archiveTable(archive, 'invoice_line_devices');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ hostname: 'roundtrip-01', device_role: 'server', counted_as: 'included' });
    // ...but the outcome row's jsonb digests are DELIBERATELY absent (decision 3).
    const outcome = await archiveTable(archive, 'contract_billing_period_outcomes');
    expect(outcome).toHaveLength(1);
    expect(outcome[0]).toMatchObject({ uncovered_total: 2, flagged_total: 0, billed_overage_total: 0, snapshot_device_total: 3 });
    expect(outcome[0]).not.toHaveProperty('uncovered_by_role');
    expect(outcome[0]).not.toHaveProperty('overages');

    const serializedZip = await Promise.all(
      Object.values(archive.files).map((entry) => entry.async('string')),
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
    expect(await rowCount(db, 'portal_branding', orgA)).toBe(1);
    expect(await rowCount(db, 'portal_branding', orgB)).toBe(1);
    expect(await rowCount(db, 'quotes', orgA)).toBe(1);
    expect(await rowCount(db, 'quote_lines', orgA)).toBe(2);
    expect(await rowCount(db, 'invoice_line_devices', orgA)).toBe(1);
    expect(await rowCount(db, 'contract_billing_period_outcomes', orgA)).toBe(1);

    const stats = await cascadeDeleteOrg(orgA, PERFORMED_BY, PERFORMED_EMAIL);

    // Target org fully wiped.
    expect(await rowCount(db, 'sites', orgA)).toBe(0);
    expect(await rowCount(db, 'device_groups', orgA)).toBe(0);
    expect(await rowCount(db, 'contracts', orgA)).toBe(0);
    expect(await rowCount(db, 'contract_lines', orgA)).toBe(0);
    expect(await rowCount(db, 'quotes', orgA)).toBe(0);
    expect(await rowCount(db, 'quote_lines', orgA)).toBe(0);
    expect(await rowCount(db, 'device_mtls_certificates', orgA)).toBe(0);
    expect(await rowCount(db, 'portal_branding', orgA)).toBe(0);
    expect(await rowCount(db, 'invoice_line_devices', orgA)).toBe(0);
    expect(await rowCount(db, 'contract_billing_period_outcomes', orgA)).toBe(0);
    expect(await rowCount(db, 'portal_branding', orgB)).toBe(1);
    expect(stats.tablesDeleted.portal_branding).toBe(1);
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

    // Stats account for at least the 10 rows we seeded into org A (the
    // original 5 plus the device + device_mtls_certificates row added for
    // Wave 5 Task 2, the device group + contract line added for #3205 W02,
    // and the portal_branding row added for the portal visibility flags).
    expect(stats.totalRowsDeleted).toBeGreaterThanOrEqual(10);
    expect(stats.tablesDeleted['sites']).toBe(2);
    expect(stats.tablesDeleted['device_groups']).toBe(3);
    expect(stats.tablesDeleted['contracts']).toBeGreaterThanOrEqual(1);
    expect(stats.tablesDeleted['contract_lines']).toBeGreaterThanOrEqual(2);
    expect(stats.tablesDeleted['quotes']).toBe(1);
    expect(stats.tablesDeleted['quote_lines']).toBe(2);
    expect(stats.tablesDeleted['invoice_line_devices']).toBe(1);
    expect(stats.tablesDeleted['contract_billing_period_outcomes']).toBe(1);
    expect(stats.tablesDeleted['organizations']).toBe(1);
    // device_mtls_certificates is deleted explicitly (via its cascade-list
    // registration), not merely as a side effect of the devices row's
    // ON DELETE CASCADE — proves the table is genuinely wired into the walk.
    expect(stats.tablesDeleted['device_mtls_certificates']).toBe(1);
    expect(stats.tablesDeleted['devices']).toBe(1);
  });
});

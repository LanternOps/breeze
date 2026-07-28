/**
 * Real-driver cross-tenant forge test for device_mtls_certificates (security
 * remediation Wave 5, Task 1).
 *
 * device_mtls_certificates is a direct org-axis table (Shape 1: org_id + the
 * four breeze_has_org_access policies), modeled on
 * deviceRecoveryKeys-rls.integration.test.ts / deviceLinkGroupsRls.integration.test.ts.
 * The composite FK (device_id, org_id) -> devices(id, org_id) additionally
 * pins every certificate row to the SAME org as its device.
 *
 * This proves, as the unprivileged breeze_app role:
 *   1. same-org insert/select/update/delete are all permitted, and
 *   2. a forged cross-org insert (device_id, org_id belonging to org A, under
 *      an org-B context) is rejected by RLS (42501), and
 *   3. org B cannot SELECT org A's certificate rows.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { deviceMtlsCertificates, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });

    const [deviceA] = await db
      .insert(devices)
      .values({
        orgId: orgA.id,
        siteId: siteA.id,
        agentId: `mtls-rls-agent-${unique}`,
        hostname: `mtls-rls-host-${unique}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'offline',
      })
      .returning({ id: devices.id });
    if (!deviceA) throw new Error('failed to seed device');

    return { partner, orgA, orgB, deviceA, unique };
  });
}

describe('device_mtls_certificates RLS (breeze_app)', () => {
  runDb('allows same-org insert, select, update, and delete', async () => {
    const { orgA, deviceA, unique } = await seed();

    const inserted = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db
        .insert(deviceMtlsCertificates)
        .values({
          orgId: orgA.id,
          deviceId: deviceA.id,
          providerCertificateId: `prov-${unique}`,
          serialNumber: `serial-${unique}`,
          fingerprintSha256: 'a'.repeat(64),
          legacyProvenance: false,
          state: 'active',
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          activatedAt: new Date(),
        })
        .returning({ id: deviceMtlsCertificates.id, orgId: deviceMtlsCertificates.orgId });
      return row;
    });
    expect(inserted?.orgId).toBe(orgA.id);

    const selected = await withDbAccessContext(orgCtx(orgA.id), () =>
      db.select({ id: deviceMtlsCertificates.id })
        .from(deviceMtlsCertificates)
        .where(eq(deviceMtlsCertificates.id, inserted!.id)),
    );
    expect(selected).toHaveLength(1);

    const updated = await withDbAccessContext(orgCtx(orgA.id), () =>
      db.update(deviceMtlsCertificates)
        .set({ state: 'pending_revocation' })
        .where(eq(deviceMtlsCertificates.id, inserted!.id))
        .returning({ state: deviceMtlsCertificates.state }),
    );
    expect(updated[0]?.state).toBe('pending_revocation');

    const deleted = await withDbAccessContext(orgCtx(orgA.id), () =>
      db.delete(deviceMtlsCertificates)
        .where(eq(deviceMtlsCertificates.id, inserted!.id))
        .returning({ id: deviceMtlsCertificates.id }),
    );
    expect(deleted).toHaveLength(1);
  });

  runDb('rejects a forged cross-org insert and hides org A rows from org B', async () => {
    const { orgA, orgB, deviceA, unique } = await seed();

    const inserted = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db
        .insert(deviceMtlsCertificates)
        .values({
          orgId: orgA.id,
          deviceId: deviceA.id,
          providerCertificateId: `prov-visible-${unique}`,
          serialNumber: `serial-visible-${unique}`,
          fingerprintSha256: 'b'.repeat(64),
          legacyProvenance: false,
          state: 'active',
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          activatedAt: new Date(),
        })
        .returning({ id: deviceMtlsCertificates.id });
      return row;
    });
    if (!inserted) throw new Error('failed to seed certificate row');

    // Cross-tenant forge: org B context inserting a row claiming org A + org
    // A's device must fail. The try/catch MUST wrap the withDbAccessContext
    // call itself, not sit inside its callback — Postgres aborts the whole
    // transaction the instant one statement fails, so postgres.js's
    // client.begin() wrapper rejects the outer transaction promise on commit
    // regardless of whether the callback locally swallowed the error (no
    // savepoint used here). See deviceRecoveryKeys-rls.integration.test.ts.
    let caught: unknown;
    try {
      await withDbAccessContext(orgCtx(orgB.id), () =>
        db.insert(deviceMtlsCertificates).values({
          orgId: orgA.id,
          deviceId: deviceA.id,
          providerCertificateId: `prov-forged-${unique}`,
          serialNumber: `serial-forged-${unique}`,
          fingerprintSha256: 'c'.repeat(64),
          legacyProvenance: false,
          state: 'active',
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          activatedAt: new Date(),
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'cross-org insert must be rejected by RLS').toBeDefined();
    const cause = (caught as { cause?: { message?: string; code?: string } } | undefined)?.cause;
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "device_mtls_certificates"/,
    );

    // Org B cannot read org A's certificate row.
    const visibleToB = await withDbAccessContext(orgCtx(orgB.id), () =>
      db.select({ id: deviceMtlsCertificates.id })
        .from(deviceMtlsCertificates)
        .where(eq(deviceMtlsCertificates.id, inserted.id)),
    );
    expect(visibleToB).toHaveLength(0);
  });

  runDb('composite FK forbids a mismatched (device_id, org_id) tuple even under system context', async () => {
    const { orgB, deviceA, unique } = await seed();

    // The RLS forge test above proves the WRITE POLICY rejects org B claiming
    // org A's (device, org) tuple — but that tuple was still internally
    // consistent (deviceA really does belong to orgA), so it never exercises
    // the composite FK itself. This proves the FK independently: under
    // withSystemDbAccessContext (RLS bypassed, mirroring
    // deviceLinkGroupsRls.integration.test.ts's "composite FK forbids linking
    // a device to a group in another org" case), attempt to insert a row
    // where device_id belongs to org A but org_id names org B — a genuinely
    // mismatched tuple with no (device_id, org_id) match in devices at all.
    // Only devices_id_org_id_uniq + this table's FK stand between that insert
    // and a written row; RLS plays no part since we're in system context.
    let caught: unknown;
    try {
      await withSystemDbAccessContext(() =>
        db.insert(deviceMtlsCertificates).values({
          orgId: orgB.id,
          deviceId: deviceA.id, // deviceA belongs to orgA, not orgB
          providerCertificateId: `prov-mismatched-${unique}`,
          serialNumber: `serial-mismatched-${unique}`,
          fingerprintSha256: 'd'.repeat(64),
          legacyProvenance: false,
          state: 'active',
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          activatedAt: new Date(),
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'mismatched (device_id, org_id) tuple must be rejected by the composite FK').toBeDefined();
    // This FK is DEFERRABLE INITIALLY DEFERRED (2026-08-06-d-device-mtls-certificate-history.sql,
    // added so POST /devices/:id/move-org can flip devices.org_id — see the
    // schema module doc), so the violation is raised at COMMIT of the
    // wrapping withSystemDbAccessContext transaction, not at the INSERT
    // statement itself. That changes the thrown error's SHAPE: an
    // immediate (non-deferred) constraint failure comes back as Drizzle's
    // `DrizzleQueryError` wrapping the raw driver error in `.cause`, but a
    // deferred failure surfacing at COMMIT is the raw `postgres` driver
    // `PostgresError` itself (no Drizzle wrapper, so no `.cause`) — assert
    // against whichever shape is present rather than assuming `.cause`.
    const raw = caught as { cause?: { code?: string; message?: string }; code?: string; message?: string } | undefined;
    const code = raw?.cause?.code ?? raw?.code;
    const message = raw?.cause?.message ?? raw?.message;
    expect(code).toBe('23503'); // foreign_key_violation
    expect(message).toMatch(/device_mtls_certificates_device_org_fkey/);
  });
});

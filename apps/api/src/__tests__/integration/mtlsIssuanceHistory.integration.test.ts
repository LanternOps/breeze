/**
 * #7431 / #7432 — every mTLS certificate Breeze issues outside the renewal
 * route (enrollment, admin provisioning, quarantine approve) must land in
 * `device_mtls_certificates` as the device's ACTIVE row, in the same
 * transaction as the legacy `devices.mtls_cert_*` columns, superseding (and
 * revoking) whatever was active before.
 *
 * Before the fix, `issueMtlsCertForDevice` wrote only the legacy columns:
 *  - #7431: a device enrolled after the history migration had no history row,
 *    so `/renew-cert` in `enforce` mode refused it with 403
 *    `renewal_proof_missing` — even for the proactive renewal of a valid cert.
 *  - #7432: a device that already had an active history row kept the OLD
 *    serial active after quarantine approve, so the binding check denied the
 *    new certificate with `serial_mismatch`, and the old Cloudflare cert was
 *    never revoked.
 *
 * Real Postgres (as `breeze_app`, so RLS applies) and the real route; only the
 * Cloudflare provider is faked, issuing genuine self-signed leaf PEMs so the
 * SPKI/fingerprint parse runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/clientIp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/clientIp')>()),
  // Pretend the request came through the trusted edge so the client-cert
  // assertion headers are honored (the production trust gate is the edge
  // proxy's address; there is no edge in this test).
  trustsForwardedHeadersFrom: () => true,
}));

import './setup';
import 'reflect-metadata';
import { Hono } from 'hono';
import { createHash, randomBytes, randomUUID, webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { deviceMtlsCertificates, devices } from '../../db/schema';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';
import { CloudflareMtlsService, type CfCertResult } from '../../services/cloudflareMtls';
import { enforceAgentCertificateBinding } from '../../services/agentCertificateBinding';
import { issueMtlsCertForDevice } from '../../routes/agents/helpers';
import { agentRoutes } from '../../routes/agents/index';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MOUNT = '/api/v1/agents';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const EC_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

interface MintedLeaf {
  pem: string;
  /** Canonical form: what `X509Certificate.serialNumber` renders. */
  serial: string;
  spkiBase64: string;
}

async function mintLeaf(): Promise<MintedLeaf> {
  const keys = await webcrypto.subtle.generateKey(EC_ALG as never, true, ['sign', 'verify']) as CryptoKeyPair;
  // First byte 0x10–0x7f: positive, and no leading zero byte for the DER
  // INTEGER to drop, so the canonical serial is exactly this hex.
  const serialBytes = randomBytes(16);
  serialBytes[0] = 0x10 + (serialBytes[0]! % 0x70);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialBytes.toString('hex'),
    name: 'CN=breeze-agent-test',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 90 * 24 * 3_600_000),
    signingAlgorithm: EC_ALG as never,
    keys,
  });
  const pem = cert.toString('pem');
  const parsed = new X509Certificate(pem);
  return {
    pem,
    serial: parsed.serialNumber,
    spkiBase64: parsed.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** Cloudflare renders serials its own way; colon-separated lowercase exercises normalization. */
function cloudflareStyleSerial(canonical: string): string {
  return canonical.toLowerCase().match(/.{2}/g)!.join(':');
}

const provider = {
  issued: [] as Array<CfCertResult & { canonicalSerial: string; spkiBase64: string }>,
  revoked: [] as string[],
  nextCertificate: null as null | (() => Promise<CfCertResult>),
};

const fakeCloudflare = {
  issueCertificate: vi.fn(async (validityDays: number): Promise<CfCertResult> => {
    if (provider.nextCertificate) {
      const next = provider.nextCertificate;
      provider.nextCertificate = null;
      return next();
    }
    const leaf = await mintLeaf();
    const now = Date.now();
    const result = {
      id: `cf-${randomUUID()}`,
      certificate: leaf.pem,
      privateKey: 'test-private-key-material',
      serialNumber: cloudflareStyleSerial(leaf.serial),
      issuedOn: new Date(now).toISOString(),
      expiresOn: new Date(now + validityDays * 24 * 3_600_000).toISOString(),
    };
    provider.issued.push({ ...result, canonicalSerial: leaf.serial, spkiBase64: leaf.spkiBase64 });
    return result;
  }),
  revokeCertificate: vi.fn(async (certificateId: string) => {
    provider.revoked.push(certificateId);
    return 'revoked' as const;
  }),
};

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

interface SeededDevice {
  orgId: string;
  deviceId: string;
  agentToken: string;
}

async function seedDevice(
  legacy?: { cfId: string; serial: string; issuedAt: Date; expiresAt: Date },
): Promise<SeededDevice> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const suffix = randomUUID().slice(0, 8);
  const agentToken = `brz_mtls_issuance_${suffix}`;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `mtls-issuance-${suffix}`,
      hostname: `mtls-issuance-${suffix}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      agentTokenHash: digest(agentToken),
      tokenIssuedAt: new Date(),
      ...(legacy
        ? {
            mtlsCertCfId: legacy.cfId,
            mtlsCertSerialNumber: legacy.serial,
            mtlsCertIssuedAt: legacy.issuedAt,
            mtlsCertExpiresAt: legacy.expiresAt,
          }
        : {}),
    })
    .returning({ id: devices.id });
  return { orgId: org.id, deviceId: row!.id, agentToken };
}

async function historyFor(deviceId: string) {
  return getTestDb()
    .select()
    .from(deviceMtlsCertificates)
    .where(eq(deviceMtlsCertificates.deviceId, deviceId));
}

async function legacyColumnsFor(deviceId: string) {
  const [row] = await getTestDb()
    .select({
      serial: devices.mtlsCertSerialNumber,
      cfId: devices.mtlsCertCfId,
      expiresAt: devices.mtlsCertExpiresAt,
    })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return row!;
}

async function renew(deviceAgentToken: string, assertedSerial: string): Promise<Response> {
  const app = new Hono();
  app.route(MOUNT, agentRoutes);
  return await app.request(`${MOUNT}/renew-cert`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${deviceAgentToken}`,
      'X-Breeze-Client-Cert-Verified': 'true',
      'X-Breeze-Client-Cert-Serial': assertedSerial,
    },
  });
}

const originalBindingMode = process.env.AGENT_MTLS_BINDING_MODE;

beforeEach(() => {
  provider.issued.length = 0;
  provider.revoked.length = 0;
  provider.nextCertificate = null;
  fakeCloudflare.issueCertificate.mockClear();
  fakeCloudflare.revokeCertificate.mockClear();
  vi.spyOn(CloudflareMtlsService, 'fromEnv').mockReturnValue(fakeCloudflare as unknown as CloudflareMtlsService);
  process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalBindingMode === undefined) delete process.env.AGENT_MTLS_BINDING_MODE;
  else process.env.AGENT_MTLS_BINDING_MODE = originalBindingMode;
});

describe('#7431 — issuance writes the active certificate-history row', () => {
  runDb('enrollment-shaped issuance (system context) records an active row with SPKI + fingerprint, then enforce-mode renewal succeeds', async () => {
    const seeded = await seedDevice();

    // Enrollment calls issuance inside its own open system-scoped transaction.
    const issued = await withSystemDbAccessContext(() => issueMtlsCertForDevice(seeded.deviceId, seeded.orgId));
    expect(issued).not.toBeNull();
    const first = provider.issued[0]!;

    const rows = await historyFor(seeded.deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: seeded.orgId,
      providerCertificateId: first.id,
      serialNumber: first.canonicalSerial,
      publicKeySpki: first.spkiBase64,
      legacyProvenance: false,
      state: 'active',
    });
    expect(rows[0]!.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.activatedAt).not.toBeNull();

    // The legacy columns name the same certificate.
    const legacy = await legacyColumnsFor(seeded.deviceId);
    expect(legacy.cfId).toBe(first.id);
    expect(legacy.serial).toBe(first.canonicalSerial);

    // The regression the issue describes: proactive renewal of a still-valid
    // certificate in enforce mode, presenting that certificate at the edge.
    const res = await renew(seeded.agentToken, first.canonicalSerial);
    expect(res.status, await res.clone().text()).toBe(200);
    const second = provider.issued[1]!;
    expect(((await res.json()) as { mtls: { serialNumber: string } }).mtls.serialNumber).toBe(second.serialNumber);

    const after = await historyFor(seeded.deviceId);
    expect(after.find((r) => r.state === 'active')?.providerCertificateId).toBe(second.id);
    expect(after.find((r) => r.providerCertificateId === first.id)?.state).toBe('revoked');
    expect(provider.revoked).toEqual([first.id]);
  });

  runDb('a parse failure on the issued certificate returns null and revokes the provider cert — no row, legacy columns untouched', async () => {
    const seeded = await seedDevice();
    provider.nextCertificate = async () => ({
      id: `cf-unparseable-${randomUUID()}`,
      certificate: '-----BEGIN CERTIFICATE-----\nbm90LWEtcmVhbC1jZXJ0\n-----END CERTIFICATE-----',
      privateKey: 'k',
      serialNumber: '01',
      issuedOn: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const issued = await withSystemDbAccessContext(() => issueMtlsCertForDevice(seeded.deviceId, seeded.orgId));

    expect(issued).toBeNull();
    expect(await historyFor(seeded.deviceId)).toHaveLength(0);
    expect((await legacyColumnsFor(seeded.deviceId)).cfId).toBeNull();
    expect(provider.revoked).toHaveLength(1);
    expect(provider.revoked[0]).toMatch(/^cf-unparseable-/);
  });

  runDb('a history write that cannot commit returns null, keeps the enclosing transaction usable, and revokes the provider cert', async () => {
    const seeded = await seedDevice();
    const clashingProviderId = `cf-clash-${randomUUID()}`;
    // A row already holds the provider id the next issuance returns, so the
    // history insert violates device_mtls_certificates_provider_uq.
    await getTestDb().insert(deviceMtlsCertificates).values({
      orgId: seeded.orgId,
      deviceId: seeded.deviceId,
      providerCertificateId: clashingProviderId,
      serialNumber: `CLASH${randomUUID().replace(/-/g, '').toUpperCase()}`,
      fingerprintSha256: 'c'.repeat(64),
      legacyProvenance: false,
      state: 'revoked',
      issuedAt: new Date(Date.now() - 86_400_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: new Date(),
    });
    provider.nextCertificate = async () => {
      const leaf = await mintLeaf();
      return {
        id: clashingProviderId,
        certificate: leaf.pem,
        privateKey: 'k',
        serialNumber: leaf.serial,
        issuedOn: new Date().toISOString(),
        expiresOn: new Date(Date.now() + 86_400_000).toISOString(),
      };
    };

    // The enclosing transaction must survive the failed write: enrollment
    // keeps working in it after issuance returns.
    const followUp = await withSystemDbAccessContext(async () => {
      const issued = await issueMtlsCertForDevice(seeded.deviceId, seeded.orgId);
      const [stillUsable] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(eq(devices.id, seeded.deviceId));
      return { issued, stillUsable };
    });

    expect(followUp.issued).toBeNull();
    expect(followUp.stillUsable?.id).toBe(seeded.deviceId);
    expect((await historyFor(seeded.deviceId)).filter((r) => r.state === 'active')).toHaveLength(0);
    expect((await legacyColumnsFor(seeded.deviceId)).cfId).toBeNull();
    await vi.waitFor(() => expect(provider.revoked).toEqual([clashingProviderId]));
  });
});

describe('#7432 — re-issuance supersedes and revokes the previous active row', () => {
  runDb('approve-shaped re-issuance (org-scoped context) demotes the old active row, revokes its provider cert, and binds the new serial', async () => {
    const oldProviderId = `cf-old-${randomUUID()}`;
    const oldSerial = `0A${randomUUID().replace(/-/g, '').toUpperCase()}`;
    const issuedAt = new Date(Date.now() - 100 * 24 * 3_600_000);
    const expiredAt = new Date(Date.now() - 10 * 24 * 3_600_000);
    const seeded = await seedDevice({ cfId: oldProviderId, serial: oldSerial, issuedAt, expiresAt: expiredAt });
    // What the history migration's one-time import left for this device.
    const [oldRow] = await getTestDb().insert(deviceMtlsCertificates).values({
      orgId: seeded.orgId,
      deviceId: seeded.deviceId,
      providerCertificateId: oldProviderId,
      serialNumber: oldSerial,
      legacyProvenance: true,
      state: 'active',
      issuedAt,
      expiresAt: expiredAt,
      activatedAt: issuedAt,
    }).returning({ id: deviceMtlsCertificates.id });

    // The approve route runs issuance inside the admin's request context.
    const issued = await withDbAccessContext(orgContext(seeded.orgId), () =>
      issueMtlsCertForDevice(seeded.deviceId, seeded.orgId),
    );
    expect(issued).not.toBeNull();
    const fresh = provider.issued[0]!;

    const rows = await historyFor(seeded.deviceId);
    const active = rows.filter((r) => r.state === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ providerCertificateId: fresh.id, serialNumber: fresh.canonicalSerial });

    // The old certificate is revoked at the provider once the request's
    // transaction has committed.
    await vi.waitFor(() => expect(provider.revoked).toEqual([oldProviderId]));
    await vi.waitFor(async () => {
      const [old] = await getTestDb()
        .select({ state: deviceMtlsCertificates.state, revokedAt: deviceMtlsCertificates.revokedAt })
        .from(deviceMtlsCertificates)
        .where(eq(deviceMtlsCertificates.id, oldRow!.id));
      expect(old?.state).toBe('revoked');
      expect(old?.revokedAt).not.toBeNull();
    });

    // Enforce-mode binding accepts the new certificate and refuses the old one.
    const assertion = (serial: string) => ({ assertionTrusted: true, assertedVerified: true, assertedSerial: serial });
    await expect(enforceAgentCertificateBinding({
      deviceId: seeded.deviceId, assertion: assertion(fresh.canonicalSerial), pathClass: 'rest',
    })).resolves.toEqual({ allowed: true, reason: 'matched' });
    await expect(enforceAgentCertificateBinding({
      deviceId: seeded.deviceId, assertion: assertion(oldSerial), pathClass: 'rest',
    })).resolves.toEqual({ allowed: false, reason: 'serial_mismatch' });

    expect((await legacyColumnsFor(seeded.deviceId)).serial).toBe(fresh.canonicalSerial);
  });

  runDb('an org-scoped context for a DIFFERENT org cannot bind a certificate to the device', async () => {
    const seeded = await seedDevice();
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });

    const issued = await withDbAccessContext(orgContext(otherOrg.id), () =>
      issueMtlsCertForDevice(seeded.deviceId, seeded.orgId),
    );

    expect(issued).toBeNull();
    expect(await historyFor(seeded.deviceId)).toHaveLength(0);
    expect((await legacyColumnsFor(seeded.deviceId)).cfId).toBeNull();
    await vi.waitFor(() => expect(provider.revoked).toEqual([provider.issued[0]!.id]));
  });

  runDb('issuance never creates a second active row for the device', async () => {
    const seeded = await seedDevice();
    await withSystemDbAccessContext(() => issueMtlsCertForDevice(seeded.deviceId, seeded.orgId));
    await withSystemDbAccessContext(() => issueMtlsCertForDevice(seeded.deviceId, seeded.orgId));
    await withSystemDbAccessContext(() => issueMtlsCertForDevice(seeded.deviceId, seeded.orgId));

    const rows = await getTestDb()
      .select({ id: deviceMtlsCertificates.id })
      .from(deviceMtlsCertificates)
      .where(and(eq(deviceMtlsCertificates.deviceId, seeded.deviceId), eq(deviceMtlsCertificates.state, 'active')));
    expect(rows).toHaveLength(1);
    await vi.waitFor(() => expect(provider.revoked).toHaveLength(2));
  });
});

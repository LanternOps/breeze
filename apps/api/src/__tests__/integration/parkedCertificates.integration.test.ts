/**
 * Parked certificates (#8318 wave D-1, spec 2026-10-12 §10.4, §13 decision 9)
 * against real Postgres + Redis, through the real enroll, renewal and
 * heartbeat routes. Only the Cloudflare provider is faked; it issues genuine
 * self-signed leaves so the SPKI/fingerprint parse runs for real.
 *
 * Proven here:
 *   - lifetime: a deploy-key enrollment asks the provider for
 *     min(org policy, whole days left in the parking window), also on an
 *     in-place re-enrollment late in the window;
 *   - renewal: /renew-cert refuses the parked device (403
 *     device_pending_assignment) and issues nothing;
 *   - expiry: the scheduled expiry moves the device's active certificate to
 *     `revoked` (the provider is called after commit);
 *   - key revocation: revoking the deploy key expires the device and revokes
 *     its certificate;
 *   - purge: a removed parked device whose certificate is still live is not
 *     purged until the certificate is revoked; the next run purges it;
 *   - assignment: records the parked certificate's serial, the first full
 *     heartbeat in the customer org signals renewCert, the renewal issues the
 *     org's lifetime, and the next beat signals nothing.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts --maxWorkers 1 \
 *     src/__tests__/integration/parkedCertificates.integration.test.ts
 */
import './setup';
import 'reflect-metadata';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { randomBytes, randomUUID, webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { and, eq, sql } from 'drizzle-orm';

vi.mock('../../services/clientIp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/clientIp')>()),
  getTrustedClientIp: vi.fn(() => '203.0.113.10'),
}));

import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { deviceMtlsCertificates, devices, organizations, partnerDeployKeys, partners, refreshTokenFamilies } from '../../db/schema';
import { CloudflareMtlsService, type CfCertResult } from '../../services/cloudflareMtls';
import { agentRoutes } from '../../routes/agents/index';
import { generateDeployKey, hashDeployKey } from '../../services/deployKeys/keyFormat';
import { revokeDeployKey, type DeployKeyActor } from '../../services/deployKeys/manage';
import { expireParkedDevice, purgeExpiredParkedDevice } from '../../services/unassignedPool/parkedExpiry';
import { assignParkedDevice, type ParkedAssignmentActor } from '../../services/unassignedPool/assignParkedDevice';
import { UNASSIGNED_POOL_ORG_TYPE } from '../../services/unassignedPool/orgType';

const MOUNT = '/api/v1/agents';
const DAY_MS = 86_400_000;
const EC_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

async function mintLeafPem(): Promise<string> {
  const keys = await webcrypto.subtle.generateKey(EC_ALG as never, true, ['sign', 'verify']) as CryptoKeyPair;
  const serialBytes = randomBytes(16);
  serialBytes[0] = 0x10 + (serialBytes[0]! % 0x70);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialBytes.toString('hex'),
    name: 'CN=breeze-agent-test',
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 400 * DAY_MS),
    signingAlgorithm: EC_ALG as never,
    keys,
  });
  return cert.toString('pem');
}

const provider = {
  validityDays: [] as number[],
  revoked: [] as string[],
};

const fakeCloudflare = {
  issueCertificate: vi.fn(async (validityDays: number): Promise<CfCertResult> => {
    provider.validityDays.push(validityDays);
    const pem = await mintLeafPem();
    const now = Date.now();
    return {
      id: `cf-${randomUUID()}`,
      certificate: pem,
      privateKey: 'test-private-key-material',
      serialNumber: new X509Certificate(pem).serialNumber,
      issuedOn: new Date(now).toISOString(),
      expiresOn: new Date(now + validityDays * DAY_MS).toISOString(),
    };
  }),
  revokeCertificate: vi.fn(async (certificateId: string) => {
    provider.revoked.push(certificateId);
    return 'revoked' as const;
  }),
};

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const name of ['PRE_ASSIGNMENT_ENROLLMENT_ENABLED', 'AGENT_ENROLL_RATE_LIMIT', 'AGENT_ENROLLMENT_SECRET', 'BREEZE_BILLING_URL', 'AGENT_MTLS_BINDING_MODE']) {
    saved[name] = process.env[name];
  }
  process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'true';
  process.env.AGENT_ENROLL_RATE_LIMIT = '1000';
  process.env.AGENT_MTLS_BINDING_MODE = 'off';
  delete process.env.BREEZE_BILLING_URL;
  delete process.env.AGENT_ENROLLMENT_SECRET;
});
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

let partnerId: string;

beforeEach(async () => {
  provider.validityDays.length = 0;
  provider.revoked.length = 0;
  fakeCloudflare.issueCertificate.mockClear();
  fakeCloudflare.revokeCertificate.mockClear();
  vi.spyOn(CloudflareMtlsService, 'fromEnv').mockReturnValue(fakeCloudflare as unknown as CloudflareMtlsService);
  const partner = await createPartner({ status: 'active' });
  partnerId = partner.id;
  await getTestDb().update(partners).set({ deployKeyEnrollmentEnabled: true }).where(eq(partners.id, partnerId));
});

function app(): Hono {
  const a = new Hono();
  a.route(MOUNT, agentRoutes);
  return a;
}

async function seedKey(): Promise<{ id: string; plaintext: string }> {
  const plaintext = generateDeployKey();
  const [row] = await getTestDb().insert(partnerDeployKeys).values({
    partnerId,
    name: 'Bench image',
    imageLabel: `img-${randomUUID().slice(0, 8)}`,
    keyHash: hashDeployKey(plaintext),
    expiresAt: sql`now() + interval '30 days'`,
    maxUsage: 100,
    maxParked: 20,
  } as any).returning({ id: partnerDeployKeys.id });
  return { id: row!.id, plaintext };
}

async function enroll(enrollmentKey: string, hostname: string, headers: Record<string, string> = {}) {
  const res = await app().request(`${MOUNT}/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      enrollmentKey,
      hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '1.0.0-test',
      hardwareInfo: { serialNumber: `SN-${hostname}`, manufacturer: 'Acme' },
      networkInfo: [{ name: 'eth0', mac: '00:11:22:33:44:55', ip: '10.0.0.5', isPrimary: true }],
    }),
  });
  const body = await res.json() as Record<string, any>;
  expect(res.status, JSON.stringify(body)).toBe(201);
  return body;
}

async function enrollParked(hostname = `parked-${randomUUID().slice(0, 8)}`) {
  const key = await seedKey();
  const body = await enroll(key.plaintext, hostname);
  return { key, hostname, deviceId: body.deviceId as string, agentId: body.agentId as string, authToken: body.authToken as string, body };
}

async function certificates(deviceId: string) {
  return getTestDb().select().from(deviceMtlsCertificates)
    .where(eq(deviceMtlsCertificates.deviceId, deviceId))
    .orderBy(deviceMtlsCertificates.createdAt);
}

async function deviceRow(deviceId: string) {
  const [row] = await getTestDb().select().from(devices).where(eq(devices.id, deviceId));
  return row;
}

async function actorFor(): Promise<ParkedAssignmentActor & DeployKeyActor> {
  const user = await createUser({ partnerId, email: `certs-${randomUUID()}@example.com` });
  const sid = randomUUID();
  await getTestDb().insert(refreshTokenFamilies).values({ familyId: sid, userId: user.id, absoluteExpiresAt: new Date(Date.now() + DAY_MS) });
  return {
    partnerId,
    allowedSiteIds: undefined,
    auth: {
      scope: 'partner', partnerId, partnerOrgAccess: 'all',
      user: { id: user.id, email: user.email, name: 'Admin' },
      token: { aep: user.authEpoch, mep: user.mfaEpoch, sid },
    } as any,
  };
}

const heartbeatBody = { agentVersion: '1.0.0-test', status: 'ok' };

async function heartbeat(agentId: string, token: string): Promise<Record<string, unknown>> {
  const res = await app().request(`${MOUNT}/${agentId}/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(heartbeatBody),
  });
  const body = await res.json() as Record<string, unknown>;
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

describe('lifetime of a pool-enrolled certificate', () => {
  it('is cut to the whole days left in the parking window (org policy 90 days → 13)', async () => {
    const parked = await enrollParked();
    // Issued moments after created_at: 13.99… days are left, rounded down, so
    // the certificate never outlives the parked expiry.
    expect(provider.validityDays).toEqual([13]);
    expect(parked.body.mtls).toMatchObject({ certificate: expect.any(String), serialNumber: expect.any(String) });
    const [active] = await certificates(parked.deviceId);
    expect(active).toMatchObject({ state: 'active' });
    expect(active!.expiresAt.getTime() - active!.issuedAt.getTime()).toBe(13 * DAY_MS);
    const parkedExpiry = (await deviceRow(parked.deviceId))!.createdAt.getTime() + 14 * DAY_MS;
    expect(active!.expiresAt.getTime()).toBeLessThanOrEqual(parkedExpiry);
  });

  it('keeps a shorter org policy, and shrinks on an in-place re-enrollment late in the window', async () => {
    const key = await seedKey();
    const first = await enroll(key.plaintext, 'bench-01');
    const [pool] = await getTestDb().select({ id: organizations.id, settings: organizations.settings }).from(organizations)
      .where(and(eq(organizations.partnerId, partnerId), eq(organizations.type, UNASSIGNED_POOL_ORG_TYPE)));
    await getTestDb().update(organizations).set({ settings: { ...(pool!.settings as object), mtls: { certLifetimeDays: 7 } } })
      .where(eq(organizations.id, pool!.id));
    // Parked 10.5 days ago: 3 whole days are left.
    await getTestDb().update(devices).set({ createdAt: new Date(Date.now() - 10.5 * DAY_MS) }).where(eq(devices.id, first.deviceId));

    const again = await enroll(key.plaintext, 'bench-01', { 'x-agent-reenrollment-token': first.authToken });
    expect(again.deviceId).toBe(first.deviceId);
    expect(provider.validityDays).toEqual([13, 3]);

    const fresh = await enroll(key.plaintext, 'bench-02');
    expect(fresh.deviceId).not.toBe(first.deviceId);
    expect(provider.validityDays).toEqual([13, 3, 7]);
  });
});

describe('renewal while parked', () => {
  it('/renew-cert refuses the parked device and issues nothing', async () => {
    const parked = await enrollParked();
    const issuedBefore = provider.validityDays.length;
    const res = await app().request(`${MOUNT}/renew-cert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${parked.authToken}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'device_pending_assignment' });
    expect(provider.validityDays.length).toBe(issuedBefore);
    expect((await certificates(parked.deviceId)).map((row) => row.state)).toEqual(['active']);
  });
});

describe('revocation with the parked device', () => {
  it('scheduled expiry revokes the active certificate', async () => {
    const parked = await enrollParked();
    const [before] = await certificates(parked.deviceId);
    await getTestDb().update(devices).set({ createdAt: new Date(Date.now() - 15 * DAY_MS) }).where(eq(devices.id, parked.deviceId));

    const outcome = await expireParkedDevice({ partnerId, deviceId: parked.deviceId, actorUserId: null, reason: 'parking_window' });
    expect(outcome).toMatchObject({ expired: true });

    const [after] = await certificates(parked.deviceId);
    expect(after).toMatchObject({ id: before!.id, state: 'revoked', revokeAttempts: 0 });
    expect(after!.revokedAt).toBeInstanceOf(Date);
    expect(provider.revoked).toEqual([before!.providerCertificateId]);
  });

  it('leaves the row pending_revocation with a due retry when the provider fails', async () => {
    const parked = await enrollParked();
    fakeCloudflare.revokeCertificate.mockRejectedValueOnce(new Error('provider down'));

    await expireParkedDevice({ partnerId, deviceId: parked.deviceId, actorUserId: null, reason: 'parking_window' });

    const [after] = await certificates(parked.deviceId);
    expect(after).toMatchObject({ state: 'pending_revocation', revokeAttempts: 1 });
    expect(after!.nextRevokeAttemptAt).toBeInstanceOf(Date);
  });

  it('revoking the deploy key expires the device and revokes its certificate', async () => {
    const parked = await enrollParked();
    const [before] = await certificates(parked.deviceId);
    const revoked = await revokeDeployKey({ actor: await actorFor(), deployKeyId: parked.key.id });
    expect(revoked).toMatchObject({ ok: true, expiry: { matched: 1, expired: 1, failed: 0 } });

    expect((await deviceRow(parked.deviceId))!.status).toBe('decommissioned');
    const [after] = await certificates(parked.deviceId);
    expect(after).toMatchObject({ id: before!.id, state: 'revoked' });
    expect(provider.revoked).toEqual([before!.providerCertificateId]);
  });

  it('purge waits for a live certificate to be revoked, then purges', async () => {
    const parked = await enrollParked();
    const [cert] = await certificates(parked.deviceId);
    // Removed 40 days ago some other way than expiry (its certificate still
    // active), and the agent reported its uninstall, so only the certificate
    // stands in the purge's way.
    await getTestDb().update(devices).set({
      status: 'decommissioned',
      decommissionedAt: new Date(Date.now() - 40 * DAY_MS),
      lastSeenAt: new Date(Date.now() - 3 * DAY_MS),
      uninstallIntentAt: new Date(Date.now() - 2 * DAY_MS),
    }).where(eq(devices.id, parked.deviceId));

    const first = await purgeExpiredParkedDevice({ partnerId, deviceId: parked.deviceId, cutoff: new Date(Date.now() - 30 * DAY_MS) });
    expect(first).toEqual({ purged: false, deviceId: parked.deviceId, reason: 'CERTIFICATE_REVOCATION_PENDING' });
    expect(await deviceRow(parked.deviceId)).toBeDefined();
    expect(provider.revoked).toEqual([cert!.providerCertificateId]);
    expect((await certificates(parked.deviceId))[0]).toMatchObject({ state: 'revoked' });

    const second = await purgeExpiredParkedDevice({ partnerId, deviceId: parked.deviceId, cutoff: new Date(Date.now() - 30 * DAY_MS) });
    expect(second).toMatchObject({ purged: true, deviceId: parked.deviceId });
    expect(await deviceRow(parked.deviceId)).toBeUndefined();
    expect(provider.revoked).toHaveLength(1);
  });

  it('purge is not held up by a certificate past its own expiry', async () => {
    const parked = await enrollParked();
    await getTestDb().update(deviceMtlsCertificates).set({
      issuedAt: new Date(Date.now() - 60 * DAY_MS),
      expiresAt: new Date(Date.now() - 46 * DAY_MS),
    }).where(eq(deviceMtlsCertificates.deviceId, parked.deviceId));
    await getTestDb().update(devices).set({
      status: 'decommissioned',
      decommissionedAt: new Date(Date.now() - 40 * DAY_MS),
      lastSeenAt: new Date(Date.now() - 3 * DAY_MS),
      uninstallIntentAt: new Date(Date.now() - 2 * DAY_MS),
    }).where(eq(devices.id, parked.deviceId));

    const outcome = await purgeExpiredParkedDevice({ partnerId, deviceId: parked.deviceId, cutoff: new Date(Date.now() - 30 * DAY_MS) });
    expect(outcome).toMatchObject({ purged: true });
  });
});

describe('assignment gives the device its real certificate', () => {
  it('the first full beat in the customer org signals renewCert, the renewal issues the org lifetime, then nothing more', async () => {
    const parked = await enrollParked();
    const [parkedCert] = await certificates(parked.deviceId);
    const target = await createOrganization({ partnerId, status: 'active' });
    const site = await createSite({ orgId: target.id });

    const assigned = await assignParkedDevice({
      actor: await actorFor(),
      item: { deviceId: parked.deviceId, targetOrgId: target.id, targetSiteId: site.id },
      stepUp: null,
      audit: { req: { header: () => undefined } },
    });
    expect(assigned).toMatchObject({ ok: true });
    const moved = await deviceRow(parked.deviceId);
    expect(moved).toMatchObject({ orgId: target.id, mtlsRenewalRequestedSerial: parkedCert!.serialNumber });
    expect(moved!.mtlsCertSerialNumber).toBe(parkedCert!.serialNumber);

    // Not yet two thirds into the 13-day certificate: only the request asks.
    expect(await heartbeat(parked.agentId, parked.authToken)).toMatchObject({ renewCert: true });

    const renewed = await app().request(`${MOUNT}/renew-cert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${parked.authToken}` },
    });
    expect(renewed.status, await renewed.clone().text()).toBe(200);
    expect(provider.validityDays).toEqual([13, 90]);

    const after = await deviceRow(parked.deviceId);
    expect(after!.mtlsCertSerialNumber).not.toBe(parkedCert!.serialNumber);
    const rows = await certificates(parked.deviceId);
    expect(rows.find((row) => row.id === parkedCert!.id)!.state).not.toBe('active');
    expect(rows.filter((row) => row.state === 'active')).toHaveLength(1);

    expect(await heartbeat(parked.agentId, parked.authToken)).not.toHaveProperty('renewCert');
  });

  it('without mTLS configured, assignment records nothing and the beat asks for nothing', async () => {
    vi.spyOn(CloudflareMtlsService, 'fromEnv').mockReturnValue(null);
    const parked = await enrollParked();
    expect(parked.body.mtls ?? null).toBeNull();
    const target = await createOrganization({ partnerId, status: 'active' });
    const site = await createSite({ orgId: target.id });
    const assigned = await assignParkedDevice({
      actor: await actorFor(),
      item: { deviceId: parked.deviceId, targetOrgId: target.id, targetSiteId: site.id },
      stepUp: null,
      audit: { req: { header: () => undefined } },
    });
    expect(assigned).toMatchObject({ ok: true });
    expect((await deviceRow(parked.deviceId))!.mtlsRenewalRequestedSerial).toBeNull();
    expect(await heartbeat(parked.agentId, parked.authToken)).not.toHaveProperty('renewCert');
  });
});

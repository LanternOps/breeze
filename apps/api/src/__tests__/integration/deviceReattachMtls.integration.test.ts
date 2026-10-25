/**
 * The bounded rebind with mTLS configured (#8318 wave 1b, spec §6.3 step 3,
 * §6.4 "Certificates", "mTLS binding", "After commit").
 *
 * Real Postgres + Redis and the REAL agent router; only the Cloudflare
 * provider is faked, issuing genuine self-signed leaf PEMs (as
 * mtlsIssuanceHistory.integration.test.ts does), and the edge's client-cert
 * headers are trusted. Binding mode `enforce` throughout.
 *
 * Proven here:
 *   - phase 1 issues the target's next certificate as a pending_activation
 *     row bounded by the intent's expiry, and returns its material; a retry
 *     issues a fresh one and revokes the previous; a refused restage revokes
 *     the staged one;
 *   - confirm accepts the source's active certificate or the target's staged
 *     one, never the target's old active one; it activates the staged row,
 *     demotes and revokes the target's old certificate, moves the legacy
 *     columns, and gives the source's certificate a 24 h pending_revocation
 *     grace (the replay is still accepted under it).
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceReattachMtls.integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/clientIp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/clientIp')>()),
  // The client-cert assertion headers are honored only from the trusted edge.
  trustsForwardedHeadersFrom: () => true,
}));

import './setup';
import 'reflect-metadata';
import { randomBytes, randomUUID, webcrypto, X509Certificate } from 'node:crypto';
import * as x509 from '@peculiar/x509';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { deviceMtlsCertificates, devices } from '../../db/schema';
import { agentRoutes } from '../../routes/agents/index';
import { CloudflareMtlsService, type CfCertResult } from '../../services/cloudflareMtls';
import { requestDeviceReattach } from '../../services/deviceReattach/requestIntent';
import {
  parkedSource,
  readDevice,
  readIntent,
  seedReattachTenant,
  silentTarget,
  stagedSet,
  type SeededAgentDevice,
} from './deviceReattachFixtures';
import { getTestDb } from './setup';

const MOUNT = '/api/v1/agents';
const EC_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
x509.cryptoProvider.set(webcrypto as unknown as Crypto);

async function mintLeaf() {
  const keys = await webcrypto.subtle.generateKey(EC_ALG as never, true, ['sign', 'verify']) as CryptoKeyPair;
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
  return { pem, serial: new X509Certificate(pem).serialNumber };
}

const provider = { issued: [] as Array<CfCertResult & { canonicalSerial: string }>, revoked: [] as string[] };
const fakeCloudflare = {
  issueCertificate: vi.fn(async (validityDays: number): Promise<CfCertResult> => {
    const leaf = await mintLeaf();
    const now = Date.now();
    const result = {
      id: `cf-${randomUUID()}`,
      certificate: leaf.pem,
      privateKey: 'test-private-key-material',
      serialNumber: leaf.serial,
      issuedOn: new Date(now).toISOString(),
      expiresOn: new Date(now + validityDays * 24 * 3_600_000).toISOString(),
    };
    provider.issued.push({ ...result, canonicalSerial: leaf.serial });
    return result;
  }),
  revokeCertificate: vi.fn(async (certificateId: string) => {
    provider.revoked.push(certificateId);
    return 'revoked' as const;
  }),
};

/** An active certificate-history row (and the legacy columns) for a seeded device. */
async function giveActiveCertificate(device: SeededAgentDevice): Promise<{ id: string; serial: string; providerId: string }> {
  const serial = randomBytes(10).toString('hex').toUpperCase();
  const providerId = `cf-seed-${randomUUID()}`;
  const [row] = await getTestDb().insert(deviceMtlsCertificates).values({
    orgId: device.orgId,
    deviceId: device.id,
    providerCertificateId: providerId,
    serialNumber: serial,
    legacyProvenance: true,
    state: 'active',
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
    activatedAt: new Date(),
  }).returning({ id: deviceMtlsCertificates.id });
  await getTestDb().update(devices).set({ mtlsCertSerialNumber: serial, mtlsCertCfId: providerId }).where(eq(devices.id, device.id));
  return { id: row!.id, serial, providerId };
}

function certHeaders(serial: string | null): Record<string, string> {
  return serial ? { 'X-Breeze-Client-Cert-Verified': 'true', 'X-Breeze-Client-Cert-Serial': serial } : {};
}

async function call(path: string, token: string, body: unknown, serial: string | null) {
  const app = new Hono();
  app.route(MOUNT, agentRoutes);
  const res = await app.request(`${MOUNT}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...certHeaders(serial) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function arrange() {
  const tenant = await seedReattachTenant();
  const source = await parkedSource(tenant);
  const target = await silentTarget(tenant.orgA);
  const sourceCert = await giveActiveCertificate(source);
  const targetCert = await giveActiveCertificate(target);
  const result = await requestDeviceReattach({
    actor: { userId: tenant.admin.id }, sourceDeviceId: source.id, targetDeviceId: target.id,
    evidenceLevel: 'hint', restoreDecommissioned: false,
  });
  if (!result.ok) throw new Error(result.code);
  return { tenant, source, target, sourceCert, targetCert, intent: result.intent };
}

const certRow = async (id: string) => (await getTestDb().select().from(deviceMtlsCertificates).where(eq(deviceMtlsCertificates.id, id)))[0];

const originalBindingMode = process.env.AGENT_MTLS_BINDING_MODE;
beforeEach(() => {
  provider.issued.length = 0;
  provider.revoked.length = 0;
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

describe('rebind with mTLS (#8318 §6.3, §6.4)', () => {
  it('phase 1 issues the target\'s next certificate as pending_activation bounded by the intent; a retry replaces and revokes it', async () => {
    const { source, target, sourceCert, intent } = await arrange();
    const set = stagedSet();

    const first = await call(`/${source.agentId}/rebind`, source.agentToken, { intentId: intent.id, ...set.hashes }, sourceCert.serial);
    expect(first.status).toBe(200);
    expect(first.body.certificate).toMatchObject({ privateKey: 'test-private-key-material', serialNumber: provider.issued[0]!.serialNumber });
    const staged = await readIntent(intent.id);
    const pending = await certRow(staged!.stagedMtlsCertificateId!);
    expect(pending).toMatchObject({ deviceId: target.id, orgId: target.orgId, state: 'pending_activation' });
    expect(pending!.activationExpiresAt!.getTime()).toBe(staged!.expiresAt.getTime());
    // The target's old certificate is untouched.
    expect((await readDevice(target.id))!.mtlsCertSerialNumber).not.toBe(provider.issued[0]!.canonicalSerial);

    const retry = await call(`/${source.agentId}/rebind`, source.agentToken, { intentId: intent.id, ...set.hashes }, sourceCert.serial);
    expect(retry.status).toBe(200);
    expect(retry.body.stagedAgentId).toBe(first.body.stagedAgentId);
    expect(retry.body.certificate.serialNumber).toBe(provider.issued[1]!.serialNumber);
    const restaged = await readIntent(intent.id);
    expect(restaged!.stagedMtlsCertificateId).not.toBe(pending!.id);
    expect((await certRow(pending!.id))!.state).toMatch(/^(pending_revocation|revoked)$/);
    expect(provider.revoked).toContain(provider.issued[0]!.id);
  });

  it('a refused restage revokes the staged certificate', async () => {
    const { source, sourceCert, intent } = await arrange();
    const set = stagedSet();
    expect((await call(`/${source.agentId}/rebind`, source.agentToken, { intentId: intent.id, ...set.hashes }, sourceCert.serial)).status).toBe(200);
    const stagedCertId = (await readIntent(intent.id))!.stagedMtlsCertificateId!;
    const refused = await call(`/${source.agentId}/rebind`, source.agentToken, { intentId: intent.id, ...stagedSet().hashes }, sourceCert.serial);
    expect(refused.body).toMatchObject({ code: 'restage_refused' });
    expect((await certRow(stagedCertId))!.state).toMatch(/^(pending_revocation|revoked)$/);
    expect(provider.revoked).toContain(provider.issued[0]!.id);
    // A different set is decided before any provider call: nothing new was issued.
    expect(provider.issued).toHaveLength(1);
  });

  it('confirm: refuses the target\'s OLD certificate and a missing one; accepts the staged one; activates it, revokes the old, gives the source a 24 h grace', async () => {
    const { source, target, sourceCert, targetCert, intent } = await arrange();
    const set = stagedSet();
    const staged = await call(`/${source.agentId}/rebind`, source.agentToken, { intentId: intent.id, ...set.hashes }, sourceCert.serial);
    expect(staged.status).toBe(200);
    const stagedSerial = provider.issued[0]!.canonicalSerial;
    const stagedCertId = (await readIntent(intent.id))!.stagedMtlsCertificateId!;

    const confirmAs = (serial: string | null) =>
      call(`/${source.agentId}/rebind-confirm`, set.tokens.confirmationToken, {}, serial);
    expect(await confirmAs(targetCert.serial)).toMatchObject({ status: 403, body: { code: 'certificate_binding_failed' } });
    expect(await confirmAs(null)).toMatchObject({ status: 403, body: { code: 'certificate_binding_failed' } });
    expect((await readIntent(intent.id))!.state).toBe('staged');

    const confirmed = await confirmAs(stagedSerial);
    expect(confirmed.status).toBe(200);

    expect(await certRow(stagedCertId)).toMatchObject({ state: 'active', deviceId: target.id });
    expect((await certRow(targetCert.id))!.state).toMatch(/^(pending_revocation|revoked)$/);
    expect(provider.revoked).toContain(targetCert.providerId);
    expect(await readDevice(target.id)).toMatchObject({ mtlsCertSerialNumber: stagedSerial, mtlsCertCfId: provider.issued[0]!.id });

    // The source's certificate: pending_revocation, due in 24 h, not revoked yet.
    const sourceRow = await certRow(sourceCert.id);
    expect(sourceRow!.state).toBe('pending_revocation');
    const dueIn = sourceRow!.nextRevokeAttemptAt!.getTime() - Date.now();
    expect(dueIn).toBeGreaterThan(23 * 3_600_000);
    expect(dueIn).toBeLessThanOrEqual(24 * 3_600_000);
    expect(provider.revoked).not.toContain(sourceCert.providerId);

    // Review finding 4: after confirm the replay is bound to the TARGET as
    // agent auth now sees it (the new install's active certificate); the
    // source's certificate, pending revocation, no longer passes.
    expect((await confirmAs(stagedSerial)).status).toBe(200);
    expect(await confirmAs(sourceCert.serial)).toMatchObject({ status: 403, body: { code: 'certificate_binding_failed' } });

    // Exactly one active certificate on the target.
    const active = await getTestDb().select().from(deviceMtlsCertificates)
      .where(and(eq(deviceMtlsCertificates.deviceId, target.id), eq(deviceMtlsCertificates.state, 'active')));
    expect(active).toHaveLength(1);
  });

  it('before confirm, a source certificate that is no longer active (pending_revocation) is refused', async () => {
    const { source, sourceCert, intent } = await arrange();
    const set = stagedSet();
    expect((await call(`/${source.agentId}/rebind`, source.agentToken, { intentId: intent.id, ...set.hashes }, sourceCert.serial)).status).toBe(200);
    await getTestDb().update(deviceMtlsCertificates)
      .set({ state: 'pending_revocation', nextRevokeAttemptAt: new Date(Date.now() + 86_400_000) })
      .where(eq(deviceMtlsCertificates.id, sourceCert.id));
    expect(await call(`/${source.agentId}/rebind-confirm`, set.tokens.confirmationToken, {}, sourceCert.serial))
      .toMatchObject({ status: 403, body: { code: 'certificate_binding_failed' } });
    expect((await readIntent(intent.id))!.state).toBe('staged');
  });

  it('confirm accepts the source\'s active certificate before confirm', async () => {
    const { source, sourceCert, intent } = await arrange();
    const set = stagedSet();
    expect((await call(`/${source.agentId}/rebind`, source.agentToken, { intentId: intent.id, ...set.hashes }, sourceCert.serial)).status).toBe(200);
    expect((await call(`/${source.agentId}/rebind-confirm`, set.tokens.confirmationToken, {}, sourceCert.serial)).status).toBe(200);
  });
});

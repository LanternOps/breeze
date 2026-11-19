/**
 * TPM EK collection (#8318 wave T1; spec 2026-10-12 §12.2) against real
 * Postgres and Redis, as `breeze_app` in the agent's own org context.
 *
 * The TPM is played in software: the vectors carry test EK private keys, so
 * TPM2_ActivateCredential is done here by the book (Part 1 §24) — recover
 * the seed with the EK, check the integrity HMAC over the AK name, decrypt
 * the secret. A blob that opened here opens in a TPM; the agent wave runs it
 * against a real one.
 *
 * Proves:
 *   - a round trip records the baseline (the EK's SPKI hash), its time and
 *     tpm_available; the same EK again refreshes it; a different EK never
 *     replaces it, and is held in tpm_ek_mismatch_* for review;
 *   - a challenge is single use, even after a wrong answer, and bound to the
 *     device and agent that asked for it;
 *   - two concurrent first completions with different EKs serialize on the
 *     device row: one records the baseline, the other a mismatch;
 *   - a first baseline and a mismatch are audited in the same transaction;
 *   - a row that changed hands since auth records nothing;
 *   - the inventory writer never touches the baseline (§5.1).
 */
import './setup';
import { createDecipheriv, createHmac, createPrivateKey, constants, privateDecrypt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { auditLogs, deviceHardware } from '../../db/schema';
import { writeHardwareReport } from '../../services/inventoryChildSync';
import { kdfaSha256 } from '../../services/tpmAttestation/makeCredential';
import { objectName, parseRsaPublic } from '../../services/tpmAttestation/tpm2Public';
import {
  completeAttestation,
  issueAttestationChallenge,
  type BaselineAuditBuilder,
  type IssuedChallenge,
} from '../../services/tpmAttestation';
import { db } from '../../db';
import { createDevice, createOrganization, createPartner, createSite, deviceAgentId } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type Vector = { ekPublic: string; ekPrivatePkcs8: string; ekSpkiSha256: string; akPublic: string };
const { vectors } = JSON.parse(readFileSync(join(__dirname, '../../services/tpmAttestation/__tests__/vectors/makeCredential.vectors.json'), 'utf8')) as { vectors: Vector[] };

/** TPM2_ActivateCredential in software, with the EK's private key. */
function activate(v: Vector, issued: IssuedChallenge): string {
  const seed = privateDecrypt({
    key: createPrivateKey({ key: Buffer.from(v.ekPrivatePkcs8, 'base64'), format: 'der', type: 'pkcs8' }),
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
    oaepLabel: Buffer.from('IDENTITY\0', 'latin1'),
  }, Buffer.from(issued.encryptedSecret, 'base64'));
  const akName = objectName(parseRsaPublic(Buffer.from(v.akPublic, 'base64')));
  const blob = Buffer.from(issued.credentialBlob, 'base64');
  const hmacSize = blob.readUInt16BE(0);
  const integrity = blob.subarray(2, 2 + hmacSize);
  const encIdentity = blob.subarray(2 + hmacSize);
  const hmacKey = kdfaSha256(seed, 'INTEGRITY', Buffer.alloc(0), Buffer.alloc(0), 256);
  const expected = createHmac('sha256', hmacKey).update(encIdentity).update(akName).digest();
  if (!expected.equals(integrity)) throw new Error('integrity HMAC mismatch: the TPM would refuse this blob');
  const symKey = kdfaSha256(seed, 'STORAGE', akName, Buffer.alloc(0), 128);
  const decipher = createDecipheriv('aes-128-cfb', symKey, Buffer.alloc(16));
  const plain = Buffer.concat([decipher.update(encIdentity), decipher.final()]);
  const size = plain.readUInt16BE(0);
  return plain.subarray(2, 2 + size).toString('base64');
}

async function seed() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  const agentId = await deviceAgentId(device.id);
  const context: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
    userId: null,
  };
  return { org, device, agent: { deviceId: device.id, agentId, orgId: org.id, partnerId: partner.id }, context };
}

const audit: BaselineAuditBuilder = (action, orgId) => ({
  orgId,
  action,
  actorType: 'agent',
  actorId: '00000000-0000-0000-0000-000000000000',
  resourceType: 'device',
  result: 'success',
  initiatedBy: 'agent',
});

/** Completes outside any DB context, as the self-managed route does. */
function complete(fx: Fx, challengeId: string, secret: string) {
  return completeAttestation(fx.agent, { challengeId, secret }, (action, orgId) => ({ ...audit(action, orgId), resourceId: fx.device.id }));
}

async function auditActions(deviceId: string) {
  const rows = await getTestDb()
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.resourceId, deviceId), sql`${auditLogs.action} LIKE 'device.tpm_%'`));
  return rows.map((r) => r.action).sort();
}

type Fx = Awaited<ReturnType<typeof seed>>;

async function attest(fx: Fx, v: Vector) {
  const issued = await issueAttestationChallenge(fx.agent, { ekPublic: v.ekPublic, akPublic: v.akPublic });
  const result = await complete(fx, issued.challengeId, activate(v, issued));
  if (typeof result !== 'object') throw new Error(`attestation did not record: ${result}`);
  return result;
}

async function hardwareRow(deviceId: string) {
  const [row] = await getTestDb().select().from(deviceHardware).where(eq(deviceHardware.deviceId, deviceId));
  return row;
}

describe('TPM EK collection (real Postgres and Redis, as breeze_app)', () => {
  runDb('records the first baseline, refreshes it for the same EK and keeps it against another', async () => {
    const fx = await seed();
    expect(await attest(fx, vectors[0]!)).toEqual({ outcome: 'recorded', orgId: fx.org.id });
    const first = await hardwareRow(fx.device.id);
    expect(first).toMatchObject({
      tpmEkPubSha256: vectors[0]!.ekSpkiSha256,
      tpmAvailable: true,
      orgId: fx.org.id,
      tpmEkMismatchSha256: null,
      tpmEkMismatchAt: null,
    });
    expect(first!.tpmAttestedAt).toBeInstanceOf(Date);

    expect((await attest(fx, vectors[0]!)).outcome).toBe('refreshed');
    const refreshed = await hardwareRow(fx.device.id);

    // A different proven EK: held for review, the baseline and its time untouched.
    expect((await attest(fx, vectors[1]!)).outcome).toBe('mismatch');
    const held = await hardwareRow(fx.device.id);
    expect(held).toMatchObject({
      tpmEkPubSha256: vectors[0]!.ekSpkiSha256,
      tpmAttestedAt: refreshed!.tpmAttestedAt,
      tpmEkMismatchSha256: vectors[1]!.ekSpkiSha256,
    });
    expect(held!.tpmEkMismatchAt).toBeInstanceOf(Date);

    // The baseline EK again still refreshes, and the mismatch stays for review.
    expect((await attest(fx, vectors[0]!)).outcome).toBe('refreshed');
    expect(await hardwareRow(fx.device.id)).toMatchObject({
      tpmEkPubSha256: vectors[0]!.ekSpkiSha256,
      tpmEkMismatchSha256: vectors[1]!.ekSpkiSha256,
    });
    // Audited with the change: the first baseline and the mismatch, not the refreshes.
    expect(await auditActions(fx.device.id)).toEqual(['device.tpm_baseline.mismatch', 'device.tpm_baseline.recorded']);
  });

  runDb('two concurrent first completions with different EKs: one baseline, one mismatch', async () => {
    const fx = await seed();
    const [a, b] = [vectors[0]!, vectors[1]!];
    const issuedA = await issueAttestationChallenge(fx.agent, { ekPublic: a.ekPublic, akPublic: a.akPublic });
    const issuedB = await issueAttestationChallenge(fx.agent, { ekPublic: b.ekPublic, akPublic: b.akPublic });
    expect(await hardwareRow(fx.device.id)).toBeUndefined();

    const results = await Promise.all([
      complete(fx, issuedA.challengeId, activate(a, issuedA)),
      complete(fx, issuedB.challengeId, activate(b, issuedB)),
    ]);
    const outcomes = results.map((r) => (typeof r === 'object' ? r.outcome : r));
    expect([...outcomes].sort()).toEqual(['mismatch', 'recorded']);
    const winner = outcomes[0] === 'recorded' ? a : b;
    const loser = winner === a ? b : a;
    expect(await hardwareRow(fx.device.id)).toMatchObject({
      tpmEkPubSha256: winner.ekSpkiSha256,
      tpmEkMismatchSha256: loser.ekSpkiSha256,
    });
    expect(await auditActions(fx.device.id)).toEqual(['device.tpm_baseline.mismatch', 'device.tpm_baseline.recorded']);
  });

  runDb('a mismatch cannot exist without a baseline (CHECK)', async () => {
    const fx = await seed();
    await expect(getTestDb().insert(deviceHardware).values({
      deviceId: fx.device.id,
      orgId: fx.org.id,
      tpmEkMismatchSha256: vectors[1]!.ekSpkiSha256,
      tpmEkMismatchAt: new Date(),
    })).rejects.toMatchObject({ cause: { constraint_name: 'device_hardware_tpm_ek_mismatch_shape_chk' } });
  });

  runDb('a challenge is single use, even after a wrong answer, and bound to its device and agent', async () => {
    const fx = await seed();
    const other = await seed();
    const v = vectors[0]!;

    const wrong = await issueAttestationChallenge(fx.agent, { ekPublic: v.ekPublic, akPublic: v.akPublic });
    await expect(complete(fx, wrong.challengeId, Buffer.alloc(32).toString('base64')))
      .rejects.toMatchObject({ code: 'TPM_CHALLENGE_INVALID', status: 403, reason: 'wrong_secret' });
    // Consumed by the wrong answer: the right one no longer counts.
    await expect(complete(fx, wrong.challengeId, activate(v, wrong)))
      .rejects.toMatchObject({ code: 'TPM_CHALLENGE_INVALID', reason: undefined });

    const stolen = await issueAttestationChallenge(fx.agent, { ekPublic: v.ekPublic, akPublic: v.akPublic });
    await expect(complete(other, stolen.challengeId, activate(v, stolen)))
      .rejects.toMatchObject({ code: 'TPM_CHALLENGE_INVALID', reason: undefined });
    expect(await hardwareRow(fx.device.id)).toBeUndefined();
    expect(await hardwareRow(other.device.id)).toBeUndefined();
  });

  runDb('a row that changed hands since auth records nothing', async () => {
    const fx = await seed();
    const v = vectors[0]!;
    const issued = await issueAttestationChallenge(fx.agent, { ekPublic: v.ekPublic, akPublic: v.akPublic });
    await getTestDb().execute(sql`UPDATE devices SET agent_id = ${`agent-next-${fx.device.id}`} WHERE id = ${fx.device.id}::uuid`);
    expect(await complete(fx, issued.challengeId, activate(v, issued))).toBe('stale');
    expect(await hardwareRow(fx.device.id)).toBeUndefined();
    expect(await auditActions(fx.device.id)).toEqual([]);
  });

  runDb('the inventory writer never touches the baseline (§5.1)', async () => {
    const fx = await seed();
    await attest(fx, vectors[0]!);
    const before = await hardwareRow(fx.device.id);
    await withDbAccessContext(fx.context, () => db.transaction((tx) => writeHardwareReport(
      tx,
      { id: fx.device.id, orgId: fx.org.id },
      { serialNumber: 'SN-1', manufacturer: 'Acme', tpmAvailable: true },
      null,
      new Date(),
    )));
    const after = await hardwareRow(fx.device.id);
    expect(after).toMatchObject({ serialNumber: 'SN-1', tpmEkPubSha256: before!.tpmEkPubSha256, tpmAttestedAt: before!.tpmAttestedAt });
    await attest(fx, vectors[1]!);
    const held = await hardwareRow(fx.device.id);
    await withDbAccessContext(fx.context, () => db.transaction((tx) => writeHardwareReport(
      tx,
      { id: fx.device.id, orgId: fx.org.id },
      { serialNumber: 'SN-2', tpmAvailable: true },
      null,
      new Date(),
    )));
    expect(await hardwareRow(fx.device.id)).toMatchObject({
      serialNumber: 'SN-2',
      tpmEkMismatchSha256: held!.tpmEkMismatchSha256,
      tpmEkMismatchAt: held!.tpmEkMismatchAt,
    });
  });

  runDb('refuses an EK that is not the default template before anything is stored', async () => {
    const fx = await seed();
    const v = vectors[0]!;
    // The AK in the EK's place: a signing key, not the EK template.
    await expect(issueAttestationChallenge(fx.agent, { ekPublic: v.akPublic, akPublic: v.akPublic }))
      .rejects.toMatchObject({ code: 'TPM_EK_REFUSED', reason: 'ek_attributes' });
  });
});

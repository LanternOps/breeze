/**
 * Recording an issued device mTLS certificate as the device's ACTIVE identity
 * (#7431 / #7432).
 *
 * `device_mtls_certificates` is what renewal authorization
 * (`routes/agents/mtls.ts`) and the certificate-binding decision
 * (`services/agentCertificateBinding.ts`) read. Every path that hands a device
 * a certificate must therefore record it there, in the same transaction as the
 * legacy `devices.mtls_cert_*` columns, superseding whatever was active
 * before. Two paths do:
 *
 *  - `/renew-cert` (legacy, no protocolVersion) composes
 *    `activateIssuedCertificateCore` into its own transaction.
 *  - `issueMtlsCertForDevice` (enrollment, admin provisioning, quarantine
 *    approve) calls `recordIssuedCertificateForDevice`, which runs the same
 *    core inside the caller's DB context.
 *
 * Revoking the superseded certificate at the provider always happens after
 * the transaction commits, never inside it (#1105: no transaction held across
 * a provider call). Until then the superseded row sits in
 * `pending_revocation` with a due `next_revoke_attempt_at`, so the five-minute
 * sweep (jobs/mtlsCertificateRevocation.ts) revokes it even if the inline
 * attempt never runs.
 *
 * Logging: never log PEM, keys, serials, fingerprints, or provider ids.
 */

import { and, eq } from 'drizzle-orm';
import { db, runAfterDbContextExit, withSystemDbAccessContext } from '../db';
import { deviceMtlsCertificates, devices } from '../db/schema';
import { normalizeCertificateSerial } from './agentCertificateBinding';
import type { CfCertResult, CloudflareMtlsService, ParsedIssuedCertificate } from './cloudflareMtls';
import {
  queueCertificateRevocationCore,
  revokeCertificateNowOrEnqueue,
  type Tx,
} from './deviceMtlsCertificateLifecycle';

export interface IssuedCertificateActivation {
  orgId: string;
  deviceId: string;
  cert: CfCertResult;
  parsedCert: ParsedIssuedCertificate;
  now: Date;
}

export interface IssuedCertificateActivationResult {
  certificateId: string;
  /** The previously active row, now `pending_revocation`; revoke it after commit. */
  demotedCertificateId: string | null;
}

/**
 * Makes `cert` the device's active certificate inside `tx`:
 *
 *  1. read the current `active` row (if any);
 *  2. insert the new certificate as `pending_activation` — the replacement
 *     `queueCertificateRevocationCore` requires before it will demote;
 *  3. demote the old row to `pending_revocation`;
 *  4. promote the new row to `active` — after the demote, because
 *     `device_mtls_certificates_one_active_uq` is checked per statement;
 *  5. point the legacy `devices.mtls_cert_*` columns at the new certificate.
 *
 * Throws on any step that does not land, so the caller's transaction rolls
 * back and no half-recorded identity survives. The caller owns revoking
 * `demotedCertificateId` once the transaction has committed.
 */
export async function activateIssuedCertificateCore(
  tx: Tx,
  input: IssuedCertificateActivation,
): Promise<IssuedCertificateActivationResult> {
  const { orgId, deviceId, cert, parsedCert, now } = input;

  const [existingActive] = await tx
    .select({ id: deviceMtlsCertificates.id })
    .from(deviceMtlsCertificates)
    .where(and(eq(deviceMtlsCertificates.deviceId, deviceId), eq(deviceMtlsCertificates.state, 'active')))
    .limit(1);

  const [inserted] = await tx
    .insert(deviceMtlsCertificates)
    .values({
      orgId,
      deviceId,
      providerCertificateId: cert.id,
      serialNumber: parsedCert.serialNumber,
      fingerprintSha256: parsedCert.fingerprintSha256,
      publicKeySpki: parsedCert.publicKeySpkiBase64,
      legacyProvenance: false,
      state: 'pending_activation',
      issuedAt: new Date(cert.issuedOn),
      expiresAt: new Date(cert.expiresOn),
      activationExpiresAt: now,
    })
    .returning({ id: deviceMtlsCertificates.id });

  if (!inserted) {
    throw new Error('mtls_history_insert_failed');
  }

  let demoted = false;
  if (existingActive) {
    demoted = await queueCertificateRevocationCore(tx, existingActive.id);
  }

  const activated = await tx
    .update(deviceMtlsCertificates)
    .set({ state: 'active', activatedAt: now, updatedAt: now })
    .where(and(eq(deviceMtlsCertificates.id, inserted.id), eq(deviceMtlsCertificates.state, 'pending_activation')))
    .returning({ id: deviceMtlsCertificates.id });

  if (activated.length !== 1) {
    throw new Error('mtls_history_activation_failed');
  }

  // `cert.serialNumber` is Cloudflare's raw `serial_number` field, whose
  // format is not guaranteed; store it in the canonical form the binding
  // decision compares against.
  const legacyUpdated = await tx
    .update(devices)
    .set({
      mtlsCertSerialNumber: normalizeCertificateSerial(cert.serialNumber),
      mtlsCertExpiresAt: new Date(cert.expiresOn),
      mtlsCertIssuedAt: new Date(cert.issuedOn),
      mtlsCertCfId: cert.id,
      updatedAt: now,
    })
    .where(eq(devices.id, deviceId))
    .returning({ id: devices.id });

  if (legacyUpdated.length !== 1) {
    throw new Error('legacy_device_update_failed');
  }

  return {
    certificateId: inserted.id,
    demotedCertificateId: demoted && existingActive ? existingActive.id : null,
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** The device is missing, in another org, or invisible to the caller's context. */
class DeviceNotIssuableError extends Error {
  constructor() {
    super('mtls_issuance_device_not_found');
    this.name = 'DeviceNotIssuableError';
  }
}

/**
 * One best-effort provider revoke, started once the caller's outermost DB
 * context has settled. Not durable: for a certificate with no history row,
 * which the retry sweep cannot see.
 */
export function revokeInlineAfterContextExit(cert: CfCertResult, cfService: CloudflareMtlsService): void {
  runAfterDbContextExit('mtls-issuance.revoke-orphan-inline', async () => {
    try {
      await cfService.revokeCertificate(cert.id);
    } catch (err) {
      console.error('[mtls-issuance] inline orphan revoke failed:', errorName(err));
    }
  });
}

/**
 * Revokes a provider certificate that was issued but never recorded as the
 * device's identity. A `pending_revocation` marker row makes the revoke
 * durable (retried by the sweep); if even the marker cannot be written, one
 * inline best-effort revoke is the last resort.
 *
 * The marker write runs in a savepoint: when this is called inside an open
 * caller transaction (enrollment), a failed INSERT must not abort it. Only
 * call this once the device is known to exist in `target.orgId` — the
 * composite (device_id, org_id) FK is DEFERRABLE INITIALLY DEFERRED, so a
 * marker for any other pair would fail at the OUTER commit, not here.
 */
async function revokeUnrecordedCertificate(
  target: { orgId: string; deviceId: string },
  cert: CfCertResult,
  parsedCert: ParsedIssuedCertificate,
  cfService: CloudflareMtlsService,
): Promise<void> {
  let markerId: string | null = null;
  try {
    markerId = await withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        const [marker] = await tx
          .insert(deviceMtlsCertificates)
          .values({
            orgId: target.orgId,
            deviceId: target.deviceId,
            providerCertificateId: cert.id,
            serialNumber: parsedCert.serialNumber,
            fingerprintSha256: parsedCert.fingerprintSha256,
            publicKeySpki: parsedCert.publicKeySpkiBase64,
            legacyProvenance: false,
            state: 'pending_revocation',
            issuedAt: new Date(cert.issuedOn),
            expiresAt: new Date(cert.expiresOn),
            nextRevokeAttemptAt: new Date(),
          })
          .returning({ id: deviceMtlsCertificates.id });
        return marker?.id ?? null;
      }),
    );
  } catch (err) {
    console.error('[mtls-issuance] orphan-revoke marker row could not be written:', errorName(err));
  }

  if (markerId) {
    const id = markerId;
    runAfterDbContextExit('mtls-issuance.revoke-orphan', () => revokeCertificateNowOrEnqueue(id));
    return;
  }

  console.error('[mtls-issuance] ORPHAN_PROVIDER_CERT: no durable marker, inline best-effort revoke:', target.deviceId);
  revokeInlineAfterContextExit(cert, cfService);
}

/**
 * Records a certificate just issued for `deviceId` as its active identity,
 * superseding the previous active row, within the caller's DB context
 * (enrollment's system transaction, or the admin request's own context for
 * provisioning and quarantine approve — RLS applies to both).
 *
 * The device row is locked and must belong to `orgId` in that context;
 * otherwise nothing is recorded. Returns `true` when the certificate is now
 * the device's identity. On `false` the certificate was never recorded, it is
 * revoked at the provider, and the caller must not hand it to the agent —
 * the agent would hold a certificate the binding check does not know.
 *
 * Post-commit work (revoking the superseded or orphaned certificate) is
 * deferred until the OUTERMOST DB context has settled: the revoke locks the
 * history row on a separate connection, and the caller's still-open
 * transaction holds that row's lock until it commits.
 */
export async function recordIssuedCertificateForDevice(input: {
  orgId: string;
  deviceId: string;
  cert: CfCertResult;
  parsedCert: ParsedIssuedCertificate;
  cfService: CloudflareMtlsService;
}): Promise<boolean> {
  const { orgId, deviceId, cert, parsedCert, cfService } = input;

  let result: IssuedCertificateActivationResult;
  try {
    result = await withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        const [device] = await tx
          .select({ id: devices.id })
          .from(devices)
          .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
          .limit(1)
          .for('update');
        if (!device) {
          throw new DeviceNotIssuableError();
        }
        return activateIssuedCertificateCore(tx, { orgId, deviceId, cert, parsedCert, now: new Date() });
      }),
    );
  } catch (err) {
    console.error('[mtls-issuance] certificate could not be recorded, revoking it:', errorName(err));
    if (err instanceof DeviceNotIssuableError) {
      // No marker row: one naming this (device, org) pair could only fail at
      // the caller's commit (deferred FK) and abort its whole transaction.
      console.error('[mtls-issuance] ORPHAN_PROVIDER_CERT: device not issuable, inline best-effort revoke:', deviceId);
      revokeInlineAfterContextExit(cert, cfService);
    } else {
      await revokeUnrecordedCertificate({ orgId, deviceId }, cert, parsedCert, cfService);
    }
    return false;
  }

  const demotedId = result.demotedCertificateId;
  if (demotedId) {
    runAfterDbContextExit('mtls-issuance.revoke-superseded', () => revokeCertificateNowOrEnqueue(demotedId));
  }
  return true;
}

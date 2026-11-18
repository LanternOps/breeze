/**
 * The target's NEXT mTLS certificate, issued at phase 1 (#8318 spec §6.3
 * step 3) as a `pending_activation` row on the TARGET, activated by confirm.
 *
 * Mirrors the v2 `/renew-cert` issue path (routes/agents/mtls.ts): the
 * provider call is made OUTSIDE any DB transaction (#1105); the pending row
 * is inserted in phase 1's transaction; a certificate that never became a
 * row (the transaction refused or failed) is an orphan, revoked durably
 * through a `pending_revocation` marker row and the five-minute sweep.
 *
 * Without mTLS configured (no provider), nothing is issued and phase 1 stages
 * without a certificate, as enrollment does.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceMtlsCertificates, organizations } from '../../db/schema';
import {
  CloudflareMtlsService,
  parseIssuedLeafCertificate,
  type CfCertResult,
  type ParsedIssuedCertificate,
} from '../cloudflareMtls';
import { revokeCertificateNowOrEnqueue } from '../deviceMtlsCertificateLifecycle';
import type { ReattachTx } from './intentStore';

export interface IssuedStagedCertificate {
  cert: CfCertResult;
  parsedCert: ParsedIssuedCertificate;
  cfService: CloudflareMtlsService;
}

export type StagedCertificateIssue =
  | { kind: 'not_configured' }
  | { kind: 'issued'; issued: IssuedStagedCertificate }
  | { kind: 'failed' };

const DEFAULT_CERT_LIFETIME_DAYS = 90;

/** The org's certificate lifetime (organizations.settings.mtls), as enrollment reads it. */
async function readOrgCertLifetimeDays(orgId: string): Promise<number> {
  const [org] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)));
  const settings = org?.settings && typeof org.settings === 'object' ? (org.settings as Record<string, unknown>) : {};
  const mtls = settings.mtls && typeof settings.mtls === 'object' ? (settings.mtls as Record<string, unknown>) : {};
  const days = mtls.certLifetimeDays;
  return typeof days === 'number' && days >= 1 && days <= 365 ? Math.round(days) : DEFAULT_CERT_LIFETIME_DAYS;
}

/** Issue a certificate for the target's org at the provider. Call with no DB context held. */
export async function issueStagedCertificate(targetOrgId: string): Promise<StagedCertificateIssue> {
  const cfService = CloudflareMtlsService.fromEnv();
  if (!cfService) return { kind: 'not_configured' };

  let cert: CfCertResult;
  try {
    cert = await cfService.issueCertificate(await readOrgCertLifetimeDays(targetOrgId));
  } catch (err) {
    console.error('[deviceReattach] staged certificate issuance failed:', err instanceof Error ? err.name : 'unknown');
    return { kind: 'failed' };
  }
  try {
    return { kind: 'issued', issued: { cert, parsedCert: parseIssuedLeafCertificate(cert.certificate), cfService } };
  } catch (err) {
    // No history row is possible without the parsed serial and fingerprint:
    // one inline best-effort revoke, as the renewal path does.
    console.error('[deviceReattach] ORPHAN_PROVIDER_CERT (cert-parse-failure, no durable row possible):', err instanceof Error ? err.name : 'unknown');
    try {
      await cfService.revokeCertificate(cert.id);
    } catch (revokeErr) {
      console.error('[deviceReattach] failed to revoke an unparseable staged certificate:', String(revokeErr));
    }
    return { kind: 'failed' };
  }
}

/** Insert the pending_activation row on the target, inside phase 1's transaction. */
export async function insertStagedCertificateRow(
  tx: ReattachTx,
  input: { orgId: string; deviceId: string; issued: IssuedStagedCertificate; activationExpiresAt: Date },
): Promise<string> {
  const { cert, parsedCert } = input.issued;
  const [row] = await tx
    .insert(deviceMtlsCertificates)
    .values({
      orgId: input.orgId,
      deviceId: input.deviceId,
      providerCertificateId: cert.id,
      serialNumber: parsedCert.serialNumber,
      fingerprintSha256: parsedCert.fingerprintSha256,
      publicKeySpki: parsedCert.publicKeySpkiBase64,
      legacyProvenance: false,
      state: 'pending_activation',
      issuedAt: new Date(cert.issuedOn),
      expiresAt: new Date(cert.expiresOn),
      activationExpiresAt: input.activationExpiresAt,
    })
    .returning({ id: deviceMtlsCertificates.id });
  if (!row) throw new Error('staged certificate row was not written');
  return row.id;
}

/**
 * Revoke a certificate issued for phase 1 that never became the intent's
 * staged row. A `pending_revocation` marker on the target makes the revoke
 * durable; if even the marker cannot be written, one inline best-effort
 * revoke is the last resort. Call after phase 1's transaction settled.
 */
export async function revokeOrphanStagedCertificate(
  target: { orgId: string; deviceId: string },
  issued: IssuedStagedCertificate,
): Promise<void> {
  const { cert, parsedCert, cfService } = issued;
  let markerId: string | null = null;
  try {
    markerId = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [marker] = await db
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
    }));
  } catch (err) {
    console.error('[deviceReattach] orphan staged certificate marker write failed:', err instanceof Error ? err.name : 'unknown');
  }
  if (markerId) {
    try {
      await revokeCertificateNowOrEnqueue(markerId);
    } catch (err) {
      console.error('[deviceReattach] orphan staged certificate revoke failed; the sweep will retry it:', err instanceof Error ? err.name : 'unknown');
    }
    return;
  }
  try {
    await cfService.revokeCertificate(cert.id);
  } catch (err) {
    console.error('[deviceReattach] inline revoke of an orphan staged certificate failed:', String(err));
  }
}

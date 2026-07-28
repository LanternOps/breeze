/**
 * Cloudflare mTLS Client Certificate management via API Shield.
 *
 * This service is entirely optional. When CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ZONE_ID are not set, all public methods return null
 * and no network calls are made.
 *
 * Security remediation Wave 5 Task 3: `revokeCertificate` returns a TYPED
 * outcome instead of making callers parse exception text, and every failure
 * mode is a `CloudflareMtlsError` with a `retryable` flag. Error MESSAGES are
 * deliberately body-free (never include the upstream response text, the
 * provider certificate id, or any other cert material) — the lifecycle
 * service persists only a bounded category string
 * (`categorizeCloudflareMtlsError`) to `device_mtls_certificates.last_revoke_error`,
 * never a raw message.
 */

import { X509Certificate } from 'crypto';

/** Hard ceiling on the revoke call so a hung Cloudflare connection can't wedge a worker slot forever. */
const REVOKE_TIMEOUT_MS = 10_000;

export type CertificateRevocationResult = 'revoked' | 'not_found';

/** Bounded, PII/secret-free category persisted to `last_revoke_error`. */
export type CloudflareMtlsErrorCategory = 'timeout' | 'rate_limited' | 'provider_5xx' | 'provider_4xx';

export class CloudflareMtlsError extends Error {
  constructor(
    public readonly operation: 'issue' | 'revoke',
    public readonly status: number | undefined,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'CloudflareMtlsError';
  }
}

/**
 * Maps a caught error to a bounded category safe to persist. `status ===
 * undefined` covers both network failures and timeouts (a fetch abort/reject
 * never carries an HTTP status) — both are grouped as `timeout`. Anything that
 * isn't a `CloudflareMtlsError` (defensive; revokeCertificate never throws
 * anything else) falls back to the same retryable `timeout` bucket rather than
 * risk persisting an unbounded message.
 */
export function categorizeCloudflareMtlsError(err: unknown): CloudflareMtlsErrorCategory {
  if (err instanceof CloudflareMtlsError) {
    if (err.status === undefined) return 'timeout';
    if (err.status === 429) return 'rate_limited';
    if (err.status >= 500) return 'provider_5xx';
    return 'provider_4xx';
  }
  return 'timeout';
}

export interface CfCertResult {
  id: string;
  certificate: string;
  privateKey: string;
  serialNumber: string;
  expiresOn: string;
  issuedOn: string;
}

/**
 * Derived, DB-storable identity for an issued leaf certificate — Wave 5
 * Task 4's durable `device_mtls_certificates` history rows need the
 * certificate's own serial (parsed from the cert itself, not just
 * Cloudflare's `serial_number` string field), a SHA-256 fingerprint of the
 * DER-encoded certificate, and the certificate's SubjectPublicKeyInfo (SPKI)
 * for later proof-of-possession recovery (`mtlsRenewalProof.ts`).
 */
export interface ParsedIssuedCertificate {
  serialNumber: string;
  fingerprintSha256: string;
  publicKeySpkiBase64: string;
}

/**
 * `certificatePem` may be a single leaf certificate OR a bundle (leaf +
 * intermediate(s)) depending on the provider response shape — only the FIRST
 * PEM block (the leaf) is ever the device's own identity, so this extracts
 * that block before parsing.
 */
function extractFirstPemCertificateBlock(pem: string): string {
  const match = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (!match) {
    throw new Error('No PEM certificate block found in issued certificate response');
  }
  return match[0];
}

/**
 * Parses the leaf certificate from an issued PEM using node:crypto's
 * `X509Certificate` — no new dependency. Returns the certificate's own
 * serial number (uppercase hex, no separators — matches `X509Certificate`'s
 * own format), a SHA-256 fingerprint of the DER-encoded certificate
 * (lowercase hex, no separators — matches this codebase's other sha256-hex
 * conventions, e.g. agent token hashing), and the base64-encoded DER SPKI.
 *
 * Throws (never returns partial data) on a malformed/unparseable PEM — the
 * caller must revoke the just-issued provider certificate and fail the
 * renewal rather than persist a history row it can't derive an identity for.
 * Never logs the PEM, the parsed key material, or the fingerprint.
 */
export function parseIssuedLeafCertificate(certificatePem: string): ParsedIssuedCertificate {
  const leafPem = extractFirstPemCertificateBlock(certificatePem);
  const cert = new X509Certificate(leafPem);
  const spkiDer = cert.publicKey.export({ type: 'spki', format: 'der' });

  return {
    serialNumber: cert.serialNumber,
    fingerprintSha256: cert.fingerprint256.replace(/:/g, '').toLowerCase(),
    publicKeySpkiBase64: spkiDer.toString('base64'),
  };
}

export class CloudflareMtlsService {
  private apiToken: string;
  private zoneId: string;
  private baseUrl: string;

  constructor(apiToken: string, zoneId: string) {
    this.apiToken = apiToken;
    this.zoneId = zoneId;
    this.baseUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}`;
  }

  /**
   * Returns a configured instance if env vars are set, otherwise null.
   */
  static fromEnv(): CloudflareMtlsService | null {
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    if (!apiToken || !zoneId) {
      return null;
    }
    return new CloudflareMtlsService(apiToken, zoneId);
  }

  async issueCertificate(validityDays: number): Promise<CfCertResult> {
    const csr = ''; // Cloudflare generates key pair when CSR is empty
    const resp = await fetch(`${this.baseUrl}/client_certificates`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        csr,
        validity_days: validityDays,
      }),
    });

    // FINAL-REVIEW I9: the issue path used to throw
    // `Cloudflare API error ${status}: ${text}` with the RAW upstream body,
    // and routes/agents/mtls.ts logs that message on issuance failure. This
    // module's own contract (see the file docblock) is that error messages are
    // body-free — it was only ever applied to `revokeCertificate`. The issue
    // path now throws the same typed, bounded `CloudflareMtlsError`: no
    // response body, no certificate material, and a `retryable` flag callers
    // can act on instead of substring-matching the message.
    if (resp.status === 429) {
      throw new CloudflareMtlsError(
        'issue',
        429,
        true,
        'Cloudflare mTLS certificate issuance rate limited',
      );
    }

    if (!resp.ok) {
      throw new CloudflareMtlsError(
        'issue',
        resp.status,
        resp.status >= 500,
        resp.status >= 500
          ? 'Cloudflare mTLS certificate issuance failed with a provider server error'
          : 'Cloudflare mTLS certificate issuance failed with a provider client error',
      );
    }

    const json = await resp.json() as {
      success: boolean;
      result: {
        id: string;
        certificate: string;
        private_key: string;
        serial_number: string;
        expires_on: string;
        issued_on: string;
      };
    };

    if (!json.success || !json.result) {
      throw new Error('Cloudflare API returned unsuccessful response');
    }

    return {
      id: json.result.id,
      certificate: json.result.certificate,
      privateKey: json.result.private_key,
      serialNumber: json.result.serial_number,
      expiresOn: json.result.expires_on,
      issuedOn: json.result.issued_on,
    };
  }

  /**
   * Revokes a client certificate at the provider. Returns a typed outcome
   * (`revoked` for 2xx, `not_found` for 404 — Cloudflare's own idempotent
   * "already gone" signal, treated as a completed revocation) or throws a
   * `CloudflareMtlsError` for every other case. `.message` never includes the
   * `providerCertificateId` argument or the upstream response body — those are
   * exactly the values SR (Wave 5 Task 3) forbids from ever reaching a log or
   * the `last_revoke_error` column.
   */
  async revokeCertificate(providerCertificateId: string): Promise<CertificateRevocationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS);
    let resp: Pick<Response, 'status' | 'ok'>;
    try {
      resp = await fetch(`${this.baseUrl}/client_certificates/${providerCertificateId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiToken}`,
        },
        signal: controller.signal,
      });
    } catch {
      // Network failure, DNS failure, or the AbortController firing on
      // timeout all land here — fetch never gives us a status in any of these
      // cases, so they're indistinguishable and all retryable.
      throw new CloudflareMtlsError(
        'revoke',
        undefined,
        true,
        'Cloudflare mTLS certificate revocation request failed or timed out',
      );
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 404) {
      return 'not_found';
    }
    if (resp.ok) {
      return 'revoked';
    }
    if (resp.status === 429) {
      throw new CloudflareMtlsError('revoke', 429, true, 'Cloudflare mTLS certificate revocation rate limited');
    }
    if (resp.status >= 500) {
      throw new CloudflareMtlsError(
        'revoke',
        resp.status,
        true,
        'Cloudflare mTLS certificate revocation failed with a provider server error',
      );
    }
    throw new CloudflareMtlsError(
      'revoke',
      resp.status,
      false,
      'Cloudflare mTLS certificate revocation failed with a provider client error',
    );
  }
}

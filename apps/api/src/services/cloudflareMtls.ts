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

    if (resp.status === 429) {
      throw new Error('Cloudflare rate limit exceeded (429). Retry later.');
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '(unable to read response body)');
      throw new Error(`Cloudflare API error ${resp.status}: ${text}`);
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

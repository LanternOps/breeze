/**
 * Cloudflare mTLS Client Certificate management via API Shield.
 *
 * This service is entirely optional. When CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ZONE_ID are not set, all public methods return null
 * and no network calls are made.
 */

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

  async revokeCertificate(certId: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/client_certificates/${certId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
      },
    });

    if (resp.status === 429) {
      throw new Error('Cloudflare rate limit exceeded (429). Retry later.');
    }

    if (!resp.ok && resp.status !== 404) {
      const text = await resp.text().catch(() => '(unable to read response body)');
      throw new Error(`Cloudflare API error ${resp.status}: ${text}`);
    }
  }
}

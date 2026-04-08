// Module-level singleton so instance persists across requests
let _instance: MsiSigningService | null | undefined;

/**
 * Server-side MSI Authenticode signing via a remote Windows signing service.
 * The signing VM runs signtool + Azure Trusted Signing dlib behind a
 * Cloudflare Access tunnel. Entirely optional — returns null from fromEnv()
 * when not configured.
 */
export class MsiSigningService {
  constructor(
    private signingUrl: string,
    private cfAccessId: string | undefined,
    private cfAccessSecret: string | undefined,
  ) {}

  static fromEnv(): MsiSigningService | null {
    if (_instance !== undefined) return _instance;

    const signingUrl = process.env.MSI_SIGNING_URL?.trim();
    if (!signingUrl) {
      _instance = null;
      return null;
    }

    const cfAccessId = process.env.MSI_SIGNING_CF_ACCESS_ID?.trim();
    const cfAccessSecret = process.env.MSI_SIGNING_CF_ACCESS_SECRET?.trim();

    _instance = new MsiSigningService(signingUrl, cfAccessId, cfAccessSecret);
    return _instance;
  }

  /** Reset the singleton — for testing only. */
  static _resetForTests(): void {
    _instance = undefined;
  }

  async signMsi(msiBuffer: Buffer): Promise<Buffer> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
    };

    // Cloudflare Access service token auth
    if (this.cfAccessId && this.cfAccessSecret) {
      headers['CF-Access-Client-Id'] = this.cfAccessId;
      headers['CF-Access-Client-Secret'] = this.cfAccessSecret;
    }

    const resp = await fetch(this.signingUrl, {
      method: 'POST',
      headers,
      body: msiBuffer,
      signal: AbortSignal.timeout(120_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`MSI signing service returned ${resp.status}: ${text.slice(0, 500)}`);
    }

    const signed = Buffer.from(await resp.arrayBuffer());
    if (signed.length < 1024) {
      throw new Error(`Signed MSI is suspiciously small (${signed.length} bytes) — signing service may have returned an error`);
    }

    return signed;
  }
}

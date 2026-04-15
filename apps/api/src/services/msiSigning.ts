import { z } from 'zod';

// Module-level singleton so instance persists across requests
let _instance: MsiSigningService | null | undefined;

/**
 * Wire-format schema for the POST body sent to the remote signing service.
 *
 * Property names are intentionally SCREAMING_SNAKE: they are MSI Property-table
 * identifiers passed verbatim to `MsiDatabase.OpenView` on the signing VM.
 * Hiding them behind a camelCase mirror would add a transform layer for zero
 * safety gain.
 *
 * Validation is deliberately loose — catch injection and empty-string garbage
 * before making a network call, but don't enforce policy the signing service
 * owns. Self-hosters may legitimately use `"latest"` for `version` or
 * `http://` for `SERVER_URL` in dev, so neither is rejected here.
 */
/* eslint-disable @typescript-eslint/naming-convention */
export const BuildAndSignRequestSchema = z.object({
  version: z
    .string()
    .min(1, 'version must not be empty')
    .max(64, 'version exceeds 64 char limit'),
  properties: z.object({
    SERVER_URL: z
      .string()
      .url('SERVER_URL must be a valid URL')
      .max(512, 'SERVER_URL exceeds 512 char limit'),
    ENROLLMENT_KEY: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'ENROLLMENT_KEY must be 64 lowercase hex characters'),
    ENROLLMENT_SECRET: z
      .string()
      .regex(
        /^[\x20-\x7e]{1,512}$/,
        'ENROLLMENT_SECRET must be 1-512 printable ASCII characters',
      )
      .optional(),
  }),
});
/* eslint-enable @typescript-eslint/naming-convention */

export type BuildAndSignRequest = z.infer<typeof BuildAndSignRequestSchema>;
export type BuildAndSignProperties = BuildAndSignRequest['properties'];

// OLE2 compound document signature — all MSI files begin with these 8 bytes.
// Guards against the "2xx with HTML login page / JSON error body / wrong
// content-type" failure mode that the size check alone cannot catch.
const MSI_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * Server-side MSI build-and-sign via a remote Windows signing service.
 *
 * The signing service fetches the template MSI for the requested version
 * from the GitHub release, verifies it against checksums.txt, injects the
 * supplied properties via the Windows Installer COM API, and signs with
 * signtool + Azure Trusted Signing dlib. Entirely optional — fromEnv()
 * returns null when MSI_SIGNING_URL is unset, in which case callers fall
 * back to the zip-bundle installer path.
 */
export class MsiSigningService {
  constructor(
    private signingUrl: string,
    private cfAccessId: string | undefined,
    private cfAccessSecret: string | undefined,
    private apiKey: string | undefined,
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
    const apiKey = process.env.MSI_SIGNING_API_KEY?.trim();

    _instance = new MsiSigningService(signingUrl, cfAccessId, cfAccessSecret, apiKey);
    return _instance;
  }

  /** Reset the singleton — for testing only. */
  static _resetForTests(): void {
    _instance = undefined;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    // Cloudflare Access service token — authenticates the tunnel itself.
    if (this.cfAccessId && this.cfAccessSecret) {
      headers['CF-Access-Client-Id'] = this.cfAccessId;
      headers['CF-Access-Client-Secret'] = this.cfAccessSecret;
    }
    // Per-account API key — authenticates the caller to the signing service.
    // Minted per account via manage-accounts.ps1, SHA256-hashed on the VM.
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    return headers;
  }

  /**
   * Network liveness + health check for the signing service. Used by the
   * installer-link route to fail fast before creating an orphaned child
   * enrollment key.
   *
   * Targets `GET /health` at the origin of signingUrl (not HEAD on the sign
   * endpoint itself — the signing server hangs on HEAD, and /health is the
   * endpoint the deploy explicitly exposes for liveness probes). Any non-2xx
   * is treated as unhealthy so a sick service (503), misconfigured CF Access
   * (401), or wrong DNS/TCP (network error) all produce the same clear
   * failure at link-creation time.
   */
  async probe(): Promise<void> {
    const healthUrl = new URL('/health', this.signingUrl).toString();
    try {
      const resp = await fetch(healthUrl, {
        method: 'GET',
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) {
        throw new Error(`/health returned ${resp.status}`);
      }
    } catch (err) {
      throw new Error(
        `MSI signing service unreachable at ${healthUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async buildAndSignMsi(request: BuildAndSignRequest): Promise<Buffer> {
    const parsed = BuildAndSignRequestSchema.safeParse(request);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid MSI signing request: ${issues}`);
    }

    const resp = await fetch(this.signingUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify(parsed.data),
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
    if (!signed.subarray(0, 8).equals(MSI_MAGIC)) {
      throw new Error(
        `Signing service returned non-MSI body (magic bytes: ${signed.subarray(0, 8).toString('hex')})`,
      );
    }

    return signed;
  }
}

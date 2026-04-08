import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

// Module-level singleton so token cache persists across requests
let _instance: MsiSigningService | null | undefined;

/**
 * Server-side MSI Authenticode signing via jsign + Azure Trusted Signing.
 * Entirely optional — returns null from fromEnv() when not configured.
 */
export class MsiSigningService {
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(
    private endpoint: string,
    private account: string,
    private profile: string,
    private tenantId: string,
    private clientId: string,
    private clientSecret: string,
  ) {}

  static fromEnv(): MsiSigningService | null {
    if (_instance !== undefined) return _instance;

    const endpoint = process.env.AZURE_SIGNING_ENDPOINT?.trim();
    const account = process.env.AZURE_SIGNING_ACCOUNT?.trim();
    const profile = process.env.AZURE_SIGNING_PROFILE?.trim();
    const tenantId = process.env.AZURE_SIGNING_TENANT_ID?.trim();
    const clientId = process.env.AZURE_SIGNING_CLIENT_ID?.trim();
    const clientSecret = process.env.AZURE_SIGNING_CLIENT_SECRET?.trim();

    if (!endpoint || !account || !profile || !tenantId || !clientId || !clientSecret) {
      _instance = null;
      return null;
    }

    _instance = new MsiSigningService(endpoint, account, profile, tenantId, clientId, clientSecret);
    return _instance;
  }

  /** Reset the singleton — for testing only. */
  static _resetForTests(): void {
    _instance = undefined;
  }

  async signMsi(msiBuffer: Buffer): Promise<Buffer> {
    // Token acquisition errors propagate with their own clear message
    const token = await this.getAccessToken();
    const jsignJar = process.env.JSIGN_BIN?.trim() || '/opt/jsign.jar';
    const workingDir = await mkdtemp(join(tmpdir(), 'msi-signing-'));

    try {
      const msiPath = join(workingDir, 'installer.msi');
      await writeFile(msiPath, msiBuffer);

      // Write token to temp file to avoid exposing it in process listing
      const tokenPath = join(workingDir, '.storepass');
      await writeFile(tokenPath, token, { mode: 0o600 });

      // jsign expects bare hostname (e.g. wcus.codesigning.azure.net), not a full URL
      const keystoreHost = this.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');

      await execFileAsync('java', [
        '-jar', jsignJar,
        '--storetype', 'TRUSTEDSIGNING',
        '--keystore', keystoreHost,
        '--storepass', `file:${tokenPath}`,
        '--alias', `${this.account}/${this.profile}`,
        msiPath,
      ], { timeout: 60_000 });

      return await readFile(msiPath);
    } catch (error) {
      throw new Error(
        `MSI signing failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      await rm(workingDir, { recursive: true, force: true }).catch((cleanupErr) => {
        console.error('[msi-signing] Failed to clean up temp dir:', workingDir,
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
      });
    }
  }

  /** Acquire an Azure AD access token for the Trusted Signing scope, with caching. */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now) {
      return this.cachedToken.token;
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'https://codesigning.azure.net/.default',
      grant_type: 'client_credentials',
    });

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Azure token request failed (${resp.status}): ${text}`);
    }

    const data = (await resp.json()) as Record<string, unknown>;
    if (!data.access_token || typeof data.expires_in !== 'number') {
      throw new Error(`Azure token response missing required fields: ${JSON.stringify(data).slice(0, 200)}`);
    }

    // Cache with safety margin (half the TTL or 5 minutes, whichever is smaller)
    const safetyMarginSecs = Math.min(300, Math.floor(data.expires_in / 2));
    this.cachedToken = {
      token: data.access_token as string,
      expiresAt: now + (data.expires_in - safetyMarginSecs) * 1000,
    };

    return data.access_token as string;
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MsiSigningService } from './msiSigning';

// Mock child_process.execFile (safe — no shell injection)
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: any, cb: any) => {
    if (cb) cb(null, '', '');
    return { on: vi.fn() };
  }),
}));

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/tmp/msi-signing-abc123'),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.from('signed-msi-content')),
  rm: vi.fn(async () => undefined),
}));

// Mock fetch for token acquisition
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const ENV_VARS = {
  AZURE_SIGNING_ENDPOINT: 'weu.codesigning.azure.net',
  AZURE_SIGNING_ACCOUNT: 'test-account',
  AZURE_SIGNING_PROFILE: 'test-profile',
  AZURE_SIGNING_TENANT_ID: 'tenant-123',
  AZURE_SIGNING_CLIENT_ID: 'client-456',
  AZURE_SIGNING_CLIENT_SECRET: 'secret-789',
};

describe('MsiSigningService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MsiSigningService._resetForTests();
  });

  afterEach(() => {
    for (const key of Object.keys(ENV_VARS)) {
      delete process.env[key];
    }
    MsiSigningService._resetForTests();
  });

  describe('fromEnv', () => {
    it('returns null when no env vars set', () => {
      expect(MsiSigningService.fromEnv()).toBeNull();
    });

    it('returns null when only some env vars set', () => {
      process.env.AZURE_SIGNING_ENDPOINT = 'weu.codesigning.azure.net';
      process.env.AZURE_SIGNING_ACCOUNT = 'test-account';
      expect(MsiSigningService.fromEnv()).toBeNull();
    });

    it('returns instance when all env vars set', () => {
      for (const [key, val] of Object.entries(ENV_VARS)) {
        process.env[key] = val;
      }
      const service = MsiSigningService.fromEnv();
      expect(service).toBeInstanceOf(MsiSigningService);
    });

    it('returns null when any single var is empty string', () => {
      for (const [key, val] of Object.entries(ENV_VARS)) {
        process.env[key] = val;
      }
      process.env.AZURE_SIGNING_PROFILE = '';
      expect(MsiSigningService.fromEnv()).toBeNull();
    });

    it('returns cached singleton on repeated calls', () => {
      for (const [key, val] of Object.entries(ENV_VARS)) {
        process.env[key] = val;
      }
      const first = MsiSigningService.fromEnv();
      const second = MsiSigningService.fromEnv();
      expect(first).toBe(second);
    });
  });

  describe('getAccessToken', () => {
    it('fetches token from Azure AD', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'test-token', expires_in: 3600 }),
      });

      const service = new MsiSigningService(
        ENV_VARS.AZURE_SIGNING_ENDPOINT,
        ENV_VARS.AZURE_SIGNING_ACCOUNT,
        ENV_VARS.AZURE_SIGNING_PROFILE,
        ENV_VARS.AZURE_SIGNING_TENANT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_SECRET,
      );

      const token = await service.getAccessToken();
      expect(token).toBe('test-token');
      expect(mockFetch).toHaveBeenCalledWith(
        `https://login.microsoftonline.com/${ENV_VARS.AZURE_SIGNING_TENANT_ID}/oauth2/v2.0/token`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('caches token on subsequent calls', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'cached-token', expires_in: 3600 }),
      });

      const service = new MsiSigningService(
        ENV_VARS.AZURE_SIGNING_ENDPOINT,
        ENV_VARS.AZURE_SIGNING_ACCOUNT,
        ENV_VARS.AZURE_SIGNING_PROFILE,
        ENV_VARS.AZURE_SIGNING_TENANT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_SECRET,
      );

      await service.getAccessToken();
      const token2 = await service.getAccessToken();

      expect(token2).toBe('cached-token');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws on Azure AD error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const service = new MsiSigningService(
        ENV_VARS.AZURE_SIGNING_ENDPOINT,
        ENV_VARS.AZURE_SIGNING_ACCOUNT,
        ENV_VARS.AZURE_SIGNING_PROFILE,
        ENV_VARS.AZURE_SIGNING_TENANT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_SECRET,
      );

      await expect(service.getAccessToken()).rejects.toThrow('Azure token request failed (401)');
    });

    it('throws on malformed token response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ error: 'invalid_grant' }),
      });

      const service = new MsiSigningService(
        ENV_VARS.AZURE_SIGNING_ENDPOINT,
        ENV_VARS.AZURE_SIGNING_ACCOUNT,
        ENV_VARS.AZURE_SIGNING_PROFILE,
        ENV_VARS.AZURE_SIGNING_TENANT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_SECRET,
      );

      await expect(service.getAccessToken()).rejects.toThrow('missing required fields');
    });

    it('uses smaller safety margin for short-lived tokens', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'short-token', expires_in: 60 }),
      });

      const service = new MsiSigningService(
        ENV_VARS.AZURE_SIGNING_ENDPOINT,
        ENV_VARS.AZURE_SIGNING_ACCOUNT,
        ENV_VARS.AZURE_SIGNING_PROFILE,
        ENV_VARS.AZURE_SIGNING_TENANT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_SECRET,
      );

      const token = await service.getAccessToken();
      expect(token).toBe('short-token');
      // Should not throw — safety margin is clamped to half the TTL
    });
  });

  describe('signMsi', () => {
    it('writes temp file, invokes jsign with file-based storepass, reads result, cleans up', async () => {
      const { writeFile, readFile, rm, mkdtemp } = await import('node:fs/promises');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'sign-token', expires_in: 3600 }),
      });

      const service = new MsiSigningService(
        ENV_VARS.AZURE_SIGNING_ENDPOINT,
        ENV_VARS.AZURE_SIGNING_ACCOUNT,
        ENV_VARS.AZURE_SIGNING_PROFILE,
        ENV_VARS.AZURE_SIGNING_TENANT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_SECRET,
      );

      const input = Buffer.from('unsigned-msi');
      const result = await service.signMsi(input);

      expect(mkdtemp).toHaveBeenCalled();
      // MSI written to temp dir
      expect(writeFile).toHaveBeenCalledWith(
        '/tmp/msi-signing-abc123/installer.msi',
        input,
      );
      // Token written to temp file with restricted permissions
      expect(writeFile).toHaveBeenCalledWith(
        '/tmp/msi-signing-abc123/.storepass',
        'sign-token',
        { mode: 0o600 },
      );
      expect(readFile).toHaveBeenCalledWith('/tmp/msi-signing-abc123/installer.msi');
      expect(rm).toHaveBeenCalledWith('/tmp/msi-signing-abc123', { recursive: true, force: true });
      expect(result.toString()).toBe('signed-msi-content');
    });

    it('passes file-based storepass to jsign (not raw token)', async () => {
      const { execFile } = await import('node:child_process');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'secret-token', expires_in: 3600 }),
      });

      const service = new MsiSigningService(
        ENV_VARS.AZURE_SIGNING_ENDPOINT,
        ENV_VARS.AZURE_SIGNING_ACCOUNT,
        ENV_VARS.AZURE_SIGNING_PROFILE,
        ENV_VARS.AZURE_SIGNING_TENANT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_SECRET,
      );

      await service.signMsi(Buffer.from('test'));

      const execCall = vi.mocked(execFile).mock.calls[0]!;
      const args = execCall[1] as string[];
      // Token should NOT appear directly in args
      expect(args).not.toContain('secret-token');
      // Should use file reference instead
      expect(args).toContain('file:/tmp/msi-signing-abc123/.storepass');
    });

    it('cleans up temp dir on exec failure', async () => {
      const { execFile } = await import('node:child_process');
      const { rm } = await import('node:fs/promises');

      vi.mocked(execFile).mockImplementationOnce(
        (_cmd: any, _args: any, _opts: any, cb: any) => {
          if (cb) cb(new Error('jsign crashed'), '', 'error output');
          return { on: vi.fn() } as any;
        },
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'token', expires_in: 3600 }),
      });

      const service = new MsiSigningService(
        ENV_VARS.AZURE_SIGNING_ENDPOINT,
        ENV_VARS.AZURE_SIGNING_ACCOUNT,
        ENV_VARS.AZURE_SIGNING_PROFILE,
        ENV_VARS.AZURE_SIGNING_TENANT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_SECRET,
      );

      await expect(service.signMsi(Buffer.from('test'))).rejects.toThrow('MSI signing failed');
      expect(rm).toHaveBeenCalledWith('/tmp/msi-signing-abc123', { recursive: true, force: true });
    });

    it('lets token acquisition errors propagate with their own message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      const service = new MsiSigningService(
        ENV_VARS.AZURE_SIGNING_ENDPOINT,
        ENV_VARS.AZURE_SIGNING_ACCOUNT,
        ENV_VARS.AZURE_SIGNING_PROFILE,
        ENV_VARS.AZURE_SIGNING_TENANT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_ID,
        ENV_VARS.AZURE_SIGNING_CLIENT_SECRET,
      );

      // Error should say "Azure token" not "sign MSI with jsign"
      await expect(service.signMsi(Buffer.from('test'))).rejects.toThrow('Azure token request failed');
    });
  });
});

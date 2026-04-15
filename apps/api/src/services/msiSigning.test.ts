import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MsiSigningService } from './msiSigning';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const MSI_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Build a fake signed-MSI buffer that passes both the size and magic-byte checks. */
function fakeSignedMsi(): Buffer {
  const body = Buffer.alloc(2048, 0xbb);
  MSI_MAGIC.copy(body, 0);
  return body;
}

const SAMPLE_REQUEST = {
  version: '0.62.24',
  properties: {
    SERVER_URL: 'https://breeze.example.com',
    ENROLLMENT_KEY: 'a'.repeat(64),
    ENROLLMENT_SECRET: 'shared-deployment-secret',
  },
} as const;

function mockSignedResponse(content = fakeSignedMsi()) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    arrayBuffer: async () => content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ),
  });
}

describe('MsiSigningService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MsiSigningService._resetForTests();
  });

  afterEach(() => {
    delete process.env.MSI_SIGNING_URL;
    delete process.env.MSI_SIGNING_CF_ACCESS_ID;
    delete process.env.MSI_SIGNING_CF_ACCESS_SECRET;
    delete process.env.MSI_SIGNING_API_KEY;
    MsiSigningService._resetForTests();
  });

  describe('fromEnv', () => {
    it('returns null when MSI_SIGNING_URL not set', () => {
      expect(MsiSigningService.fromEnv()).toBeNull();
    });

    it('returns instance when MSI_SIGNING_URL is set', () => {
      process.env.MSI_SIGNING_URL = 'https://sign.2breeze.app/sign-breeze-agent';
      const service = MsiSigningService.fromEnv();
      expect(service).toBeInstanceOf(MsiSigningService);
    });

    it('returns cached singleton on repeated calls', () => {
      process.env.MSI_SIGNING_URL = 'https://sign.2breeze.app/sign-breeze-agent';
      const first = MsiSigningService.fromEnv();
      const second = MsiSigningService.fromEnv();
      expect(first).toBe(second);
    });

    it('returns null when MSI_SIGNING_URL is empty', () => {
      process.env.MSI_SIGNING_URL = '';
      expect(MsiSigningService.fromEnv()).toBeNull();
    });
  });

  describe('buildAndSignMsi', () => {
    it('POSTs JSON body to signing URL and returns signed bytes', async () => {
      mockSignedResponse();

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      const result = await service.buildAndSignMsi(SAMPLE_REQUEST);

      expect(result.length).toBe(2048);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://sign.example.com/sign-breeze-agent');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual(SAMPLE_REQUEST);
    });

    it('includes Cloudflare Access headers when configured', async () => {
      mockSignedResponse();

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        'cf-access-id-123',
        'cf-access-secret-456',
        undefined,
      );
      await service.buildAndSignMsi(SAMPLE_REQUEST);

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['CF-Access-Client-Id']).toBe('cf-access-id-123');
      expect(headers['CF-Access-Client-Secret']).toBe('cf-access-secret-456');
    });

    it('includes X-API-Key when configured', async () => {
      mockSignedResponse();

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        'bsk_test_key_123',
      );
      await service.buildAndSignMsi(SAMPLE_REQUEST);

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['X-API-Key']).toBe('bsk_test_key_123');
    });

    it('does not include auth headers when not configured', async () => {
      mockSignedResponse();

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await service.buildAndSignMsi(SAMPLE_REQUEST);

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['CF-Access-Client-Id']).toBeUndefined();
      expect(headers['CF-Access-Client-Secret']).toBeUndefined();
      expect(headers['X-API-Key']).toBeUndefined();
    });

    it('passes through ENROLLMENT_SECRET when present', async () => {
      mockSignedResponse();

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await service.buildAndSignMsi(SAMPLE_REQUEST);

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.properties.ENROLLMENT_SECRET).toBe('shared-deployment-secret');
    });

    it('omits ENROLLMENT_SECRET when caller does not supply one', async () => {
      mockSignedResponse();

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await service.buildAndSignMsi({
        version: '0.62.24',
        properties: {
          SERVER_URL: 'https://breeze.example.com',
          ENROLLMENT_KEY: 'a'.repeat(64),
        },
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
      expect(body.properties).not.toHaveProperty('ENROLLMENT_SECRET');
    });

    it('throws on non-200 response and surfaces upstream error body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'version 99.99.99 not found in checksums.txt',
      });

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await expect(service.buildAndSignMsi(SAMPLE_REQUEST)).rejects.toThrow(/version 99\.99\.99 not found/);
    });

    it('throws on suspiciously small response', async () => {
      const tiny = Buffer.from('error');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => tiny.buffer.slice(
          tiny.byteOffset,
          tiny.byteOffset + tiny.byteLength,
        ),
      });

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await expect(service.buildAndSignMsi(SAMPLE_REQUEST)).rejects.toThrow('suspiciously small');
    });

    it('throws on non-MSI body (e.g. HTML login page with valid size)', async () => {
      // Simulate a CF Access login page (HTML) large enough to pass the size
      // check but without the MSI magic bytes.
      const htmlPage = Buffer.alloc(4096, 0);
      htmlPage.write('<!DOCTYPE html><html><body>Cloudflare Access login</body></html>');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => htmlPage.buffer.slice(
          htmlPage.byteOffset,
          htmlPage.byteOffset + htmlPage.byteLength,
        ),
      });

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await expect(service.buildAndSignMsi(SAMPLE_REQUEST)).rejects.toThrow(/non-MSI body/);
    });

    it('throws on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await expect(service.buildAndSignMsi(SAMPLE_REQUEST)).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('buildAndSignMsi — input validation (Zod)', () => {
    const service = new MsiSigningService(
      'https://sign.example.com/sign-breeze-agent',
      undefined,
      undefined,
      undefined,
    );

    it('accepts version="latest" (self-hoster default, signing service decides policy)', async () => {
      mockSignedResponse();
      await expect(
        service.buildAndSignMsi({ ...SAMPLE_REQUEST, version: 'latest' }),
      ).resolves.toBeInstanceOf(Buffer);
    });

    it('accepts bare semver version', async () => {
      mockSignedResponse();
      await expect(
        service.buildAndSignMsi({ ...SAMPLE_REQUEST, version: '0.62.24' }),
      ).resolves.toBeInstanceOf(Buffer);
    });

    it('accepts v-prefixed semver version (signing service tag format)', async () => {
      mockSignedResponse();
      await expect(
        service.buildAndSignMsi({ ...SAMPLE_REQUEST, version: 'v0.62.24' }),
      ).resolves.toBeInstanceOf(Buffer);
    });

    it('accepts version with prerelease suffix', async () => {
      mockSignedResponse();
      await expect(
        service.buildAndSignMsi({ ...SAMPLE_REQUEST, version: '0.62.24-rc.2' }),
      ).resolves.toBeInstanceOf(Buffer);
    });

    it('rejects empty version', async () => {
      await expect(
        service.buildAndSignMsi({ ...SAMPLE_REQUEST, version: '' }),
      ).rejects.toThrow(/version/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('accepts http:// SERVER_URL (self-hoster dev setups)', async () => {
      mockSignedResponse();
      await expect(
        service.buildAndSignMsi({
          version: '0.62.24',
          properties: { ...SAMPLE_REQUEST.properties, SERVER_URL: 'http://breeze.local' },
        }),
      ).resolves.toBeInstanceOf(Buffer);
    });

    it('rejects ENROLLMENT_KEY that is not 64 hex chars', async () => {
      await expect(
        service.buildAndSignMsi({
          version: '0.62.24',
          properties: { ...SAMPLE_REQUEST.properties, ENROLLMENT_KEY: 'too-short' },
        }),
      ).rejects.toThrow(/ENROLLMENT_KEY/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects ENROLLMENT_KEY with uppercase hex', async () => {
      await expect(
        service.buildAndSignMsi({
          version: '0.62.24',
          properties: { ...SAMPLE_REQUEST.properties, ENROLLMENT_KEY: 'A'.repeat(64) },
        }),
      ).rejects.toThrow(/ENROLLMENT_KEY/);
    });

    it('rejects ENROLLMENT_SECRET with control characters', async () => {
      await expect(
        service.buildAndSignMsi({
          version: '0.62.24',
          properties: { ...SAMPLE_REQUEST.properties, ENROLLMENT_SECRET: 'bad\nnewline' },
        }),
      ).rejects.toThrow(/ENROLLMENT_SECRET/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects SERVER_URL longer than 512 chars', async () => {
      const longUrl = 'https://' + 'a'.repeat(510) + '.com';
      await expect(
        service.buildAndSignMsi({
          version: '0.62.24',
          properties: { ...SAMPLE_REQUEST.properties, SERVER_URL: longUrl },
        }),
      ).rejects.toThrow(/SERVER_URL/);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('probe', () => {
    it('GETs /health at the origin of the signing URL', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await expect(service.probe()).resolves.toBeUndefined();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://sign.example.com/health');
      expect(init.method).toBe('GET');
    });

    it('throws when /health returns non-2xx (sick but reachable)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await expect(service.probe()).rejects.toThrow(/503/);
    });

    it('throws on 401 (CF Access blocking /health)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await expect(service.probe()).rejects.toThrow(/401/);
    });

    it('throws on network-level failure (DNS / TCP)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND sign.example.com'));

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await expect(service.probe()).rejects.toThrow(/unreachable/);
    });

    it('throws on timeout', async () => {
      const timeoutErr = new Error('The operation was aborted due to timeout');
      timeoutErr.name = 'TimeoutError';
      mockFetch.mockRejectedValueOnce(timeoutErr);

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        undefined,
      );
      await expect(service.probe()).rejects.toThrow(/unreachable/);
    });

    it('sends CF Access headers on the probe', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        'cf-id',
        'cf-secret',
        undefined,
      );
      await service.probe();

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['CF-Access-Client-Id']).toBe('cf-id');
      expect(headers['CF-Access-Client-Secret']).toBe('cf-secret');
    });

    it('sends X-API-Key on the probe', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });

      const service = new MsiSigningService(
        'https://sign.example.com/sign-breeze-agent',
        undefined,
        undefined,
        'bsk_test_key_456',
      );
      await service.probe();

      const headers = mockFetch.mock.calls[0]![1].headers;
      expect(headers['X-API-Key']).toBe('bsk_test_key_456');
    });
  });
});

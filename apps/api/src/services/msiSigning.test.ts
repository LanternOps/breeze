import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MsiSigningService } from './msiSigning';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('MsiSigningService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    MsiSigningService._resetForTests();
  });

  afterEach(() => {
    delete process.env.MSI_SIGNING_URL;
    delete process.env.MSI_SIGNING_CF_ACCESS_ID;
    delete process.env.MSI_SIGNING_CF_ACCESS_SECRET;
    MsiSigningService._resetForTests();
  });

  describe('fromEnv', () => {
    it('returns null when MSI_SIGNING_URL not set', () => {
      expect(MsiSigningService.fromEnv()).toBeNull();
    });

    it('returns instance when MSI_SIGNING_URL is set', () => {
      process.env.MSI_SIGNING_URL = 'https://sign.2breeze.app/sign';
      const service = MsiSigningService.fromEnv();
      expect(service).toBeInstanceOf(MsiSigningService);
    });

    it('returns cached singleton on repeated calls', () => {
      process.env.MSI_SIGNING_URL = 'https://sign.2breeze.app/sign';
      const first = MsiSigningService.fromEnv();
      const second = MsiSigningService.fromEnv();
      expect(first).toBe(second);
    });

    it('returns null when MSI_SIGNING_URL is empty', () => {
      process.env.MSI_SIGNING_URL = '';
      expect(MsiSigningService.fromEnv()).toBeNull();
    });
  });

  describe('signMsi', () => {
    it('POSTs MSI buffer to signing URL and returns signed bytes', async () => {
      const signedContent = Buffer.alloc(2048, 0xbb);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => signedContent.buffer.slice(
          signedContent.byteOffset,
          signedContent.byteOffset + signedContent.byteLength,
        ),
      });

      const service = new MsiSigningService('https://sign.example.com/sign', undefined, undefined);
      const input = Buffer.alloc(2048, 0xaa);
      const result = await service.signMsi(input);

      expect(result.length).toBe(2048);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://sign.example.com/sign',
        expect.objectContaining({
          method: 'POST',
          body: new Uint8Array(input),
        }),
      );
    });

    it('includes Cloudflare Access headers when configured', async () => {
      const signedContent = Buffer.alloc(2048, 0xbb);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => signedContent.buffer.slice(
          signedContent.byteOffset,
          signedContent.byteOffset + signedContent.byteLength,
        ),
      });

      const service = new MsiSigningService(
        'https://sign.example.com/sign',
        'cf-access-id-123',
        'cf-access-secret-456',
      );
      await service.signMsi(Buffer.alloc(2048, 0xaa));

      const fetchCall = mockFetch.mock.calls[0]!;
      const headers = fetchCall[1].headers;
      expect(headers['CF-Access-Client-Id']).toBe('cf-access-id-123');
      expect(headers['CF-Access-Client-Secret']).toBe('cf-access-secret-456');
    });

    it('does not include CF headers when not configured', async () => {
      const signedContent = Buffer.alloc(2048, 0xbb);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => signedContent.buffer.slice(
          signedContent.byteOffset,
          signedContent.byteOffset + signedContent.byteLength,
        ),
      });

      const service = new MsiSigningService('https://sign.example.com/sign', undefined, undefined);
      await service.signMsi(Buffer.alloc(2048, 0xaa));

      const fetchCall = mockFetch.mock.calls[0]!;
      const headers = fetchCall[1].headers;
      expect(headers['CF-Access-Client-Id']).toBeUndefined();
      expect(headers['CF-Access-Client-Secret']).toBeUndefined();
    });

    it('throws on non-200 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'signtool failed',
      });

      const service = new MsiSigningService('https://sign.example.com/sign', undefined, undefined);
      await expect(service.signMsi(Buffer.alloc(2048))).rejects.toThrow('MSI signing service returned 500');
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

      const service = new MsiSigningService('https://sign.example.com/sign', undefined, undefined);
      await expect(service.signMsi(Buffer.alloc(2048))).rejects.toThrow('suspiciously small');
    });

    it('throws on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const service = new MsiSigningService('https://sign.example.com/sign', undefined, undefined);
      await expect(service.signMsi(Buffer.alloc(2048))).rejects.toThrow('ECONNREFUSED');
    });
  });
});

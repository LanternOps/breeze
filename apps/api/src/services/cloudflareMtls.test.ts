import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareMtlsError,
  CloudflareMtlsService,
  categorizeCloudflareMtlsError,
} from './cloudflareMtls';

const SENSITIVE_PROVIDER_ID = 'cf-provider-cert-id-should-never-leak';

function mockFetchOnce(response: { status: number; ok?: boolean }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    status: response.status,
    ok: response.ok ?? (response.status >= 200 && response.status < 300),
    text: async () => 'unused response body',
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('CloudflareMtlsService.revokeCertificate', () => {
  let service: CloudflareMtlsService;

  beforeEach(() => {
    service = new CloudflareMtlsService('test-api-token', 'test-zone-id');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns "revoked" for a 2xx response', async () => {
    mockFetchOnce({ status: 200 });
    await expect(service.revokeCertificate(SENSITIVE_PROVIDER_ID)).resolves.toBe('revoked');
  });

  it('returns "not_found" for a 404 response (already revoked)', async () => {
    mockFetchOnce({ status: 404, ok: false });
    await expect(service.revokeCertificate(SENSITIVE_PROVIDER_ID)).resolves.toBe('not_found');
  });

  it('throws a retryable CloudflareMtlsError on 429', async () => {
    mockFetchOnce({ status: 429, ok: false });
    await expect(service.revokeCertificate(SENSITIVE_PROVIDER_ID)).rejects.toMatchObject({
      operation: 'revoke',
      status: 429,
      retryable: true,
    });
  });

  it('throws a retryable CloudflareMtlsError on 5xx', async () => {
    mockFetchOnce({ status: 503, ok: false });
    await expect(service.revokeCertificate(SENSITIVE_PROVIDER_ID)).rejects.toMatchObject({
      operation: 'revoke',
      status: 503,
      retryable: true,
    });
  });

  it('throws a non-retryable CloudflareMtlsError on other 4xx', async () => {
    mockFetchOnce({ status: 403, ok: false });
    await expect(service.revokeCertificate(SENSITIVE_PROVIDER_ID)).rejects.toMatchObject({
      operation: 'revoke',
      status: 403,
      retryable: false,
    });
  });

  it('throws a retryable CloudflareMtlsError with no status on network failure/timeout', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('AbortError: The operation was aborted');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(service.revokeCertificate(SENSITIVE_PROVIDER_ID)).rejects.toMatchObject({
      operation: 'revoke',
      status: undefined,
      retryable: true,
    });
  });

  it('never includes the provider certificate id in a thrown error message', async () => {
    mockFetchOnce({ status: 500, ok: false });
    try {
      await service.revokeCertificate(SENSITIVE_PROVIDER_ID);
      expect.fail('expected revokeCertificate to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CloudflareMtlsError);
      expect((err as Error).message).not.toContain(SENSITIVE_PROVIDER_ID);
    }
  });

  it('never includes the response body text in a thrown error message', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 500,
      ok: false,
      text: async () => 'super-secret-upstream-body-detail',
    }));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await service.revokeCertificate(SENSITIVE_PROVIDER_ID);
      expect.fail('expected revokeCertificate to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('super-secret-upstream-body-detail');
    }
  });
});

describe('categorizeCloudflareMtlsError', () => {
  it('categorizes a status-less error as timeout', () => {
    expect(categorizeCloudflareMtlsError(new CloudflareMtlsError('revoke', undefined, true, 'x'))).toBe('timeout');
  });

  it('categorizes 429 as rate_limited', () => {
    expect(categorizeCloudflareMtlsError(new CloudflareMtlsError('revoke', 429, true, 'x'))).toBe('rate_limited');
  });

  it('categorizes 5xx as provider_5xx', () => {
    expect(categorizeCloudflareMtlsError(new CloudflareMtlsError('revoke', 502, true, 'x'))).toBe('provider_5xx');
  });

  it('categorizes other 4xx as provider_4xx', () => {
    expect(categorizeCloudflareMtlsError(new CloudflareMtlsError('revoke', 401, false, 'x'))).toBe('provider_4xx');
  });

  it('falls back to timeout for a non-CloudflareMtlsError', () => {
    expect(categorizeCloudflareMtlsError(new Error('boom'))).toBe('timeout');
  });
});

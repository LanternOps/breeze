import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloudflareMtlsError,
  CloudflareMtlsService,
  categorizeCloudflareMtlsError,
  parseIssuedLeafCertificate,
} from './cloudflareMtls';

const SENSITIVE_PROVIDER_ID = 'cf-provider-cert-id-should-never-leak';

// Static fixture: a real self-signed EC P-256 cert (10y validity, CN=breeze-agent-new),
// generated once with `openssl req -x509 -newkey ec ...` and pinned here so the
// unit suite never shells out to openssl at test time. Expected serial/fingerprint/
// SPKI were derived once via `new crypto.X509Certificate(pem)` against this exact PEM.
const FIXTURE_LEAF_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBjDCCATGgAwIBAgIULdi98VWChh4CPbJOhNTfTOxBiicwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQYnJlZXplLWFnZW50LW5ldzAeFw0yNjA3MjcxOTI0MDRaFw0z
NjA3MjQxOTI0MDRaMBsxGTAXBgNVBAMMEGJyZWV6ZS1hZ2VudC1uZXcwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAARZFuMmkAztgQnzIk+4BrZrUCsCoaevo5Ib2bxO
68zpCSuzXken/TWXABS+PvkVqjcdLqZ6NbnOgCwUJyNaZSzzo1MwUTAdBgNVHQ4E
FgQUoK7QuRA6KOj9T/vaXj5Crwoi4FwwHwYDVR0jBBgwFoAUoK7QuRA6KOj9T/va
Xj5Crwoi4FwwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA7kwk
lgznC76pR5Z2n5gjiGOhGJqZbRY2cLfoC8Zs9zECIQDRO0VdLavsoCPppTVOPN9o
yMR+DE23HZhAN9jAjaIJFQ==
-----END CERTIFICATE-----`;
const FIXTURE_LEAF_CERT_SERIAL = '2DD8BDF15582861E023DB24E84D4DF4CEC418A27';
const FIXTURE_LEAF_CERT_FINGERPRINT_SHA256 =
  'd1de6d4090167e2531b9c8c4a5ea17a77972624b219e91e5a86805081944079f';
const FIXTURE_LEAF_CERT_SPKI_BASE64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWRbjJpAM7YEJ8yJPuAa2a1ArAqGnr6OSG9m8TuvM6Qkrs15Hp/01lwAUvj75Fao3HS6mejW5zoAsFCcjWmUs8w==';

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

describe('parseIssuedLeafCertificate', () => {
  it('derives the exact serial, lowercase-hex SHA-256 fingerprint, and base64 SPKI', () => {
    const parsed = parseIssuedLeafCertificate(FIXTURE_LEAF_CERT_PEM);
    expect(parsed).toEqual({
      serialNumber: FIXTURE_LEAF_CERT_SERIAL,
      fingerprintSha256: FIXTURE_LEAF_CERT_FINGERPRINT_SHA256,
      publicKeySpkiBase64: FIXTURE_LEAF_CERT_SPKI_BASE64,
    });
    // Never colon-separated, never uppercase — matches this codebase's other
    // sha256-hex conventions (e.g. agent token hashing) and the schema's
    // `char(64)` column.
    expect(parsed.fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('parses only the FIRST PEM block when given a leaf+intermediate bundle', () => {
    const bundle = `${FIXTURE_LEAF_CERT_PEM}\n${FIXTURE_LEAF_CERT_PEM}`;
    const parsed = parseIssuedLeafCertificate(bundle);
    expect(parsed.serialNumber).toBe(FIXTURE_LEAF_CERT_SERIAL);
  });

  it('throws on a PEM with no certificate block', () => {
    expect(() => parseIssuedLeafCertificate('not a certificate')).toThrow();
  });

  it('throws on a malformed certificate block', () => {
    const malformed = '-----BEGIN CERTIFICATE-----\nbm90LWEtcmVhbC1jZXJ0\n-----END CERTIFICATE-----';
    expect(() => parseIssuedLeafCertificate(malformed)).toThrow();
  });
});

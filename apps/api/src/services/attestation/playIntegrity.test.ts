import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPlayIntegrityForTests,
  isPlayIntegrityConfigured,
  parsePlayIntegrityServiceAccount,
  verifyPlayIntegrityToken,
  type PlayIntegrityTokenPayload,
} from './playIntegrity';

const PACKAGE = 'com.breeze.rmm';
const NOW = new Date('2026-09-05T12:00:00.000Z');
const REQUEST_HASH = 'dGhlLXRyYW5zY3JpcHQtZGlnZXN0';

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'breeze-test',
  client_email: 'play-integrity@breeze-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\\nZmFrZQ==\\n-----END PRIVATE KEY-----\\n',
};

function payload(overrides: Record<string, unknown> = {}): PlayIntegrityTokenPayload {
  return {
    requestDetails: {
      requestPackageName: PACKAGE,
      requestHash: REQUEST_HASH,
      timestampMillis: String(NOW.getTime() - 5_000),
      ...((overrides.requestDetails as object) ?? {}),
    },
    appIntegrity: {
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      packageName: PACKAGE,
      ...((overrides.appIntegrity as object) ?? {}),
    },
    deviceIntegrity: {
      deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY'],
      ...((overrides.deviceIntegrity as object) ?? {}),
    },
  } as PlayIntegrityTokenPayload;
}

/** A decoder seam standing in for the Play Integrity `decodeIntegrityToken` call. */
const decoderFor = (p: PlayIntegrityTokenPayload) => vi.fn().mockResolvedValue(p);

function opts(
  decodeIntegrityToken: ReturnType<typeof decoderFor>,
  extra: Record<string, unknown> = {},
) {
  return {
    packageName: PACKAGE,
    expectedRequestHash: REQUEST_HASH,
    now: NOW,
    decodeIntegrityToken,
    ...extra,
  };
}

describe('verifyPlayIntegrityToken (#1374 W04)', () => {
  const ORIGINAL = process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT;

  beforeEach(() => {
    __resetPlayIntegrityForTests();
    process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT = JSON.stringify(SERVICE_ACCOUNT);
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT;
    else process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT = ORIGINAL;
    __resetPlayIntegrityForTests();
  });

  it('accepts a verdict that meets device integrity and is Play-recognized', async () => {
    const decode = decoderFor(payload());
    const result = await verifyPlayIntegrityToken('token', opts(decode));

    expect(result).toEqual({
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      deviceRecognitionVerdicts: ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY'],
      packageName: PACKAGE,
    });
    expect(decode).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'token', packageName: PACKAGE }),
    );
  });

  it('returns null when no service account is configured, so registration still works', async () => {
    delete process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT;
    __resetPlayIntegrityForTests();
    const decode = decoderFor(payload());

    await expect(verifyPlayIntegrityToken('token', opts(decode))).resolves.toBeNull();
    // Never even attempts the call: an unconfigured deploy must not emit a
    // request that will 401 on every Android registration.
    expect(decode).not.toHaveBeenCalled();
    expect(isPlayIntegrityConfigured()).toBe(false);
  });

  it('rejects a verdict for a different package', async () => {
    const decode = decoderFor(
      payload({
        requestDetails: { requestPackageName: 'com.evil.app' },
        appIntegrity: { packageName: 'com.evil.app' },
      }),
    );
    await expect(verifyPlayIntegrityToken('token', opts(decode))).rejects.toThrow(/package/i);
  });

  it('rejects a verdict whose appIntegrity package disagrees with requestDetails', async () => {
    const decode = decoderFor(payload({ appIntegrity: { packageName: 'com.evil.app' } }));
    await expect(verifyPlayIntegrityToken('token', opts(decode))).rejects.toThrow(/package/i);
  });

  it('rejects UNRECOGNIZED_VERSION', async () => {
    const decode = decoderFor(
      payload({ appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } }),
    );
    await expect(verifyPlayIntegrityToken('token', opts(decode))).rejects.toThrow(
      /app recognition|UNRECOGNIZED_VERSION/i,
    );
  });

  it('rejects a device that does not meet device integrity', async () => {
    const decode = decoderFor(
      payload({ deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] } }),
    );
    await expect(verifyPlayIntegrityToken('token', opts(decode))).rejects.toThrow(
      /device integrity/i,
    );
  });

  it('rejects an empty deviceRecognitionVerdict (rooted / uncertified device)', async () => {
    const decode = decoderFor(payload({ deviceIntegrity: { deviceRecognitionVerdict: [] } }));
    await expect(verifyPlayIntegrityToken('token', opts(decode))).rejects.toThrow(
      /device integrity/i,
    );
  });

  it('rejects a stale timestampMillis', async () => {
    const decode = decoderFor(
      payload({ requestDetails: { timestampMillis: String(NOW.getTime() - 3_600_000) } }),
    );
    await expect(verifyPlayIntegrityToken('token', opts(decode))).rejects.toThrow(/stale|age|old/i);
  });

  it('rejects a timestampMillis from the future beyond clock skew', async () => {
    const decode = decoderFor(
      payload({ requestDetails: { timestampMillis: String(NOW.getTime() + 3_600_000) } }),
    );
    await expect(verifyPlayIntegrityToken('token', opts(decode))).rejects.toThrow(/future|skew/i);
  });

  it('rejects a requestHash that is not the registration transcript', async () => {
    const decode = decoderFor(payload({ requestDetails: { requestHash: 'c29tZXRoaW5nLWVsc2U' } }));
    await expect(verifyPlayIntegrityToken('token', opts(decode))).rejects.toThrow(/request hash/i);
  });

  it('rejects a token carrying no requestHash at all', async () => {
    const decode = decoderFor(payload({ requestDetails: { requestHash: undefined } }));
    await expect(verifyPlayIntegrityToken('token', opts(decode))).rejects.toThrow(/request hash/i);
  });

  it('degrades to null when the Play Integrity API itself is unreachable', async () => {
    const decode = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    // A Google outage must not block an approver-device registration whose
    // trust basis comes from Key Attestation, not from Play Integrity.
    await expect(verifyPlayIntegrityToken('token', opts(decode))).resolves.toBeNull();
  });
});

describe('parsePlayIntegrityServiceAccount', () => {
  it('accepts raw JSON', () => {
    const parsed = parsePlayIntegrityServiceAccount(JSON.stringify(SERVICE_ACCOUNT));
    expect(parsed?.clientEmail).toBe(SERVICE_ACCOUNT.client_email);
  });

  it('accepts base64-encoded JSON', () => {
    const b64 = Buffer.from(JSON.stringify(SERVICE_ACCOUNT), 'utf8').toString('base64');
    expect(parsePlayIntegrityServiceAccount(b64)?.clientEmail).toBe(SERVICE_ACCOUNT.client_email);
  });

  it('un-escapes \\n in the private key so a single-line env var works', () => {
    const parsed = parsePlayIntegrityServiceAccount(JSON.stringify(SERVICE_ACCOUNT));
    expect(parsed?.privateKey).toContain('\n');
    expect(parsed?.privateKey).not.toContain('\\n');
  });

  it('returns null for a value that is neither JSON nor base64 JSON', () => {
    expect(parsePlayIntegrityServiceAccount('not-a-service-account')).toBeNull();
  });

  it('returns null when the required fields are missing', () => {
    expect(parsePlayIntegrityServiceAccount(JSON.stringify({ project_id: 'x' }))).toBeNull();
  });
});

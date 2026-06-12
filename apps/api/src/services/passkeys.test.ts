import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { redisMock, webauthnMocks } = vi.hoisted(() => ({
  redisMock: {
    getdel: vi.fn(),
    setex: vi.fn(),
  },
  webauthnMocks: {
    generateRegistrationOptions: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyRegistrationResponse: vi.fn(),
    verifyAuthenticationResponse: vi.fn(),
  },
}));

vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redisMock),
}));

vi.mock('@simplewebauthn/server', () => webauthnMocks);

import { getRedis } from './redis';
import {
  PasskeyChallengeError,
  authenticationInfoToPasskeyUpdateFields,
  generatePasskeyAuthenticationOptions,
  generatePasskeyRegistrationOptions,
  passkeyToWebAuthnCredential,
  registrationInfoToPasskeyFields,
  resolveWebAuthnConfig,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  type StoredPasskeyCredential,
} from './passkeys';

const getRedisMock = vi.mocked(getRedis);

function challengeRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    purpose: 'authentication',
    userId: 'u1',
    challenge: 'stored-challenge',
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

const fakePasskey: StoredPasskeyCredential = {
  credentialId: 'cred-1',
  publicKey: 'AQID', // base64url of [1,2,3]
  counter: 0,
  transports: ['internal'],
};

const savedEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  getRedisMock.mockReturnValue(redisMock as never);
  redisMock.setex.mockResolvedValue('OK');
  // Default: env unset so config derives from defaults
  delete process.env.WEBAUTHN_RP_ID;
  delete process.env.WEBAUTHN_ORIGIN;
  delete process.env.WEBAUTHN_RP_NAME;
  delete process.env.PUBLIC_APP_URL;
  delete process.env.DASHBOARD_URL;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('consumePasskeyChallenge (via verify fns)', () => {
  it('passes the stored challenge to @simplewebauthn for authentication', async () => {
    redisMock.getdel.mockResolvedValue(challengeRecord());
    webauthnMocks.verifyAuthenticationResponse.mockResolvedValue({ verified: true });

    await verifyPasskeyAuthentication({
      userId: 'u1',
      response: { id: 'cred-1' } as never,
      passkey: fakePasskey,
    });

    expect(redisMock.getdel).toHaveBeenCalledWith('passkey:challenge:authentication:u1');
    expect(webauthnMocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({ expectedChallenge: 'stored-challenge' })
    );
  });

  it('passes the stored challenge to @simplewebauthn for registration', async () => {
    redisMock.getdel.mockResolvedValue(
      challengeRecord({ purpose: 'registration', challenge: 'reg-challenge' })
    );
    webauthnMocks.verifyRegistrationResponse.mockResolvedValue({ verified: true });

    await verifyPasskeyRegistration({ userId: 'u1', response: {} as never });

    expect(redisMock.getdel).toHaveBeenCalledWith('passkey:challenge:registration:u1');
    expect(webauthnMocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({ expectedChallenge: 'reg-challenge' })
    );
  });

  it('throws on purpose mismatch (stored registration, requested authentication)', async () => {
    redisMock.getdel.mockResolvedValue(challengeRecord({ purpose: 'registration' }));

    await expect(
      verifyPasskeyAuthentication({
        userId: 'u1',
        response: {} as never,
        passkey: fakePasskey,
      })
    ).rejects.toThrow(PasskeyChallengeError);
    await expect(
      verifyPasskeyAuthentication({
        userId: 'u1',
        response: {} as never,
        passkey: fakePasskey,
      })
    ).rejects.toThrow(/mismatched challenge record/);
    expect(webauthnMocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('throws on userId mismatch (stored u2, requested u1)', async () => {
    redisMock.getdel.mockResolvedValue(challengeRecord({ userId: 'u2' }));

    await expect(
      verifyPasskeyAuthentication({
        userId: 'u1',
        response: {} as never,
        passkey: fakePasskey,
      })
    ).rejects.toThrow(/mismatched challenge record/);
  });

  it('throws missing-or-expired when getdel returns null', async () => {
    redisMock.getdel.mockResolvedValue(null);

    await expect(
      verifyPasskeyAuthentication({
        userId: 'u1',
        response: {} as never,
        passkey: fakePasskey,
      })
    ).rejects.toThrow('Passkey challenge is missing or expired');
  });

  it('wraps a corrupt (non-JSON) record as PasskeyChallengeError', async () => {
    redisMock.getdel.mockResolvedValue('not-json{');

    const err = await verifyPasskeyAuthentication({
      userId: 'u1',
      response: {} as never,
      passkey: fakePasskey,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(PasskeyChallengeError);
    expect(err.message).toMatch(/Invalid passkey challenge record/);
  });

  it('throws "reading" error when redis unavailable on consume path', async () => {
    getRedisMock.mockReturnValue(null as never);

    await expect(
      verifyPasskeyAuthentication({
        userId: 'u1',
        response: {} as never,
        passkey: fakePasskey,
      })
    ).rejects.toThrow('Redis unavailable while reading passkey challenge');
  });
});

describe('storePasskeyChallenge (via generate fns)', () => {
  it('throws "storing" error when redis unavailable (registration)', async () => {
    getRedisMock.mockReturnValue(null as never);
    webauthnMocks.generateRegistrationOptions.mockResolvedValue({ challenge: 'c' });

    await expect(
      generatePasskeyRegistrationOptions({
        user: { id: 'u1', email: 'a@b.co' },
      })
    ).rejects.toThrow('Redis unavailable while storing passkey challenge');
  });

  it('throws "storing" error when redis unavailable (authentication)', async () => {
    getRedisMock.mockReturnValue(null as never);
    webauthnMocks.generateAuthenticationOptions.mockResolvedValue({ challenge: 'c' });

    await expect(
      generatePasskeyAuthenticationOptions({ userId: 'u1' })
    ).rejects.toThrow('Redis unavailable while storing passkey challenge');
  });

  it('stores the generated challenge with setex on success', async () => {
    webauthnMocks.generateAuthenticationOptions.mockResolvedValue({ challenge: 'gen-c' });

    await generatePasskeyAuthenticationOptions({ userId: 'u1' });

    expect(redisMock.setex).toHaveBeenCalledWith(
      'passkey:challenge:authentication:u1',
      expect.any(Number),
      expect.stringContaining('"challenge":"gen-c"')
    );
  });
});

describe('user-verification is required (no silent downgrade)', () => {
  it('generateRegistrationOptions requests userVerification: required', async () => {
    webauthnMocks.generateRegistrationOptions.mockResolvedValue({ challenge: 'c' });

    await generatePasskeyRegistrationOptions({ user: { id: 'u1', email: 'a@b.co' } });

    expect(webauthnMocks.generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatorSelection: expect.objectContaining({ userVerification: 'required' }),
      })
    );
  });

  it('generateAuthenticationOptions requests userVerification: required', async () => {
    webauthnMocks.generateAuthenticationOptions.mockResolvedValue({ challenge: 'c' });

    await generatePasskeyAuthenticationOptions({ userId: 'u1' });

    expect(webauthnMocks.generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({ userVerification: 'required' })
    );
  });

  it('verifyRegistration requires user verification', async () => {
    redisMock.getdel.mockResolvedValue(challengeRecord({ purpose: 'registration' }));
    webauthnMocks.verifyRegistrationResponse.mockResolvedValue({ verified: true });

    await verifyPasskeyRegistration({ userId: 'u1', response: {} as never });

    expect(webauthnMocks.verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({ requireUserVerification: true })
    );
  });

  it('verifyAuthentication requires user verification', async () => {
    redisMock.getdel.mockResolvedValue(challengeRecord());
    webauthnMocks.verifyAuthenticationResponse.mockResolvedValue({ verified: true });

    await verifyPasskeyAuthentication({
      userId: 'u1',
      response: {} as never,
      passkey: fakePasskey,
    });

    expect(webauthnMocks.verifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        requireUserVerification: true,
        advancedFIDOConfig: expect.objectContaining({ userVerification: 'required' }),
      })
    );
  });
});

describe('public key base64url round-trip', () => {
  it('survives registrationInfoToPasskeyFields -> passkeyToWebAuthnCredential', () => {
    const knownBytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);

    const fields = registrationInfoToPasskeyFields({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-x',
          publicKey: knownBytes,
          counter: 7,
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        aaguid: 'aaguid-1',
      },
    } as never);

    const credential = passkeyToWebAuthnCredential({
      credentialId: fields.credentialId,
      publicKey: fields.publicKey,
      counter: fields.counter,
      transports: null,
    });

    expect(Array.from(credential.publicKey)).toEqual(Array.from(knownBytes));
  });
});

describe('unverified responses are rejected', () => {
  it('registrationInfoToPasskeyFields throws when verified: false', () => {
    expect(() => registrationInfoToPasskeyFields({ verified: false } as never)).toThrow(
      /unverified registration response/
    );
  });

  it('authenticationInfoToPasskeyUpdateFields throws when verified: false', () => {
    expect(() =>
      authenticationInfoToPasskeyUpdateFields({ verified: false } as never)
    ).toThrow(/unverified authentication response/);
  });
});

describe('resolveWebAuthnConfig', () => {
  it('derives rpID from the origin hostname by default', () => {
    process.env.WEBAUTHN_ORIGIN = 'https://app.example.com';
    const config = resolveWebAuthnConfig();
    expect(config.origin).toBe('https://app.example.com');
    expect(config.rpID).toBe('app.example.com');
  });

  it('honors WEBAUTHN_RP_ID override', () => {
    process.env.WEBAUTHN_ORIGIN = 'https://app.example.com';
    process.env.WEBAUTHN_RP_ID = 'example.com';
    const config = resolveWebAuthnConfig();
    expect(config.rpID).toBe('example.com');
  });

  it('trims trailing slashes from the origin', () => {
    process.env.WEBAUTHN_ORIGIN = 'https://app.example.com///';
    const config = resolveWebAuthnConfig();
    expect(config.origin).toBe('https://app.example.com');
    expect(config.rpID).toBe('app.example.com');
  });
});

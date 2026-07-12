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
    version: 1,
    purpose: 'authentication',
    userId: 'u1',
    challenge: 'stored-challenge',
    createdAt: new Date().toISOString(),
    binding: null,
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
      challengeRecord({
        purpose: 'registration',
        challenge: 'reg-challenge',
        binding: { kind: 'initial-password' },
      })
    );
    webauthnMocks.verifyRegistrationResponse.mockResolvedValue({ verified: true });

    await verifyPasskeyRegistration({
      userId: 'u1',
      response: {} as never,
      authorization: { kind: 'initial-password' },
    });

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
        authorization: { kind: 'initial-password' },
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

describe('purpose-bound registration authorization', () => {
  const authorization = {
    kind: 'mfa-step-up' as const,
    purpose: 'passkey.register' as const,
    grantHash: 'a'.repeat(64),
  };

  it('stores only the grant hash and purpose with the registration challenge', async () => {
    webauthnMocks.generateRegistrationOptions.mockResolvedValue({ challenge: 'reg-c' });

    await generatePasskeyRegistrationOptions({
      user: { id: 'u1', email: 'a@b.co' },
      authorization,
    });

    const [, , raw] = redisMock.setex.mock.calls[0]!;
    expect(JSON.parse(raw as string)).toMatchObject({
      version: 1,
      purpose: 'registration',
      binding: authorization,
    });
    expect(raw).not.toContain('opaque-raw-grant');
  });

  it('requires the same grant reference at registration verification', async () => {
    redisMock.getdel.mockResolvedValue(challengeRecord({
      purpose: 'registration',
      binding: authorization,
    }));
    webauthnMocks.verifyRegistrationResponse.mockResolvedValue({ verified: true });

    await verifyPasskeyRegistration({
      userId: 'u1',
      response: {} as never,
      authorization,
    });
    expect(webauthnMocks.verifyRegistrationResponse).toHaveBeenCalledOnce();

    redisMock.getdel.mockResolvedValue(challengeRecord({
      purpose: 'registration',
      binding: authorization,
    }));
    await expect(verifyPasskeyRegistration({
      userId: 'u1',
      response: {} as never,
      authorization: { ...authorization, grantHash: 'b'.repeat(64) },
    })).rejects.toThrow(/mismatched challenge record/i);
  });

  it('does not accept an initial-password verification for a grant-bound challenge', async () => {
    redisMock.getdel.mockResolvedValue(challengeRecord({
      purpose: 'registration',
      binding: authorization,
    }));

    await expect(verifyPasskeyRegistration({
      userId: 'u1',
      response: {} as never,
      authorization: { kind: 'initial-password' },
    })).rejects.toThrow(/mismatched challenge record/i);
    expect(webauthnMocks.verifyRegistrationResponse).not.toHaveBeenCalled();
  });
});

describe('existing-passkey step-up proof challenge', () => {
  it('uses a distinct one-time ceremony bound to the target purpose', async () => {
    webauthnMocks.generateAuthenticationOptions.mockResolvedValue({ challenge: 'step-up-c' });

    await generatePasskeyAuthenticationOptions({
      userId: 'u1',
      passkeys: [fakePasskey],
      challengePurpose: 'step-up-authentication',
      stepUpPurpose: 'passkey.register',
    });

    expect(redisMock.setex).toHaveBeenCalledWith(
      'passkey:challenge:step-up-authentication:u1',
      300,
      expect.stringContaining('"stepUpPurpose":"passkey.register"'),
    );
  });

  it('rejects a different target purpose and cannot be replayed', async () => {
    const raw = challengeRecord({
      purpose: 'step-up-authentication',
      binding: { kind: 'step-up-proof', stepUpPurpose: 'passkey.register' },
    });
    redisMock.getdel.mockResolvedValueOnce(raw).mockResolvedValueOnce(null);
    webauthnMocks.verifyAuthenticationResponse.mockResolvedValue({ verified: true });

    await expect(verifyPasskeyAuthentication({
      userId: 'u1',
      response: {} as never,
      passkey: fakePasskey,
      challengePurpose: 'step-up-authentication',
      stepUpPurpose: 'totp.replace',
    })).rejects.toThrow(/mismatched challenge record/i);

    await expect(verifyPasskeyAuthentication({
      userId: 'u1',
      response: {} as never,
      passkey: fakePasskey,
      challengePurpose: 'step-up-authentication',
      stepUpPurpose: 'passkey.register',
    })).rejects.toThrow(/missing or expired/i);
    expect(webauthnMocks.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('has one verifier when two existing-passkey proofs race on one challenge', async () => {
    const raw = challengeRecord({
      purpose: 'step-up-authentication',
      binding: { kind: 'step-up-proof', stepUpPurpose: 'passkey.register' },
    });
    redisMock.getdel.mockResolvedValueOnce(raw).mockResolvedValueOnce(null);
    webauthnMocks.verifyAuthenticationResponse.mockResolvedValue({ verified: true });
    const input = {
      userId: 'u1',
      response: {} as never,
      passkey: fakePasskey,
      challengePurpose: 'step-up-authentication' as const,
      stepUpPurpose: 'passkey.register' as const,
    };

    const outcomes = await Promise.allSettled([
      verifyPasskeyAuthentication(input),
      verifyPasskeyAuthentication(input),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(webauthnMocks.verifyAuthenticationResponse).toHaveBeenCalledOnce();
  });
});

describe('user-verification is required (no silent downgrade)', () => {
  it('generateRegistrationOptions requests userVerification: required', async () => {
    webauthnMocks.generateRegistrationOptions.mockResolvedValue({ challenge: 'c' });

    await generatePasskeyRegistrationOptions({
      user: { id: 'u1', email: 'a@b.co' },
      authorization: { kind: 'initial-password' },
    });

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
    redisMock.getdel.mockResolvedValue(challengeRecord({
      purpose: 'registration',
      binding: { kind: 'initial-password' },
    }));
    webauthnMocks.verifyRegistrationResponse.mockResolvedValue({ verified: true });

    await verifyPasskeyRegistration({
      userId: 'u1',
      response: {} as never,
      authorization: { kind: 'initial-password' },
    });

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

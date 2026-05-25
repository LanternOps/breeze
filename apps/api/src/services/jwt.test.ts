import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import {
  createAccessToken,
  createRefreshToken,
  verifyToken,
  createTokenPair
} from './jwt';

describe('jwt service', () => {
  const testPayload = {
    sub: 'user-123',
    email: 'test@example.com',
    roleId: 'role-123',
    orgId: 'org-123',
    partnerId: 'partner-123',
    scope: 'organization' as const,
    mfa: false
  };

  describe('createAccessToken', () => {
    it('should create a valid JWT access token', async () => {
      const token = await createAccessToken(testPayload);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });
  });

  describe('createRefreshToken', () => {
    it('should create a valid JWT refresh token', async () => {
      const token = await createRefreshToken(testPayload);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });
  });

  describe('verifyToken', () => {
    it('should verify and decode an access token', async () => {
      const token = await createAccessToken(testPayload);
      const decoded = await verifyToken(token);

      expect(decoded).not.toBeNull();
      expect(decoded?.sub).toBe(testPayload.sub);
      expect(decoded?.email).toBe(testPayload.email);
      expect(decoded?.type).toBe('access');
    });

    it('should verify and decode a refresh token', async () => {
      const token = await createRefreshToken(testPayload);
      const decoded = await verifyToken(token);

      expect(decoded).not.toBeNull();
      expect(decoded?.sub).toBe(testPayload.sub);
      expect(decoded?.type).toBe('refresh');
      expect(decoded?.jti).toBeDefined();
    });

    it('should return null for invalid token', async () => {
      const decoded = await verifyToken('invalid-token');
      expect(decoded).toBeNull();
    });

    it('should return null for tampered token', async () => {
      const token = await createAccessToken(testPayload);
      const tamperedToken = token.slice(0, -5) + 'xxxxx';

      const decoded = await verifyToken(tamperedToken);
      expect(decoded).toBeNull();
    });

    // G2 — explicit HS256-only allowlist
    it('rejects a token signed with a non-allowlisted alg (G2)', async () => {
      const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
      // Sign a token with HS384 — correct issuer/audience but wrong alg.
      // With an explicit algorithms: ['HS256'] allowlist, jose must reject this.
      const hs384Token = await new SignJWT({
        ...testPayload,
        type: 'access'
      })
        .setProtectedHeader({ alg: 'HS384' })
        .setIssuedAt()
        .setExpirationTime('15m')
        .setIssuer('breeze')
        .setAudience('breeze-api')
        .sign(secret);

      const decoded = await verifyToken(hs384Token);
      expect(decoded).toBeNull();
    });
  });

  describe('mobile device binding claim (mdid) — SR-001', () => {
    it('round-trips an mdid claim through an access token', async () => {
      const token = await createAccessToken({ ...testPayload, mdid: 'install-abc-123' });
      const decoded = await verifyToken(token);
      expect(decoded?.mdid).toBe('install-abc-123');
    });

    it('round-trips an mdid claim through a refresh token', async () => {
      const token = await createRefreshToken({ ...testPayload, mdid: 'install-abc-123' });
      const decoded = await verifyToken(token);
      expect(decoded?.mdid).toBe('install-abc-123');
    });

    it('leaves mdid undefined when not bound (web / MCP / OAuth tokens)', async () => {
      const decoded = await verifyToken(await createAccessToken(testPayload));
      expect(decoded?.mdid).toBeUndefined();
    });
  });

  describe('createTokenPair', () => {
    it('should create both access and refresh tokens', async () => {
      const result = await createTokenPair(testPayload);

      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.expiresInSeconds).toBe(15 * 60);
    });

    it('should create tokens with correct types', async () => {
      const result = await createTokenPair(testPayload);

      const accessDecoded = await verifyToken(result.accessToken);
      const refreshDecoded = await verifyToken(result.refreshToken);

      expect(accessDecoded?.type).toBe('access');
      expect(refreshDecoded?.type).toBe('refresh');
      expect(accessDecoded?.jti).toBeUndefined();
      expect(refreshDecoded?.jti).toBeDefined();
    });
  });

  describe('signing keyring + kid header — zero-downtime rotation', () => {
    let envBackup: Record<string, string | undefined>;
    const k1Secret = 'k1-secret-must-be-at-least-32-characters-long-aaaaa';
    const k2Secret = 'k2-secret-must-be-at-least-32-characters-long-bbbbb';

    beforeEach(() => {
      envBackup = {
        JWT_SECRET: process.env.JWT_SECRET,
        JWT_SIGNING_KEYRING: process.env.JWT_SIGNING_KEYRING,
        JWT_ACTIVE_KID: process.env.JWT_ACTIVE_KID
      };
    });

    afterEach(() => {
      for (const [k, v] of Object.entries(envBackup)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    function decodeHeader(token: string): Record<string, unknown> {
      const headerB64 = token.split('.')[0] ?? '';
      return JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    }

    it('signs with active kid in protected header', async () => {
      delete process.env.JWT_SECRET;
      process.env.JWT_SIGNING_KEYRING = JSON.stringify({ k1: k1Secret, k2: k2Secret });
      process.env.JWT_ACTIVE_KID = 'k2';

      const token = await createAccessToken(testPayload);
      const header = decodeHeader(token);

      expect(header.kid).toBe('k2');
      expect(header.alg).toBe('HS256');

      const decoded = await verifyToken(token);
      expect(decoded?.sub).toBe(testPayload.sub);
    });

    it('verifies a token signed under a prior kid (rotation)', async () => {
      process.env.JWT_SECRET = 'legacy-secret-must-be-at-least-32-chars-long-zzzz';
      process.env.JWT_SIGNING_KEYRING = JSON.stringify({ k1: k1Secret, k2: k2Secret });
      process.env.JWT_ACTIVE_KID = 'k1';

      // Mint under k1
      const oldToken = await createAccessToken(testPayload);
      expect(decodeHeader(oldToken).kid).toBe('k1');

      // Operator rotates: active flips to k2 (k1 stays in keyring for verify)
      process.env.JWT_ACTIVE_KID = 'k2';

      const decoded = await verifyToken(oldToken);
      expect(decoded).not.toBeNull();
      expect(decoded?.sub).toBe(testPayload.sub);

      const newToken = await createAccessToken(testPayload);
      expect(decodeHeader(newToken).kid).toBe('k2');
    });

    it('rejects tokens whose kid is not in the keyring', async () => {
      process.env.JWT_SECRET = 'legacy-secret-must-be-at-least-32-chars-long-zzzz';
      process.env.JWT_SIGNING_KEYRING = JSON.stringify({ k1: k1Secret, k2: k2Secret });
      process.env.JWT_ACTIVE_KID = 'k1';

      // Manually craft a token with an unknown kid signed with k1's bytes —
      // a verifier must reject it because its kid is not in the keyring.
      const rogue = await new SignJWT({ ...testPayload, type: 'access' })
        .setProtectedHeader({ alg: 'HS256', kid: 'unknown-kid' })
        .setIssuedAt()
        .setExpirationTime('15m')
        .setIssuer('breeze')
        .setAudience('breeze-api')
        .sign(new TextEncoder().encode(k1Secret));

      const decoded = await verifyToken(rogue);
      expect(decoded).toBeNull();
    });

    it('verifies legacy JWT_SECRET tokens (no keyring set)', async () => {
      delete process.env.JWT_SIGNING_KEYRING;
      delete process.env.JWT_ACTIVE_KID;
      // JWT_SECRET inherited from the test runner env.

      const token = await createAccessToken(testPayload);
      // Single-secret mode: no kid header.
      expect(decodeHeader(token).kid).toBeUndefined();

      const decoded = await verifyToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded?.sub).toBe(testPayload.sub);
    });

    it('verifies legacy-signed token after keyring is added (transition window)', async () => {
      // Step 1: mint a token in legacy single-secret mode (no kid).
      delete process.env.JWT_SIGNING_KEYRING;
      delete process.env.JWT_ACTIVE_KID;
      process.env.JWT_SECRET = 'legacy-secret-must-be-at-least-32-chars-long-zzzz';

      const legacyToken = await createAccessToken(testPayload);
      expect(decodeHeader(legacyToken).kid).toBeUndefined();

      // Step 2: operator deploys keyring, keeps JWT_SECRET as fallback.
      process.env.JWT_SIGNING_KEYRING = JSON.stringify({ k1: k1Secret });
      process.env.JWT_ACTIVE_KID = 'k1';
      // JWT_SECRET unchanged.

      const decoded = await verifyToken(legacyToken);
      expect(decoded).not.toBeNull();
      expect(decoded?.sub).toBe(testPayload.sub);
    });
  });
});

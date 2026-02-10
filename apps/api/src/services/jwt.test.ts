import { describe, it, expect, beforeAll } from 'vitest';
import { createAccessToken, createRefreshToken, verifyToken, createTokenPair } from './jwt';

describe('jwt service', () => {
  const testPayload = {
    sub: 'user-123',
    email: 'test@example.com',
    roleId: 'role-123',
    orgId: 'org-123',
    partnerId: 'partner-123',
    scope: 'organization' as const
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
});

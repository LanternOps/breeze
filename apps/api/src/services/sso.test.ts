import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  decodeIdToken,
  verifyIdTokenClaims,
  discoverOIDCConfig,
  type OIDCConfig,
  PROVIDER_PRESETS,
  SAML_PROVIDER_PRESETS,
  ALL_SSO_PRESETS
} from './sso';

vi.mock('dns/promises', () => ({
  lookup: vi.fn()
}));

const baseConfig: OIDCConfig = {
  issuer: 'https://issuer.example.com',
  clientId: 'client-123',
  clientSecret: 'secret-456',
  authorizationUrl: 'https://issuer.example.com/auth',
  tokenUrl: 'https://issuer.example.com/token',
  userInfoUrl: 'https://issuer.example.com/userinfo',
  scopes: 'openid profile email'
};

function createIdToken(payload: Record<string, unknown>): string {
  const header = { alg: 'none', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedHeader}.${encodedPayload}.signature`;
}

describe('sso service', () => {
  describe('token validation', () => {
    it('should decode a valid ID token payload', () => {
      const now = Math.floor(Date.now() / 1000);
      const token = createIdToken({
        iss: baseConfig.issuer,
        sub: 'user-1',
        aud: baseConfig.clientId,
        exp: now + 3600,
        iat: now,
        nonce: 'nonce-abc',
        email: 'test@example.com'
      });

      const claims = decodeIdToken(token);
      expect(claims.iss).toBe(baseConfig.issuer);
      expect(claims.sub).toBe('user-1');
      expect(claims.email).toBe('test@example.com');
    });

    it('should throw on invalid ID token format', () => {
      expect(() => decodeIdToken('invalid-token')).toThrow('Invalid ID token format');
    });

    it('should verify ID token claims with matching issuer, audience, and nonce', () => {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: baseConfig.issuer,
        sub: 'user-1',
        aud: baseConfig.clientId,
        exp: now + 3600,
        iat: now,
        nonce: 'nonce-abc'
      };

      expect(() => verifyIdTokenClaims(claims, baseConfig, 'nonce-abc')).not.toThrow();
    });

    it('should reject mismatched issuer', () => {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: 'https://wrong-issuer.example.com',
        sub: 'user-1',
        aud: baseConfig.clientId,
        exp: now + 3600,
        iat: now,
        nonce: 'nonce-abc'
      };

      expect(() => verifyIdTokenClaims(claims, baseConfig, 'nonce-abc')).toThrow('Invalid issuer');
    });

    it('should reject audience that does not include client id', () => {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: baseConfig.issuer,
        sub: 'user-1',
        aud: ['other-client'],
        exp: now + 3600,
        iat: now,
        nonce: 'nonce-abc'
      };

      expect(() => verifyIdTokenClaims(claims, baseConfig, 'nonce-abc')).toThrow('Invalid audience');
    });

    it('should reject expired ID token', () => {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: baseConfig.issuer,
        sub: 'user-1',
        aud: baseConfig.clientId,
        exp: now - 10,
        iat: now - 20,
        nonce: 'nonce-abc'
      };

      expect(() => verifyIdTokenClaims(claims, baseConfig, 'nonce-abc')).toThrow('ID token has expired');
    });

    it('should reject invalid nonce', () => {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: baseConfig.issuer,
        sub: 'user-1',
        aud: baseConfig.clientId,
        exp: now + 3600,
        iat: now,
        nonce: 'nonce-abc'
      };

      expect(() => verifyIdTokenClaims(claims, baseConfig, 'nonce-other')).toThrow('Invalid nonce');
    });
  });

  describe('provider config', () => {
    it('should define OIDC provider presets with required fields', () => {
      for (const preset of Object.values(PROVIDER_PRESETS)) {
        expect(preset.type).toBe('oidc');
        expect(preset.name).toBeTruthy();
        expect(preset.scopes).toBeTruthy();
        expect(preset.attributeMapping.email).toBeTruthy();
        expect(preset.attributeMapping.name).toBeTruthy();
      }
    });

    it('should define SAML provider presets with required fields', () => {
      for (const preset of Object.values(SAML_PROVIDER_PRESETS)) {
        expect(preset.type).toBe('saml');
        expect(preset.name).toBeTruthy();
        expect(preset.certificateInstructions).toBeTruthy();
        expect(preset.attributeMapping.email).toBeTruthy();
        expect(preset.attributeMapping.name).toBeTruthy();
      }
    });

    it('should combine all presets in ALL_SSO_PRESETS', () => {
      for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
        expect(ALL_SSO_PRESETS[key]).toBe(preset);
      }

      for (const [key, preset] of Object.entries(SAML_PROVIDER_PRESETS)) {
        expect(ALL_SSO_PRESETS[key]).toBe(preset);
      }
    });
  });

  describe('discoverOIDCConfig (SSRF defenses)', () => {
    const originalFetch = globalThis.fetch;
    // Keep a reference to the mocked lookup
    let lookupMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const dns = await import('dns/promises');
      lookupMock = dns.lookup as unknown as ReturnType<typeof vi.fn>;
      lookupMock.mockReset();
      // By default: fetch would succeed if we got that far. Tests that expect
      // rejection assert that fetch is NOT called.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          issuer: 'https://issuer.example.com',
          authorization_endpoint: 'https://issuer.example.com/auth',
          token_endpoint: 'https://issuer.example.com/token',
          userinfo_endpoint: 'https://issuer.example.com/userinfo',
          jwks_uri: 'https://issuer.example.com/jwks',
        })
      }) as any;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('rejects hostnames that DNS-resolve to loopback (127.0.0.1)', async () => {
      lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(discoverOIDCConfig('https://attacker.example.com')).rejects.toThrow(
        /internal network addresses|must not resolve to internal/
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects hostnames that DNS-resolve to AWS metadata (169.254.169.254)', async () => {
      lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(discoverOIDCConfig('https://metadata-rebind.example.com')).rejects.toThrow(
        /internal network addresses|must not resolve to internal/
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects hostnames that resolve to RFC1918 (10.x)', async () => {
      lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      await expect(discoverOIDCConfig('https://rebind.example.com')).rejects.toThrow(
        /internal network addresses|must not resolve to internal/
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects IPv6 loopback resolutions', async () => {
      lookupMock.mockResolvedValue([{ address: '::1', family: 6 }]);
      await expect(discoverOIDCConfig('https://ipv6-loop.example.com')).rejects.toThrow();
    });

    it('rejects string-level internal URLs before DNS (localhost literal)', async () => {
      await expect(discoverOIDCConfig('https://localhost/oidc')).rejects.toThrow(
        /internal network addresses/
      );
      expect(lookupMock).not.toHaveBeenCalled();
    });

    it('rejects HTTP (non-HTTPS) issuers', async () => {
      await expect(discoverOIDCConfig('http://issuer.example.com')).rejects.toThrow();
    });

    // NOTE: safeFetch (urlSafety.ts) owns the DNS-rebinding defense: IP pinning,
    // mixed-record handling, ENOTFOUND translation. Those cases are covered in
    // urlSafety.test.ts — we only keep sso-level checks here (string literal,
    // non-HTTPS scheme, IPv6 loopback via full integration).
  });
});

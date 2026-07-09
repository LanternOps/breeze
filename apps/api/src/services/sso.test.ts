import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  decodeIdToken,
  verifyIdTokenClaims,
  verifyIdTokenSignature,
  assertEmailVerified,
  idpAssertedMfa,
  discoverOIDCConfig,
  isInternalUrl,
  type OIDCConfig,
  PROVIDER_PRESETS,
  SAML_PROVIDER_PRESETS,
  ALL_SSO_PRESETS
} from './sso';

describe('idpAssertedMfa (security review #2 H-1)', () => {
  it('is true only when amr contains the RFC 8176 "mfa" reference', () => {
    expect(idpAssertedMfa({ amr: ['mfa'] })).toBe(true);
    expect(idpAssertedMfa({ amr: ['pwd', 'otp', 'mfa'] })).toBe(true);
  });

  it('is false for single-factor or missing amr', () => {
    expect(idpAssertedMfa({ amr: ['pwd'] })).toBe(false);
    expect(idpAssertedMfa({ amr: [] })).toBe(false);
    expect(idpAssertedMfa({})).toBe(false);
    // A non-array amr (malformed) must not be trusted.
    expect(idpAssertedMfa({ amr: 'mfa' as unknown as string[] })).toBe(false);
  });
});

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

  describe('id_token signature verification', () => {
    it('refuses to verify when the provider has no JWKS URL', async () => {
      await expect(
        verifyIdTokenSignature('a.b.c', baseConfig, 'nonce-abc')
      ).rejects.toThrow('no JWKS URL configured');
    });

    it('rejects an unsigned/forged token (alg=none) against a JWKS', async () => {
      const config: OIDCConfig = { ...baseConfig, jwksUrl: 'https://issuer.example.com/jwks' };
      const now = Math.floor(Date.now() / 1000);
      // An alg=none token cannot satisfy the asymmetric-only JWKS verification.
      const forged = createIdToken({
        iss: config.issuer,
        sub: 'user-1',
        aud: config.clientId,
        exp: now + 3600,
        iat: now,
        nonce: 'nonce-abc'
      });

      await expect(
        verifyIdTokenSignature(forged, config, 'nonce-abc')
      ).rejects.toThrow('ID token signature verification failed');
    });
  });

  describe('assertEmailVerified', () => {
    it('passes when email_verified is the boolean true', () => {
      expect(() => assertEmailVerified({ email_verified: true })).not.toThrow();
    });

    it('passes when email_verified is the string "true"', () => {
      expect(() => assertEmailVerified({ email_verified: 'true' })).not.toThrow();
    });

    it('rejects when email_verified is explicitly false', () => {
      expect(() => assertEmailVerified({ email_verified: false }))
        .toThrow(/not verified/);
    });

    it('rejects when email_verified is the string "false"', () => {
      expect(() => assertEmailVerified({ email_verified: 'false' as unknown as boolean }))
        .toThrow(/not verified/);
    });

    // Azure AD / Entra (and others) omit email_verified even for verified
    // mailboxes; absent must NOT block login. Identity comes from the
    // server-to-server userinfo call, not the id_token email, anyway.
    it('passes when email_verified is absent (does not lock out Azure AD)', () => {
      expect(() => assertEmailVerified({})).not.toThrow();
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

    // The metadata/loopback floor holds even with the opt-in: safeFetch's
    // isAlwaysBlockedIp still rejects a rebind to cloud metadata.
    it('still blocks cloud metadata even when allowPrivateNetwork is set', async () => {
      lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(
        discoverOIDCConfig('https://metadata-rebind.example.com', { allowPrivateNetwork: true })
      ).rejects.toThrow(/internal network addresses/);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    // NOTE: safeFetch (urlSafety.ts) owns the DNS-rebinding defense: IP pinning,
    // mixed-record handling, ENOTFOUND translation. Those cases are covered in
    // urlSafety.test.ts — we only keep sso-level checks here (string literal,
    // non-HTTPS scheme, IPv6 loopback via full integration).
  });

  describe('isInternalUrl (SSRF pre-check policy)', () => {
    describe('strict mode (hosted SaaS — allowPrivateNetwork off)', () => {
      it('requires HTTPS', () => {
        expect(isInternalUrl('http://issuer.example.com')).toBe(true);
        expect(isInternalUrl('https://issuer.example.com')).toBe(false);
      });

      it('rejects malformed URLs', () => {
        expect(isInternalUrl('not-a-url')).toBe(true);
      });

      it('blocks loopback, unspecified, and RFC1918/ULA literals', () => {
        expect(isInternalUrl('https://localhost')).toBe(true);
        expect(isInternalUrl('https://127.0.0.1')).toBe(true);
        expect(isInternalUrl('https://0.0.0.0')).toBe(true);
        expect(isInternalUrl('https://10.0.0.5')).toBe(true);
        expect(isInternalUrl('https://172.16.4.4')).toBe(true);
        expect(isInternalUrl('https://192.168.1.10')).toBe(true);
        expect(isInternalUrl('https://[fd00::1]')).toBe(true);
        expect(isInternalUrl('https://169.254.169.254')).toBe(true);
      });

      it('allows public hostnames and IPs', () => {
        expect(isInternalUrl('https://accounts.google.com')).toBe(false);
        expect(isInternalUrl('https://8.8.8.8')).toBe(false);
      });
    });

    describe('self-host mode (allowPrivateNetwork on)', () => {
      it('permits plain HTTP', () => {
        expect(isInternalUrl('http://authentik.internal', true)).toBe(false);
      });

      it('permits RFC1918 and ULA hosts', () => {
        expect(isInternalUrl('https://10.0.0.5', true)).toBe(false);
        expect(isInternalUrl('https://172.16.4.4', true)).toBe(false);
        expect(isInternalUrl('https://192.168.1.10', true)).toBe(false);
        expect(isInternalUrl('http://192.168.1.10', true)).toBe(false);
        expect(isInternalUrl('https://[fd00::1]', true)).toBe(false);
      });

      it('STILL blocks loopback, unspecified, link-local, and cloud metadata', () => {
        expect(isInternalUrl('https://localhost', true)).toBe(true);
        expect(isInternalUrl('https://127.0.0.1', true)).toBe(true);
        expect(isInternalUrl('http://127.0.0.2', true)).toBe(true);
        expect(isInternalUrl('https://0.0.0.0', true)).toBe(true);
        expect(isInternalUrl('https://169.254.169.254', true)).toBe(true);
        expect(isInternalUrl('https://[fe80::1]', true)).toBe(true);
        expect(isInternalUrl('https://[::1]', true)).toBe(true);
      });
    });
  });
});

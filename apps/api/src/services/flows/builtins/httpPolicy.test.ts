import { describe, expect, it } from 'vitest';
import { breezeOwnHostnames, isBreezeOwnHostname, isDeniedHeaderName, literalOriginOf, looksLikeCredential } from './httpPolicy';

/** W5 PR B (#5220, Decision 12) — the pure egress policy, rule by rule. */
describe('breezeOwnHostnames', () => {
  it.each(['PUBLIC_API_URL', 'API_URL', 'PUBLIC_APP_URL', 'DASHBOARD_URL', 'PUBLIC_URL', 'PUBLIC_PORTAL_URL', 'PUBLIC_WEB_URL',
    'OAUTH_RESOURCE_URL', 'OAUTH_CONSENT_URL_BASE', 'TUNNEL_FRAME_ANCESTOR', 'WEBAUTHN_ORIGIN', 'CORS_ALLOWED_ORIGINS'])(
    '%s names one of Breeze\'s own hosts',
    (key) => {
      const env = { [key]: 'https://Own.Example.TEST.:8443/path' } as NodeJS.ProcessEnv;
      expect([...breezeOwnHostnames(env)]).toEqual(['own.example.test']);
      expect(isBreezeOwnHostname('own.example.test', env)).toBe(true);
      expect(isBreezeOwnHostname('OWN.example.test..', env)).toBe(true);
      expect(isBreezeOwnHostname('api.example.com', env)).toBe(false);
    },
  );

  it('a scheme-less host or host:port still names a host (never silently dropped); comma lists and the CORS wildcard', () => {
    const env = {
      PUBLIC_API_URL: 'breeze.example.test', API_URL: 'localhost:3001',
      CORS_ALLOWED_ORIGINS: 'https://app.example.test, *, https://portal.example.test',
      WEBAUTHN_ORIGIN: 'https://login.example.test,https://app.example.test',
    } as NodeJS.ProcessEnv;
    expect([...breezeOwnHostnames(env)].sort()).toEqual(['app.example.test', 'breeze.example.test', 'localhost', 'login.example.test', 'portal.example.test']);
  });

  it('an empty or unparseable variable names nothing', () => {
    expect(breezeOwnHostnames({ PUBLIC_API_URL: 'not a url at all', API_URL: '  ' } as NodeJS.ProcessEnv).size).toBe(0);
  });
});

describe('literalOriginOf', () => {
  it('pins scheme + host + port; a template may start only after the authority', () => {
    expect(literalOriginOf('https://api.example.com:8443/a/{{x}}')).toMatchObject({ ok: true, origin: 'https://api.example.com:8443' });
    expect(literalOriginOf('https://api.example.com?q={{x}}')).toMatchObject({ ok: true, origin: 'https://api.example.com' });
    expect(literalOriginOf('https://api.{{x}}.com/')).toMatchObject({ ok: false, reason: 'templated' });
    expect(literalOriginOf('https://{{u}}@api.example.com/')).toMatchObject({ ok: false, reason: 'templated' });
    expect(literalOriginOf('https://a@api.example.com/')).toMatchObject({ ok: false, reason: 'userinfo' });
    expect(literalOriginOf('https://api.example.com\\@evil.example/')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(literalOriginOf('file:///etc/passwd')).toMatchObject({ ok: false });
  });
});

describe('isDeniedHeaderName', () => {
  it.each(['Host', 'content-length', 'Transfer-Encoding', 'CONNECTION', 'upgrade', 'TE', 'trailer', 'keep-alive', 'expect', 'Cookie', 'authorization', 'Forwarded', 'Proxy-Authorization', 'x-forwarded-host', 'X-Breeze-Delivery-Id'])(
    '%s is denied',
    (name) => expect(isDeniedHeaderName(name)).toBe(true),
  );
  it.each(['Accept', 'User-Agent', 'X-Request-Id', 'If-None-Match'])('%s is allowed', (name) => expect(isDeniedHeaderName(name)).toBe(false));
});

describe('looksLikeCredential', () => {
  it('credential-like names with any literal value', () => {
    for (const name of ['X-Api-Key', 'apikey', 'access_token', 'client-secret', 'password', 'X-Auth-Token', 'session_id']) {
      expect(looksLikeCredential(name, 'v')).toBe(true);
    }
    expect(looksLikeCredential('X-Request-Id', 'v')).toBe(false);
  });
  it('credential-shaped values whatever the name', () => {
    for (const value of ['Bearer abc', 'basic dXNlcjpw', 'bwh_x', 'brz_live', 'sk-proj-1', 'sk_live_1', 'ghp_1', 'xoxb-1', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1.e.s']) {
      expect(looksLikeCredential(null, value)).toBe(true);
    }
  });
  it('high-entropy tokens from 32 characters, mixed classes; words and short ids pass', () => {
    expect(looksLikeCredential(null, 'kP9xQ2mZ7vR4tW8yB3nL6cF1hJ5dS0aG')).toBe(true); // 32
    expect(looksLikeCredential(null, 'kP9xQ2mZ7vR4tW8yB3nL6cF1hJ5dS0a')).toBe(false); // 31
    expect(looksLikeCredential(null, 'name_ascending_by_default_value_order')).toBe(false); // one class
    expect(looksLikeCredential(null, 'application/json')).toBe(false);
  });
  it('a templated value is not in the document and is never judged', () => {
    expect(looksLikeCredential('X-Api-Key', '{{inputs.key}}')).toBe(false);
  });
});

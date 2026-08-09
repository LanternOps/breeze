import { describe, it, expect } from 'vitest';
import { createPSAProvider } from './index';
import { PsaConfigError, mergeProviderCredentials, validateProviderCredentials } from './credentials';

describe('createPSAProvider credential validation', () => {
  it('throws PsaConfigError for providers without an adapter (dead DB enum values)', () => {
    for (const dead of ['halo', 'syncro', 'kaseya', 'other', 'nonsense']) {
      expect(() => createPSAProvider(dead, { baseUrl: 'https://x.example.com' }))
        .toThrowError(PsaConfigError);
    }
  });

  it('throws a typed error naming the missing keys instead of a deep TypeError', () => {
    // servicenow without baseUrl previously TypeError'd inside the adapter's
    // baseUrl getter (`.replace` on undefined).
    expect(() => createPSAProvider('servicenow', { username: 'u', password: 'p' }))
      .toThrowError(/missing required credential field\(s\): baseUrl/);

    expect(() => createPSAProvider('connectwise', { baseUrl: 'https://cw.example.com' }))
      .toThrowError(/companyId, publicKey, privateKey/);

    expect(() => createPSAProvider('autotask', { baseUrl: 'https://at.example.com', username: 'u' }))
      .toThrowError(/secret, integrationCode/);
  });

  it('treats empty/whitespace values as missing', () => {
    expect(() => createPSAProvider('servicenow', { baseUrl: '   ', username: 'u', password: 'p' }))
      .toThrowError(PsaConfigError);
    expect(() => createPSAProvider('zendesk', { baseUrl: 'https://z.example.com', email: 'a@b.c', apiToken: '' }))
      .toThrowError(PsaConfigError);
  });

  it('rejects non-object credentials', () => {
    expect(() => createPSAProvider('jira', null as unknown as Record<string, unknown>))
      .toThrowError(PsaConfigError);
  });

  it('constructs providers when the required keys are present', () => {
    const provider = createPSAProvider('servicenow', {
      baseUrl: 'https://now.example.com',
      username: 'u',
      password: 'p'
    });
    expect(typeof provider.testConnection).toBe('function');
  });

  it('bridges the generic web-form fields onto adapter key names', () => {
    // freshservice: apiToken → apiKey; zendesk + jira cloud: username → email.
    expect(() => createPSAProvider('freshservice', { baseUrl: 'https://fs.example.com', apiToken: 'k' }))
      .not.toThrow();
    expect(() => createPSAProvider('zendesk', { baseUrl: 'https://z.example.com', username: 'a@b.c', apiToken: 'k' }))
      .not.toThrow();
    expect(() => createPSAProvider('jira', { baseUrl: 'https://j.atlassian.net', username: 'a@b.c', apiToken: 'k' }))
      .not.toThrow();
  });
});

describe('validateProviderCredentials normalization', () => {
  it('normalizes baseUrl (trims + strips trailing slashes) without mutating the input', () => {
    const input = { baseUrl: ' https://j.atlassian.net/ ', email: 'a@b.c', apiToken: 'k' };
    const { credentials } = validateProviderCredentials('jira', input);
    expect(credentials.baseUrl).toBe('https://j.atlassian.net');
    expect(input.baseUrl).toBe(' https://j.atlassian.net/ ');
  });

  it('defaults jira to cloud auth and aliases username to email', () => {
    const { credentials } = validateProviderCredentials('jira', {
      baseUrl: 'https://j.atlassian.net',
      username: 'a@b.c',
      apiToken: 'k'
    });
    expect(credentials.type).toBe('cloud');
    expect(credentials.email).toBe('a@b.c');
  });

  it('infers jira server auth from a personal access token', () => {
    const { credentials } = validateProviderCredentials('jira', {
      baseUrl: 'https://jira.internal.example.com',
      personalAccessToken: 'pat-1'
    });
    expect(credentials.type).toBe('server');
  });

  it('requires username+password for jira server without a PAT', () => {
    expect(() => validateProviderCredentials('jira', {
      baseUrl: 'https://jira.internal.example.com',
      type: 'server',
      username: 'u'
    })).toThrowError(/password/);
  });

  it('accepts jira server basic auth (username + password, no PAT, no type)', () => {
    // Previously inferred type 'cloud' whenever no PAT was present, so a valid
    // Jira Server basic-auth pair was rejected for a missing apiToken it never
    // needed — every /test on such a connection 400'd.
    const { credentials } = validateProviderCredentials('jira', {
      baseUrl: 'https://jira.internal.example.com',
      username: 'svc-breeze',
      password: 'pw'
    });
    expect(credentials.type).toBe('server');
    expect(credentials.username).toBe('svc-breeze');
  });

  it('accepts all three jira auth modes', () => {
    const base = { baseUrl: 'https://jira.example.com' };
    // cloud via email
    expect(validateProviderCredentials('jira', { ...base, email: 'a@b.c', apiToken: 'k' })
      .credentials.type).toBe('cloud');
    // cloud via the username alias
    expect(validateProviderCredentials('jira', { ...base, username: 'a@b.c', apiToken: 'k' })
      .credentials.type).toBe('cloud');
    // server basic
    expect(validateProviderCredentials('jira', { ...base, username: 'u', password: 'p' })
      .credentials.type).toBe('server');
    // server PAT
    expect(validateProviderCredentials('jira', { ...base, personalAccessToken: 'pat' })
      .credentials.type).toBe('server');
  });

  it('keeps an explicit email over the username alias', () => {
    const { credentials } = validateProviderCredentials('zendesk', {
      baseUrl: 'https://z.example.com',
      email: 'real@b.c',
      username: 'ignored',
      apiToken: 'k'
    });
    expect(credentials.email).toBe('real@b.c');
  });
});

describe('mergeProviderCredentials', () => {
  it('overwrites supplied keys, deletes on explicit null, keeps the rest', () => {
    const merged = mergeProviderCredentials(
      'servicenow',
      { baseUrl: 'https://sn.example.com', username: 'u', password: 'old' },
      { password: 'new', username: null }
    );
    expect(merged).toEqual({ baseUrl: 'https://sn.example.com', password: 'new' });
  });

  it('drops the other jira auth groups when one is supplied', () => {
    const stored = {
      baseUrl: 'https://jira.example.com',
      username: 'svc',
      personalAccessToken: 'pat-OLD'
    };

    // PAT → password rotation
    expect(mergeProviderCredentials('jira', stored, { password: 'pw' })).toEqual({
      baseUrl: 'https://jira.example.com',
      username: 'svc',
      password: 'pw'
    });

    // password → cloud token rotation drops both server-side groups
    expect(mergeProviderCredentials(
      'jira',
      { ...stored, personalAccessToken: undefined, password: 'pw' },
      { email: 'a@b.c', apiToken: 'tok' }
    )).toEqual({
      baseUrl: 'https://jira.example.com',
      username: 'svc',
      personalAccessToken: undefined,
      email: 'a@b.c',
      apiToken: 'tok'
    });
  });

  it('rotates within a group without clearing the group\'s other keys', () => {
    // Supplying only apiToken must keep the stored email — they are one group.
    expect(mergeProviderCredentials(
      'jira',
      { baseUrl: 'https://jira.example.com', email: 'a@b.c', apiToken: 'old' },
      { apiToken: 'new' }
    )).toEqual({ baseUrl: 'https://jira.example.com', email: 'a@b.c', apiToken: 'new' });
  });

  it('clears the legacy freshservice apiToken alias when a real apiKey is supplied', () => {
    // normalize() only backfills apiKey from apiToken when apiKey is absent, so
    // a stale apiKey would otherwise always outrank a freshly entered token.
    expect(mergeProviderCredentials(
      'freshservice',
      { baseUrl: 'https://fs.example.com', apiToken: 'legacy' },
      { apiKey: 'new' }
    )).toEqual({ baseUrl: 'https://fs.example.com', apiKey: 'new' });
  });

  it('leaves providers with a single auth mode as a plain merge', () => {
    expect(mergeProviderCredentials(
      'connectwise',
      { baseUrl: 'https://cw.example.com', companyId: 'acme', publicKey: 'pk', privateKey: 'sk' },
      { privateKey: 'sk2' }
    )).toEqual({
      baseUrl: 'https://cw.example.com',
      companyId: 'acme',
      publicKey: 'pk',
      privateKey: 'sk2'
    });
  });
});

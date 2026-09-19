import { describe, expect, it } from 'vitest';
import { compactToolResultForChat } from './aiToolOutput';

/**
 * #6140 — chokepoint coverage for tool-output redaction.
 *
 * `compactToolResultForChat` is the single point every aiTools*.ts result
 * passes through on its way to the model. It used to run the LOG redactor
 * (`redactLogFields`) over that payload, whose key denylist is an unanchored
 * substring match: any key containing `session`/`token`/`credential`/... had its
 * whole value replaced with the string `[REDACTED]` regardless of the value's
 * type. That wiped `list_remote_sessions.sessions` (an array), the session
 * counts in `get_active_users` (numbers) and the `has*Token` presence flags in
 * `query_c2c_connections` (booleans) — data that exists precisely so the secret
 * itself never has to be returned.
 *
 * The two halves below are a pair: `survives` proves the false positives are
 * gone, `still redacts` proves the redactor is still fail-closed for every
 * string that can actually carry secret material.
 */
const REDACTED = '[REDACTED]';

const parse = (toolName: string, payload: unknown): any =>
  JSON.parse(compactToolResultForChat(toolName, JSON.stringify(payload)));

describe('compactToolResultForChat — non-secret structure survives redaction (#6140)', () => {
  it('list_remote_sessions: the sessions array survives with its rows intact', () => {
    const out = parse('list_remote_sessions', {
      sessions: [
        {
          id: 'rs_1',
          deviceId: 'dev_1',
          hostname: 'WS-01',
          technicianName: 'Ada Lovelace',
          status: 'ended',
          startedAt: '2026-09-01T10:00:00.000Z',
          endedAt: '2026-09-01T10:42:00.000Z',
          durationSeconds: 2520,
          bytesTransferred: 91234,
        },
      ],
      total: 1,
    });

    expect(Array.isArray(out.sessions)).toBe(true);
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]).toMatchObject({
      id: 'rs_1',
      hostname: 'WS-01',
      technicianName: 'Ada Lovelace',
      durationSeconds: 2520,
    });
    expect(out.total).toBe(1);
  });

  it('get_active_users: session counts stay numbers and per-device sessions survive', () => {
    const out = parse('get_active_users', {
      idleThresholdMinutes: 30,
      totalActiveSessions: 3,
      totalDevicesWithSessions: 2,
      devices: [
        {
          deviceId: 'dev_1',
          hostname: 'WS-01',
          deviceStatus: 'online',
          activeSessionCount: 2,
          blockingSessionCount: 1,
          safeToReboot: false,
          sessions: [
            { username: 'jdoe', sessionType: 'console', idleMinutes: 3, state: 'Active' },
            { username: 'svc', sessionType: 'rdp', idleMinutes: 90, state: 'Disc' },
          ],
        },
      ],
    });

    expect(out.totalActiveSessions).toBe(3);
    expect(out.totalDevicesWithSessions).toBe(2);
    expect(out.devices[0].activeSessionCount).toBe(2);
    expect(out.devices[0].blockingSessionCount).toBe(1);
    expect(out.devices[0].safeToReboot).toBe(false);
    expect(out.devices[0].sessions).toHaveLength(2);
    expect(out.devices[0].sessions[0]).toMatchObject({ username: 'jdoe', sessionType: 'console' });
  });

  it('query_c2c_connections: has*Token booleans and tokenExpiresAt survive', () => {
    const out = parse('query_c2c_connections', {
      connections: [
        {
          id: 'c2c_1',
          provider: 'microsoft',
          displayName: 'Contoso',
          tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          clientId: '11111111-2222-3333-4444-555555555555',
          hasClientSecret: true,
          hasRefreshToken: true,
          hasAccessToken: false,
          tokenExpiresAt: '2026-09-20T12:00:00.000Z',
          status: 'active',
        },
      ],
      total: 1,
    });

    const row = out.connections[0];
    expect(row.hasClientSecret).toBe(true);
    expect(row.hasRefreshToken).toBe(true);
    expect(row.hasAccessToken).toBe(false);
    expect(row.tokenExpiresAt).toBe('2026-09-20T12:00:00.000Z');
  });

  it('numeric and boolean values under secret-named keys are kept (a JSON number cannot be a secret)', () => {
    const out = parse('any_tool', {
      maxSessionDurationHours: 8,
      tokenCount: 42,
      credentialCount: 0,
      passwordExpiryDays: 90,
      requireApiKey: true,
      cookieEnabled: false,
    });

    expect(out).toMatchObject({
      maxSessionDurationHours: 8,
      tokenCount: 42,
      credentialCount: 0,
      passwordExpiryDays: 90,
      requireApiKey: true,
      cookieEnabled: false,
    });
  });

  it('timestamp strings under secret-named keys are kept', () => {
    const out = parse('any_tool', {
      tokenExpiresAt: '2026-09-20T12:00:00.000Z',
      secretRotatedAt: '2026-01-02T03:04:05Z',
      sessionStartedAt: '2026-09-01T10:00:00.000Z',
      credentialUpdatedAt: '2026-09-01',
    });

    expect(out.tokenExpiresAt).toBe('2026-09-20T12:00:00.000Z');
    expect(out.secretRotatedAt).toBe('2026-01-02T03:04:05Z');
    expect(out.sessionStartedAt).toBe('2026-09-01T10:00:00.000Z');
    expect(out.credentialUpdatedAt).toBe('2026-09-01');
  });
});

describe('compactToolResultForChat — secret material is still redacted (#6140)', () => {
  it('string values under secret-named keys are still masked', () => {
    const out = parse('any_tool', {
      password: 'hunter2',
      apiKey: 'sk_live_abcdef0123456789',
      accessToken: 'ya29.a0AfH6SMB-real-looking-token',
      refreshToken: '1//0gRealRefreshToken',
      clientSecret: 'Xy8Q~verysecretvalue',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      cookie: 'connect.sid=s%3Aabc123',
      privateKey: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
      connectionString: 'Server=db;User Id=sa;Password=p@ss',
      community: 'public-but-actually-secret',
      sessionToken: 'FQoGZXIvYXdzEBYaD-session-token',
      session: 'sid_9f2c8ab41',
    });

    for (const key of [
      'password',
      'apiKey',
      'accessToken',
      'refreshToken',
      'clientSecret',
      'authorization',
      'cookie',
      'privateKey',
      'connectionString',
      'community',
      'sessionToken',
      'session',
    ]) {
      expect(out[key], `${key} must be redacted`).toBe(REDACTED);
    }
  });

  it('secret leaves nested inside a surviving sessions array are still masked', () => {
    const out = parse('list_remote_sessions', {
      sessions: [
        {
          id: 'rs_1',
          username: 'jdoe',
          sessionToken: 'st_live_abcdef0123456789',
          cookie: 'connect.sid=s%3Aabc',
          apiKey: 'sk_live_zzz',
          durationSeconds: 10,
        },
      ],
      total: 1,
    });

    const row = out.sessions[0];
    expect(row.id).toBe('rs_1');
    expect(row.username).toBe('jdoe');
    expect(row.durationSeconds).toBe(10);
    expect(row.sessionToken).toBe(REDACTED);
    expect(row.cookie).toBe(REDACTED);
    expect(row.apiKey).toBe(REDACTED);
  });

  it('session-identifier strings stay redacted while session descriptors survive', () => {
    const out = parse('any_tool', {
      session: 'sid_9f2c8ab41',
      sessionId: 'sid_9f2c8ab41',
      session_id: 'sid_9f2c8ab41',
      sessionKey: 'k_9f2c8ab41',
      rdpSession: 'sid_9f2c8ab41',
      sessionType: 'console',
      sessionState: 'Active',
      sessionName: 'Support call with Ada',
    });

    expect(out.session).toBe(REDACTED);
    expect(out.sessionId).toBe(REDACTED);
    expect(out.session_id).toBe(REDACTED);
    expect(out.sessionKey).toBe(REDACTED);
    expect(out.rdpSession).toBe(REDACTED);
    expect(out.sessionType).toBe('console');
    expect(out.sessionState).toBe('Active');
    expect(out.sessionName).toBe('Support call with Ada');
  });

  it('an object or array under a secret-material key is still wiped wholesale', () => {
    const out = parse('any_tool', {
      credentials: { username: 'svc', password: 'hunter2', extra: 'sk_live_leak' },
      apiKeys: ['sk_live_aaa', 'sk_live_bbb'],
      tokens: { access: 'ya29.x', refresh: '1//y' },
      privateKeys: ['-----BEGIN PRIVATE KEY-----'],
    });

    expect(out.credentials).toBe(REDACTED);
    expect(out.apiKeys).toBe(REDACTED);
    expect(out.tokens).toBe(REDACTED);
    expect(out.privateKeys).toBe(REDACTED);
  });

  // Review finding: recursing into a `session`-named container must not let a
  // BARE string element slip past every key rule. An array element has no key
  // of its own, so it is judged under the array's key.
  it('bare string elements of an array under a session-named key are redacted', () => {
    const out = parse('any_tool', {
      activeSessions: ['opaque_vendor_token_000111222'],
      sessionIds: ['sid_abcdef123456', 'sid_ghijkl789012'],
      sessionKeys: ['k_aaa'],
      sessions: ['sid_bare_one'],
      // Nested one level deeper, to prove the label is inherited through the walk.
      nested: { rdpSessions: ['sid_nested_one'] },
    });

    expect(out.activeSessions).toEqual([REDACTED]);
    expect(out.sessionIds).toEqual([REDACTED, REDACTED]);
    expect(out.sessionKeys).toEqual([REDACTED]);
    expect(out.sessions).toEqual([REDACTED]);
    expect(out.nested.rdpSessions).toEqual([REDACTED]);
  });

  it('an array of session OBJECTS still survives while its string siblings do not', () => {
    const out = parse('list_remote_sessions', {
      sessions: [{ id: 'rs_1', hostname: 'WS-01', durationSeconds: 5 }, 'sid_bare'],
    });

    expect(out.sessions[0]).toMatchObject({ id: 'rs_1', hostname: 'WS-01', durationSeconds: 5 });
    expect(out.sessions[1]).toBe(REDACTED);
  });

  // Review finding: the old blanket wipe of `session*` containers incidentally
  // caught secrets carried under an innocuous key inside them. Recursion gives
  // that up, so the bare vendor-token shapes now run on every tool-output
  // string leaf (previously only on the non-JSON branch).
  it('bare vendor-token shapes are caught under a key that names nothing sensitive', () => {
    const out = parse('list_remote_sessions', {
      sessions: [
        { id: 'rs_1', raw: 'ghp_abcdefghijklmnopqrstuvwxyz0123' },
        { id: 'rs_2', note: 'used AKIAIOSFODNN7EXAMPLE to connect' },
        { id: 'rs_3', blob: 'eyJhbGciOiJIUzI1NiJ9abcdefghijkl.eyJzdWIiOiIxMjM0NTY3ODkwIn0x.dBjftJeZ4CV' },
      ],
    });

    expect(out.sessions[0].raw).toBe(REDACTED);
    expect(out.sessions[0].id).toBe('rs_1');
    expect(out.sessions[1].note).toContain(REDACTED);
    expect(out.sessions[1].note).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out.sessions[2].blob).toBe(REDACTED);
  });

  it('inline secret assignments inside ordinary string leaves are still scrubbed', () => {
    const out = parse('any_tool', {
      sessions: [
        { id: 'rs_1', note: 'connected with password=hunter2 then idled' },
        { id: 'rs_2', note: 'curl -H "Authorization: Bearer eyJabc.def.ghi" https://x' },
      ],
    });

    expect(out.sessions[0].note).toContain(REDACTED);
    expect(out.sessions[0].note).not.toContain('hunter2');
    expect(out.sessions[1].note).toContain(REDACTED);
    expect(out.sessions[1].note).not.toContain('eyJabc.def.ghi');
  });

  it('a non-ISO string under a timestamp-shaped secret-material key is still redacted', () => {
    const out = parse('any_tool', {
      // `*At` naming does not license an arbitrary string payload: the ISO
      // exemption is a value-shape test, not a key-name test.
      tokenIssuedAt: 'ya29.a0AfH6SMB-not-a-timestamp',
      secretRotatedAt: 'sk_live_not_a_timestamp',
      apiKeyExpiresAt: 'AKIAIOSFODNN7EXAMPLE',
    });

    expect(out.tokenIssuedAt).toBe(REDACTED);
    expect(out.secretRotatedAt).toBe(REDACTED);
    expect(out.apiKeyExpiresAt).toBe(REDACTED);
  });
});

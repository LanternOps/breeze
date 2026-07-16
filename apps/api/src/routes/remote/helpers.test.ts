import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  insert,
  insertValues,
  select,
  runOutsideDbContext,
  withSystemDbAccessContext,
  captureException
} = vi.hoisted(() => {
  const insertValues = vi.fn(() => Promise.resolve());
  const insert = vi.fn(() => ({ values: insertValues }));
  const select = vi.fn();
  // `runOutsideDbContext` is synchronous (wraps AsyncLocalStorage.exit); the
  // real impl just calls its argument outside the current context. The mock
  // passes through so we can assert ordering separately.
  const runOutsideDbContext = vi.fn(<T>(fn: () => T): T => fn());
  const withSystemDbAccessContext = vi.fn(async (fn: () => unknown) => fn());
  const captureException = vi.fn();
  return {
    insert,
    insertValues,
    select,
    runOutsideDbContext,
    withSystemDbAccessContext,
    captureException
  };
});

vi.mock('../../db', () => ({
  db: { insert, select },
  runOutsideDbContext,
  withSystemDbAccessContext
}));

vi.mock('../../db/schema', () => ({
  remoteSessions: {},
  devices: {},
  auditLogs: { __table: 'audit_logs' },
  configPolicyFeatureLinks: {},
  configPolicyRemoteAccessSettings: {},
  users: {},
  organizations: {},
  partners: {}
}));

// buildRemoteSessionPromptPayload → resolveRemoteSessionPromptConfig lazily
// imports the configurationPolicy service; return "no effective config" so the
// prompt config falls to the spec defaults (mode 'notify', indicator on).
vi.mock('../../services/configurationPolicy', () => ({
  resolveEffectiveConfig: vi.fn(async () => undefined)
}));

vi.mock('../../services/sentry', () => ({
  captureException
}));

import { buildRemoteSessionPromptPayload, buildTechnicianDisplay, classifyConsentDenyAction, generateTurnCredentials, getIceServers, getTurnCredentialTtlSeconds, logSessionAudit, resolveConsentMarkerSessionId } from './helpers';

describe('buildTechnicianDisplay', () => {
  it('returns name + email + orgName at name_email level', () => {
    expect(buildTechnicianDisplay('name_email', 'Jordan Lee', 'j@acme.com', 'Acme')).toEqual({
      name: 'Jordan Lee',
      email: 'j@acme.com',
      orgName: 'Acme',
    });
  });

  it('drops the email at name level, keeping name + orgName', () => {
    expect(buildTechnicianDisplay('name', 'Jordan Lee', 'j@acme.com', 'Acme')).toEqual({
      name: 'Jordan Lee',
      email: null,
      orgName: 'Acme',
    });
  });

  it('redacts name + email at generic level, keeping only orgName', () => {
    expect(buildTechnicianDisplay('generic', 'Jordan Lee', 'j@acme.com', 'Acme')).toEqual({
      name: null,
      email: null,
      orgName: 'Acme',
    });
  });

  it('passes through null inputs without inventing values', () => {
    expect(buildTechnicianDisplay('name_email', null, null, null)).toEqual({
      name: null,
      email: null,
      orgName: null,
    });
  });
});

describe('buildRemoteSessionPromptPayload', () => {
  const DEVICE = { id: 'dev-1', orgId: 'org-1' };

  function rigTechSelect(result: Promise<unknown[]>) {
    // technician lookup — select({name,email}).from(users).where().limit()
    select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue(result),
        }),
      }),
    } as never);
  }

  function rigPartnerSelect(result: Promise<unknown[]>) {
    // org → partner join — select({name}).from(organizations).innerJoin(partners).where().limit()
    select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue(result),
          }),
        }),
      }),
    } as never);
  }

  beforeEach(() => {
    select.mockReset();
  });

  it('feeds the PARTNER (MSP) name into technicianDisplay, not the client org name', async () => {
    rigTechSelect(Promise.resolve([{ name: 'Billy Tech', email: 'billy@example.com' }]));
    rigPartnerSelect(Promise.resolve([{ name: 'Olive Technology' }]));

    const prompt = await buildRemoteSessionPromptPayload(DEVICE, 'user-1');

    expect(prompt).toMatchObject({
      mode: 'notify',
      showIndicator: true,
      notifyOnEnd: true,
      consentTimeoutMs: 30000,
      technicianDisplay: {
        name: 'Billy Tech',
        email: 'billy@example.com',
        orgName: 'Olive Technology', // partner name — NOT the org name
      },
    });
  });

  it('still ships the prompt with a null identity when the lookups throw', async () => {
    rigTechSelect(Promise.reject(new Error('connection reset')));

    const prompt = await buildRemoteSessionPromptPayload(DEVICE, 'user-1');

    // A resolution failure must not strand the session mid-start: the prompt
    // ships (defaults, indicator on) with the identity fields nulled.
    expect(prompt).toMatchObject({
      mode: 'notify',
      showIndicator: true,
      technicianDisplay: { name: null, email: null, orgName: null },
    });
    expect(captureException).toHaveBeenCalled();
  });
});

describe('classifyConsentDenyAction', () => {
  // The agent WS command-result path and the operator deny route both feed
  // reasons through this single classifier; these cases pin the taxonomy so the
  // two paths can never drift (type-design finding #5).
  it('classifies an explicit user denial as session_consent_denied', () => {
    expect(classifyConsentDenyAction('user')).toBe('session_consent_denied');
  });

  it('classifies a consent timeout as session_consent_denied', () => {
    expect(classifyConsentDenyAction('timeout')).toBe('session_consent_denied');
  });

  it('classifies unavailable/technical reasons as session_consent_bypassed', () => {
    expect(classifyConsentDenyAction('no_user')).toBe('session_consent_bypassed');
    expect(classifyConsentDenyAction('helper_absent')).toBe('session_consent_bypassed');
    expect(classifyConsentDenyAction('policy_proceed')).toBe('session_consent_bypassed');
  });

  it('defaults an unknown/empty reason to the safer bypassed bucket', () => {
    expect(classifyConsentDenyAction('')).toBe('session_consent_bypassed');
    expect(classifyConsentDenyAction('something-new')).toBe('session_consent_bypassed');
  });
});

describe('resolveConsentMarkerSessionId', () => {
  const id = 'sess-abc';

  it('uses the command-id session when the result carries no session id', () => {
    expect(resolveConsentMarkerSessionId(id, null)).toBe(id);
  });

  it('accepts a result session id that matches the command id', () => {
    expect(resolveConsentMarkerSessionId(id, id)).toBe(id);
  });

  it('rejects a mismatched result session id (no cross-session write)', () => {
    expect(resolveConsentMarkerSessionId(id, 'sess-other')).toBeNull();
  });

  it('rejects when the command id yields no session id', () => {
    expect(resolveConsentMarkerSessionId(null, id)).toBeNull();
    expect(resolveConsentMarkerSessionId(null, null)).toBeNull();
  });
});

describe('logSessionAudit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Regression: the viewer-token desktop WS path has no request-scoped DB
  // context, so the audit insert was hitting `audit_logs` RLS and silently
  // failing. See issue #437.
  //
  // Follow-up: the fix must also isolate the audit write from the caller's
  // request transaction to avoid rolling back real work on audit failure.
  // See `services/auditService.ts` for the same pattern.
  it('runs outside the caller context and under a system DB scope', async () => {
    const orgId = '11111111-1111-1111-1111-111111111111';
    const actorId = '22222222-2222-2222-2222-222222222222';
    const sessionId = '33333333-3333-3333-3333-333333333333';

    await logSessionAudit(
      'session_offer_submitted',
      actorId,
      orgId,
      { sessionId, type: 'desktop', via: 'viewer_token' },
      '10.0.0.1'
    );

    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    // Ordering: runOutsideDbContext must wrap withSystemDbAccessContext so the
    // nested system-scope call actually opens a fresh tx on its own connection.
    const outsideOrder = runOutsideDbContext.mock.invocationCallOrder[0]!;
    const systemOrder = withSystemDbAccessContext.mock.invocationCallOrder[0]!;
    expect(outsideOrder).toBeLessThan(systemOrder);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId,
        actorType: 'user',
        actorId,
        action: 'session_offer_submitted',
        resourceType: 'remote_session',
        resourceId: sessionId,
        ipAddress: '10.0.0.1',
        result: 'success'
      })
    );
  });

  it('swallows insert errors so the request path is not broken, and escalates to Sentry', async () => {
    insertValues.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      logSessionAudit(
        'session_offer_submitted',
        '22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111',
        { sessionId: '33333333-3333-3333-3333-333333333333' }
      )
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith('Failed to log session audit:', expect.any(Error));
    expect(captureException).toHaveBeenCalledWith(expect.any(Error));
    errSpy.mockRestore();
  });
});

describe('TURN credential helpers', () => {
  const originalTurnSecret = process.env.TURN_SECRET;
  const originalTurnHost = process.env.TURN_HOST;
  const originalTurnTtl = process.env.TURN_CREDENTIAL_TTL_SECONDS;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TURN_SECRET = 'test-turn-secret';
    process.env.TURN_HOST = 'turn.example.com';
    delete process.env.TURN_CREDENTIAL_TTL_SECONDS;
  });

  afterEach(() => {
    if (originalTurnSecret === undefined) delete process.env.TURN_SECRET;
    else process.env.TURN_SECRET = originalTurnSecret;
    if (originalTurnHost === undefined) delete process.env.TURN_HOST;
    else process.env.TURN_HOST = originalTurnHost;
    if (originalTurnTtl === undefined) delete process.env.TURN_CREDENTIAL_TTL_SECONDS;
    else process.env.TURN_CREDENTIAL_TTL_SECONDS = originalTurnTtl;
  });

  it('generates short-lived scoped usernames with nonce entropy', () => {
    const scope = {
      sessionId: '33333333-3333-4333-8333-333333333333',
      userId: '22222222-2222-4222-8222-222222222222',
      deviceId: '44444444-4444-4444-8444-444444444444',
    };

    const first = generateTurnCredentials(scope);
    const second = generateTurnCredentials(scope);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.ttlSeconds).toBe(600);
    expect(first!.username).toMatch(/^\d+:breeze:22222222-222\.33333333-333\.44444444-444\./);
    expect(second!.username).not.toBe(first!.username);
  });

  it('clamps configured TURN credential TTL to session-scale bounds', () => {
    process.env.TURN_CREDENTIAL_TTL_SECONDS = '86400';
    expect(getTurnCredentialTtlSeconds()).toBe(900);

    process.env.TURN_CREDENTIAL_TTL_SECONDS = '30';
    expect(getTurnCredentialTtlSeconds()).toBe(60);
  });

  it('only includes TURN credentials when a session scope is supplied', () => {
    expect(getIceServers().some((server) => Boolean(server.username))).toBe(false);

    const scoped = getIceServers({
      sessionId: '33333333-3333-4333-8333-333333333333',
      userId: '22222222-2222-4222-8222-222222222222',
      deviceId: '44444444-4444-4444-8444-444444444444',
    });

    expect(scoped.some((server) => Boolean(server.username && server.credential))).toBe(true);
  });
});

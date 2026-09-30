import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  insert,
  insertValues,
  select,
  runOutsideDbContext,
  withSystemDbAccessContext,
  hasDbAccessContext,
  withDbTransaction,
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
  const hasDbAccessContext = vi.fn(() => false);
  const withDbTransaction = vi.fn(async (fn: () => unknown) => fn());
  const captureException = vi.fn();
  return {
    insert,
    insertValues,
    select,
    runOutsideDbContext,
    withSystemDbAccessContext,
    hasDbAccessContext,
    withDbTransaction,
    captureException
  };
});

vi.mock('../../db', () => ({
  db: { insert, select },
  runOutsideDbContext,
  withSystemDbAccessContext,
  hasDbAccessContext,
  withDbTransaction,
}));

vi.mock('../../db/schema', () => ({
  remoteSessions: {},
  devices: {},
  auditLogs: { __table: 'audit_logs' },
  configPolicyFeatureLinks: {},
  configPolicyEffectiveFeatureLinks: {},
  configPolicyRemoteAccessSettings: {},
  users: {},
  organizations: {},
  partners: {}
}));

// buildRemoteSessionPromptPayload → resolveRemoteSessionPromptConfig lazily
// imports the configurationPolicy service. The default is a resolved config
// with no remote_access feature (absence positively established), so the
// prompt config falls to the spec defaults (mode 'notify', indicator on).
const { resolveEffectiveConfig } = vi.hoisted(() => ({
  resolveEffectiveConfig: vi.fn(async (): Promise<unknown> => ({ deviceId: 'dev-1', features: {} })),
}));
vi.mock('../../services/configurationPolicy', () => ({
  resolveEffectiveConfig,
}));

vi.mock('../../services/sentry', () => ({
  captureException
}));

import {
  buildRemoteSessionPromptPayload,
  buildTechnicianDisplay,
  classifyConsentDenyAction,
  consentMarkerAuditDetails,
  isUnsolicitedConsentReason,
  createDesktopStartCommandId,
  generateTurnCredentials,
  getIceServers,
  getTurnCredentialTtlSeconds,
  logSessionAudit,
  parseDesktopStartCommandId,
  resolveConsentMarkerSessionId,
  resolveRemoteSessionPromptConfig,
} from './helpers';
import { RemoteSessionPromptPolicyError, requiresConsentCapableAgent } from './consentGate';

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
      // Flat identity fields — the agent and assist app read the top-level keys.
      technicianName: 'Billy Tech',
      technicianEmail: 'billy@example.com',
      orgName: 'Olive Technology', // partner name — NOT the client org name
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
      technicianName: null,
      technicianEmail: null,
      orgName: null,
    });
    expect(captureException).toHaveBeenCalled();
  });

  it('propagates a prompt-policy resolution failure instead of shipping a notify prompt', async () => {
    resolveEffectiveConfig.mockRejectedValueOnce(new Error('connection reset'));

    await expect(buildRemoteSessionPromptPayload(DEVICE, 'user-1'))
      .rejects.toBeInstanceOf(RemoteSessionPromptPolicyError);
    // No identity lookups: the start is refused before any prompt is built.
    expect(select).not.toHaveBeenCalled();
  });
});

describe('isUnsolicitedConsentReason', () => {
  // #6819: only these two reasons may activate a consent-mode start without a
  // user grant, and only under a bound `proceed` fallback. no_user fails closed
  // on the agent and must never be accepted as an activation reason.
  it('accepts helper_absent, timeout and no_user_session', () => {
    expect(isUnsolicitedConsentReason('helper_absent')).toBe(true);
    expect(isUnsolicitedConsentReason('timeout')).toBe(true);
    // Version 2 agents report "nobody is signed in to the captured session"
    // separately from "someone is signed in but could not be asked".
    expect(isUnsolicitedConsentReason('no_user_session')).toBe(true);
  });

  it('rejects user, no_user, helper_unreachable, unknown and non-string values', () => {
    // helper_unreachable means a signed-in user could not be prompted: the
    // agent always blocks it, and the server never activates on it.
    for (const v of ['user', 'no_user', 'helper_unreachable', 'policy_proceed', '', undefined, null, 1]) {
      expect(isUnsolicitedConsentReason(v)).toBe(false);
    }
  });
});

describe('consentMarkerAuditDetails', () => {
  it('records a version 1 marker as consentProtocol 1 with no outcome fields', () => {
    expect(consentMarkerAuditDetails({ reason: 'helper_absent' })).toEqual({ consentProtocol: 1 });
  });

  it('carries the version 2 structured outcome through verbatim', () => {
    expect(consentMarkerAuditDetails({
      reason: 'helper_unreachable',
      consentProtocol: 2,
      consentOutcome: 'unavailable',
      consentOccupancy: 'occupied',
      consentDetail: 'no_presentation',
    })).toEqual({
      consentProtocol: 2,
      consentOutcome: 'unavailable',
      consentOccupancy: 'occupied',
      consentDetail: 'no_presentation',
    });
  });

  it('ignores non-string values', () => {
    expect(consentMarkerAuditDetails({ consentProtocol: 2, consentOutcome: 1, consentOccupancy: null })).toEqual({ consentProtocol: 2 });
  });
});

describe('classifyConsentDenyAction', () => {
  // The agent WS command-result path feeds every consent_denied reason through
  // this single classifier. A refused start is never audited as session_consent_bypassed:
  // `session_consent_bypassed` is reserved for a start that PROCEEDED without
  // an answer (written on the activation path, not here).
  it('classifies an explicit user denial as session_consent_denied', () => {
    expect(classifyConsentDenyAction('user')).toBe('session_consent_denied');
  });

  it('classifies an unanswered prompt as session_consent_blocked_unanswered', () => {
    expect(classifyConsentDenyAction('timeout')).toBe('session_consent_blocked_unanswered');
  });

  it('classifies unavailable/technical reasons as session_consent_blocked_unavailable', () => {
    expect(classifyConsentDenyAction('no_user')).toBe('session_consent_blocked_unavailable');
    expect(classifyConsentDenyAction('helper_absent')).toBe('session_consent_blocked_unavailable');
    expect(classifyConsentDenyAction('policy_proceed')).toBe('session_consent_blocked_unavailable');
    expect(classifyConsentDenyAction('no_user_session')).toBe('session_consent_blocked_unavailable');
    expect(classifyConsentDenyAction('helper_unreachable')).toBe('session_consent_blocked_unavailable');
  });

  it('classifies an unknown/empty reason as blocked-unavailable, never as session_consent_bypassed', () => {
    expect(classifyConsentDenyAction('')).toBe('session_consent_blocked_unavailable');
    expect(classifyConsentDenyAction('something-new')).toBe('session_consent_blocked_unavailable');
    for (const reason of ['user', 'timeout', 'no_user', 'helper_absent', '', 'x']) {
      expect(classifyConsentDenyAction(reason)).not.toBe('session_consent_bypassed');
    }
  });
});

describe('resolveRemoteSessionPromptConfig', () => {
  const REMOTE_ACCESS_FEATURE = {
    featureType: 'remote_access',
    sourcePolicyId: 'policy-1',
    inlineSettings: null,
  };

  // link lookup — select({...}).from(effectiveLinks).leftJoin(settings).where().limit()
  function rigLinkSelect(result: unknown[] | Error) {
    select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: result instanceof Error
              ? vi.fn().mockRejectedValue(result)
              : vi.fn().mockResolvedValue(result),
          }),
        }),
      }),
    } as never);
  }

  function settingsRow(overrides: Record<string, unknown> = {}) {
    return {
      linkId: 'link-1',
      linkInlineSettings: { sessionPromptMode: 'consent' },
      settingsId: 'settings-1',
      sessionPromptMode: 'consent',
      consentUnavailableBehavior: 'block',
      notifyOnSessionEnd: true,
      showActiveIndicator: true,
      technicianIdentityLevel: 'name',
      ...overrides,
    };
  }

  beforeEach(() => {
    select.mockReset();
    captureException.mockClear();
    resolveEffectiveConfig.mockReset();
    resolveEffectiveConfig.mockResolvedValue({ deviceId: 'dev-1', features: {} });
  });

  it('returns the notify defaults only when the device resolves with no remote_access policy', async () => {
    const cfg = await resolveRemoteSessionPromptConfig('dev-1');
    expect(cfg).toEqual({
      mode: 'notify',
      consentUnavailableBehavior: 'proceed',
      notifyOnEnd: true,
      showIndicator: true,
      identityLevel: 'name_email',
    });
    expect(select).not.toHaveBeenCalled();
  });

  it('resolves in the caller\'s DB context (a savepoint, no second connection) when one is active', async () => {
    hasDbAccessContext.mockReturnValue(true);
    runOutsideDbContext.mockClear();
    withSystemDbAccessContext.mockClear();
    withDbTransaction.mockClear();
    try {
      await expect(resolveRemoteSessionPromptConfig('dev-1')).resolves.toMatchObject({ mode: 'notify' });
      expect(withDbTransaction).toHaveBeenCalledTimes(1);
      expect(runOutsideDbContext).not.toHaveBeenCalled();
      expect(withSystemDbAccessContext).not.toHaveBeenCalled();
    } finally {
      hasDbAccessContext.mockReturnValue(false);
    }
  });

  it('opens a system DB context only when no DB context is active', async () => {
    runOutsideDbContext.mockClear();
    withSystemDbAccessContext.mockClear();
    withDbTransaction.mockClear();
    await expect(resolveRemoteSessionPromptConfig('dev-1')).resolves.toMatchObject({ mode: 'notify' });
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    expect(withDbTransaction).not.toHaveBeenCalled();
  });

  it('returns the stored consent settings when the normalized row exists', async () => {
    resolveEffectiveConfig.mockResolvedValue({ deviceId: 'dev-1', features: { remote_access: REMOTE_ACCESS_FEATURE } });
    rigLinkSelect([settingsRow()]);
    await expect(resolveRemoteSessionPromptConfig('dev-1')).resolves.toEqual({
      mode: 'consent',
      consentUnavailableBehavior: 'block',
      notifyOnEnd: true,
      showIndicator: true,
      identityLevel: 'name',
    });
  });

  it('refuses (throws) instead of falling back to notify when policy resolution throws', async () => {
    resolveEffectiveConfig.mockRejectedValue(new Error('connection reset'));
    await expect(resolveRemoteSessionPromptConfig('dev-1')).rejects.toBeInstanceOf(RemoteSessionPromptPolicyError);
    expect(captureException).toHaveBeenCalled();
  });

  it('refuses when the device configuration cannot be resolved at all', async () => {
    resolveEffectiveConfig.mockResolvedValue(null);
    await expect(resolveRemoteSessionPromptConfig('dev-1')).rejects.toThrow(/did not resolve/);
  });

  it('refuses when the settings lookup throws', async () => {
    resolveEffectiveConfig.mockResolvedValue({ deviceId: 'dev-1', features: { remote_access: REMOTE_ACCESS_FEATURE } });
    rigLinkSelect(new Error('statement timeout'));
    await expect(resolveRemoteSessionPromptConfig('dev-1')).rejects.toThrow(/statement timeout/);
  });

  it('refuses when the resolved remote_access policy has no matching feature link', async () => {
    resolveEffectiveConfig.mockResolvedValue({ deviceId: 'dev-1', features: { remote_access: REMOTE_ACCESS_FEATURE } });
    rigLinkSelect([]);
    await expect(resolveRemoteSessionPromptConfig('dev-1')).rejects.toThrow(/feature link not found/);
  });

  it('refuses an invalid stored prompt mode instead of coercing it to notify', async () => {
    resolveEffectiveConfig.mockResolvedValue({ deviceId: 'dev-1', features: { remote_access: REMOTE_ACCESS_FEATURE } });
    rigLinkSelect([settingsRow({ sessionPromptMode: 'CONSENT ' })]);
    await expect(resolveRemoteSessionPromptConfig('dev-1')).rejects.toThrow(/invalid session prompt mode/);
  });

  it('refuses an invalid stored unavailable-behavior instead of coercing it to proceed', async () => {
    resolveEffectiveConfig.mockResolvedValue({ deviceId: 'dev-1', features: { remote_access: REMOTE_ACCESS_FEATURE } });
    rigLinkSelect([settingsRow({ consentUnavailableBehavior: 'maybe' })]);
    await expect(resolveRemoteSessionPromptConfig('dev-1')).rejects.toThrow(/invalid consent-unavailable behavior/);
  });

  it('refuses a missing settings row when the link carries prompt settings', async () => {
    resolveEffectiveConfig.mockResolvedValue({ deviceId: 'dev-1', features: { remote_access: REMOTE_ACCESS_FEATURE } });
    rigLinkSelect([settingsRow({
      settingsId: null,
      sessionPromptMode: null,
      consentUnavailableBehavior: null,
      notifyOnSessionEnd: null,
      showActiveIndicator: null,
      technicianIdentityLevel: null,
    })]);
    await expect(resolveRemoteSessionPromptConfig('dev-1')).rejects.toThrow(/settings row missing/);
  });

  it('uses the stored-row defaults for a missing settings row when the link carries no prompt settings', async () => {
    resolveEffectiveConfig.mockResolvedValue({ deviceId: 'dev-1', features: { remote_access: REMOTE_ACCESS_FEATURE } });
    rigLinkSelect([settingsRow({
      linkInlineSettings: { webrtcDesktop: true, vncRelay: true },
      settingsId: null,
      sessionPromptMode: null,
      consentUnavailableBehavior: null,
      notifyOnSessionEnd: null,
      showActiveIndicator: null,
      technicianIdentityLevel: null,
    })]);
    await expect(resolveRemoteSessionPromptConfig('dev-1')).resolves.toMatchObject({
      mode: 'notify',
      consentUnavailableBehavior: 'proceed',
    });
  });
});

describe('requiresConsentCapableAgent', () => {
  it('is true only for a consent-mode prompt on an agent without the consent prompt protocol', () => {
    expect(requiresConsentCapableAgent({ mode: 'consent' }, { consentPromptProtocolVersion: 0 })).toBe(true);
    expect(requiresConsentCapableAgent({ mode: 'consent' }, { consentPromptProtocolVersion: 3 })).toBe(true);
    expect(requiresConsentCapableAgent({ mode: 'consent' }, { consentPromptProtocolVersion: null })).toBe(true);
    expect(requiresConsentCapableAgent({ mode: 'consent' }, { consentPromptProtocolVersion: 1 })).toBe(false);
    // Version 2 agents report whether the prompt was shown and answered; they
    // gate capture on the prompt block exactly like version 1.
    expect(requiresConsentCapableAgent({ mode: 'consent' }, { consentPromptProtocolVersion: 2 })).toBe(false);
    expect(requiresConsentCapableAgent({ mode: 'notify' }, { consentPromptProtocolVersion: 0 })).toBe(false);
    expect(requiresConsentCapableAgent(undefined, { consentPromptProtocolVersion: 0 })).toBe(false);
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

describe('desktop start command generations', () => {
  it('creates and parses a one-off generation-bound identity', () => {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const first = createDesktopStartCommandId(sessionId);
    const second = createDesktopStartCommandId(sessionId);

    expect(first).not.toBe(second);
    expect(parseDesktopStartCommandId(first)).toEqual({ sessionId, commandId: first });
    expect(parseDesktopStartCommandId(second)).toEqual({ sessionId, commandId: second });
  });

  it.each([
    'desk-start-33333333-3333-4333-8333-333333333333',
    'desk-start-session-not-a-generation',
    'desk-stop-33333333-3333-4333-8333-333333333333-22222222-2222-4222-8222-222222222222',
  ])('rejects a legacy or malformed command identity: %s', (commandId) => {
    expect(parseDesktopStartCommandId(commandId)).toBeNull();
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

  it('records authenticated endpoint reports with agent provenance', async () => {
    await logSessionAudit(
      'session_consent_granted',
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      { sessionId: '33333333-3333-4333-8333-333333333333' },
      undefined,
      'agent',
    );

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'agent',
      actorId: '22222222-2222-4222-8222-222222222222',
    }));
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveRemoteSessionPromptConfig, createAuditLogAsync } = vi.hoisted(() => ({
  resolveRemoteSessionPromptConfig: vi.fn(),
  createAuditLogAsync: vi.fn(async () => undefined),
}));
vi.mock('./helpers', () => ({ resolveRemoteSessionPromptConfig }));
vi.mock('../../services/auditService', () => ({ createAuditLogAsync }));

import { checkScreenAccessConsentGate, SCREEN_ACCESS_CONSENT_BLOCKED_AUDIT_ACTION } from './screenAccessConsentGate';
import { RemoteSessionPromptPolicyError } from './consentGate';

const DEVICE_ID = '11111111-2222-4333-8444-555555555555';
const ORG_ID = '22222222-3333-4444-8555-666666666666';
const USER_ID = '33333333-4444-4555-8666-777777777777';
const AGENT_ID = '44444444-5555-4666-8777-888888888888';

function config(mode: 'off' | 'notify' | 'consent') {
  return {
    mode,
    consentUnavailableBehavior: 'proceed',
    notifyOnEnd: true,
    showIndicator: true,
    identityLevel: 'name_email',
  };
}

const userActor = {
  principal: { kind: 'user_session' as const },
  user: { id: USER_ID, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
};

function gateInput(overrides: Partial<Parameters<typeof checkScreenAccessConsentGate>[0]> = {}) {
  return {
    deviceId: DEVICE_ID,
    orgId: ORG_ID,
    hostname: 'pc-1',
    surface: 'take_screenshot' as const,
    actor: userActor,
    isEphemeral: false,
    ...overrides,
  };
}

describe('checkScreenAccessConsentGate', () => {
  beforeEach(() => {
    resolveRemoteSessionPromptConfig.mockReset();
    createAuditLogAsync.mockClear();
  });

  it.each(['off', 'notify'] as const)('allows screen access when the resolved prompt mode is %s, without an audit row', async (mode) => {
    resolveRemoteSessionPromptConfig.mockResolvedValueOnce(config(mode));
    await expect(checkScreenAccessConsentGate(gateInput())).resolves.toEqual({ ok: true });
    expect(resolveRemoteSessionPromptConfig).toHaveBeenCalledWith(DEVICE_ID);
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });

  it.each(['take_screenshot', 'analyze_screen', 'computer_control', 'device_diagnose'] as const)(
    'refuses %s with 409 CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE on a consent-mode device and audits it',
    async (surface) => {
      resolveRemoteSessionPromptConfig.mockResolvedValueOnce(config('consent'));
      const result = await checkScreenAccessConsentGate(gateInput({ surface }));
      expect(result).toEqual({
        ok: false,
        status: 409,
        body: {
          code: 'CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE',
          error: expect.stringMatching(/requires the user's consent/),
        },
      });
      expect(createAuditLogAsync).toHaveBeenCalledTimes(1);
      expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
        orgId: ORG_ID,
        actorType: 'user',
        actorId: USER_ID,
        action: SCREEN_ACCESS_CONSENT_BLOCKED_AUDIT_ACTION,
        resourceType: 'device',
        resourceId: DEVICE_ID,
        resourceName: 'pc-1',
        result: 'denied',
        initiatedBy: surface === 'device_diagnose' ? 'manual' : 'ai',
        details: {
          deviceId: DEVICE_ID,
          surface,
          reason: 'prompt_unsupported',
          promptMode: 'consent',
        },
      }));
    },
  );

  it('refuses with 503 REMOTE_PROMPT_POLICY_UNAVAILABLE when the prompt policy cannot be read, and audits it', async () => {
    resolveRemoteSessionPromptConfig.mockRejectedValueOnce(
      new RemoteSessionPromptPolicyError(DEVICE_ID, 'statement timeout'),
    );
    const result = await checkScreenAccessConsentGate(gateInput({ surface: 'analyze_screen' }));
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      body: { code: 'REMOTE_PROMPT_POLICY_UNAVAILABLE' },
    });
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: SCREEN_ACCESS_CONSENT_BLOCKED_AUDIT_ACTION,
      result: 'denied',
      details: {
        deviceId: DEVICE_ID,
        surface: 'analyze_screen',
        reason: 'policy_unavailable',
        promptMode: null,
      },
    }));
  });

  it.each(['take_screenshot', 'analyze_screen', 'computer_control', 'device_diagnose'] as const)(
    'refuses %s with 409 SCREEN_ACCESS_UNAVAILABLE_IN_QUICK_SUPPORT on a Quick Support device, whatever its prompt mode, and audits it',
    async (surface) => {
      resolveRemoteSessionPromptConfig.mockResolvedValue(config('off'));
      const result = await checkScreenAccessConsentGate(gateInput({ surface, isEphemeral: true }));
      expect(result).toEqual({
        ok: false,
        status: 409,
        body: {
          code: 'SCREEN_ACCESS_UNAVAILABLE_IN_QUICK_SUPPORT',
          error: expect.stringMatching(/Quick Support/),
        },
      });
      expect(resolveRemoteSessionPromptConfig).not.toHaveBeenCalled();
      expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
        action: SCREEN_ACCESS_CONSENT_BLOCKED_AUDIT_ACTION,
        result: 'denied',
        details: { deviceId: DEVICE_ID, surface, reason: 'quick_support_session', promptMode: null },
      }));
    },
  );

  it('rethrows an unexpected error rather than allowing screen access', async () => {
    resolveRemoteSessionPromptConfig.mockRejectedValueOnce(new TypeError('boom'));
    await expect(checkScreenAccessConsentGate(gateInput())).rejects.toThrow('boom');
  });

  it('records an AI agent principal as an ai_agent actor', async () => {
    resolveRemoteSessionPromptConfig.mockResolvedValueOnce(config('consent'));
    await checkScreenAccessConsentGate(gateInput({
      actor: {
        principal: { kind: 'ai_agent', agentId: AGENT_ID, runId: 'run-1' },
        user: { id: AGENT_ID, email: 'agent', name: 'Agent', isPlatformAdmin: false },
      },
    }));
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'ai_agent',
      actorId: AGENT_ID,
    }));
  });

  it('records a device helper principal as an agent actor', async () => {
    resolveRemoteSessionPromptConfig.mockResolvedValueOnce(config('consent'));
    const result = await checkScreenAccessConsentGate(gateInput({
      actor: {
        principal: { kind: 'helper', deviceId: DEVICE_ID },
        user: { id: DEVICE_ID, email: 'helper@pc-1', name: 'pc-1', isPlatformAdmin: false },
      },
    }));
    // The on-device helper chat is refused too: the capture is not bound to
    // the Windows session the chat runs in, so it cannot stand in for consent.
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'agent',
      actorId: DEVICE_ID,
    }));
  });

  it('falls back to the nil actor id when the principal id is not a uuid', async () => {
    resolveRemoteSessionPromptConfig.mockResolvedValueOnce(config('consent'));
    await checkScreenAccessConsentGate(gateInput({
      actor: {
        principal: { kind: 'system', reason: 'test' },
        user: { id: 'system', email: 'system', name: 'System', isPlatformAdmin: false },
      },
    }));
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'system',
      actorId: '00000000-0000-0000-0000-000000000000',
    }));
  });
});

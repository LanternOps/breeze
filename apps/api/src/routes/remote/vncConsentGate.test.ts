import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveRemoteSessionPromptConfig } = vi.hoisted(() => ({
  resolveRemoteSessionPromptConfig: vi.fn(),
}));
vi.mock('./helpers', () => ({ resolveRemoteSessionPromptConfig }));

import { checkVncConsentGate } from './vncConsentGate';
import { RemoteSessionPromptPolicyError } from './consentGate';

function config(mode: 'off' | 'notify' | 'consent') {
  return {
    mode,
    consentUnavailableBehavior: 'proceed',
    notifyOnEnd: true,
    showIndicator: true,
    identityLevel: 'name_email',
  };
}

describe('checkVncConsentGate', () => {
  beforeEach(() => {
    resolveRemoteSessionPromptConfig.mockReset();
  });

  it.each(['off', 'notify'] as const)('allows VNC when the resolved prompt mode is %s', async (mode) => {
    resolveRemoteSessionPromptConfig.mockResolvedValueOnce(config(mode));
    await expect(checkVncConsentGate('dev-1')).resolves.toEqual({ ok: true });
    expect(resolveRemoteSessionPromptConfig).toHaveBeenCalledWith('dev-1');
  });

  it('refuses VNC with 409 CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE when the prompt mode is consent', async () => {
    resolveRemoteSessionPromptConfig.mockResolvedValueOnce(config('consent'));
    const result = await checkVncConsentGate('dev-1');
    expect(result).toEqual({
      ok: false,
      status: 409,
      body: {
        code: 'CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE',
        error: expect.stringMatching(/VNC can't ask for consent/),
      },
    });
  });

  it('refuses VNC with 503 when the prompt policy cannot be resolved', async () => {
    resolveRemoteSessionPromptConfig.mockRejectedValueOnce(
      new RemoteSessionPromptPolicyError('dev-1', 'statement timeout'),
    );
    await expect(checkVncConsentGate('dev-1')).resolves.toMatchObject({
      ok: false,
      status: 503,
      body: { code: 'REMOTE_PROMPT_POLICY_UNAVAILABLE' },
    });
  });

  it('rethrows an unexpected error rather than allowing VNC', async () => {
    resolveRemoteSessionPromptConfig.mockRejectedValueOnce(new TypeError('boom'));
    await expect(checkVncConsentGate('dev-1')).rejects.toThrow('boom');
  });
});

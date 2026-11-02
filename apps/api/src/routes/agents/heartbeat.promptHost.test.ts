import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { promptHostSettingsSchema } from '@breeze/shared/promptHost';
import { setupHeartbeatHarness, beat, resetSelects, recordPromptHostObservationMock, recordWorkstationCapabilitiesMock } from './heartbeatTestHarness';
const REPORT = { protocolVersion: 1, kinds: ['notice.info@1'], rendererVersion: '0.2.0' };
const READINESS = { callerVerify: true, usernames: ['alex'] };

const originalKinds = process.env.PROMPT_HOST_ENABLED_KINDS;
afterEach(() => {
  vi.restoreAllMocks();
  if (originalKinds === undefined) delete process.env.PROMPT_HOST_ENABLED_KINDS;
  else process.env.PROMPT_HOST_ENABLED_KINDS = originalKinds;
});

describe('POST /agents/:id/heartbeat — prompt host (#10190 W02)', () => {
  beforeEach(setupHeartbeatHarness);

  async function promptHostOf(resp: Response): Promise<unknown> {
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('promptHost');
    // The wire shape the agent decodes (shared contract).
    expect(promptHostSettingsSchema.safeParse(body.promptHost).success).toBe(true);
    return body.promptHost;
  }

  describe('heartbeat response always carries promptHost.enabledKinds', () => {
    it('unset env: the code default (empty in W02), with no helper policy and no helperCapabilities', async () => {
      expect(await promptHostOf(await beat())).toEqual({ enabledKinds: [] });
    });

    it('carries the configured kinds, dropping unknown entries', async () => {
      process.env.PROMPT_HOST_ENABLED_KINDS = 'notice.info, restart.prompt@1,bogus.kind';
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await promptHostOf(await beat())).toEqual({ enabledKinds: ['notice.info', 'restart.prompt@1'] });
    });

    it('the kill switch (empty string) still sends the block, empty', async () => {
      process.env.PROMPT_HOST_ENABLED_KINDS = '';
      expect(await promptHostOf(await beat())).toEqual({ enabledKinds: [] });
    });

    it('is present on a retain-state beat too', async () => {
      process.env.PROMPT_HOST_ENABLED_KINDS = 'notice.info';
      const resp = await beat({ securityCapabilities: { retainStateProtocolVersion: 1 } });
      expect(await promptHostOf(resp)).toEqual({ enabledKinds: ['notice.info'] });
    });
  });

  describe('the live renderer observation', () => {
    it('records a well-formed report for the authenticated device', async () => {
      const resp = await beat({ helperCapabilities: { ...READINESS, promptHost: REPORT } });
      expect(resp.status).toBe(200);
      expect(recordPromptHostObservationMock).toHaveBeenCalledTimes(1);
      expect(recordPromptHostObservationMock).toHaveBeenCalledWith('device-1', REPORT);
    });

    it('records a renderer that advertises no kinds', async () => {
      const empty = { protocolVersion: 1, kinds: [], rendererVersion: '0.2.0' };
      expect((await beat({ helperCapabilities: { ...READINESS, promptHost: empty } })).status).toBe(200);
      expect(recordPromptHostObservationMock).toHaveBeenCalledWith('device-1', empty);
    });

    it('an old agent (no helperCapabilities at all) clears the observation', async () => {
      expect((await beat()).status).toBe(200);
      expect(recordPromptHostObservationMock).toHaveBeenCalledTimes(1);
      expect(recordPromptHostObservationMock).toHaveBeenCalledWith('device-1', undefined);
    });

    it.each([
      ['a string protocolVersion', { protocolVersion: 'one', kinds: [], rendererVersion: '0.2.0' }],
      ['a malformed kind', { protocolVersion: 1, kinds: ['Notice.Info'], rendererVersion: '0.2.0' }],
      ['an over-long rendererVersion', { protocolVersion: 1, kinds: [], rendererVersion: 'v'.repeat(33) }],
      ['a string block', 'assist'],
    ])('malformed helperCapabilities.promptHost does not fail the heartbeat (%s)', async (_label, promptHost) => {
      const resp = await beat({ helperCapabilities: { ...READINESS, promptHost } });
      expect(await promptHostOf(resp)).toEqual({ enabledKinds: [] });
      // The bad block degrades to "nothing reported" ...
      expect(recordPromptHostObservationMock).toHaveBeenCalledWith('device-1', undefined);
      // ... and does not take the caller-verification readiness beside it.
      expect(recordWorkstationCapabilitiesMock).toHaveBeenCalledWith(
        'org-1', 'device-1', expect.objectContaining(READINESS),
      );
    });
  });

  // Review: a dropped block reads like "no renderer" on the device page, so
  // the collapse is logged (throttled), the same idea as #1121 watchdogState.
  describe('a present-but-invalid promptHost is logged, never silent', () => {
    function promptHostWarnings(warn: MockInstance) {
      return warn.mock.calls.filter((call) => String(call[0]).includes('helperCapabilities.promptHost'));
    }

    it('present but invalid: one warning naming the device', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const resp = await beat({ helperCapabilities: { ...READINESS, promptHost: { protocolVersion: 'one' } } });
      expect(resp.status).toBe(200);
      const hits = promptHostWarnings(warn);
      expect(hits).toHaveLength(1);
      expect(String(hits[0]![0])).toContain('device-1');
    });

    it('absent (old agent): no warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await beat({ helperCapabilities: READINESS })).status).toBe(200);
      resetSelects();
      expect((await beat()).status).toBe(200);
      expect(promptHostWarnings(warn)).toHaveLength(0);
    });

    it('well-formed: no warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await beat({ helperCapabilities: { ...READINESS, promptHost: REPORT } })).status).toBe(200);
      expect(promptHostWarnings(warn)).toHaveLength(0);
    });
  });

  // A watchdog beat does not describe the user session: it must neither
  // write nor clear the main agent's observation. Paired with a main-role
  // control carrying the same body.
  describe('watchdog beats never touch the observation', () => {
    const body = { helperCapabilities: { ...READINESS, promptHost: REPORT } };

    it('control: the main agent role records it', async () => {
      expect((await beat(body)).status).toBe(200);
      expect(recordPromptHostObservationMock).toHaveBeenCalledTimes(1);
      expect(recordPromptHostObservationMock).toHaveBeenCalledWith('device-1', REPORT);
    });

    it('the watchdog role does not', async () => {
      const resp = await beat({ ...body, role: 'watchdog', watchdogState: 'MONITORING' }, { role: 'watchdog' });
      expect(resp.status).toBe(200);
      expect(recordPromptHostObservationMock).not.toHaveBeenCalled();
    });
  });
});


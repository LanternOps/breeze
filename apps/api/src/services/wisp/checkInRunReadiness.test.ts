/** #11610 — the decision logic behind the schedule-time refusal of a run check-in. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envFlag } = vi.hoisted(() => ({ envFlag: vi.fn() }));
const { resolveEffectiveAgentSystem } = vi.hoisted(() => ({ resolveEffectiveAgentSystem: vi.fn() }));
vi.mock('../../config/env', () => ({ envFlag }));
vi.mock('../aiAgents/effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

import { runCheckInBlocker, runCheckInBlockerMessage, type RunCheckInBlocker } from './checkInRunReadiness';

const ORG = '00000000-0000-4000-8000-000000000d01';

beforeEach(() => {
  vi.clearAllMocks();
  envFlag.mockReturnValue(true);
  resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: true, mode: 'act' } });
});

describe('runCheckInBlocker', () => {
  it('null when an enabled Triage agent resolves; asks for the triage kind', async () => {
    expect(await runCheckInBlocker(ORG)).toBeNull();
    expect(resolveEffectiveAgentSystem).toHaveBeenCalledWith(ORG, 'triage');
  });

  it('kill switch off wins before any agent is resolved', async () => {
    envFlag.mockReturnValue(false);
    expect(await runCheckInBlocker(ORG)).toBe('kill_switch_off');
    expect(resolveEffectiveAgentSystem).not.toHaveBeenCalled();
  });

  it('no agent resolves → no_effective_agent', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(null);
    expect(await runCheckInBlocker(ORG)).toBe('no_effective_agent');
  });

  it('a resolved but disabled agent → agent_disabled (before the mode check)', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: false, mode: 'off' } });
    expect(await runCheckInBlocker(ORG)).toBe('agent_disabled');
  });

  it('an enabled agent in mode off → mode_off', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue({ agentId: 'a', effective: { enabled: true, mode: 'off' } });
    expect(await runCheckInBlocker(ORG)).toBe('mode_off');
  });

  it('a resolver failure propagates (loud, not a false "ready")', async () => {
    resolveEffectiveAgentSystem.mockRejectedValue(new Error('db down'));
    await expect(runCheckInBlocker(ORG)).rejects.toThrow('db down');
  });
});

describe('runCheckInBlockerMessage', () => {
  it.each<[RunCheckInBlocker, string]>([
    ['no_effective_agent', 'No Triage agent is switched on'],
    ['agent_disabled', 'No Triage agent is switched on'],
    ['mode_off', 'set to mode Off'],
    ['kill_switch_off', 'turned off on this server'],
  ])('%s names its cause and the notify fallback', (blocker, text) => {
    const msg = runCheckInBlockerMessage(blocker);
    expect(msg).toContain(text);
    expect(msg).toContain('mode notify');
  });
});

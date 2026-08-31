/**
 * Ticket-shadow guardrail contract (#3828 wave-6-3 task 3).
 *
 * Pins the claim the plan's Self-Review Notes make explicit: a
 * ticket-triggered agent run must write NOTHING to tickets. Two independent,
 * already-existing guardrail rules combine to guarantee this for EVERY
 * `manage_tickets` mutation action, with no new gating code required by this
 * task:
 *
 *  1. Ticket-triggered runs are FORCED shadow (`runService.ts`,
 *     `modeAtStart = triggerKind === 'ticket' ? 'shadow' : effective.mode`)
 *     — shadow mode converts every non-read-only tool call into a recorded
 *     `propose` disposition rather than executing it.
 *  2. Ticket-triggered runs are ALSO always device-less (`deviceId: null` —
 *     tickets have no device axis in v1), and `checkAgentGuardrails` denies
 *     ANY mutating tool call from a device-less run outright (a device-less
 *     mutation would be org-wide with no site scope a human approver could
 *     see) — this fires even in 'act' mode, so it is a stronger, independent
 *     backstop, not merely a restatement of (1).
 *
 * This suite proves both hold for every `manage_tickets` mutation action.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { checkAgentGuardrails, TIER2_ACTIONS, type AgentGuardrailPolicy } from '../aiGuardrails';

const BASE_POLICY: AgentGuardrailPolicy = {
  enabled: true,
  mode: 'shadow',
  toolAllowlist: ['manage_tickets'],
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  // Ticket-triggered runs are always device-less (runLoop.ts's
  // guardrailPolicy.deviceId = run.deviceId, and run.deviceId is always null
  // for triggerKind: 'ticket' — runService.ts never accepts a device for a
  // ticket admission).
  deviceId: null,
  deviceSiteId: null,
};

// Every mutating manage_tickets action: all of TIER2_ACTIONS.manage_tickets
// (aiGuardrails.ts — derived, not restated, so this suite can't silently
// drift from the real tier table) plus the Tier-3 `move_org` (tenant-shape
// mutation, gated separately from the TIER2 table). list/get are
// deliberately excluded — they are read-only and legitimately reach 'allow',
// which is correct and not what this suite is about.
const MUTATING_ACTIONS = [...TIER2_ACTIONS.manage_tickets!, 'move_org'] as const;

beforeEach(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.BREEZE_AI_AGENTS_ENABLED;
});

describe('a device-less ticket-triggered run never mutates tickets', () => {
  it.each(MUTATING_ACTIONS)(
    'manage_tickets:%s denies outright (device-less mutation gate) even under shadow',
    (action) => {
      const verdict = checkAgentGuardrails('manage_tickets', { action }, BASE_POLICY);
      expect(verdict.disposition).toBe('deny');
      expect(verdict.allowed).toBe(false);
    },
  );

  it.each(MUTATING_ACTIONS)(
    'manage_tickets:%s STILL denies even if the operator forced act mode on the policy snapshot',
    (action) => {
      // Belt-and-suspenders: runService.ts's forced-shadow override means
      // this policy shape (mode: 'act' with deviceId: null) can never
      // actually be constructed for a real ticket run — but the device-less
      // gate must hold independently of modeAtStart, since it is the
      // stronger of the two backstops the module doc above describes.
      const verdict = checkAgentGuardrails(
        'manage_tickets',
        { action },
        { ...BASE_POLICY, mode: 'act' },
      );
      expect(verdict.disposition).toBe('deny');
      expect(verdict.allowed).toBe(false);
    },
  );

  it('read-only actions are unaffected (list/get still allow)', () => {
    for (const action of ['list', 'get']) {
      const verdict = checkAgentGuardrails('manage_tickets', { action }, BASE_POLICY);
      expect(verdict.disposition).toBe('allow');
    }
  });
});

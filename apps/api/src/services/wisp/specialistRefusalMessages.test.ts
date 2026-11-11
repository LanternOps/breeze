/**
 * #10193 — every launch_specialist refusal reads as a sentence with a next
 * step, never only a code.
 */
import { describe, expect, it } from 'vitest';
import type { SpecialistRefusal } from './specialistLaunchers';
import { agentOffMessage, specialistRefusalMessage } from './specialistRefusalMessages';

const CODES: SpecialistRefusal[] = [
  'wisp_disabled', 'not_entitled', 'grant_inactive', 'org_out_of_ceiling', 'depth_exceeded',
  'budget_exhausted', 'permission_missing', 'workspace_execute_required', 'unknown_kind',
  'invalid_params', 'device_not_in_org', 'no_sweep_schedule', 'no_effective_agent', 'agent_disabled',
  'admission_skipped', 'too_many_requests', 'bulk_reply_incomplete',
];

describe('specialistRefusalMessage', () => {
  it.each(CODES)('%s has a sentence that is not the bare code', (code) => {
    const message = specialistRefusalMessage(code);
    expect(message).toMatch(/\.$/);
    expect(message).not.toContain(code);
  });

  it('points the agent refusals at Settings → AI Agents', () => {
    for (const code of ['no_effective_agent', 'agent_disabled', 'no_sweep_schedule'] as const) {
      expect(specialistRefusalMessage(code)).toContain('Settings → AI Agents (/settings/ai-agents)');
    }
  });

  it('a known detail picks its own sentence; an unknown one falls back to the code\'s', () => {
    expect(specialistRefusalMessage('admission_skipped', 'agent_disabled')).toContain('is switched off');
    expect(specialistRefusalMessage('admission_skipped', 'mode_off')).toContain('mode Off');
    expect(specialistRefusalMessage('admission_skipped', 'cooldown')).toBe(specialistRefusalMessage('admission_skipped'));
    expect(specialistRefusalMessage('invalid_params', 'unknown_recipe')).toContain('not a released Operator recipe');
  });

  it('never resolves a detail through the prototype (detail can carry model text)', () => {
    for (const detail of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(specialistRefusalMessage('invalid_params', detail)).toBe(specialistRefusalMessage('invalid_params'));
    }
  });
});

describe('agentOffMessage', () => {
  it('names the agent and the next step for each reason', () => {
    expect(agentOffMessage('disabled', 'QA Patching agent')).toBe(
      'The agent "QA Patching agent" is switched off. Turn it on under Settings → AI Agents (/settings/ai-agents), then ask again.',
    );
    expect(agentOffMessage('mode_off', 'QA Patching agent')).toContain('Set it to Shadow or Act');
    expect(agentOffMessage('kill_switch_off', 'QA Patching agent')).toContain('BREEZE_AI_AGENTS_ENABLED');
    expect(agentOffMessage('disabled', null)).toContain('The agent this specialist needs is switched off');
  });
});

// #10406: the on-demand assessment's refusal details.
describe('assessment refusal details (#10406)', () => {
  it('a chat-only refusal says who can start one, instead of listing the kind as an option', () => {
    const msg = specialistRefusalMessage('unknown_kind', 'chat_only');
    expect(msg).toMatch(/only a person in chat/i);
    expect(msg).not.toMatch(/not a specialist kind/);
  });

  it('each launcher detail has its own sentence', () => {
    const generic = specialistRefusalMessage('admission_skipped');
    for (const detail of ['no_open_alerts', 'no_assessable_orgs', 'queue_unavailable']) {
      expect(specialistRefusalMessage('admission_skipped', detail), detail).not.toBe(generic);
    }
  });
});

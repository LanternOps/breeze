import { describe, it, expect } from 'vitest';
import {
  SCRIPT_ORIGINS,
  SCRIPT_APPROVAL_METHODS,
  type ScriptOrigin,
  type ScriptApprovalMethod,
} from './scriptProposals';

describe('script proposal enums', () => {
  it('lists the four script origins in the order the pg enum declares them', () => {
    expect(SCRIPT_ORIGINS).toEqual(['human', 'ai_proposal', 'imported', 'system']);
  });

  it('lists the five approval methods', () => {
    expect(SCRIPT_APPROVAL_METHODS).toEqual([
      'supervised_self',
      'four_eyes',
      'unattended_reviewer_gated',
      'direct_ui',
      'automation',
    ]);
  });

  it('narrows the union types to the tuple members', () => {
    const origin: ScriptOrigin = 'ai_proposal';
    const method: ScriptApprovalMethod = 'four_eyes';
    expect(SCRIPT_ORIGINS).toContain(origin);
    expect(SCRIPT_APPROVAL_METHODS).toContain(method);
  });
});

describe('shared barrel', () => {
  it('re-exports the origin tuple from the package root', async () => {
    const barrel = await import('../index');
    expect((barrel as { SCRIPT_ORIGINS: readonly string[] }).SCRIPT_ORIGINS).toEqual(SCRIPT_ORIGINS);
  });
});

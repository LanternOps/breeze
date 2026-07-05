import { describe, it, expect } from 'vitest';
import { AI_SYSTEM_PROMPT_BASE, BREEZE_AI_GUARDRAILS_CORE } from './aiAgentSystemPrompt';

describe('BREEZE_AI_GUARDRAILS_CORE', () => {
  it('is a non-empty safety block', () => {
    expect(BREEZE_AI_GUARDRAILS_CORE.length).toBeGreaterThan(100);
    expect(BREEZE_AI_GUARDRAILS_CORE).toMatch(/never fabricate/i);
    expect(BREEZE_AI_GUARDRAILS_CORE).toMatch(/destructive/i);
  });

  it('is embedded verbatim in the in-product system prompt (no drift)', () => {
    expect(AI_SYSTEM_PROMPT_BASE).toContain(BREEZE_AI_GUARDRAILS_CORE);
  });
});

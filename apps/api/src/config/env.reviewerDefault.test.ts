import { describe, expect, it } from 'vitest';
import { resolveReviewerDefaultModel } from './env';

describe('resolveReviewerDefaultModel (#7600 W02 extraction)', () => {
  it('BREEZE_AI_SCRIPT_REVIEWER_MODEL (trimmed) wins, else the platform default (ANTHROPIC_MODEL honoured)', () => {
    expect(resolveReviewerDefaultModel({ BREEZE_AI_SCRIPT_REVIEWER_MODEL: ' claude-opus-5-5 ' })).toBe('claude-opus-5-5');
    expect(resolveReviewerDefaultModel({ BREEZE_AI_SCRIPT_REVIEWER_MODEL: '  ', ANTHROPIC_MODEL: 'claude-haiku-4-5' })).toBe('claude-haiku-4-5');
  });
});

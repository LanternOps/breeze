// apps/api/src/config/env.aiScriptReviewerModel.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('AI_SCRIPT_REVIEWER_MODEL', () => {
  const ORIGINAL = process.env.BREEZE_AI_SCRIPT_REVIEWER_MODEL;
  const ORIGINAL_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.BREEZE_AI_SCRIPT_REVIEWER_MODEL;
    delete process.env.ANTHROPIC_MODEL;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.BREEZE_AI_SCRIPT_REVIEWER_MODEL;
    else process.env.BREEZE_AI_SCRIPT_REVIEWER_MODEL = ORIGINAL;
    if (ORIGINAL_ANTHROPIC_MODEL === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = ORIGINAL_ANTHROPIC_MODEL;
  });

  it('defaults to the platform Sonnet-class fallback model when unset', async () => {
    const { AI_SCRIPT_REVIEWER_MODEL } = await import('./env');
    expect(AI_SCRIPT_REVIEWER_MODEL).toBe('claude-sonnet-4-6');
  });

  it('honours BREEZE_AI_SCRIPT_REVIEWER_MODEL, trimmed', async () => {
    process.env.BREEZE_AI_SCRIPT_REVIEWER_MODEL = '  claude-opus-4-6  ';
    const { AI_SCRIPT_REVIEWER_MODEL } = await import('./env');
    expect(AI_SCRIPT_REVIEWER_MODEL).toBe('claude-opus-4-6');
  });

  it('a whitespace-only override falls back to the platform default (never an empty model id)', async () => {
    process.env.BREEZE_AI_SCRIPT_REVIEWER_MODEL = '   ';
    process.env.ANTHROPIC_MODEL = 'local-gateway-model';
    const { AI_SCRIPT_REVIEWER_MODEL } = await import('./env');
    expect(AI_SCRIPT_REVIEWER_MODEL).toBe('local-gateway-model');
  });
});

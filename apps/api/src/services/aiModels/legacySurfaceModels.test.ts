import { describe, expect, it } from 'vitest';
import {
  EXTENSION_AI_DEFAULT_MODEL,
  legacyAgentModel,
  legacyExtensionModel,
  legacyOfficeChatModel,
  legacyReviewerModel,
} from './legacySurfaceModels';

describe('legacy surface model pickers (#7600 W02)', () => {
  it.each([
    [[], 'claude-sonnet-5-5', 'claude-sonnet-5-5'],
    [['claude-haiku-4-5'], 'claude-sonnet-5-5', 'claude-haiku-4-5'],
    [['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'], 'claude-sonnet-5-5', 'claude-sonnet-4-5-20250929'],
  ])('office chat: allowedModels %j over %s → %s', (allowed, resolved, expected) => {
    expect(legacyOfficeChatModel(allowed, resolved)).toBe(expected);
  });

  it('extension: caller model wins, then WORKSPACE_CONTENT_LLM_MODEL, then Haiku', () => {
    expect(legacyExtensionModel('claude-opus-5-5', { WORKSPACE_CONTENT_LLM_MODEL: 'x' })).toBe('claude-opus-5-5');
    expect(legacyExtensionModel(undefined, { WORKSPACE_CONTENT_LLM_MODEL: 'claude-sonnet-4-6' })).toBe('claude-sonnet-4-6');
    expect(legacyExtensionModel(undefined, {})).toBe(EXTENSION_AI_DEFAULT_MODEL);
    expect(EXTENSION_AI_DEFAULT_MODEL).toBe('claude-haiku-4-5');
  });

  it('extension: an empty env value is kept, exactly as the legacy `??` chain did', () => {
    // isPricedModel('') then rejects it at the call site — unchanged behaviour.
    expect(legacyExtensionModel(undefined, { WORKSPACE_CONTENT_LLM_MODEL: '' })).toBe('');
  });

  it('reviewer: the effective policy model wins over the env/platform reviewer default', () => {
    expect(legacyReviewerModel('claude-opus-5-5', 'claude-sonnet-5-5')).toBe('claude-opus-5-5');
    expect(legacyReviewerModel(null, 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });

  it('agents: the merged policy model wins over the resolved partner default', () => {
    expect(legacyAgentModel('claude-haiku-4-5', 'claude-sonnet-5-5')).toBe('claude-haiku-4-5');
    expect(legacyAgentModel(null, 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
  });
});

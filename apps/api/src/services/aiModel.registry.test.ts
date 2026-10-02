import { describe, expect, it } from 'vitest';
import { derivePromptProfile } from './aiModel';
import { SEEDED_PLATFORM_MODELS } from './aiModels/__fixtures__/seededPlatformModels';

describe('derivePromptProfile', () => {
  it.each([
    ['claude-opus-5-5', 'claude-frontier'],
    ['claude-opus-5', 'claude-frontier'],
    ['claude-fable-5-1', 'claude-frontier'],
    ['claude-mythos-5-1', 'claude-frontier'],
    ['claude-opus-4-8', 'claude-standard'],
    ['claude-sonnet-5-5', 'claude-standard'],
    ['claude-sonnet-4-5-20250929', 'claude-standard'],
    ['claude-haiku-4-5', 'claude-small'],
    ['claude-haiku-4-5-20251001', 'claude-small'],
    ['gpt-5', 'generic'],
    ['anthropic/claude-sonnet-5-5', 'generic'],
    ['', 'generic'],
  ] as const)('%j → %s', (modelId, profile) => {
    expect(derivePromptProfile(modelId)).toBe(profile);
  });

  it('agrees with every seeded row', () => {
    for (const model of SEEDED_PLATFORM_MODELS) expect(derivePromptProfile(model.modelId), model.modelId).toBe(model.promptProfile);
  });
});

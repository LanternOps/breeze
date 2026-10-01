// apps/api/src/services/aiModels/modelWireOptions.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPlatformModelSnapshot, setPlatformModelSnapshot } from './platformModelSnapshot';
import { SEEDED_PLATFORM_MODELS, seededPlatformModel } from './__fixtures__/seededPlatformModels';
import { agentSdkWireOptions, messagesApiWireOptions, modelWireProfile } from './modelWireOptions';

const ADAPTIVE_MEDIUM = { thinking: { type: 'adaptive' }, effort: 'medium' };
const DISABLED = { thinking: { type: 'disabled' } };
const ONE_SHOT_CAPPED = { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } };
const ADAPTIVE_CAPS = {
  thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
};

// Every row of W00's aiModelThinking.test.ts (#7587), unchanged.
const W00_AGENT_ADAPTIVE = [
  'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-6-20260101',
];
const W00_AGENT_DISABLED = [
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-sonnet-4-0',
  'my-vllm-model', 'anthropic/claude-sonnet-5-5', 'us.anthropic.claude-sonnet-5-5', 'claude-sonnet-5-5-custom', 'gpt-5', '',
];
const W00_ONE_SHOT_CAPPED = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5'];
const W00_ONE_SHOT_NOTHING = [
  'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-5',
  'anthropic/claude-sonnet-5-5', 'my-vllm-model',
];

afterEach(() => clearPlatformModelSnapshot());

describe.each([
  ['cold snapshot (W00 bootstrap rules)', () => clearPlatformModelSnapshot()],
  ['registry = seed', () => setPlatformModelSnapshot(SEEDED_PLATFORM_MODELS)],
] as const)('W00 parity: %s', (_label, arrange) => {
  it.each(W00_AGENT_ADAPTIVE)('agentSdkWireOptions(%s) → adaptive + effort medium, never disabled', (model) => {
    arrange();
    expect(agentSdkWireOptions(model)).toEqual(ADAPTIVE_MEDIUM);
  });

  // Haiku 4.5: an omitted thinking option lets the SDK CLI turn thinking ON (~11x tokens, #7587).
  it.each(W00_AGENT_DISABLED)('agentSdkWireOptions(%j) → thinking disabled, never omitted, no effort', (model) => {
    arrange();
    const out = agentSdkWireOptions(model);
    expect(out).toEqual(DISABLED);
    expect('effort' in out).toBe(false);
  });

  it.each(W00_ONE_SHOT_CAPPED)('messagesApiWireOptions(%s) → adaptive + output_config.effort medium', (model) => {
    arrange();
    expect(messagesApiWireOptions(model, 512)).toEqual(ONE_SHOT_CAPPED);
  });

  it.each(W00_ONE_SHOT_NOTHING)('messagesApiWireOptions(%s) → nothing (one-shots only ever reduce thinking)', (model) => {
    arrange();
    expect(messagesApiWireOptions(model, 512)).toEqual({});
  });
});

describe('registry-driven behaviour (W01)', () => {
  it('the registry decides for an id the W00 name rules do not know', () => {
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-sonnet-5-5'), modelId: 'vendor-model-x', isPlatformDefault: false, capabilities: ADAPTIVE_CAPS }]);
    expect(modelWireProfile('vendor-model-x').source).toBe('registry');
    expect(agentSdkWireOptions('vendor-model-x')).toEqual(ADAPTIVE_MEDIUM);
  });

  it('the registry beats the name rules (capabilities, not names, decide)', () => {
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-haiku-4-5'), capabilities: ADAPTIVE_CAPS,
      optionSupport: { effort: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] } }]);
    expect(agentSdkWireOptions('claude-haiku-4-5')).toEqual(ADAPTIVE_MEDIUM);
  });

  it('an operator-narrowed effort list drops effort (adaptive stays; warns once)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-sonnet-5-5'),
      optionSupport: { effort: ['low', 'high'], thinkingDisplay: ['omitted'], speed: ['standard'], inferenceGeo: [] } }]);
    expect(agentSdkWireOptions('claude-sonnet-5-5')).toEqual({ thinking: { type: 'adaptive' } });
    agentSdkWireOptions('claude-sonnet-5-5');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a row whose capabilities derive to unknown falls back to the W00 rules: Sonnet 5.5 never receives disabled', () => {
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-sonnet-5-5'), capabilities: null }]);
    expect(modelWireProfile('claude-sonnet-5-5').source).toBe('legacy');
    expect(agentSdkWireOptions('claude-sonnet-5-5')).toEqual(ADAPTIVE_MEDIUM);
  });

  it('an explicit request overrides the surface default', () => {
    setPlatformModelSnapshot(SEEDED_PLATFORM_MODELS);
    expect(agentSdkWireOptions('claude-opus-5-5', { effort: 'xhigh' })).toEqual({ thinking: { type: 'adaptive' }, effort: 'xhigh' });
  });

  it('returns a fresh object per call (callers spread it)', () => {
    expect(agentSdkWireOptions('claude-sonnet-5-5')).not.toBe(agentSdkWireOptions('claude-sonnet-5-5'));
  });
});

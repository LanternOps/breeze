/**
 * W05 (#7603), spike constraint 5: "Fast mode can be silently downgraded.
 * Show what was applied, not what was requested." On the Agent SDK the only
 * served-speed signal is the result's fast_mode_state (and any 'cooldown' /
 * 'off' seen during the turn). Fast is billed only when it was served.
 */
import { describe, expect, it } from 'vitest';
import { newSdkTurnObservation, observeSdkMessage, sdkTurnUsage, messagesUsage, type SdkResultLike } from './invocationUsage';
import type { TurnBinding } from './turnBinding';

const STD = { inputCentsPerM: 500, outputCentsPerM: 2500, cacheReadCentsPerM: 50, cacheWriteCentsPerM: 625 };
const FAST = { inputCentsPerM: 1000, outputCentsPerM: 5000, cacheReadCentsPerM: 100, cacheWriteCentsPerM: 1250 };
const OPUS = 'claude-opus-5-5';
const OPUS48 = 'claude-opus-4-8';

function binding(speed: 'fast' | 'standard' | undefined): TurnBinding {
  return {
    v: 1, surface: 'chat', role: 'default', partnerId: 'p1', offeringId: 'off-opus', connectionId: null,
    connectionKind: 'platform', configVersion: null, catalogRevisionId: null, funding: 'platform',
    logicalModel: OPUS, wireModel: OPUS, options: speed ? { speed } : {}, thinkingMode: 'adaptive',
    inferenceGeo: null, wireFingerprint: 'fp',
    rateSnapshot: speed === 'fast' ? { source: 'platform', standard: STD, option: { key: 'speed:fast', rates: FAST } } : { source: 'platform', standard: STD },
    refusalFallback: null,
  };
}

function result(fastState: 'on' | 'cooldown' | 'off' | undefined): SdkResultLike {
  return {
    subtype: 'success', stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { [OPUS]: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    ...(fastState ? { fast_mode_state: fastState } : {}),
  };
}

const ZERO_ENTRY = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 };

describe('sdkTurnUsage: served speed (W05)', () => {
  it('fast requested + result on + no cooldown seen → billed fast, not downgraded', () => {
    const t = sdkTurnUsage({ binding: binding('fast'), observation: newSdkTurnObservation(), result: result('on'), previousSnapshot: null });
    expect(t.usage.map((u) => u.speedServed)).toEqual(['fast']);
    expect(t.outcome.fastDowngraded).toBe(false);
  });
  it('fast requested + cooldown observed during the turn → standard, downgraded (spike Q4 silent retry)', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'status', fast_mode_state: 'cooldown' });
    const t = sdkTurnUsage({ binding: binding('fast'), observation: obs, result: result('on'), previousSnapshot: null });
    expect(t.usage.map((u) => u.speedServed)).toEqual(['standard']);
    expect(t.outcome.fastDowngraded).toBe(true);
  });
  it('fast requested + result reports cooldown → standard, downgraded', () => {
    const t = sdkTurnUsage({ binding: binding('fast'), observation: newSdkTurnObservation(), result: result('cooldown'), previousSnapshot: null });
    expect(t.usage[0]!.speedServed).toBe('standard');
    expect(t.outcome.fastDowngraded).toBe(true);
  });
  it('fast requested + no fast_mode_state at all (older CLI) → standard, downgraded (never billed on a guess)', () => {
    const t = sdkTurnUsage({ binding: binding('fast'), observation: newSdkTurnObservation(), result: result(undefined), previousSnapshot: null });
    expect(t.usage[0]!.speedServed).toBe('standard');
    expect(t.outcome.fastDowngraded).toBe(true);
  });
  it('fast not requested → standard and never "downgraded", whatever the CLI reports', () => {
    const t = sdkTurnUsage({ binding: binding(undefined), observation: newSdkTurnObservation(), result: result('on'), previousSnapshot: null });
    expect(t.usage[0]!.speedServed).toBe('standard');
    expect(t.outcome.fastDowngraded).toBe(false);
  });
  it('fast requested but a refusal fallback served the turn → nothing billed fast, downgraded', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'model_refusal_fallback', fallback_model: OPUS48, api_refusal_category: 'cyber' });
    const r = result('on');
    r.modelUsage = { [OPUS48]: { inputTokens: 5, outputTokens: 5 } };
    const t = sdkTurnUsage({ binding: binding('fast'), observation: obs, result: r, previousSnapshot: null });
    expect(t.usage.every((u) => u.speedServed === 'standard')).toBe(true);
    expect(t.outcome.fastDowngraded).toBe(true);
  });
  it('a key other than the bound wire model is never billed fast (a helper / earlier-seen model)', () => {
    // The other key is already in the snapshot, so it is not a CLI refusal
    // swap (W03 servedModelOf) and the main loop ended on the bound model.
    const r = result('on');
    r.modelUsage = { ...r.modelUsage!, [OPUS48]: { inputTokens: 5, outputTokens: 5 } };
    const t = sdkTurnUsage({
      binding: binding('fast'), observation: newSdkTurnObservation(), result: r,
      previousSnapshot: { version: 1, models: { [OPUS48]: ZERO_ENTRY } },
    });
    const byModel = Object.fromEntries(t.usage.map((u) => [u.model, u.speedServed]));
    expect(byModel).toEqual({ [OPUS]: 'fast', [OPUS48]: 'standard' });
    expect(t.outcome.fastDowngraded).toBe(false);
  });
  it('a model that first appeared this turn is read as a CLI swap: nothing billed fast, downgraded', () => {
    const r = result('on');
    r.modelUsage = { ...r.modelUsage!, [OPUS48]: { inputTokens: 5, outputTokens: 5 } };
    const t = sdkTurnUsage({ binding: binding('fast'), observation: newSdkTurnObservation(), result: r, previousSnapshot: { version: 1, models: {} } });
    expect(t.usage.every((u) => u.speedServed === 'standard')).toBe(true);
    expect(t.outcome.fastDowngraded).toBe(true);
  });
  it('a regressed snapshot still bills the served speed (fast served → fast)', () => {
    const t = sdkTurnUsage({
      binding: binding('fast'), observation: newSdkTurnObservation(), result: result('on'),
      previousSnapshot: { version: 1, models: { [OPUS]: { tokens: { input: 999, output: 999, cacheRead: 0, cacheWrite: 0 }, webSearchRequests: 0 } } },
    });
    expect(t.usageNote).toBe('snapshot_regressed');
    expect(t.usage.map((u) => u.speedServed)).toEqual(['fast']);
    expect(t.outcome.fastDowngraded).toBe(false);
  });
  it('no result (aborted) with fast requested → nothing billed, downgraded', () => {
    const t = sdkTurnUsage({ binding: binding('fast'), observation: newSdkTurnObservation(), result: null, previousSnapshot: null });
    expect(t.usage).toEqual([]);
    expect(t.outcome.fastDowngraded).toBe(true);
  });
});

describe('messagesUsage: fastDowngraded (W05)', () => {
  it('fast requested, provider reports standard → downgraded', () => {
    const msg = { model: OPUS, stop_reason: 'end_turn', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 1, speed: 'standard' as const } };
    const t = messagesUsage(binding('fast'), [{ wireModel: OPUS, message: msg as never }]);
    expect(t.outcome.fastDowngraded).toBe(true);
  });
  it('fast requested, provider confirms fast → not downgraded', () => {
    const msg = { model: OPUS, stop_reason: 'end_turn', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 1, speed: 'fast' as const } };
    const t = messagesUsage(binding('fast'), [{ wireModel: OPUS, message: msg as never }]);
    expect(t.outcome.fastDowngraded).toBe(false);
  });
  it('fast not requested → never downgraded', () => {
    const msg = { model: OPUS, stop_reason: 'end_turn', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 1, speed: 'standard' as const } };
    expect(messagesUsage(binding(undefined), [{ wireModel: OPUS, message: msg as never }]).outcome.fastDowngraded).toBe(false);
  });
  it('several calls: downgraded when ANY call was not served fast', () => {
    const fastMsg = { model: OPUS, stop_reason: 'end_turn', content: [{ type: 'text' }], usage: { input_tokens: 1, output_tokens: 1, speed: 'fast' as const } };
    const stdMsg = { ...fastMsg, usage: { ...fastMsg.usage, speed: 'standard' as const } };
    const t = messagesUsage(binding('fast'), [
      { wireModel: OPUS, message: stdMsg as never, call: 0 },
      { wireModel: OPUS, message: fastMsg as never, call: 1 },
    ]);
    expect(t.outcome.fastDowngraded).toBe(true);
  });
});

describe('#7786: a turn that failed before any output never claims fast', () => {
  it('fast requested and the result says on, but nothing answered: fastDowngraded, nothing billed', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 429' }] } });
    const t = sdkTurnUsage({
      binding: binding('fast'), observation: obs, previousSnapshot: null,
      result: {
        subtype: 'success', is_error: true, stop_reason: 'stop_sequence', fast_mode_state: 'on',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 900, outputTokens: 15 } },
      },
    });
    expect(t.outcome).toMatchObject({ servedModel: OPUS, fallbackUsed: false, fastDowngraded: true });
    expect(t.usage).toEqual([]);
  });
});

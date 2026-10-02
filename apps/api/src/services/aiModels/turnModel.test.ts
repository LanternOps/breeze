import { describe, expect, it, vi } from 'vitest';
import { makeResolvedModel } from './__fixtures__/resolvedModel';
import { turnBindingFrom } from './turnBinding';
import type { TurnOutcome } from './invocationUsage';
import { appliedOptionsOf, describeTurnModel, lastTurnModelOf, turnDisplayFrom } from './turnModel';

const OPUS = 'claude-opus-5-5';
const outcome = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
  stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false,
  servedModel: OPUS, providerModel: null, sdkReportedCostUsd: null, fastDowngraded: false, ...over,
});
const resolved = makeResolvedModel('platform', {
  offering: { id: 'off-opus', displayName: 'Opus 5.5' }, logicalModel: OPUS, wireModel: OPUS, options: { effort: 'high', speed: 'fast' },
});
const binding = turnBindingFrom(resolved);
const deps = { platformDisplayName: vi.fn(async (id: string) => (id === 'claude-opus-4-8' ? 'Claude Opus 4.8' : null)) };

describe('describeTurnModel (W05 spike constraint 5)', () => {
  it('served = requested → the offering\'s name, nothing fell back', async () => {
    const t = await describeTurnModel({ binding, outcome: outcome(), display: turnDisplayFrom(resolved) }, deps);
    expect(t).toEqual({
      requestedModel: OPUS, requestedDisplayName: 'Opus 5.5', servedModel: OPUS, servedDisplayName: 'Opus 5.5',
      fallbackUsed: false, appliedOptions: { effort: 'high', speed: 'fast' }, fastDowngraded: false,
    });
  });
  it('a CLI refusal swap reports the served model\'s name and fallbackUsed', async () => {
    const t = await describeTurnModel({
      binding, outcome: outcome({ servedModel: 'claude-opus-4-8', fallbackUsed: true }), display: turnDisplayFrom(resolved),
    }, deps);
    expect(t).toMatchObject({ servedModel: 'claude-opus-4-8', servedDisplayName: 'Claude Opus 4.8', fallbackUsed: true });
  });
  it('an unknown served id is shown as the id, never as the requested name', async () => {
    const t = await describeTurnModel({ binding, outcome: outcome({ servedModel: 'mystery-1', fallbackUsed: true }), display: turnDisplayFrom(resolved) }, deps);
    expect(t.servedDisplayName).toBe('mystery-1');
  });
  it('a failing name lookup is shown as the id, never fails the turn model', async () => {
    const failing = { platformDisplayName: vi.fn(async () => { throw new Error('db down'); }) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const t = await describeTurnModel({ binding, outcome: outcome({ servedModel: 'claude-opus-4-8', fallbackUsed: true }), display: turnDisplayFrom(resolved) }, failing);
    expect(t.servedDisplayName).toBe('claude-opus-4-8');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[turnModel]'), { servedModel: 'claude-opus-4-8', error: 'db down' });
    warn.mockRestore();
  });
  it('a configured refusal fallback that served uses its offering name', async () => {
    const withFb = makeResolvedModel('platform', {
      offering: { id: 'off-opus', displayName: 'Opus 5.5' }, wireModel: OPUS,
      refusalFallback: { offeringId: 'off-s', displayName: 'Sonnet 5.5', wireModel: 'claude-sonnet-5-5', wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: resolved.rateSnapshot },
    });
    const t = await describeTurnModel({
      binding: turnBindingFrom(withFb), outcome: outcome({ servedModel: 'claude-sonnet-5-5', fallbackUsed: true }), display: turnDisplayFrom(withFb),
    }, deps);
    expect(t.servedDisplayName).toBe('Sonnet 5.5');
  });
  it('fast requested but downgraded → applied speed is standard', () => {
    expect(appliedOptionsOf(binding, outcome({ fastDowngraded: true }))).toEqual({ effort: 'high', speed: 'standard' });
    expect(appliedOptionsOf(binding, outcome())).toEqual({ effort: 'high', speed: 'fast' });
  });
  it('a fallback model served → no option claims at all (its options are not the primary\'s; Codex review finding 15)', () => {
    expect(appliedOptionsOf(binding, outcome({ servedModel: 'claude-opus-4-8', fallbackUsed: true }))).toEqual({});
  });
});

describe('lastTurnModelOf', () => {
  it('parses a persisted turn model and rejects anything else', () => {
    const tm = { requestedModel: OPUS, requestedDisplayName: 'Opus 5.5', servedModel: OPUS, servedDisplayName: 'Opus 5.5', fallbackUsed: false, appliedOptions: { effort: 'high' }, fastDowngraded: false };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(lastTurnModelOf({ lastTurnModel: tm })).toEqual(tm);
    expect(lastTurnModelOf({ lastTurnModel: null })).toBeNull();
    expect(lastTurnModelOf({})).toBeNull();
    // Absent is normal and silent; only a stored value that does not parse is reported.
    expect(warn).not.toHaveBeenCalled();
    expect(lastTurnModelOf({ id: 'sess-1', lastTurnModel: { servedModel: 1 } })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[turnModel]'), expect.objectContaining({ sessionId: 'sess-1' }));
    warn.mockRestore();
  });
});

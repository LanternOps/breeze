import { describe, expect, it } from 'vitest';
import { CONTEXT_WINDOW_MEMO_TTL_MS, MAX_PLAUSIBLE_TOKENS, MIN_PLAUSIBLE_WINDOW } from './gateway/openai/contextWindow';
import { resolveEffectiveContextWindow, type ContextWindowFields } from './contextWindowFacts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const minutesAgo = (m: number): Date => new Date(NOW - m * 60_000);

const NONE: ContextWindowFields = {
  contextWindowOverride: null,
  contextWindowDiscovered: null,
  contextWindowObserved: null,
  contextWindowObservedAt: null,
  contextWindowObservedConfigVersion: null,
};

const observed = (value: number, at: Date, configVersion = 4): Partial<ContextWindowFields> => ({
  contextWindowObserved: value, contextWindowObservedAt: at, contextWindowObservedConfigVersion: configVersion,
});

describe('resolveEffectiveContextWindow (#11396 T5)', () => {
  it('override 16384 wins over discovered 131072 and a fresh observed 8192', () => {
    const r = resolveEffectiveContextWindow({
      ...NONE, contextWindowOverride: 16_384, contextWindowDiscovered: 131_072, ...observed(8_192, minutesAgo(5)),
    }, 4, NOW);
    expect(r).toEqual({ value: 16_384, source: 'override', observedFresh: true });
  });

  it('a fresh 8192 observed beats 262144 discovered (the serving limit below the advertised maximum)', () => {
    const r = resolveEffectiveContextWindow({
      ...NONE, contextWindowDiscovered: 262_144, ...observed(8_192, minutesAgo(12)),
    }, 4, NOW);
    expect(r).toEqual({ value: 8_192, source: 'observed', observedFresh: true });
  });

  it('a fresh observed LARGER than discovered does not raise it: the smaller of the two', () => {
    const r = resolveEffectiveContextWindow({
      ...NONE, contextWindowDiscovered: 32_768, ...observed(65_536, minutesAgo(1)),
    }, 4, NOW);
    expect(r).toEqual({ value: 32_768, source: 'discovered', observedFresh: true });
  });

  it('observed at config_version 3 is ignored under 4 (source discovered)', () => {
    const r = resolveEffectiveContextWindow({
      ...NONE, contextWindowDiscovered: 131_072, ...observed(8_192, minutesAgo(1), 3),
    }, 4, NOW);
    expect(r).toEqual({ value: 131_072, source: 'discovered', observedFresh: false });
  });

  it('an observation older than the TTL is a hint only (value = discovered, observedFresh false)', () => {
    const r = resolveEffectiveContextWindow({
      ...NONE, contextWindowDiscovered: 131_072, ...observed(8_192, new Date(NOW - CONTEXT_WINDOW_MEMO_TTL_MS - 1)),
    }, 4, NOW);
    expect(r).toEqual({ value: 131_072, source: 'discovered', observedFresh: false });
  });

  it('exactly at the TTL is still fresh (control for the boundary above)', () => {
    const r = resolveEffectiveContextWindow({
      ...NONE, contextWindowDiscovered: 131_072, ...observed(8_192, new Date(NOW - CONTEXT_WINDOW_MEMO_TTL_MS)),
    }, 4, NOW);
    expect(r.source).toBe('observed');
  });

  it('a stale observation with nothing discovered is unknown', () => {
    const r = resolveEffectiveContextWindow({ ...NONE, ...observed(8_192, minutesAgo(61)) }, 4, NOW);
    expect(r).toEqual({ value: null, source: 'unknown', observedFresh: false });
  });

  it('no current config_version (no connection): an observation never constrains', () => {
    const r = resolveEffectiveContextWindow({ ...NONE, ...observed(8_192, minutesAgo(1)) }, null, NOW);
    expect(r).toEqual({ value: null, source: 'unknown', observedFresh: false });
  });

  it('all null → unknown', () => {
    expect(resolveEffectiveContextWindow(NONE, 4, NOW)).toEqual({ value: null, source: 'unknown', observedFresh: false });
  });

  it('discovered below MIN_PLAUSIBLE_WINDOW or above MAX_PLAUSIBLE_TOKENS is ignored', () => {
    expect(resolveEffectiveContextWindow({ ...NONE, contextWindowDiscovered: MIN_PLAUSIBLE_WINDOW - 1 }, 4, NOW).source).toBe('unknown');
    expect(resolveEffectiveContextWindow({ ...NONE, contextWindowDiscovered: MAX_PLAUSIBLE_TOKENS + 1 }, 4, NOW).source).toBe('unknown');
    expect(resolveEffectiveContextWindow({ ...NONE, contextWindowDiscovered: MIN_PLAUSIBLE_WINDOW }, 4, NOW))
      .toEqual({ value: MIN_PLAUSIBLE_WINDOW, source: 'discovered', observedFresh: false });
  });

  it('an implausible observed value is ignored even when fresh', () => {
    const r = resolveEffectiveContextWindow({ ...NONE, contextWindowDiscovered: 32_768, ...observed(70, minutesAgo(1)) }, 4, NOW);
    expect(r).toEqual({ value: 32_768, source: 'discovered', observedFresh: false });
  });

  it('a row without the columns (older fixtures) is unknown', () => {
    expect(resolveEffectiveContextWindow({}, 4, NOW)).toEqual({ value: null, source: 'unknown', observedFresh: false });
  });
});

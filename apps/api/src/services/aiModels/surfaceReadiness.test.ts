import { describe, expect, it } from 'vitest';
import { FIDELITY_HARNESS_VERSION } from '../llm/providerFidelityHarness';
import { endpointFingerprint } from './gatewayCapabilities';
import {
  SURFACE_READINESS_KEY,
  SURFACE_TURN_VERSION,
  currentReadinessEntries,
  failedToolSurfaces,
  mergeSurfaceReadiness,
  readSurfaceReadiness,
  readinessProfileKey,
  surfaceReadinessState,
  type SurfaceReadinessRecord,
} from './surfaceReadiness';
import type { ToolProfileFacts } from './toolProfileFacts';

const fp = endpointFingerprint({ kind: 'openai_compatible', baseUrl: 'https://llm.example.com/v1', providerConfig: null });
const otherFp = endpointFingerprint({ kind: 'openai_compatible', baseUrl: 'https://other.example.com/v1', providerConfig: null });
const facts = (toolProfile: ToolProfileFacts['toolProfile'], effectiveWindow: number | null = null): ToolProfileFacts => ({
  toolProfile, toolAllowlist: null, effectiveWindow, transport: 'gateway',
});
const minimalKey = readinessProfileKey(facts('minimal'), 'chat');

const entry = (over: Partial<SurfaceReadinessRecord> = {}): SurfaceReadinessRecord => ({
  state: 'failed',
  profileKey: minimalKey,
  exposureFingerprint: 'abcdef0123456789',
  profile: 'minimal',
  endpointFingerprint: fp,
  version: SURFACE_TURN_VERSION,
  at: '2026-11-12T00:00:00.000Z',
  promptTokens: 3100,
  cachedTokens: 0,
  summary: 'answered without calling a tool',
  ...over,
});
const caps = (readiness: Record<string, unknown>) => ({ tool_use: { supported: true }, [SURFACE_READINESS_KEY]: readiness });

describe('surface readiness (#11393 W04 T11)', () => {
  it('the fidelity harness version is unchanged (basic records keep verifying)', () => {
    expect(FIDELITY_HARNESS_VERSION).toBe('1');
    expect(SURFACE_TURN_VERSION).toBe('1');
  });

  it('profile key: identity facts read "full"; a constrained profile reads its facts key', () => {
    expect(readinessProfileKey(facts('full'), 'chat')).toBe('full');
    expect(readinessProfileKey(facts('auto'), 'chat')).toBe('full');
    expect(minimalKey).toMatch(/^[0-9a-f]{16}$/);
    expect(readinessProfileKey(facts('standard'), 'chat')).not.toBe(minimalKey);
    // auto with a learned window resolves to a profile, and so to that profile's key.
    expect(readinessProfileKey(facts('auto', 8192), 'chat')).toBe(minimalKey);
  });

  it('reads valid entries and drops malformed ones and non-tool surfaces', () => {
    const read = readSurfaceReadiness(caps({
      chat: entry(),
      helper: { ...entry(), state: 'maybe' },
      script_builder: { ...entry(), extra: 1 },
      catalog_enrichment: entry(),
      ai_agents: { ...entry(), summary: 'x'.repeat(201) },
    }));
    expect(Object.keys(read)).toEqual(['chat']);
    expect(readSurfaceReadiness(null)).toEqual({});
    expect(readSurfaceReadiness({ [SURFACE_READINESS_KEY]: 'nope' })).toEqual({});
  });

  it.each<[string, SurfaceReadinessRecord | undefined, string]>([
    ['absent (a grandfathered record)', undefined, 'absent'],
    ['current failed', entry(), 'failed'],
    ['current passed', entry({ state: 'passed', summary: null }), 'passed'],
    ['current inconclusive', entry({ state: 'inconclusive' }), 'inconclusive'],
    ['another endpoint', entry({ endpointFingerprint: otherFp }), 'stale'],
    ['an older stage version', entry({ version: '0' }), 'stale'],
    ['another tool profile', entry({ profileKey: 'full' }), 'stale'],
  ])('state: %s', (_label, e, expected) => {
    expect(surfaceReadinessState(e, { endpointFingerprint: fp, profileKey: minimalKey })).toBe(expected);
  });

  it('a failed chat readiness refuses chat only; inconclusive, stale and absent entries refuse nothing', () => {
    const raw = caps({
      chat: entry(),
      helper: entry({ state: 'inconclusive', profileKey: readinessProfileKey(facts('minimal'), 'helper') }),
      script_builder: entry({ endpointFingerprint: otherFp }),
      ai_agents: entry({ state: 'failed', profileKey: 'full' }), // recorded under full, now minimal
    });
    expect(failedToolSurfaces(raw, { endpointFingerprint: fp, facts: facts('minimal') })).toEqual(['chat']);
  });

  it('a failed entry for an older profile stays eligible after the operator changes the profile', () => {
    const raw = caps({ chat: entry() });
    expect(failedToolSurfaces(raw, { endpointFingerprint: fp, facts: facts('standard') })).toEqual([]);
    expect(failedToolSurfaces(raw, { endpointFingerprint: otherFp, facts: facts('minimal') })).toEqual([]);
  });

  it('records without readiness (every model on merge) refuse nothing', () => {
    expect(failedToolSurfaces({ tool_use: { supported: true }, breeze_verification: {} }, { endpointFingerprint: fp, facts: facts('auto') })).toEqual([]);
    expect(failedToolSurfaces(null, { endpointFingerprint: fp, facts: facts('full') })).toEqual([]);
  });

  it('superseded per surface: an entry whose profile changed under the run (operator edit, learned window) is dropped', () => {
    const row = { toolProfile: 'minimal' as const, toolAllowlist: null, contextWindowOverride: null, contextWindowDiscovered: null,
      contextWindowObserved: null, contextWindowObservedAt: null, contextWindowObservedConfigVersion: null };
    const helperKey = readinessProfileKey(facts('minimal'), 'helper');
    const entries = { chat: entry(), helper: entry({ profileKey: helperKey }) };
    expect(currentReadinessEntries(entries, row, 4)).toEqual({ kept: entries, dropped: [] });
    expect(currentReadinessEntries(entries, { ...row, toolProfile: 'standard' }, 4)).toEqual({ kept: {}, dropped: ['chat', 'helper'] });
    // auto: a window learned while the run was in flight moves chat to another profile.
    const autoEntries = { chat: entry({ profileKey: readinessProfileKey(facts('auto'), 'chat') }) };
    expect(currentReadinessEntries(autoEntries, { ...row, toolProfile: 'auto' }, 4).dropped).toEqual([]);
    expect(currentReadinessEntries(autoEntries, { ...row, toolProfile: 'auto', contextWindowOverride: 8192 }, 4).dropped).toEqual(['chat']);
  });

  it('merge replaces the surfaces run now and keeps the others', () => {
    const existing = caps({ chat: entry(), helper: entry({ state: 'passed' }) });
    const merged = mergeSurfaceReadiness(existing, { chat: entry({ state: 'passed', summary: null }) });
    expect(merged.chat!.state).toBe('passed');
    expect(merged.helper!.state).toBe('passed');
    expect(mergeSurfaceReadiness(null, {})).toEqual({});
  });
});

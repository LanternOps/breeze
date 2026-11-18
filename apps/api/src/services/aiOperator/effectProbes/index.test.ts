/**
 * The provider-neutral probe registry (Recipe Library spec §6.6:
 * "Every effect is therefore probe → write → probe").
 *
 * The registry's contract is almost entirely about what happens when it does
 * NOT know something. `unknown` is the default, and `unknown` means handoff,
 * never `verified` — Operator spec §13: "Failed/inconclusive verification
 * cannot produce 'Resolved'". A registry that returned `satisfied` for an
 * unregistered tool would certify effects nobody observed, which is the exact
 * false-verified-success the release gate forbids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetEffectProbesForTest, getEffectProbe, listProbedTools, probeEffect, registerEffectProbe,
} from './index';
import type { PlannedEffect } from '../recipes/types';

const effect: PlannedEffect = {
  ordinal: 0, toolName: 'google_suspend_user', provider: 'google',
  targetId: 'c1', accountExternalId: '101',
  canonicalArguments: { reason: 'offboarding', userEmail: 'dana@customer.example' },
};
const ctx = {
  orgId: 'o1', taskId: 't1', planRevision: 1,
  effectRequestedAt: new Date('2026-09-17T10:00:00Z'), phase: 'post' as const,
};

beforeEach(() => __resetEffectProbesForTest());

describe('effect probe registry', () => {
  it('returns UNKNOWN for a tool with no registered probe — never satisfied', () => {
    expect(getEffectProbe('google_suspend_user')).toBeUndefined();
    return expect(probeEffect(effect, ctx)).resolves.toMatchObject({ state: 'unknown' });
  });

  it('names the tool in the unknown detail, so a handoff summary is actionable', async () => {
    const r = await probeEffect(effect, ctx);
    expect(r.detail).toContain('google_suspend_user');
    expect(r.observedAt).toBeInstanceOf(Date);
  });

  it('dispatches to a registered probe by tool name', async () => {
    registerEffectProbe('google_suspend_user', async () => ({
      state: 'satisfied', observedAt: new Date('2026-09-17T10:00:05Z'), detail: 'suspended=true',
    }));
    await expect(probeEffect(effect, ctx)).resolves.toMatchObject({ state: 'satisfied' });
    expect(listProbedTools()).toEqual(['google_suspend_user']);
  });

  it('a THROWING probe degrades to unknown and never propagates', async () => {
    // A provider outage must not escape into the coordinator: the intent is
    // already dispatched or about to be, and an escaping error would strand
    // the task until the stale-lease reaper rewrites the cause.
    registerEffectProbe('google_suspend_user', async () => { throw new Error('Graph 503'); });
    const r = await probeEffect(effect, ctx);
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('503');
  });

  it('a probe that exceeds the deadline degrades to unknown', async () => {
    registerEffectProbe('google_suspend_user', () => new Promise(() => {}));
    vi.useFakeTimers();
    const p = probeEffect(effect, { ...ctx });
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(p).resolves.toMatchObject({ state: 'unknown' });
    vi.useRealTimers();
  });

  it('REFUSES to register two probes for one tool name', () => {
    registerEffectProbe('google_suspend_user', async () => ({ state: 'unknown', observedAt: new Date(), detail: '' }));
    expect(() => registerEffectProbe('google_suspend_user', async () =>
      ({ state: 'satisfied', observedAt: new Date(), detail: '' }))).toThrow(/already registered/);
  });

  it('bounds the detail string so it fits the event and step columns', async () => {
    registerEffectProbe('google_suspend_user', async () => ({
      state: 'unsatisfied', observedAt: new Date(), detail: 'x'.repeat(5000),
    }));
    const r = await probeEffect(effect, ctx);
    expect(r.detail.length).toBeLessThanOrEqual(1000);
  });
});

// ---- R1a-0 Task 1c: the `alwaysUnknown` marker and recipe rule 2 ----
import * as probeRegistry from './index';
import { RECIPES } from '../recipes';
import { registerGoogleEffectProbes } from './google';
import { registerM365EffectProbes } from './m365';

describe('structurally unobservable probes (R1a-0 Task 1c)', () => {
  const isStructurallyUnobservable = (tool: string) =>
    (probeRegistry as unknown as { isStructurallyUnobservable: (t: string) => boolean }).isStructurallyUnobservable(tool);
  const always = async () => ({ state: 'unknown' as const, observedAt: new Date(), detail: 'never observable' });

  it('only a probe registered with { alwaysUnknown: true } is structurally unobservable', () => {
    (registerEffectProbe as unknown as (t: string, p: unknown, o?: unknown) => void)('tool_marked', always, { alwaysUnknown: true });
    registerEffectProbe('tool_plain', always);
    expect(isStructurallyUnobservable('tool_marked')).toBe(true);
    expect(isStructurallyUnobservable('tool_plain')).toBe(false);
    expect(isStructurallyUnobservable('tool_unregistered')).toBe(false);
    __resetEffectProbesForTest();
    expect(isStructurallyUnobservable('tool_marked')).toBe(false);
  });

  it('of every shipped probe, google_signout is the only structurally unobservable one', () => {
    registerGoogleEffectProbes();
    registerM365EffectProbes();
    expect(listProbedTools().filter(isStructurallyUnobservable)).toEqual(['google_signout']);
  });

  /** Rule 2: every declared unobservable tool is structurally unobservable; every subsumer is probed. */
  const rule2Problems = (recipe: { key: string; unobservableEffects?: Readonly<Record<string, string>> }) => {
    const probed = new Set(listProbedTools());
    const out: string[] = [];
    for (const [tool, subsumer] of Object.entries(recipe.unobservableEffects ?? {})) {
      if (!isStructurallyUnobservable(tool)) out.push(`${recipe.key}: '${tool}' is not structurally unobservable`);
      if (!probed.has(subsumer)) out.push(`${recipe.key}: subsumer '${subsumer}' has no registered probe`);
    }
    return out;
  };

  it('rule 2 holds for every registered recipe, and catches a fixture that breaks it', () => {
    registerGoogleEffectProbes();
    registerM365EffectProbes();
    for (const recipe of Object.values(RECIPES)) expect(rule2Problems(recipe as never)).toEqual([]);
    expect(rule2Problems({ key: 'fixture', unobservableEffects: { google_signout: 'google_suspend_user' } })).toEqual([]);
    expect(rule2Problems({ key: 'fixture', unobservableEffects: { google_suspend_user: 'not_a_tool' } })).toEqual([
      "fixture: 'google_suspend_user' is not structurally unobservable",
      "fixture: subsumer 'not_a_tool' has no registered probe",
    ]);
  });
});

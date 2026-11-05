import { describe, expect, it } from 'vitest';
import {
  BRIEF_TIME_OPTIONS,
  DIGEST_CADENCE_OPTIONS,
  PROACTIVITY_OPTIONS,
  QUIET_OVERRIDE_OPTIONS,
  WISP_OFFLINE_HINT,
  briefOptionFor,
  briefTimeFromOption,
  cadenceValueFor,
  proactivityDescription,
  quietOverrideDescription,
} from './wispNudgePrefsCopy';

describe('wispNudgePrefsCopy', () => {
  it('lists options in order', () => {
    expect(DIGEST_CADENCE_OPTIONS.map((o) => o.value)).toEqual([60, 240, 1440]);
    expect(QUIET_OVERRIDE_OPTIONS.map((o) => o.value)).toEqual(['never', 'urgent_only']);
    expect(BRIEF_TIME_OPTIONS.map((o) => o.value)).toEqual(['off', '07:00', '08:00', '09:00']);
    expect(PROACTIVITY_OPTIONS.map((o) => o.value)).toEqual(['quiet', 'normal', 'chatty']);
    expect(WISP_OFFLINE_HINT).toBe('Offline — reconnect to change');
  });

  it('snaps cadence to the nearest option', () => {
    expect(cadenceValueFor(15)).toBe(60);
    expect(cadenceValueFor(240)).toBe(240);
    expect(cadenceValueFor(1000)).toBe(1440);
    expect(cadenceValueFor(150)).toBe(240); // tie -> larger
    expect(cadenceValueFor(NaN)).toBe(240);
    expect(cadenceValueFor(Infinity)).toBe(240);
  });

  it('describes quiet override and proactivity distinctly', () => {
    const q = [quietOverrideDescription('never'), quietOverrideDescription('urgent_only')];
    expect(q.every((s) => s.length > 0)).toBe(true);
    expect(new Set(q).size).toBe(2);
    const p = (['quiet', 'normal', 'chatty'] as const).map(proactivityDescription);
    expect(p.every((s) => s.length > 0)).toBe(true);
    expect(new Set(p).size).toBe(3);
  });

  it('maps brief time both ways', () => {
    expect(briefOptionFor(null)).toBe('off');
    expect(briefOptionFor('08:00')).toBe('08:00');
    expect(briefOptionFor('06:30')).toBeNull();
    expect(briefTimeFromOption('off')).toBeNull();
    expect(briefTimeFromOption('07:00')).toBe('07:00');
  });
});

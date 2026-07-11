import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadSignalConfig, SIGNAL_DEFAULTS, scoreToSeverity, youngWeight } from './config';

afterEach(() => {
  delete process.env.ABUSE_SIGNAL_OVERRIDES;
  vi.restoreAllMocks();
});

describe('loadSignalConfig', () => {
  it('returns defaults when ABUSE_SIGNAL_OVERRIDES is unset', () => {
    expect(loadSignalConfig()).toEqual(SIGNAL_DEFAULTS);
  });

  it('merges known override keys', () => {
    process.env.ABUSE_SIGNAL_OVERRIDES = '{"rmm.enrollment_velocity.devices_24h": 25}';
    expect(loadSignalConfig()['rmm.enrollment_velocity.devices_24h']).toBe(25);
  });

  it('warns and ignores unknown keys and non-numeric values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ABUSE_SIGNAL_OVERRIDES = '{"nope.unknown": 1, "severity.alert_score": "high"}';
    const cfg = loadSignalConfig();
    expect(cfg['severity.alert_score']).toBe(SIGNAL_DEFAULTS['severity.alert_score']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns and returns defaults on malformed JSON', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ABUSE_SIGNAL_OVERRIDES = '{not json';
    expect(loadSignalConfig()).toEqual(SIGNAL_DEFAULTS);
    expect(warn).toHaveBeenCalled();
  });
});

describe('scoreToSeverity', () => {
  const cfg = SIGNAL_DEFAULTS;
  it('maps score bands', () => {
    expect(scoreToSeverity(75, cfg)).toBe('alert');
    expect(scoreToSeverity(45, cfg)).toBe('watch');
    expect(scoreToSeverity(5, cfg)).toBe('info');
  });
});

describe('youngWeight', () => {
  const cfg = SIGNAL_DEFAULTS;
  const now = new Date('2026-07-15T00:00:00Z');
  it('is 1.0 under 30 days, 0 at 90+, linear between', () => {
    expect(youngWeight(new Date('2026-07-01T00:00:00Z'), now, cfg)).toBe(1);
    expect(youngWeight(new Date('2026-04-01T00:00:00Z'), now, cfg)).toBe(0);
    const w = youngWeight(new Date('2026-05-16T00:00:00Z'), now, cfg); // 60 days old
    expect(w).toBeCloseTo(0.5, 1);
  });
});

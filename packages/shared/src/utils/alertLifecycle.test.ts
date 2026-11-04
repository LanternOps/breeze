import { describe, expect, it } from 'vitest';
import { BUILTIN_ALERT_LIFECYCLE, resolveAlertLifecycle } from './alertLifecycle';

const partner = {
  autoResolve: true,
  rearmMode: 'after_delay' as const,
  rearmDelayMinutes: 60,
  cooldownMinutes: 10,
};

describe('resolveAlertLifecycle', () => {
  it('monitor override wins', () => {
    const resolved = resolveAlertLifecycle({
      monitor: { autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 2 },
      org: { autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 30, cooldownMinutes: 20 },
      partner,
    });
    expect(resolved).toMatchObject({
      autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 2,
    });
    expect(resolved.sources).toEqual({
      autoResolve: 'monitor', rearmMode: 'monitor', rearmDelayMinutes: 'monitor', cooldownMinutes: 'monitor',
    });
  });

  it('org override beats partner', () => {
    const resolved = resolveAlertLifecycle({
      monitor: null,
      org: { autoResolve: false, cooldownMinutes: 20 },
      partner,
    });
    expect(resolved.autoResolve).toBe(false);
    expect(resolved.cooldownMinutes).toBe(20);
    expect(resolved.sources.autoResolve).toBe('org');
    expect(resolved.sources.cooldownMinutes).toBe('org');
  });

  it('blank (null) inherits', () => {
    const resolved = resolveAlertLifecycle({
      monitor: { autoResolve: null, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: null },
      org: { autoResolve: null, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: null },
      partner,
    });
    expect(resolved).toMatchObject(partner);
    expect(resolved.sources).toEqual({
      autoResolve: 'partner', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'partner',
    });
  });

  it('rearm pair resolves from one level', () => {
    // The monitor sets only the mode; the org's delay must NOT leak into the
    // monitor's new_evidence (a delay without after_delay is meaningless).
    const fromMonitor = resolveAlertLifecycle({
      monitor: { rearmMode: 'new_evidence' },
      org: { rearmMode: 'after_delay', rearmDelayMinutes: 30 },
      partner,
    });
    expect(fromMonitor.rearmMode).toBe('new_evidence');
    expect(fromMonitor.rearmDelayMinutes).toBeNull();
    expect(fromMonitor.sources.rearmDelayMinutes).toBe('monitor');

    // A delay set on a level that does not set the mode is not a re-arm
    // setting: the pair comes from the first level that sets the MODE.
    const fromOrg = resolveAlertLifecycle({
      monitor: { rearmDelayMinutes: 5 },
      org: { rearmMode: 'after_delay', rearmDelayMinutes: 30 },
      partner,
    });
    expect(fromOrg.rearmMode).toBe('after_delay');
    expect(fromOrg.rearmDelayMinutes).toBe(30);
    expect(fromOrg.sources.rearmMode).toBe('org');
    expect(fromOrg.sources.rearmDelayMinutes).toBe('org');
  });

  it('skips a level whose after_delay has no usable delay instead of inventing one', () => {
    const resolved = resolveAlertLifecycle({
      monitor: { rearmMode: 'after_delay', rearmDelayMinutes: null },
      org: null,
      partner: { ...partner, rearmMode: 'new_evidence', rearmDelayMinutes: null },
    });
    expect(resolved.rearmMode).toBe('new_evidence');
    expect(resolved.rearmDelayMinutes).toBeNull();
    expect(resolved.sources.rearmMode).toBe('partner');
  });

  it('legacy rule ignores partner/org', () => {
    const resolved = resolveAlertLifecycle({
      monitor: { autoResolve: false, cooldownMinutes: 1 },
      org: { autoResolve: false, rearmMode: 'after_delay', rearmDelayMinutes: 30, cooldownMinutes: 20 },
      partner,
      legacy: { autoResolve: true, cooldownMinutes: 15 },
    });
    expect(resolved).toMatchObject({
      autoResolve: true, cooldownMinutes: 15,
      rearmMode: BUILTIN_ALERT_LIFECYCLE.rearmMode, rearmDelayMinutes: null,
    });
    expect(resolved.sources).toEqual({
      autoResolve: 'legacy', cooldownMinutes: 'legacy', rearmMode: 'builtin', rearmDelayMinutes: 'builtin',
    });
  });

  it('returns sources', () => {
    const resolved = resolveAlertLifecycle({
      monitor: { cooldownMinutes: 3 },
      org: { autoResolve: true },
      partner: { autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 5 },
    });
    expect(resolved.sources).toEqual({
      autoResolve: 'org', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'monitor',
    });
  });

  it('falls back to the built-in default when no level sets a value', () => {
    const resolved = resolveAlertLifecycle({ monitor: null, org: null, partner: null });
    expect(resolved).toMatchObject(BUILTIN_ALERT_LIFECYCLE);
    expect(BUILTIN_ALERT_LIFECYCLE).toEqual({
      autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 5,
    });
    expect(resolved.sources).toEqual({
      autoResolve: 'builtin', rearmMode: 'builtin', rearmDelayMinutes: 'builtin', cooldownMinutes: 'builtin',
    });
  });

  it('0 is a real cooldown, not inherit', () => {
    const resolved = resolveAlertLifecycle({ monitor: { cooldownMinutes: 0 }, org: { cooldownMinutes: 20 }, partner });
    expect(resolved.cooldownMinutes).toBe(0);
    expect(resolved.sources.cooldownMinutes).toBe('monitor');

    const legacy = resolveAlertLifecycle({ legacy: { autoResolve: false, cooldownMinutes: 0 } });
    expect(legacy.cooldownMinutes).toBe(0);
    expect(legacy.autoResolve).toBe(false);
  });
});

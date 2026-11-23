import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { i18n, loadLocale } from '@/lib/i18n';
import ReachLine, { deviceCountPhrase, reachPhrase, saveReach } from './ReachLine';

const reach = (direct: number, throughChildren: number, partial = false) => ({
  direct,
  throughChildren,
  organizations: 1,
  ...(partial ? { partial: true as const } : {}),
});

describe('saveReach (plan W03c F3)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('the save reach line shows direct plus through-children on an active policy', () => {
    const r = saveReach({ status: 'active', reach: reach(200, 12), childPolicyCount: 1 });
    expect(r).toEqual({ kind: 'reaches', devices: 212, partial: false });
    expect(reachPhrase(r!)).toBe('reaches 212 devices');
  });

  it("an unapplied parent's saves carry its through-children reach", () => {
    // Active but applied nowhere itself; two policies are based on it.
    const active = saveReach({ status: 'active', reach: reach(0, 148), childPolicyCount: 3 });
    expect(active).toEqual({ kind: 'in_use_through', policies: 3, devices: 148, partial: false });
    expect(reachPhrase(active!)).toBe('in use through 3 policies · 148 devices');
    // An inactive parent: its own targets are not enforced, its children's are.
    const inactive = saveReach({ status: 'inactive', reach: reach(40, 148), childPolicyCount: 3 });
    expect(inactive).toEqual({ kind: 'in_use_through', policies: 3, devices: 148, partial: false });
  });

  it('a partial reach reads "at least", never an exact-looking count', () => {
    const r = saveReach({ status: 'active', reach: reach(200, 12, true), childPolicyCount: 0 });
    expect(reachPhrase(r!)).toBe('reaches at least 212 devices');
    const parent = saveReach({ status: 'inactive', reach: reach(0, 148, true), childPolicyCount: 2 });
    expect(reachPhrase(parent!)).toBe('in use through 2 policies · at least 148 devices');
  });

  it('says nothing when the reach is unknown or the save reaches nothing', () => {
    expect(saveReach(null)).toBeNull();
    expect(saveReach({ status: 'active', reach: null, childPolicyCount: 2 })).toBeNull();
    // Inactive with no policy based on it: a save changes no device.
    expect(saveReach({ status: 'inactive', reach: reach(40, 0), childPolicyCount: 0 })).toBeNull();
    expect(saveReach({ status: 'archived', reach: reach(40, 0), childPolicyCount: 0 })).toBeNull();
  });

  it('a 0 reach says no devices you can see, not 0 devices', () => {
    const r = saveReach({ status: 'active', reach: reach(0, 0), childPolicyCount: 0 });
    expect(reachPhrase(r!)).toBe('reaches no devices you can see');
    expect(deviceCountPhrase(0, false)).toBe('no devices you can see');
    expect(deviceCountPhrase(1, false)).toBe('1 device');
    expect(deviceCountPhrase(5, true)).toBe('at least 5 devices');
  });

  it('the phrases are translated', async () => {
    await loadLocale('de-DE');
    await i18n.changeLanguage('de-DE');
    const r = saveReach({ status: 'active', reach: reach(200, 12), childPolicyCount: 0 });
    expect(reachPhrase(r!)).not.toBe('reaches 212 devices');
    expect(reachPhrase(r!)).toContain('212');
  });

  it('ReachLine renders the phrase', () => {
    render(<ReachLine value={{ kind: 'reaches', devices: 3, partial: false }} testId="line" />);
    expect(screen.getByTestId('line')).toHaveTextContent('reaches 3 devices');
  });
});

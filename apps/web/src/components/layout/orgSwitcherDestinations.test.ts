import { describe, expect, it } from 'vitest';

import { destinationTarget, visibleDestinations } from './orgSwitcherDestinations';

const ALL = [{ resource: '*', action: '*' }] as never;

describe('destinationTarget', () => {
  it('maps every destination to its route', () => {
    expect(destinationTarget('overview', 'org-1')).toBe('/organizations/org-1');
    expect(destinationTarget('devices', 'org-1')).toBe('/devices');
    expect(destinationTarget('tickets', 'org-1')).toBe('/tickets');
    expect(destinationTarget('alerts', 'org-1')).toBe('/alerts');
    expect(destinationTarget('sites', 'org-1')).toBe('/organizations/org-1#sites');
    expect(destinationTarget('billing', 'org-1')).toBe('/organizations/org-1#billing');
  });
});

describe('visibleDestinations', () => {
  it('wildcard grant + native shows all six, in order', () => {
    expect(visibleDestinations(ALL, 'native')).toEqual([
      'overview',
      'devices',
      'tickets',
      'alerts',
      'sites',
      'billing',
    ]);
  });

  it('service management off hides tickets and billing', () => {
    const dests = visibleDestinations(ALL, 'off');
    expect(dests).not.toContain('tickets');
    expect(dests).not.toContain('billing');
  });

  it('external keeps tickets and hides billing', () => {
    const dests = visibleDestinations(ALL, 'external');
    expect(dests).toContain('tickets');
    expect(dests).not.toContain('billing');
  });

  it('organizations:read alone leaves overview and sites', () => {
    expect(
      visibleDestinations([{ resource: 'organizations', action: 'read' }] as never, 'native'),
    ).toEqual(['overview', 'sites']);
  });

  it('unknown permissions leave overview and sites', () => {
    expect(visibleDestinations(undefined, 'native')).toEqual(['overview', 'sites']);
  });
});

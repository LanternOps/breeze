import { describe, expect, it } from 'vitest';
import { permissionGrantMatches } from './permissionMatching';

describe('permissionGrantMatches', () => {
  it.each([
    { grant: { resource: 'reports', action: 'read' }, resource: 'reports', action: 'read', expected: true },
    { grant: { resource: '*', action: '*' }, resource: 'reports', action: 'read', expected: true },
    { grant: { resource: '*', action: 'read' }, resource: 'reports', action: 'read', expected: true },
    { grant: { resource: 'reports', action: '*' }, resource: 'reports', action: 'delete', expected: true },
    { grant: { resource: 'devices', action: '*' }, resource: 'reports', action: 'read', expected: false },
    { grant: { resource: '*', action: 'write' }, resource: 'reports', action: 'read', expected: false },
    { grant: { resource: 'reports', action: 'read' }, resource: 'reports', action: 'write', expected: false },
    { grant: { resource: 'reports', action: 'read' }, resource: 'devices', action: 'read', expected: false },
  ])(
    '$grant.resource|$grant.action vs $resource:$action -> $expected',
    ({ grant, resource, action, expected }) => {
      expect(permissionGrantMatches(grant, resource, action)).toBe(expected);
    },
  );

  it('never treats a concrete resource as a prefix wildcard', () => {
    expect(permissionGrantMatches({ resource: 'report', action: '*' }, 'reports', 'read')).toBe(false);
    expect(permissionGrantMatches({ resource: 'reports', action: 'rea' }, 'reports', 'read')).toBe(false);
  });
});

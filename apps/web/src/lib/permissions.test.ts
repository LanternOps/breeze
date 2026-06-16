import { describe, it, expect } from 'vitest';
import { hasPermission } from './permissions';
import type { Permission } from '../stores/auth';

describe('hasPermission', () => {
  it('matches an exact resource:action grant', () => {
    const perms: Permission[] = [{ resource: 'invoices', action: 'read' }];
    expect(hasPermission(perms, 'invoices', 'read')).toBe(true);
  });

  it('denies when the grant is absent', () => {
    const perms: Permission[] = [{ resource: 'invoices', action: 'read' }];
    expect(hasPermission(perms, 'invoices', 'write')).toBe(false);
    expect(hasPermission(perms, 'contracts', 'read')).toBe(false);
  });

  it('honors the admin wildcard (*:*) for any check', () => {
    const perms: Permission[] = [{ resource: '*', action: '*' }];
    expect(hasPermission(perms, 'invoices', 'send')).toBe(true);
    expect(hasPermission(perms, 'catalog', 'delete')).toBe(true);
  });

  it('honors a resource wildcard with a specific action', () => {
    const perms: Permission[] = [{ resource: '*', action: 'read' }];
    expect(hasPermission(perms, 'contracts', 'read')).toBe(true);
    expect(hasPermission(perms, 'contracts', 'write')).toBe(false);
  });

  it('honors an action wildcard scoped to one resource', () => {
    const perms: Permission[] = [{ resource: 'invoices', action: '*' }];
    expect(hasPermission(perms, 'invoices', 'send')).toBe(true);
    expect(hasPermission(perms, 'contracts', 'send')).toBe(false);
  });

  it('returns false while permissions are still loading (undefined)', () => {
    // Gated UI must stay hidden until grants resolve, not flash then disappear.
    expect(hasPermission(undefined, 'invoices', 'read')).toBe(false);
  });

  it('returns false for an empty grant list', () => {
    expect(hasPermission([], 'invoices', 'read')).toBe(false);
  });
});

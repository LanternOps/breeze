import { describe, it, expect } from 'vitest';
import { hasPermission, usePermissions } from './permissions';
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

/**
 * Compile-time gate typing. This is the PR's central claim: a typo'd gate
 * (wrong resource OR wrong action literal) must fail to compile, since no
 * runtime test can catch a gate that's simply never reached. These assertions
 * have no runtime body — they exist purely so `tsc` rejects them. If the
 * PermissionResource / PermissionAction types were ever widened back to `string`,
 * the calls below would type-check fine and the `@ts-expect-error` directives
 * would themselves become errors ("unused @ts-expect-error"), failing the build
 * — which is exactly the regression alarm we want.
 */
describe('permission gate typing (compile-time)', () => {
  it('rejects invalid resource/action literals at the type level', () => {
    const perms: Permission[] = [];

    // bare hasPermission(): unknown action on a known resource
    // @ts-expect-error 'frobnicate' is not a PermissionAction
    hasPermission(perms, 'invoices', 'frobnicate');
    // bare hasPermission(): unknown resource
    // @ts-expect-error 'nonsense' is not a PermissionResource
    hasPermission(perms, 'nonsense', 'read');
    // bare hasPermission(): unknown action on an unknown resource
    // @ts-expect-error both literals are invalid
    hasPermission(perms, 'nonsense', 'frobnicate');

    // The hook's can() is typed identically. We only need the type of `can`,
    // not a live React render, so guard the call so it never actually runs.
    if (Math.random() < 0) {
      const { can } = usePermissions();
      // @ts-expect-error 'frobnicate' is not a PermissionAction
      can('invoices', 'frobnicate');
      // @ts-expect-error 'nonsense' is not a PermissionResource
      can('nonsense', 'read');
    }

    // A valid (resource, action) pair must still compile — proves the rejections
    // above are about the literals, not a blanket failure.
    expect(hasPermission(perms, 'invoices', 'send')).toBe(false);
  });
});

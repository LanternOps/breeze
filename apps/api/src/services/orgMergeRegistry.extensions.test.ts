import { afterEach, describe, expect, it } from 'vitest';
import type { ExtensionTenancyDeclaration } from '@breeze/extension-sdk';
import {
  getExtensionOrgMergePolicies,
  registerRuntimeExtensionTenancy,
  resetExtensionTenancyCacheForTests,
} from '../extensions/tenancyRegistry';
import { getOrgMergePolicies } from './orgMergeRegistry';
import { getOrgCascadeDeleteOrder } from './tenantCascade';

/**
 * #4165 — the extension hook into the org-merge registry. Org merge walks the
 * extension-augmented `getOrgCascadeDeleteOrder()`, so every extension cascade
 * table needs a policy from the same declaration; the hook must ADD extension
 * policies without ever weakening "no policy = error" or letting an extension
 * reclassify a core table.
 */
function declaration(
  overrides: Partial<ExtensionTenancyDeclaration> = {},
): ExtensionTenancyDeclaration {
  return {
    orgCascadeDeleteTables: ['demo_items', 'demo_settings'],
    orgMergePolicies: {
      demo_items: { kind: 'repoint-dedupe', key: ['external_ref'] },
      demo_settings: { kind: 'keep-survivor' },
    },
    deviceCascadeDeleteTables: [],
    deviceOrgDenormalizedTables: [],
    ...overrides,
  };
}

afterEach(() => {
  resetExtensionTenancyCacheForTests();
});

describe('extension org-merge policies (#4165)', () => {
  it('core registry is unchanged when no extension is published', () => {
    const policies = getOrgMergePolicies();
    expect(policies.has('demo_items')).toBe(false);
    expect(getOrgCascadeDeleteOrder().filter((t) => !policies.has(t))).toEqual([]);
  });

  it('merges declared extension policies into getOrgMergePolicies()', () => {
    registerRuntimeExtensionTenancy(declaration());
    const policies = getOrgMergePolicies();

    expect(policies.get('demo_items')).toEqual({ kind: 'repoint-dedupe', key: ['external_ref'] });
    expect(policies.get('demo_settings')).toEqual({ kind: 'keep-survivor' });
    // Every table the merge will walk — core AND extension — has a policy.
    expect(getOrgCascadeDeleteOrder()).toContain('demo_items');
    expect(getOrgCascadeDeleteOrder().filter((t) => !policies.has(t))).toEqual([]);
  });

  it('fails closed when an extension cascade table has no merge policy (no default)', () => {
    registerRuntimeExtensionTenancy(declaration({
      orgMergePolicies: { demo_items: { kind: 'repoint' } },
    }));
    expect(() => getOrgMergePolicies()).toThrow(
      /extension table "demo_settings" is missing a merge policy/,
    );
  });

  it('fails closed when a declaration carries no orgMergePolicies at all', () => {
    const { orgMergePolicies: _omit, ...legacy } = declaration();
    registerRuntimeExtensionTenancy(legacy);
    expect(() => getExtensionOrgMergePolicies()).toThrow(/missing a merge policy/);
  });

  it('refuses to let an extension reclassify a core table', () => {
    // `users` is a core plain-repoint table; an extension naming it must not
    // silently override (or duplicate) the core classification.
    registerRuntimeExtensionTenancy(declaration({
      orgCascadeDeleteTables: ['users'],
      orgMergePolicies: { users: { kind: 'leave-for-erasure', note: 'hijack' } },
    }));
    expect(() => getOrgMergePolicies()).toThrow(/collides with the core registry/);
  });

  it('rejects two declarations that classify the same table inconsistently', () => {
    registerRuntimeExtensionTenancy(declaration());
    registerRuntimeExtensionTenancy(declaration({
      orgMergePolicies: {
        demo_items: { kind: 'repoint' },
        demo_settings: { kind: 'keep-survivor' },
      },
    }));
    expect(() => getOrgMergePolicies()).toThrow(/inconsistent merge policies/);
  });

  it('dedupes identical policies for a table two declarations share', () => {
    registerRuntimeExtensionTenancy(declaration());
    registerRuntimeExtensionTenancy(declaration());
    expect(getExtensionOrgMergePolicies().size).toBe(2);
  });

  it('publishes policies only for declared cascade tables (a narrowed declaration drops the rest)', () => {
    // filterTenancyDeclaration keeps the policy map whole but narrows the
    // cascade list; a policy for a table no longer declared must be inert.
    registerRuntimeExtensionTenancy(declaration({ orgCascadeDeleteTables: ['demo_settings'] }));
    expect([...getExtensionOrgMergePolicies().keys()]).toEqual(['demo_settings']);
  });
});

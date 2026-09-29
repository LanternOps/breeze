import { describe, expect, it } from 'vitest';
import { captureTenantDescriptors, CAPTURE_TENANT_SET_IDS, MAX_CAPTURE_TENANT_TOOLS } from './tenantFixtures';

describe('captureTenantDescriptors', () => {
  it('returns no tenant tools for the none set', () => {
    expect(captureTenantDescriptors('none')).toEqual([]);
  });

  it.each(['a', 'b'] as const)('set %s is non-empty, sorted by qualifiedName like the resolver, and all from one source', (set) => {
    const descriptors = captureTenantDescriptors(set);
    expect(descriptors.length).toBeGreaterThan(0);
    const names = descriptors.map((d) => d.qualifiedName);
    expect(names).toEqual([...names].sort());
    expect(new Set(descriptors.map((d) => d.sourceId)).size).toBe(1);
    for (const d of descriptors) {
      expect(d.qualifiedName).toBe(`${d.qualifiedName.split('__')[0]}__${d.name}`);
      expect(d.definition.name).toBe(d.qualifiedName);
      expect(d.inputSchema).toMatchObject({ type: 'object' });
      expect(d.validate({})).toEqual({ success: true });
    }
  });

  it('sets a and b share no tool names, so a capture can compare two differing tenant sets', () => {
    const a = new Set(captureTenantDescriptors('a').map((d) => d.qualifiedName));
    const b = captureTenantDescriptors('b').map((d) => d.qualifiedName);
    expect(b.filter((name) => a.has(name))).toEqual([]);
  });

  it('honours an explicit count, padding past the named tools with generated ones, still sorted', () => {
    expect(captureTenantDescriptors('a', 3)).toHaveLength(3);
    const many = captureTenantDescriptors('a', 40);
    expect(many).toHaveLength(40);
    expect(new Set(many.map((d) => d.qualifiedName)).size).toBe(40);
    const names = many.map((d) => d.qualifiedName);
    expect(names).toEqual([...names].sort());
  });

  it('rejects a negative or fractional count, and any count on the none set', () => {
    expect(() => captureTenantDescriptors('a', -1)).toThrow();
    expect(() => captureTenantDescriptors('a', 1.5)).toThrow();
    expect(() => captureTenantDescriptors('none', 3)).toThrow();
  });

  it('caps the count so a typo cannot allocate an absurd catalog', () => {
    expect(captureTenantDescriptors('b', MAX_CAPTURE_TENANT_TOOLS)).toHaveLength(MAX_CAPTURE_TENANT_TOOLS);
    expect(() => captureTenantDescriptors('b', MAX_CAPTURE_TENANT_TOOLS + 1)).toThrow(/at most/);
    expect(() => captureTenantDescriptors('b', 1e20)).toThrow(/at most/);
  });

  it('exposes exactly the three set ids the CLI accepts', () => {
    expect([...CAPTURE_TENANT_SET_IDS]).toEqual(['none', 'a', 'b']);
  });
});

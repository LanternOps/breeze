// apps/api/src/services/aiAgents/toolAllowlist.test.ts
import { describe, expect, it } from 'vitest';
import { intersectToolRefs, isToolAllowlisted } from './toolAllowlist';

describe('isToolAllowlisted', () => {
  it('admits every action of a bare tool entry', () => {
    expect(isToolAllowlisted(['manage_services'], 'manage_services', 'restart')).toBe(true);
    expect(isToolAllowlisted(['manage_services'], 'manage_services', 'stop')).toBe(true);
  });

  it('admits the specific tool:action entry and nothing else of that tool', () => {
    expect(isToolAllowlisted(['manage_services:restart'], 'manage_services', 'restart')).toBe(true);
    expect(isToolAllowlisted(['manage_services:restart'], 'manage_services', 'stop')).toBe(false);
  });

  it('refuses a tool that is absent from the allowlist entirely', () => {
    expect(isToolAllowlisted(['get_device_details'], 'manage_services', 'restart')).toBe(false);
    expect(isToolAllowlisted([], 'manage_services', 'restart')).toBe(false);
  });

  // A tool with no action discriminator (the sweep union's
  // `remediate_vulnerability`) can only ever be admitted by a bare entry.
  it('matches on the bare entry only when the action is undefined or null', () => {
    expect(isToolAllowlisted(['remediate_vulnerability'], 'remediate_vulnerability')).toBe(true);
    expect(isToolAllowlisted(['remediate_vulnerability'], 'remediate_vulnerability', null)).toBe(true);
    expect(isToolAllowlisted(['remediate_vulnerability:apply'], 'remediate_vulnerability')).toBe(false);
    expect(isToolAllowlisted(['remediate_vulnerability:apply'], 'remediate_vulnerability', null)).toBe(false);
  });

  // A scoped entry must never be admitted by prefix: `manage_servicesX` and
  // `manage_services:restart` share no admitting relationship with a request
  // for a DIFFERENT tool whose name happens to start the same way.
  it('never matches a different tool by prefix', () => {
    expect(isToolAllowlisted(['manage_services'], 'manage_services_v2', 'restart')).toBe(false);
    expect(isToolAllowlisted(['manage_services:restart'], 'manage', 'services:restart')).toBe(false);
  });
});

describe('intersectToolRefs', () => {
  it('keeps a scoped entry when the other side holds the bare tool (partner ceiling is a wildcard)', () => {
    expect(intersectToolRefs(['manage_services'], ['manage_services:restart']))
      .toEqual(['manage_services:restart']);
    expect(intersectToolRefs(['manage_services:restart'], ['manage_services']))
      .toEqual(['manage_services:restart']);
  });

  it('keeps a bare entry only when both sides are bare', () => {
    expect(intersectToolRefs(['run_script'], ['run_script'])).toEqual(['run_script']);
    expect(intersectToolRefs(['manage_services'], ['manage_services:stop', 'disk_cleanup:execute']))
      .toEqual(['manage_services:stop']);
  });

  it('drops entries the other side never admits', () => {
    expect(intersectToolRefs(['manage_services:restart'], ['manage_services:stop'])).toEqual([]);
    expect(intersectToolRefs(['run_script'], [])).toEqual([]);
  });

  it('is sound and complete against isToolAllowlisted', () => {
    const tools = ['manage_services', 'disk_cleanup', 'run_script'];
    const actions = ['restart', 'execute', null];
    const universe: string[] = [];
    for (const t of tools) { universe.push(t); for (const a of actions) if (a) universe.push(`${t}:${a}`); }
    const subsets = (xs: string[]): string[][] =>
      xs.reduce<string[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
    const lists = subsets(universe).filter((s) => s.length <= 3);
    for (const a of lists) for (const b of lists) {
      const merged = intersectToolRefs(a, b);
      for (const t of tools) for (const act of actions) {
        const both = isToolAllowlisted(a, t, act) && isToolAllowlisted(b, t, act);
        expect(isToolAllowlisted(merged, t, act)).toBe(both);
      }
    }
  });
});

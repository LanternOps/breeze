import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { formatAuditResourceType } from './auditResourceType';

const REPO_ROOT = resolve(__dirname, '../../../..');

// Audit rows are written by the API (and the ee/ extensions it hosts) with a
// literal `resourceType: '<snake_case>'`, occasionally behind a ternary or a
// `??` default. Importing those modules would drag in the DB layer, so the
// API side is read as source, the same way `filterFields.apiParity.test.ts`
// pins the filter catalog. Only literals in a value position count: a string
// passed to a call (`action.startsWith('layout')`) is a condition, not a type.
const TYPE_LITERAL = /(?:resourceType:|\?\?|\?|:)\s*'([a-z][a-z0-9_]*)'(?!\s*\))/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function emittedResourceTypes(): Set<string> {
  const roots = [join(REPO_ROOT, 'apps/api/src')];
  for (const ext of readdirSync(join(REPO_ROOT, 'ee'))) {
    const src = join(REPO_ROOT, 'ee', ext, 'src');
    try {
      if (statSync(src).isDirectory()) roots.push(src);
    } catch {
      // not an extension package
    }
  }
  const types = new Set<string>();
  for (const file of roots.flatMap(sourceFiles)) {
    const source = readFileSync(file, 'utf8');
    for (const line of source.split('\n')) {
      const at = line.indexOf('resourceType:');
      if (at === -1) continue;
      // One property per scan: stop at the next property separator.
      const tail = line.slice(at);
      // A schema descriptor (`resourceType: { type: 'string' }`) is not a value.
      if (/^resourceType:\s*\{/.test(tail)) continue;
      const end = tail.search(/,\s*[A-Za-z_]+\s*:|\}/);
      const value = end === -1 ? tail : tail.slice(0, end);
      for (const m of value.matchAll(TYPE_LITERAL)) types.add(m[1]!);
    }
  }
  return types;
}

function englishCatalog(): Record<string, string> {
  const admin = JSON.parse(readFileSync(resolve(__dirname, '../locales/en/admin.json'), 'utf8'));
  return admin.audit.resourceTypes as Record<string, string>;
}

describe('audit resource type labels (#9856)', () => {
  it('extracts the API resource types (sanity: the scan found the real set)', () => {
    const types = emittedResourceTypes();
    expect(types.size).toBeGreaterThan(200);
    // A plain literal, a ternary branch, and a `??` default.
    expect(types).toContain('saved_filter');
    expect(types).toContain('time_suggestion');
    expect(types).toContain('topology_view_exclusion');
    expect(types).toContain('invoice');
    // Call arguments inside a ternary condition are not types.
    expect(types).not.toContain('layout');
    expect(types).not.toContain('string');
  });

  it('has an en label for every resource type the API can emit', () => {
    const catalog = englishCatalog();
    const missing = [...emittedResourceTypes()].filter((type) => !catalog[type]?.trim()).sort();
    expect(missing, `add these to admin:audit.resourceTypes in every locale:\n${missing.join('\n')}`).toEqual([]);
  });

  it('never labels a type with its raw token', () => {
    const raw = Object.entries(englishCatalog()).filter(([type, label]) => label === type || /_/.test(label));
    expect(raw).toEqual([]);
  });

  it('formats a known type from the catalog, an unknown type readably, and nothing as "-"', () => {
    const labels = { saved_filter: 'Saved view' };
    expect(formatAuditResourceType('saved_filter', labels)).toBe('Saved view');
    // Path-derived types from the catch-all audit middleware are open-ended.
    expect(formatAuditResourceType('ai-risk', labels)).toBe('AI risk');
    expect(formatAuditResourceType('patch_compliance_report')).toBe('Patch compliance report');
    expect(formatAuditResourceType('')).toBe('-');
    expect(formatAuditResourceType(undefined)).toBe('-');
  });
});

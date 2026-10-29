import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { formatAuditResourceType } from './auditResourceType';

const REPO_ROOT = resolve(__dirname, '../../../..');

// Audit rows are written by the API (and the ee/ extensions it hosts) with a
// literal `resourceType: '<snake_case>'`, occasionally behind a ternary, a
// `??` default, or a literal union on a helper's parameter type. Importing
// those modules would drag in the DB layer, so the API side is read as source,
// the same way `filterFields.apiParity.test.ts` pins the filter catalog. Only
// literals in a value position count: a string passed to a call
// (`action.startsWith('layout')`) is a condition, not a type.
//
// Best effort, not a proof: a type passed through a variable or a positional
// helper argument, or hardcoded inside a raw `sql` insert, is not seen here.
// Those still render humanized (never raw) through `formatAuditResourceType`.
const TYPE_LITERAL = /(?:resourceType:|\?\?|\?|:|\|)\s*['"]([a-z][a-z0-9_]*)['"](?!\s*\))/g;
// Where one `resourceType` value ends: the next property, or the end of the
// object / statement.
const VALUE_END = /,\s*[A-Za-z_]+\??\s*:|\n\s*[A-Za-z_]+\??\s*:|[};]/;

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

function typesInSource(source: string): string[] {
  const types: string[] = [];
  for (const at of source.matchAll(/resourceType:/g)) {
    const rest = source.slice(at.index! + 'resourceType:'.length);
    // A schema descriptor (`resourceType: { type: 'string' }`) is not a value.
    if (/^\s*\{/.test(rest)) continue;
    const end = rest.search(VALUE_END);
    const value = `resourceType:${end === -1 ? rest : rest.slice(0, end)}`;
    for (const m of value.matchAll(TYPE_LITERAL)) types.push(m[1]!);
  }
  return types;
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
    for (const type of typesInSource(readFileSync(file, 'utf8'))) types.add(type);
  }
  // `monitor.conversion.retire` audits the converted row under its source
  // table name (monitorDefinitions.conversion.ts: `resourceType: sourceTable`).
  const conversions = readFileSync(join(REPO_ROOT, 'apps/api/src/db/schema/monitorConversions.ts'), 'utf8');
  const block = conversions.match(/MONITOR_CONVERSION_SOURCE_TABLES = \[([\s\S]*?)\]/);
  expect(block).not.toBeNull();
  for (const m of block![1]!.matchAll(/'([a-z_]+)'/g)) types.add(m[1]!);
  return types;
}

function englishCatalog(): Record<string, string> {
  const admin = JSON.parse(readFileSync(resolve(__dirname, '../locales/en/admin.json'), 'utf8'));
  return admin.audit.resourceTypes as Record<string, string>;
}

describe('audit resource type labels (#9856)', () => {
  it('reads every value shape of a resourceType property', () => {
    expect(
      typesInSource(`
        a({ resourceType: "dq", resourceId: x });
        function f(resourceType: 'u1' | 'u2', id: string) {}
        type T = {
          resourceType:
            | 'm1'
            | 'm2';
          resourceId: string;
        };
        b({ resourceType: ok ? 't1' : 't2', id });
        c({ resourceType: audit.resourceType ?? 'd1' });
        d({ resourceType: action.startsWith('cond') ? 'r1' : 'r2' });
        e({ resourceType: { type: 'string' } });
      `).sort(),
    ).toEqual(['d1', 'dq', 'm1', 'm2', 'r1', 'r2', 't1', 't2', 'u1', 'u2']);
  });

  it('extracts the API resource types (sanity: the scan found the real set)', () => {
    const types = emittedResourceTypes();
    expect(types.size).toBeGreaterThan(200);
    // A plain literal, a ternary branch, a `??` default, a double-quoted
    // literal, a later union member, a multi-line union, a conversion table.
    expect(types).toContain('saved_filter');
    expect(types).toContain('time_suggestion');
    expect(types).toContain('topology_view_exclusion');
    expect(types).toContain('invoice');
    expect(types).toContain('agent_version');
    expect(types).toContain('tunnel_allowlist');
    expect(types).toContain('report_run');
    expect(types).toContain('config_policy_alert_rules');
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
    // Not an inherited Object.prototype member.
    expect(formatAuditResourceType('constructor', labels)).toBe('Constructor');
    expect(formatAuditResourceType('')).toBe('-');
    expect(formatAuditResourceType(undefined)).toBe('-');
  });
});

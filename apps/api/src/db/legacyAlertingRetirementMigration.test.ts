import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = new URL('../../migrations/', import.meta.url);
const migration = '2026-10-31-100000-legacy-alerting-retirement-sweep.sql';
const statements = () => readFileSync(new URL(migration, directory), 'utf8')
  .replace(/--[^\n]*/g, '');

describe('legacy alerting retirement migration contract', () => {
  it('is discoverable after the retirement columns and the current migration ceiling', () => {
    const files = readdirSync(fileURLToPath(directory)).sort((a, b) => a.localeCompare(b));
    expect(files).toContain(migration);
    for (const prerequisite of [
      '2026-10-23-120000-legacy-source-retirement-columns.sql',
      ...files.filter((file) => file.startsWith('2026-10-30-110400-')),
    ]) {
      expect(files).toContain(prerequisite);
      expect(files.indexOf(migration)).toBeGreaterThan(files.indexOf(prerequisite));
    }
  });

  it('elects system scope first and preserves historical rows and schema', () => {
    const source = statements();
    expect(source.trimStart()).toMatch(/^SELECT set_config\('breeze.scope', 'system', true\);/);
    expect(source).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP|ALTER|GRANT)\b/i);
    expect(source).not.toMatch(/\bCREATE\s+(?:TABLE|POLICY|FUNCTION)\b/i);
    expect(source).not.toMatch(/^\s*(?:BEGIN|COMMIT)\s*;/im);
    expect(source).not.toMatch(/SET\s+retired_at\s*=/i);
  });

  it('reports every data mutation and counts both policy source tables plus unmanaged standalone sources', () => {
    const source = statements();
    const writes = source.split(/DO \$\$/).filter((block) => /\b(?:INSERT INTO|UPDATE)\b/.test(block));
    expect(writes).toHaveLength(3);
    for (const block of writes) {
      expect(block).toMatch(/GET DIAGNOSTICS \w+ = ROW_COUNT;/);
      expect(block).toMatch(/RAISE WARNING/);
    }
    for (const table of ['config_policy_alert_rules', 'config_policy_monitoring_watches']) {
      expect(source).toContain(`FROM ${table} WHERE retired_at IS NULL`);
    }
    expect(source).toContain('FROM alert_rules WHERE retired_at IS NULL AND managed_by_monitor_id IS NULL');
    expect(source).toContain('FROM alert_templates WHERE retired_at IS NULL AND managed_by_monitor_id IS NULL AND is_built_in = false');
  });
});

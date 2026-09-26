// M3 Task 2 — static contract for the partitioned interface-sample migration
// and its tenant-lifecycle registrations. Fails in the unit job; the live-DB
// behaviour is proven by topologyInterfaceSamples.integration.test.ts and the
// catalog contracts (rls-coverage, tenantCascade, tenant-export-policy,
// orgMergeRegistry, orgCascadeFkOnDelete).
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getOrgCascadeDeleteOrder, ORG_CASCADE_DELETE_ORDER } from '../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../services/tenantExportPolicyRegistry';
import { __testOnly as orgMergeRegistryTestOnly } from '../services/orgMergeRegistry';
import { topologyInterfaceSamples } from './schema/topologyTelemetry';
import { topologyCollectionSources } from './schema/topologyCollections';
import { checkConstraintLiterals } from './schema/checkConstraintTestHelpers';
import { TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS } from '@breeze/shared';

const MIGRATIONS = resolve(__dirname, '../../migrations');
const FILE = '2026-11-03-090000-topology-interface-samples.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const code = SQL.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');
const TABLE = 'topology_interface_samples';

describe('topology interface samples migration', () => {
  it('sorts after the M2 topology migrations', () => {
    const files = readdirSync(MIGRATIONS).filter(name => /^\d{4}-.*\.sql$/.test(name)).sort((a, b) => a.localeCompare(b));
    expect(files.indexOf(FILE)).toBeGreaterThan(files.indexOf('2026-11-03-080600-topology-relationship-endpoint-indexes.sql'));
  });

  it('partitions LIST(resolution) -> RANGE(sampled_at) with no default partition', () => {
    expect(code).toMatch(/\) PARTITION BY LIST \(resolution\);/);
    for (const resolution of TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS) {
      expect(code).toContain(`CREATE TABLE IF NOT EXISTS topology_interface_samples_${resolution} PARTITION OF topology_interface_samples\n  FOR VALUES IN ('${resolution}') PARTITION BY RANGE (sampled_at);`);
    }
    expect(code).not.toMatch(/\bDEFAULT\s*;|PARTITION OF [^\n]* DEFAULT/i);
  });

  it('declares both same-scope FKs deferrable with explicit cascade', () => {
    expect(code).toContain('FOREIGN KEY (interface_id, org_id, site_id) REFERENCES topology_interfaces (id, org_id, site_id)\n      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE');
    expect(code).toContain('FOREIGN KEY (source_id, org_id, site_id) REFERENCES topology_collection_sources (id, org_id, site_id)\n      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE');
  });

  it('bounds the uint64 sequence and the readings document', () => {
    expect(code).toContain('CHECK (source_sequence BETWEEN 0 AND 18446744073709551615)');
    expect(code).toContain("CHECK (jsonb_typeof(readings) = 'object' AND octet_length(readings::text) <= 16384)");
    expect([...checkConstraintLiterals(SQL, 'topology_interface_samples_resolution_chk', 'resolution')].sort()).toEqual([...TOPOLOGY_INTERFACE_SAMPLE_RESOLUTIONS].sort());
  });

  it('converges forced RLS, four org policies and the grant on every relation it creates', () => {
    expect(code).toContain("EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', p_relation);");
    expect(code).toContain("FOREACH command IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP");
    expect(code).toContain('breeze_has_org_access(org_id)');
    expect(code).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO breeze_app");
    expect(code).toContain("unnest(ARRAY['topology_interface_samples','topology_interface_samples_raw',\n  'topology_interface_samples_5m','topology_interface_samples_1h'])");
    expect(code).toContain('PERFORM public.breeze_converge_topology_interface_sample_rls(v_name);');
  });

  it('exposes only restricted SECURITY DEFINER partition entry points', () => {
    for (const fn of ['breeze_ensure_topology_interface_sample_partition', 'breeze_drop_topology_interface_sample_partition']) {
      const body = code.slice(code.indexOf(`FUNCTION public.${fn}(`));
      expect(body.slice(0, 400)).toMatch(/SECURITY DEFINER\s+SET search_path = pg_catalog, public/);
      expect(code).toContain(`REVOKE ALL ON FUNCTION public.${fn}(text, date) FROM PUBLIC;`);
      expect(code).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(text, date) TO breeze_app;`);
    }
    expect(code).toContain('REVOKE ALL ON FUNCTION public.breeze_converge_topology_interface_sample_rls(text) FROM PUBLIC;');
    expect(code).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.breeze_converge_topology_interface_sample_rls/);
    expect(code.match(/FROM pg_inherits/g)).toHaveLength(2);
    expect(code).toContain('is outside the % partition window');
    expect(code).toContain('is still inside % retention');
  });

  it('keeps raw readings immutable except for ownership', () => {
    expect(code).toContain("to_jsonb(NEW) - ARRAY['org_id','updated_at'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['org_id','updated_at']");
    expect(code).toContain('BEFORE UPDATE ON topology_interface_samples');
  });

  it('writes no rows and opens no transaction of its own', () => {
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    expect(code).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
  });
});

describe('topology interface samples tenant lifecycle registrations', () => {
  it('is in the org cascade exactly once, alphabetised', () => {
    expect(ORG_CASCADE_DELETE_ORDER.filter(t => t === TABLE)).toHaveLength(1);
    const order = getOrgCascadeDeleteOrder();
    const withoutLast = order.slice(0, -1);
    expect(withoutLast).toEqual([...withoutLast].sort((a, b) => a.localeCompare(b)));
    // Leaves and sub-parents are runtime partitions, never registered.
    expect(order.some(t => t.startsWith(`${TABLE}_`))).toBe(false);
  });

  it('is repointed by an org merge', () => {
    const { SPECIAL, REPOINT_TABLES } = orgMergeRegistryTestOnly;
    expect(REPOINT_TABLES).toContain(TABLE);
    expect(Object.prototype.hasOwnProperty.call(SPECIAL, TABLE)).toBe(false);
  });

  it('classifies every column for export, with readings excludedOpen', () => {
    const policy = CORE_TENANT_EXPORT_POLICY[TABLE]!;
    expect(policy).toBeDefined();
    const columns = Object.values(topologyInterfaceSamples).filter((c): c is { name: string } & object => !!c && typeof c === 'object' && 'name' in c && 'columnType' in c).map(c => c.name);
    expect(columns.length).toBeGreaterThan(10);
    for (const column of columns) expect(policy.columns[column], `${TABLE}.${column} unclassified`).toBeDefined();
    expect(policy.columns.readings?.decision).toBe('exclude');
    expect(policy.columns.readings?.openContainerReviewed).toBe(true);
  });

  it('classifies the new telemetry window columns on topology_collection_sources', () => {
    const policy = CORE_TENANT_EXPORT_POLICY.topology_collection_sources!;
    for (const column of ['telemetry_window_started_at', 'telemetry_window_samples', 'telemetry_window_bytes']) {
      expect(policy.columns[column]?.decision, column).toBe('include');
    }
    expect(topologyCollectionSources).toHaveProperty('telemetryWindowSamples');
  });
});

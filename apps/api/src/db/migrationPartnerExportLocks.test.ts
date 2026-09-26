/**
 * Partner-export set-based migration writes require family-specific pre-locks:
 * #5360 device/site/material: partners shared, then orgs exclusive;
 * #5912 configuration (including normalized children): partners exclusive,
 * then orgs under exclusive partners. Both use the same scanner and reviewed
 * @partner-export-locks: pre-acquired <reason> exception, with separate frozen
 * offender baselines. Reviewers verify ordering and complete, sorted lock sets.
 */
import { describe, expect, it } from 'vitest';

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { analyzeMigrationDml } from './migrationRlsScope';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)`;
const TARGET = String.raw`(?:${IDENT}\s*\.\s*)?(${IDENT})`;
type LockAxis = 'partners_shared' | 'orgs_exclusive' |
  'partners_exclusive' | 'orgs_under_exclusive_partners';
type LockFamily = { triggerFunction: string; partners: LockAxis; orgs: LockAxis };
const MATERIAL_FUNCTION = String.raw`EXECUTE\s+FUNCTION\s+public\.breeze_partner_export_(?:device_child|site_child|material)_(?:insert|update|delete)\s*\(`;
const MATERIAL_FAMILY: LockFamily = {
  triggerFunction: MATERIAL_FUNCTION, partners: 'partners_shared', orgs: 'orgs_exclusive',
};
const CONFIGURATION_FAMILY: LockFamily = {
  triggerFunction: String.raw`EXECUTE\s+FUNCTION\s+public\.breeze_partner_export_(?:(?:configuration_owner|direct_org|policy_child|assignment|custom_values)_(?:insert|update|delete)|normalized_policy_child)\s*\(`,
  partners: 'partners_exclusive', orgs: 'orgs_under_exclusive_partners',
};
const normalize = (name: string) => name.replace(/"/g, '').toLowerCase();

/** Preserve offsets while removing comments; optionally mask literal contents.
 * Dollar bodies stay intact: analyzeMigrationDml decides whether they run now.
 */
function maskSql(sql: string, literals = false, comments?: string[]): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  let result = '';
  for (let i = 0; i < sql.length;) {
    const start = i;
    if (sql.startsWith('--', i)) {
      i = sql.indexOf('\n', i);
      if (i < 0) i = sql.length;
      comments?.push(sql.slice(start, i));
      result += blank(sql.slice(start, i));
    } else if (comments && sql[i] === '$' && /^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(sql.slice(i))) {
      // Annotation exceptions are file-level comments, never quoted payloads.
      const tag = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? sql.length : end + tag.length;
      result += blank(sql.slice(start, i));
    } else if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      result += blank(sql.slice(start, i));
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]!;
      const escaped = quote === "'" && /(?:^|[^a-z0-9_])e$/i.test(sql.slice(0, start));
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') { i += 2; continue; }
        if (sql[i++] === quote) {
          if (sql[i] === quote) { i++; continue; }
          break;
        }
      }
      const text = sql.slice(start, i);
      result += literals && quote === "'" ? blank(text) : text;
    } else result += sql[i++];
  }
  return result;
}

function deriveMaterialTables(migrations: readonly string[], family: LockFamily = MATERIAL_FAMILY): Set<string> {
  const tables = new Set<string>();
  for (const migration of migrations) {
    const sql = maskSql(migration);
    for (const loop of sql.matchAll(/\bFOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[([^\]]*)\]\s*LOOP\b([\s\S]*?)END\s+LOOP/gi)) {
      if (!new RegExp(String.raw`CREATE\s+TRIGGER\b[^;]*?${family.triggerFunction}`, 'i').test(loop[2]!)) continue;
      for (const table of loop[1]!.matchAll(/'([a-z_][a-z0-9_$]*)'/gi)) tables.add(normalize(table[1]!));
    }
    // Literal targets (including future EXECUTE strings with literal targets).
    const trigger = new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+${IDENT}\s+[^;]*?\bON\s+${TARGET}\s+[^;]*?${family.triggerFunction}`, 'gi');
    for (const match of sql.matchAll(trigger)) tables.add(normalize(match[1]!));
  }
  return tables;
}

/** Reuse the RLS analyzer's executable-code and transaction handling. Translate
 * one lock axis into its scope marker, disabling actual RLS scope elections.
 * Quoted examples and uncalled routine bodies remain non-executable to it.
 */
function withLockScope(sql: string, axis: LockAxis): string {
  const code = maskSql(sql, true);
  const scopeDisabled = sql.replace(/\bset_config\s*\(/gi, (match) => ' '.repeat(match.length));
  const pattern = new RegExp(String.raw`(?:public\s*\.\s*)?breeze_partner_export_lock_${axis}\s*\(`, 'gi');
  // Locate matches in masked SQL before introducing quoted scope arguments:
  // inserting quotes into a quoted example would turn its contents into code.
  let translated = scopeDisabled;
  for (const match of [...code.matchAll(pattern)].reverse()) {
    translated = translated.slice(0, match.index) + "set_config('breeze.scope', 'system', " +
      translated.slice(match.index + match[0].length);
  }
  return translated;
}

function findUnlockedWrites(sql: string, tables: ReadonlySet<string>, family: LockFamily = MATERIAL_FAMILY): string[] {
  // A reviewed file-level escape hatch must explain why locking is safe.
  const comments: string[] = [];
  maskSql(sql, false, comments);
  if (comments.some((comment) => /^--[ \t]*@partner-export-locks:[ \t]+pre-acquired[ \t]+\S[^\r\n]*$/.test(comment))) return [];
  const partners = analyzeMigrationDml(withLockScope(sql, family.partners));
  const orgs = analyzeMigrationDml(withLockScope(sql, family.orgs));
  const code = maskSql(sql, true);
  const lines = code.split('\n');
  const insertOrdinals = new Map<string, number>();
  return analyzeMigrationDml(sql).flatMap((write, index) => {
    if (!tables.has(write.table) || !['UPDATE', 'DELETE', 'INSERT', 'MERGE'].includes(write.kind)) return [];
    if (write.kind === 'INSERT') {
      // Confine SELECT detection to this INSERT's source, stopping at VALUES
      // (including scalar subqueries in VALUES) or the end of the statement.
      const tail = (write.dynamic ? maskSql(sql).split('\n') : lines).slice(write.line - 1).join('\n');
      const insert = new RegExp(String.raw`\bINSERT\s+INTO\s+${TARGET}`, 'gi');
      const candidates = [...tail.matchAll(insert)].filter((m) => normalize(m[1]!) === write.table);
      const key = `${write.line}:${write.table}`;
      const ordinal = insertOrdinals.get(key) ?? 0;
      insertOrdinals.set(key, ordinal + 1);
      const candidate = candidates[ordinal];
      if (!candidate) return [];
      const source = tail.slice(candidate.index + candidate[0].length).split(';')[0]!;
      if (!/\bSELECT\b/i.test(source.split(/\bVALUES\b/i)[0]!)) return [];
    }
    return partners[index]?.scoped && orgs[index]?.scoped ? [] : [`${write.kind} ${write.table}`];
  });
}

// Newest migration in the frozen baseline. Never raise this cutoff to exempt
// a new migration; acquire the locks or repair forward instead.
const BASELINE_CUTOFF = '2026-10-15-150600-network-baseline-recurring-authority.sql';

// Exact shipped offender set, computed for #5360. MUST NEVER GROW: repair
// forward or acquire both lock axes before writing; never exempt a new file.
const UNLOCKED_DML_BASELINE: readonly string[] = [
  '0016-be19-device-ip-history.sql',
  '0025-device-approval.sql',
  '2026-04-11-bucket-c-phase-1-inventory-rls.sql',
  '2026-06-29-topology-provenance.sql',
  '2026-08-20-discovered-asset-detection-source.sql',
  '2026-10-14-100100-discovered-assets-manual-source.sql',
  '2026-10-15-150600-network-baseline-recurring-authority.sql',
];

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((name) => /^\d{4}-.*\.sql$/.test(name))
  .sort((a, b) => a.localeCompare(b))
  .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8') }));
const materialTables = deriveMaterialTables(migrations.map(({ sql }) => sql));
const configurationTables = deriveMaterialTables(migrations.map(({ sql }) => sql), CONFIGURATION_FAMILY);

// Exact shipped offenders for #5912. MUST NEVER GROW or raise the cutoff.
const CONFIGURATION_BASELINE_CUTOFF = '2026-10-16-100300-scripts-origin.sql';
const CONFIGURATION_UNLOCKED_DML_BASELINE: readonly string[] = [
  '0058-device-role-classification.sql',
  '0068-fix-script-typo.sql',
  '0083-backup-mode-targets.sql',
  '2026-04-13-fix-uuid-hostnames.sql',
  '2026-06-13-catalog-partner-axis-rls.sql',
  '2026-06-27-c-default-update-ring-dedup.sql',
  '2026-07-29-breeze-p-normalize-s3-endpoints.sql',
  '2026-07-30-alert-rule-ownership-consolidation.sql',
  '2026-07-30-b-drop-never-firing-metric-alert-rules.sql',
  '2026-08-08-drop-custom-alert-conditions.sql',
  '2026-09-09-managed-triage-automation-backfill.sql',
  '2026-10-11-160000-device-custom-field-values.sql',
  '2026-10-11-160000-device-lifecycle-feature-and-decommissioned-at.sql',
  '2026-10-16-100300-scripts-origin.sql',
];

describe('partner export migration lock contract (#5360)', () => {
  it('derives the device and site material tables from shipped trigger loops', () => {
    expect(materialTables.size).toBeGreaterThan(0);
    for (const table of [
      'device_hardware', 'device_disks', 'device_network', 'device_ip_history',
      'software_inventory', 'device_warranty', 'hyperv_vms', 'device_memory_modules',
      'discovered_assets', 'network_baselines', 'network_topology',
    ]) expect(materialTables.has(table), table).toBe(true);
  });

  it('derives the exact configuration table set from both installation migrations', () => {
    const configurationMigrations = [
      '2026-07-24-partner-export-configuration-material-state.sql',
      '2026-07-25-partner-export-canonical-configuration.sql',
    ].map((name) => {
      const migration = migrations.find((file) => file.name === name);
      expect(migration, name).toBeDefined();
      return migration!.sql;
    });
    const expected = [
      'configuration_policies', 'scripts', 'automations', 'backup_profiles',
      'custom_field_definitions', 'backup_configs', 'backup_policies',
      'config_policy_feature_links', 'config_policy_assignments', 'devices',
      'config_policy_alert_rules', 'config_policy_automations', 'config_policy_compliance_rules',
      'config_policy_patch_settings', 'config_policy_maintenance_settings',
      'config_policy_event_log_settings', 'config_policy_sensitive_data_settings',
      'config_policy_monitoring_settings', 'config_policy_monitoring_watches',
      'config_policy_backup_settings',
      'config_policy_remote_access_settings', 'config_policy_onedrive_settings',
      'config_policy_onedrive_libraries',
    ];
    expect([...deriveMaterialTables(configurationMigrations, CONFIGURATION_FAMILY)].sort()).toEqual(expected.sort());
    for (const table of expected) expect(configurationTables.has(table), table).toBe(true);
  });

  it('freezes the baseline at the cutoff so a new migration cannot join it', () => {
    expect(UNLOCKED_DML_BASELINE.filter((name) => name.localeCompare(BASELINE_CUTOFF) > 0),
      'The #5360 baseline is frozen; never raise BASELINE_CUTOFF to exempt a new migration.',
    ).toEqual([]);
    expect(migrations.map(({ name }) => name)).toContain(BASELINE_CUTOFF);
  });

  it('permits exactly the frozen baseline of shipped offenders', () => {
    const offenders = migrations.flatMap(({ name, sql }) => {
      const writes = findUnlockedWrites(sql, materialTables);
      return writes.length ? [{ name, writes }] : [];
    });
    expect(offenders.map(({ name }) => name),
      `Partner-export writes without both pre-locks (#5360):\n${offenders
        .filter(({ name }) => !UNLOCKED_DML_BASELINE.includes(name))
        .map(({ name, writes }) => `${name}: ${writes.join(', ')}`).join('\n')}\n` +
      'Acquire partners shared, then orgs exclusive before the first write, or add a reviewed ' +
      '-- @partner-export-locks: pre-acquired <reason> line. The baseline MUST NEVER GROW.',
    ).toEqual(UNLOCKED_DML_BASELINE);
  });
});

describe('configuration export migration lock contract (#5912)', () => {
  it('freezes the configuration baseline at its own cutoff', () => {
    expect(CONFIGURATION_UNLOCKED_DML_BASELINE).toHaveLength(14); // Frozen with #5912; never raise.
    expect(CONFIGURATION_UNLOCKED_DML_BASELINE.filter((name) => name.localeCompare(CONFIGURATION_BASELINE_CUTOFF) > 0),
      'The #5912 baseline is frozen; never raise CONFIGURATION_BASELINE_CUTOFF to exempt a new migration.',
    ).toEqual([]);
    expect(migrations.map(({ name }) => name)).toContain(CONFIGURATION_BASELINE_CUTOFF);
  });

  it('permits exactly the frozen configuration baseline of shipped offenders', () => {
    const offenders = migrations.flatMap(({ name, sql }) => {
      const writes = findUnlockedWrites(sql, configurationTables, CONFIGURATION_FAMILY);
      return writes.length ? [{ name, writes }] : [];
    });
    expect(offenders.map(({ name }) => name),
      `Configuration-export writes without both pre-locks (#5912):\n${offenders
        .filter(({ name }) => !CONFIGURATION_UNLOCKED_DML_BASELINE.includes(name))
        .map(({ name, writes }) => `${name}: ${writes.join(', ')}`).join('\n')}\n` +
      'Acquire partners exclusive, then orgs under exclusive partners before the first write, or add a reviewed ' +
      '-- @partner-export-locks: pre-acquired <reason> line. The baseline MUST NEVER GROW.',
    ).toEqual(CONFIGURATION_UNLOCKED_DML_BASELINE);
  });
});

describe('partner export migration lock scanner', () => {
  it('rejects a synthetic configuration-policy UPDATE without pre-acquired locks', () => {
    expect(findUnlockedWrites('UPDATE configuration_policies SET name = name;', configurationTables, CONFIGURATION_FAMILY))
      .toEqual(['UPDATE configuration_policies']);
  });

  it('rejects a synthetic set-based write without pre-acquired locks', () => {
    const fixture = "UPDATE discovered_assets SET source = 'scan' WHERE source IS NULL;";
    expect(findUnlockedWrites(fixture, new Set(['discovered_assets']))).toEqual([
      'UPDATE discovered_assets',
    ]);
  });
});


describe('partner export lock scanner fixtures', () => {
  const tables = new Set(['discovered_assets']);
  const write = 'UPDATE discovered_assets SET source = NULL;';
  const partners = 'SELECT public.breeze_partner_export_lock_partners_shared(ARRAY[]::uuid[]);';
  const orgs = 'SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY[]::uuid[]);';
  const locks = `${partners}\n${orgs}\n`;
  const scan = (sql: string) => findUnlockedWrites(sql, tables);

  it.each([
    'UPDATE ONLY public."discovered_assets" AS d SET source = NULL;',
    'DELETE FROM ONLY public.discovered_assets WHERE id IS NOT NULL;',
    'INSERT INTO discovered_assets (id) SELECT id FROM scratch;',
    'WITH doomed AS (SELECT id FROM scratch) DELETE FROM discovered_assets USING doomed;',
    'WITH moved AS (INSERT INTO discovered_assets (id) SELECT id FROM scratch RETURNING id) SELECT 1;',
    'DO $$ BEGIN UPDATE discovered_assets SET source = NULL; END $$;',
    "DO $$ BEGIN EXECUTE 'INSERT INTO discovered_assets (id) SELECT id FROM scratch'; END $$;",
  ])('detects set-based DML: %s', (sql) => {
    expect(scan(sql)).toHaveLength(1);
    expect(scan(locks + sql)).toEqual([]);
  });

  const merge = 'MERGE INTO discovered_assets AS target USING scratch AS source ' +
    'ON target.id = source.id WHEN MATCHED THEN UPDATE SET source = NULL;';

  it('rejects MERGE without prior locks', () => {
    expect(scan(merge)).toEqual(['MERGE discovered_assets']);
  });

  it('accepts MERGE with both prior locks', () => {
    expect(scan(locks + merge)).toEqual([]);
  });

  it('requires both axes earlier, even on the same line', () => {
    expect(scan(partners + write)).toHaveLength(1);
    expect(scan(orgs + write)).toHaveLength(1);
    expect(scan(partners + write + orgs)).toHaveLength(1);
    expect(scan(write + locks)).toHaveLength(1);
    expect(scan(partners + orgs + write)).toEqual([]);
    expect(scan(`DO $$ BEGIN ${locks.replaceAll('SELECT public.', 'PERFORM public.')}${write} END $$;`)).toEqual([]);
  });

  it('does not confuse RLS scope, quoted examples or routine definitions with lock calls', () => {
    for (const prefix of [
      "SELECT set_config('breeze.scope', 'system', true);",
      `/* ${locks} */`,
      `-- ${partners}\n-- ${orgs}\n`,
      `COMMENT ON TABLE discovered_assets IS $$${locks}$$;`,
      `SELECT '${partners}'; SELECT '${orgs}';`,
      `CREATE FUNCTION f() RETURNS void AS $$ BEGIN ${locks} END $$ LANGUAGE plpgsql;`,
    ]) expect(scan(prefix + write)).toHaveLength(1);
  });

  it('requires a reason on the annotation', () => {
    expect(scan('-- @partner-export-locks: pre-acquired reviewed single-org backfill\n' + write)).toEqual([]);
    expect(scan('-- @partner-export-locks: pre-acquired\n' + write)).toHaveLength(1);
    const fake = '-- @partner-export-locks: pre-acquired fake';
    expect(scan(`/*\n${fake}\n*/\n${write}`)).toHaveLength(1);
    expect(scan(`SELECT $$\n${fake}\n$$;\n${write}`)).toHaveLength(1);
    expect(scan(`SELECT '\n${fake}\n';\n${write}`)).toHaveLength(1);
    expect(scan('-- @partner-export-locks: pre-acquired   \n' + write)).toHaveLength(1);
  });

  it('ignores VALUES inserts, unrelated tables, comments and non-DML keywords', () => {
    for (const sql of [
      "INSERT INTO discovered_assets (id) VALUES ('x'); SELECT 1;",
      'INSERT INTO discovered_assets (id) VALUES ((SELECT id FROM scratch LIMIT 1));',
      'UPDATE scratch SET id = NULL;',
      `/* nested /* comment */ ${write} */`,
      `-- ${write}`,
      `DO $$ BEGIN RAISE NOTICE '${write}'; END $$;`,
      'GRANT SELECT, INSERT, UPDATE, DELETE ON discovered_assets TO breeze_app;',
      'CREATE POLICY p ON discovered_assets FOR UPDATE USING (true);',
      'CREATE FUNCTION f() RETURNS void AS $$ BEGIN DELETE FROM discovered_assets; END $$ LANGUAGE plpgsql;',
    ]) expect(scan(sql)).toEqual([]);
  });

  it('separates multiple INSERTs on one line', () => {
    const values = 'INSERT INTO discovered_assets (id) VALUES (1);';
    const select = 'INSERT INTO discovered_assets (id) SELECT id FROM scratch;';
    expect(scan(values + select)).toEqual(['INSERT discovered_assets']);
    expect(scan(select + values)).toEqual(['INSERT discovered_assets']);
  });

  it('does not carry transaction-local locks between @no-transaction statements', () => {
    expect(scan('-- @no-transaction\n' + locks + write)).toHaveLength(1);
    expect(scan(`-- @no-transaction\nDO $$ BEGIN ${locks}${write} END $$;`)).toEqual([]);
  });

  it('derives both literal and loop-installed triggers and ignores unrelated loops', () => {
    const sql = `
      FOREACH t IN ARRAY ARRAY['one', 'two'] LOOP
        EXECUTE format('CREATE TRIGGER t AFTER UPDATE ON public.%I FOR EACH STATEMENT
          EXECUTE FUNCTION public.breeze_partner_export_device_child_update()', t);
      END LOOP;
      FOREACH t IN ARRAY ARRAY['unrelated'] LOOP RAISE NOTICE 'nothing'; END LOOP;
      CREATE TRIGGER "x" AFTER DELETE ON public."three" FOR EACH STATEMENT
        EXECUTE FUNCTION public.breeze_partner_export_material_delete();
      CREATE TRIGGER y AFTER INSERT ON four FOR EACH STATEMENT
        EXECUTE FUNCTION public.breeze_partner_export_site_child_insert();
      -- CREATE TRIGGER z AFTER UPDATE ON fake EXECUTE FUNCTION public.breeze_partner_export_material_update();
    `;
    expect([...deriveMaterialTables([sql])].sort()).toEqual(['four', 'one', 'three', 'two']);
    expect([...deriveMaterialTables(['-- no triggers'])]).toEqual([]);
  });

  it('keeps the incident file in the baseline and its pre-lock repair out', () => {
    const incident = '2026-10-14-100100-discovered-assets-manual-source.sql';
    const repair = '2026-10-14-100050-discovered-assets-source-backfill-prelock.sql';
    expect(UNLOCKED_DML_BASELINE).toContain(incident);
    expect(UNLOCKED_DML_BASELINE).not.toContain(repair);
    expect(scan(migrations.find(({ name }) => name === incident)!.sql)).toHaveLength(2);
    expect(scan(migrations.find(({ name }) => name === repair)!.sql)).toEqual([]);
    expect(UNLOCKED_DML_BASELINE).toHaveLength(7); // Frozen with #5360; never raise.
    for (const name of UNLOCKED_DML_BASELINE) expect(migrations.some((file) => file.name === name)).toBe(true);
  });
});


describe('configuration export lock scanner fixtures', () => {
  const partners = 'SELECT public.breeze_partner_export_lock_partners_exclusive(ARRAY[]::uuid[]);';
  const orgs = 'SELECT public.breeze_partner_export_lock_orgs_under_exclusive_partners(ARRAY[]::uuid[], ARRAY[]::uuid[]);';
  const locks = `${partners}\n${orgs}\n`;
  const write = 'UPDATE configuration_policies SET name = name;';
  const scan = (sql: string) => findUnlockedWrites(sql, configurationTables, CONFIGURATION_FAMILY);

  it.each([
    write,
    'DELETE FROM config_policy_assignments;',
    'INSERT INTO config_policy_feature_links (id) SELECT id FROM scratch;',
    'MERGE INTO scripts s USING scratch t ON s.id = t.id WHEN MATCHED THEN DELETE;',
    'DO $$ BEGIN UPDATE backup_profiles SET name = name; END $$;',
    "DO $$ BEGIN EXECUTE 'DELETE FROM automations'; END $$;",
    'UPDATE config_policy_monitoring_watches SET name = name;',
  ])('requires configuration locks for set-based DML: %s', (sql) => {
    expect(scan(sql)).toHaveLength(1);
    expect(scan(locks + sql)).toEqual([]);
  });

  it('requires its own complete helper pair before writing', () => {
    const shared = 'SELECT public.breeze_partner_export_lock_partners_shared(ARRAY[]::uuid[]);';
    const exclusiveOrgs = 'SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY[]::uuid[]);';
    for (const prefix of [partners, orgs, shared + exclusiveOrgs, shared + orgs, partners + exclusiveOrgs]) {
      expect(scan(prefix + write)).toHaveLength(1);
    }
    expect(scan(partners + write + orgs)).toHaveLength(1);
    expect(scan(write + locks)).toHaveLength(1);
    expect(scan(partners + orgs + write)).toEqual([]);
    expect(scan(`DO $$ BEGIN ${locks.replaceAll('SELECT public.', 'PERFORM public.')}${write} END $$;`)).toEqual([]);
    // The configuration pair must not satisfy the original material family.
    expect(findUnlockedWrites(locks + 'DELETE FROM discovered_assets;', materialTables)).toHaveLength(1);
  });

  it('requires executable calls in the same transaction', () => {
    for (const prefix of [
      "SELECT set_config('breeze.scope', 'system', true);",
      `/* ${locks} */`,
      `SELECT '${partners}'; SELECT '${orgs}';`,
      `CREATE FUNCTION f() RETURNS void AS $$ BEGIN ${locks} END $$ LANGUAGE plpgsql;`,
      '-- @no-transaction\n' + locks,
    ]) expect(scan(prefix + write)).toHaveLength(1);
    expect(scan(`-- @no-transaction\nDO $$ BEGIN ${locks}${write} END $$;`)).toEqual([]);
  });

  it('shares only reasoned file-level annotation exceptions', () => {
    expect(scan('-- @partner-export-locks: pre-acquired reviewed single-org backfill\n' + write)).toEqual([]);
    const fake = '-- @partner-export-locks: pre-acquired fake';
    for (const prefix of ['-- @partner-export-locks: pre-acquired   \n', `/*\n${fake}\n*/\n`, `SELECT $$\n${fake}\n$$;`]) {
      expect(scan(prefix + write)).toHaveLength(1);
    }
  });

  it('ignores VALUES inserts and unrelated writes', () => {
    expect(scan("INSERT INTO scripts (id) VALUES ('x'); UPDATE scratch SET id = NULL;")).toEqual([]);
  });

  it('derives literal and loop-installed configuration triggers without absorbing material triggers', () => {
    const sql = `
      FOREACH t IN ARRAY ARRAY['one', 'two'] LOOP
        EXECUTE format('CREATE TRIGGER t AFTER UPDATE ON %I FOR EACH STATEMENT
          EXECUTE FUNCTION public.breeze_partner_export_configuration_owner_update()', t);
      END LOOP;
      CREATE TRIGGER x AFTER UPDATE ON public."three" FOR EACH STATEMENT
        EXECUTE FUNCTION public.breeze_partner_export_custom_values_update();
      CREATE TRIGGER y AFTER DELETE ON four FOR EACH STATEMENT
        EXECUTE FUNCTION public.breeze_partner_export_normalized_policy_child();
      CREATE TRIGGER z AFTER UPDATE ON unrelated FOR EACH STATEMENT
        EXECUTE FUNCTION public.breeze_partner_export_material_update();
      -- CREATE TRIGGER z AFTER UPDATE ON fake EXECUTE FUNCTION public.breeze_partner_export_assignment_update();
    `;
    expect([...deriveMaterialTables([sql], CONFIGURATION_FAMILY)].sort()).toEqual(['four', 'one', 'three', 'two']);
  });
});

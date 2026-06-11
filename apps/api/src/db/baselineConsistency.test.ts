import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseMigrationNumber,
  isLegacyRangeMigration,
  extractTrackedAlters,
  parseBaselineTables,
  checkAlterAgainstBaseline,
  REMEDIATED_LEGACY_GAPS,
  type BaselineSchema,
  type BaselineColumn,
} from './baselineConsistency';

describe('baselineConsistency', () => {
  describe('parseMigrationNumber', () => {
    it('extracts the numeric prefix of a legacy migration', () => {
      expect(parseMigrationNumber('0040-software-policy-scope-deprecation.sql')).toBe(40);
    });

    it('extracts 1 from the baseline filename', () => {
      expect(parseMigrationNumber('0001-baseline.sql')).toBe(1);
    });

    it('parses a date-prefixed migration as its leading year', () => {
      expect(parseMigrationNumber('2026-05-21-software-policies-target-type-nullable.sql')).toBe(2026);
    });

    it('returns null when there is no numeric prefix', () => {
      expect(parseMigrationNumber('optional-timescale.sql')).toBeNull();
    });
  });

  describe('isLegacyRangeMigration', () => {
    it('is true for a migration inside the 2-65 legacy range', () => {
      expect(isLegacyRangeMigration('0040-software-policy-scope-deprecation.sql')).toBe(true);
    });

    it('is false for the baseline itself (number 1)', () => {
      expect(isLegacyRangeMigration('0001-baseline.sql')).toBe(false);
    });

    it('is false for a post-cutoff numbered migration', () => {
      expect(isLegacyRangeMigration('0066-fix-search-vector-fresh-install.sql')).toBe(false);
    });

    it('is false for a date-prefixed migration', () => {
      expect(isLegacyRangeMigration('2026-05-21-software-policies-target-type-nullable.sql')).toBe(false);
    });
  });

  describe('extractTrackedAlters', () => {
    it('extracts a DROP NOT NULL', () => {
      expect(extractTrackedAlters('ALTER TABLE software_policies ALTER COLUMN target_type DROP NOT NULL;')).toEqual([
        { kind: 'drop-not-null', table: 'software_policies', column: 'target_type' },
      ]);
    });

    it('extracts a SET NOT NULL', () => {
      expect(extractTrackedAlters('ALTER TABLE backups ALTER COLUMN device_id SET NOT NULL;')).toEqual([
        { kind: 'set-not-null', table: 'backups', column: 'device_id' },
      ]);
    });

    it('extracts a TYPE change with its new type', () => {
      expect(extractTrackedAlters('ALTER TABLE foo ALTER COLUMN bar TYPE text;')).toEqual([
        { kind: 'type', table: 'foo', column: 'bar', newType: 'text' },
      ]);
    });

    it('captures a parameterized new type', () => {
      expect(extractTrackedAlters('ALTER TABLE foo ALTER COLUMN bar SET DATA TYPE character varying(100);')).toEqual([
        { kind: 'type', table: 'foo', column: 'bar', newType: 'character varying(100)' },
      ]);
    });

    it('extracts a DROP COLUMN, tolerating IF EXISTS', () => {
      expect(extractTrackedAlters('ALTER TABLE foo DROP COLUMN IF EXISTS legacy_col;')).toEqual([
        { kind: 'drop-column', table: 'foo', column: 'legacy_col' },
      ]);
    });

    it('extracts a RENAME COLUMN with the new name', () => {
      expect(extractTrackedAlters('ALTER TABLE foo RENAME COLUMN old_name TO new_name;')).toEqual([
        { kind: 'rename-column', table: 'foo', column: 'old_name', newColumn: 'new_name' },
      ]);
    });

    it('handles the ALTER TABLE ONLY and public. qualifiers', () => {
      expect(extractTrackedAlters('ALTER TABLE ONLY public.devices ALTER COLUMN org_id DROP NOT NULL;')).toEqual([
        { kind: 'drop-not-null', table: 'devices', column: 'org_id' },
      ]);
    });

    it('ignores ADD COLUMN (caught by drift detection, out of scope)', () => {
      expect(extractTrackedAlters('ALTER TABLE foo ADD COLUMN IF NOT EXISTS bar text;')).toEqual([]);
    });

    it('ignores tracked statements that appear only inside a SQL comment', () => {
      expect(extractTrackedAlters('-- ALTER TABLE foo ALTER COLUMN bar DROP NOT NULL;\nSELECT 1;')).toEqual([]);
    });

    it('is case-insensitive on keywords', () => {
      expect(extractTrackedAlters('alter table foo alter column bar drop not null;')).toEqual([
        { kind: 'drop-not-null', table: 'foo', column: 'bar' },
      ]);
    });

    it('extracts multiple statements from one migration', () => {
      const sql = `
        ALTER TABLE a ALTER COLUMN x DROP NOT NULL;
        ALTER TABLE b DROP COLUMN y;
      `;
      expect(extractTrackedAlters(sql)).toEqual([
        { kind: 'drop-not-null', table: 'a', column: 'x' },
        { kind: 'drop-column', table: 'b', column: 'y' },
      ]);
    });

    it('parses the real 0040 migration to exactly one drop-not-null', () => {
      const sql = [
        '-- Software policies are now pure templates (rules + enforcement only).',
        '-- Device targeting is handled exclusively through Configuration Policy assignments.',
        '-- Make target_type nullable since new policies no longer set it.',
        'ALTER TABLE software_policies ALTER COLUMN target_type DROP NOT NULL;',
      ].join('\n');
      expect(extractTrackedAlters(sql)).toEqual([
        { kind: 'drop-not-null', table: 'software_policies', column: 'target_type' },
      ]);
    });
  });

  describe('parseBaselineTables', () => {
    const sample = `
CREATE TABLE IF NOT EXISTS public.widgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(50) NOT NULL,
    note text,
    count integer DEFAULT 0 NOT NULL,
    CONSTRAINT widgets_count_check CHECK ((count >= 0))
);

CREATE TABLE public.gadgets (
    id uuid NOT NULL,
    label text
);
`;

    it('parses every table in the baseline', () => {
      const schema = parseBaselineTables(sample);
      expect([...schema.keys()].sort()).toEqual(['gadgets', 'widgets']);
    });

    it('records each column type without the DEFAULT clause', () => {
      const widgets = parseBaselineTables(sample).get('widgets');
      expect(widgets?.get('id')?.type).toBe('uuid');
      expect(widgets?.get('name')?.type).toBe('character varying(50)');
      expect(widgets?.get('count')?.type).toBe('integer');
    });

    it('records the NOT NULL flag per column', () => {
      const widgets = parseBaselineTables(sample).get('widgets');
      expect(widgets?.get('id')?.notNull).toBe(true);
      expect(widgets?.get('name')?.notNull).toBe(true);
      expect(widgets?.get('note')?.notNull).toBe(false);
      expect(widgets?.get('count')?.notNull).toBe(true);
    });

    it('skips table-level constraint lines', () => {
      const widgets = parseBaselineTables(sample).get('widgets');
      expect(widgets?.has('CONSTRAINT')).toBe(false);
      expect([...(widgets?.keys() ?? [])].sort()).toEqual(['count', 'id', 'name', 'note']);
    });
  });

  describe('checkAlterAgainstBaseline', () => {
    const baseline: BaselineSchema = new Map<string, Map<string, BaselineColumn>>([
      [
        'software_policies',
        new Map<string, BaselineColumn>([
          ['target_type', { type: 'character varying(50)', notNull: true }],
          ['name', { type: 'text', notNull: true }],
        ]),
      ],
      ['audit_logs', new Map<string, BaselineColumn>([['org_id', { type: 'uuid', notNull: false }]])],
    ]);

    it('reports a DROP NOT NULL as unsatisfied when the baseline still has NOT NULL', () => {
      const result = checkAlterAgainstBaseline(
        { kind: 'drop-not-null', table: 'software_policies', column: 'target_type' },
        baseline,
      );
      expect(result.satisfied).toBe(false);
    });

    it('reports a DROP NOT NULL as satisfied when the baseline column is already nullable', () => {
      const result = checkAlterAgainstBaseline(
        { kind: 'drop-not-null', table: 'audit_logs', column: 'org_id' },
        baseline,
      );
      expect(result.satisfied).toBe(true);
    });

    it('reports a SET NOT NULL as satisfied when the baseline column is NOT NULL', () => {
      const result = checkAlterAgainstBaseline(
        { kind: 'set-not-null', table: 'software_policies', column: 'name' },
        baseline,
      );
      expect(result.satisfied).toBe(true);
    });

    it('reports a SET NOT NULL as unsatisfied when the baseline column is nullable', () => {
      const result = checkAlterAgainstBaseline(
        { kind: 'set-not-null', table: 'audit_logs', column: 'org_id' },
        baseline,
      );
      expect(result.satisfied).toBe(false);
    });

    it('reports a TYPE change as satisfied when the baseline type matches', () => {
      const result = checkAlterAgainstBaseline(
        { kind: 'type', table: 'software_policies', column: 'name', newType: 'text' },
        baseline,
      );
      expect(result.satisfied).toBe(true);
    });

    it('reports a TYPE change as unsatisfied when the baseline type differs', () => {
      const result = checkAlterAgainstBaseline(
        { kind: 'type', table: 'software_policies', column: 'name', newType: 'jsonb' },
        baseline,
      );
      expect(result.satisfied).toBe(false);
    });

    it('reports a DROP COLUMN as unsatisfied when the column still exists in the baseline', () => {
      const result = checkAlterAgainstBaseline(
        { kind: 'drop-column', table: 'software_policies', column: 'name' },
        baseline,
      );
      expect(result.satisfied).toBe(false);
    });

    it('reports a DROP COLUMN as satisfied when the column is absent from the baseline', () => {
      const result = checkAlterAgainstBaseline(
        { kind: 'drop-column', table: 'software_policies', column: 'removed_col' },
        baseline,
      );
      expect(result.satisfied).toBe(true);
    });

    it('reports a RENAME COLUMN as satisfied when only the new name is present', () => {
      const result = checkAlterAgainstBaseline(
        { kind: 'rename-column', table: 'software_policies', column: 'old_name', newColumn: 'name' },
        baseline,
      );
      expect(result.satisfied).toBe(true);
    });

    it('reports a RENAME COLUMN as unsatisfied when the old name is still present', () => {
      const result = checkAlterAgainstBaseline(
        { kind: 'rename-column', table: 'software_policies', column: 'name', newColumn: 'name_v2' },
        baseline,
      );
      expect(result.satisfied).toBe(false);
    });
  });

  // ── The guard itself ──────────────────────────────────────────────────────
  // Every schema-shape mutation made by a legacy-range migration (2-65) must be
  // reflected in 0001-baseline.sql, because autoMigrate marks 2-65 as applied
  // WITHOUT running their SQL on fresh installs. A gap here means the schema
  // silently diverges. See issue #817.
  describe('legacy migrations are consistent with the consolidated baseline', () => {
    const migrationsDir = path.resolve(__dirname, '../../migrations');
    const baseline = parseBaselineTables(
      readFileSync(path.join(migrationsDir, '0001-baseline.sql'), 'utf8'),
    );

    const legacyFiles = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql') && isLegacyRangeMigration(f))
      .sort();

    it('finds the full legacy migration range', () => {
      expect(legacyFiles.length).toBeGreaterThan(50);
    });

    it('every legacy schema mutation is reflected in the baseline (or explicitly remediated)', () => {
      const gaps: string[] = [];

      for (const file of legacyFiles) {
        const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
        for (const alter of extractTrackedAlters(sql)) {
          const result = checkAlterAgainstBaseline(alter, baseline);
          if (result.satisfied) continue;
          if (REMEDIATED_LEGACY_GAPS[file]) continue;
          gaps.push(`  ${file}: ${alter.kind} ${alter.table}.${alter.column} — ${result.detail}`);
        }
      }

      expect(
        gaps,
        gaps.length === 0
          ? ''
          : `Legacy migration(s) mutate the schema in a way 0001-baseline.sql does not reflect.\n` +
              `On fresh installs these are marked applied but never run, so the effect is lost.\n` +
              `Fix: re-run the effect in a new dated migration and add the file to REMEDIATED_LEGACY_GAPS,\n` +
              `or correct 0001-baseline.sql if it can be regenerated.\n\n${gaps.join('\n')}`,
      ).toEqual([]);
    });

    it('every REMEDIATED_LEGACY_GAPS entry names a real legacy migration file', () => {
      for (const file of Object.keys(REMEDIATED_LEGACY_GAPS)) {
        expect(legacyFiles, `${file} is allowlisted but not a legacy-range migration`).toContain(file);
      }
    });
  });
});

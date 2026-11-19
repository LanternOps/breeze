import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { configPolicyMaintenanceSettings } from './schema/configurationPolicies';

// #9574: maintenance windows choose the weekday / day of month they open on.
const migrationPath = resolve(__dirname, '../../migrations/2027-01-28-100000-maintenance-window-day.sql');
const authoritativePath = resolve(__dirname, '../../migrations/2027-01-16-200000-event-log-application-providers.sql');

describe('maintenance window day migration', () => {
  it('adds non-null, defaulted day columns to the Drizzle schema', () => {
    const columns = getTableColumns(configPolicyMaintenanceSettings);
    expect(columns.dayOfWeek.notNull).toBe(true);
    expect(columns.dayOfWeek.default).toBe('sun');
    expect(columns.dayOfMonth.notNull).toBe(true);
    expect(columns.dayOfMonth.default).toBe(1);
  });

  it('declares both CHECK constraints in Drizzle to match the migration', () => {
    expect(getTableConfig(configPolicyMaintenanceSettings).checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'config_policy_maintenance_settings_day_of_week_check',
        'config_policy_maintenance_settings_day_of_month_check',
      ]),
    );
  });

  it('adds the columns with defaults that preserve the pre-#9574 days, idempotently', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS day_of_week varchar\(3\) NOT NULL DEFAULT 'sun'/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS day_of_month integer NOT NULL DEFAULT 1/);
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS config_policy_maintenance_settings_day_of_week_check');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS config_policy_maintenance_settings_day_of_month_check');
    expect(migration).toContain("CHECK (day_of_week IN ('sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'))");
    expect(migration).toContain('CHECK (day_of_month BETWEEN 1 AND 31)');
  });

  it('copies the full authoritative export function and grants with only the new maintenance pair', () => {
    const previous = readFileSync(authoritativePath, 'utf8');
    const migration = readFileSync(migrationPath, 'utf8');
    const body = (sql: string) => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.'));
    expect(body(migration)).toContain("'dayOfWeek', day_of_week, 'dayOfMonth', day_of_month");
    expect(body(migration).replace("        'dayOfWeek', day_of_week, 'dayOfMonth', day_of_month,\n", '')).toBe(body(previous));
  });
});

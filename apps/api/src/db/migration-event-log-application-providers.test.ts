import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { configPolicyEventLogSettings } from './schema/configurationPolicies';

const migrationPath = resolve(__dirname, '../../migrations/2027-01-16-200000-event-log-application-providers.sql');
const authoritativePath = resolve(__dirname, '../../migrations/2027-01-09-120000-remote-access-allow-user-end-session.sql');

describe('event-log Application providers migration', () => {
  it('adds the non-null text array to the Drizzle schema', () => {
    expect(getTableColumns(configPolicyEventLogSettings)).toHaveProperty('applicationProviders');
    const column = getTableColumns(configPolicyEventLogSettings).applicationProviders;
    expect(column.notNull).toBe(true);
    expect(column.hasDefault).toBe(true);
  });

  it('declares the max-length check in Drizzle to match the migration', () => {
    expect(getTableConfig(configPolicyEventLogSettings).checks.map((check) => check.name))
      .toContain('config_policy_event_log_settings_app_providers_max');
  });

  it('adds the column and max-length constraint idempotently', () => {
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS application_providers text\[\] NOT NULL DEFAULT '\{\}'::text\[\]/);
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS config_policy_event_log_settings_app_providers_max');
    expect(migration).toContain('CHECK (cardinality(application_providers) <= 20)');
  });

  it('copies the full authoritative export function and grants with only the new event-log pair', () => {
    const previous = readFileSync(authoritativePath, 'utf8');
    const migration = readFileSync(migrationPath, 'utf8');
    const body = (sql: string) => sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.'));
    expect(body(migration).replace("        'applicationProviders', application_providers,\n", '')).toBe(body(previous));
  });
});

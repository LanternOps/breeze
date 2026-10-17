import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

// Spec §1.1: a new integration is not finished until it registers a health
// source. Every *_integrations / *_connections table needs a source or a
// written exemption.
vi.mock('../../../db', () => ({ db: {} }));

import * as schema from '../../../db/schema';
import { HEALTH_SOURCES, SOURCE_COVERAGE_EXEMPTIONS } from './index';
import { CONNECTION_SOURCE_KINDS } from '../types';

const CONNECTION_TABLE_RE = /_(integrations|connections)$/;

const connectionTables = [...new Set(
  Object.values(schema).filter((v) => is(v, PgTable)).map((t) => getTableName(t as PgTable)),
)].filter((name) => CONNECTION_TABLE_RE.test(name)).sort();

describe('connection health source coverage (spec §1.1)', () => {
  it('finds the connection tables (guards against an empty schema scan)', () => {
    expect(connectionTables).toContain('huntress_integrations');
    expect(connectionTables).toContain('m365_connections');
  });

  it('every connection table has a source or an exemption with a reason', () => {
    const covered = new Set(HEALTH_SOURCES.flatMap((s) => s.tables));
    const missing = connectionTables.filter((t) => !covered.has(t) && !SOURCE_COVERAGE_EXEMPTIONS[t]?.trim());
    expect(missing, `register a HealthSource or add an exemption for: ${missing.join(', ')}`).toEqual([]);
  });

  it('no table is both covered and exempt, and every exemption names a real table', () => {
    const covered = new Set(HEALTH_SOURCES.flatMap((s) => s.tables));
    for (const table of Object.keys(SOURCE_COVERAGE_EXEMPTIONS)) {
      expect(covered.has(table), `${table} is covered and exempt`).toBe(false);
      expect(connectionTables, `exemption for unknown table ${table}`).toContain(table);
    }
  });

  it('registers exactly one source per declared kind', () => {
    expect(HEALTH_SOURCES.map((s) => s.kind).sort()).toEqual([...CONNECTION_SOURCE_KINDS].sort());
  });

  it('every interval is a positive multiple of 15 (spec §1.3)', () => {
    for (const s of HEALTH_SOURCES) expect(s.intervalMinutes > 0 && s.intervalMinutes % 15 === 0, s.kind).toBe(true);
  });
});

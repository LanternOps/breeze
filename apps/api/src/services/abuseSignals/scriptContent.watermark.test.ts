import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withHostTimeZone } from '../../testUtils/hostTimeZone';

const executeMock = vi.hoisted(() => vi.fn());
vi.mock('../../db', () => ({ db: { execute: executeMock } }));
vi.mock('../../db/schema', () => ({ abuseScriptHosts: {} }));

import { loadScriptFindings } from './scriptContent';

const dialect = new PgDialect();
const render = (q: unknown) =>
  typeof q === 'object' && q !== null && 'queryChunks' in q
    ? dialect.sqlToQuery(q as never)
    : { sql: '', params: [] as unknown[] };

describe('loadScriptFindings watermark', () => {
  beforeEach(() => executeMock.mockReset());

  it.each(['America/Denver', 'Asia/Tokyo'] as const)(
    'bounds and persists the execution watermark at the true instant on a %s host',
    async (zone) => {
      const issued: Array<{ sql: string; params: unknown[] }> = [];
      executeMock.mockImplementation(async (q: unknown) => {
        const r = render(q);
        issued.push(r);
        // offsetless `timestamp` text from a raw query; read as UTC
        if (r.sql.includes('max(created_at) AS upper_bound')) return [{ upper_bound: '2026-08-25 18:34:15.123' }];
        return [];
      });
      await withHostTimeZone(zone, async () => {
        await loadScriptFindings(new Date('2026-08-26T00:00:00Z'));
      });
      const scan = issued.find((c) => c.sql.includes('se.created_at <='));
      expect(scan?.params).toContain('2026-08-25T18:34:15.123Z');
      const persisted = issued.find((c) => c.sql.includes('INSERT INTO abuse_sweep_state'));
      expect(JSON.parse(String(persisted?.params[1]))).toEqual({
        lastExecutionCreatedAt: '2026-08-25T18:34:15.123Z',
      });
    },
  );
});

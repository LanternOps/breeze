import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { activeBaselineIdSql, reliabilityProvisionalSql } from './reliabilityBaselineQueries';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q);

describe('reliabilityBaselineQueries', () => {
  it('picks the active marker with the canonical ordering', () => {
    const { sql, params } = render(activeBaselineIdSql('dev-1'));
    expect(sql.toLowerCase()).toContain('cleared_at" is null');
    expect(sql.replace(/\s+/g, ' ')).toMatch(/order by .*baseline_at" desc, .*created_at" desc, .*"id" desc limit 1/i);
    expect(params).toContain('dev-1');
  });
  it('reads provisional from details.baseline, defaulting to false', () => {
    const { sql } = render(reliabilityProvisionalSql);
    expect(sql).toContain(`->'baseline'->>'provisional'`);
    expect(sql.toLowerCase()).toContain('coalesce');
  });
});

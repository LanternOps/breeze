import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { scriptLastRunAtSql } from './scriptLastRun';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';

function render(...args: Parameters<typeof scriptLastRunAtSql>) {
  return new PgDialect().sqlToQuery(scriptLastRunAtSql(...args));
}

describe('scriptLastRunAtSql (#9563)', () => {
  it('correlates on the outer scripts row, spelled with the table name', () => {
    const { sql } = render({ kind: 'orgs', orgIds: [ORG_A] }, undefined);
    expect(sql).toContain('se.script_id = "scripts"."id"');
    expect(sql).toMatch(/max\(se\.created_at\)/);
  });

  it('a single org binds one equality parameter', () => {
    expect(render({ kind: 'orgs', orgIds: [ORG_A] }, undefined)).toMatchObject({
      sql: expect.stringContaining('se.org_id = $1'),
      params: [ORG_A],
    });
  });

  it('several orgs bind an IN list', () => {
    expect(render({ kind: 'orgs', orgIds: [ORG_A, ORG_B] }, undefined)).toMatchObject({
      sql: expect.stringContaining('se.org_id IN ($1, $2)'),
      params: [ORG_A, ORG_B],
    });
  });

  it('system scope with no org filter adds no org predicate', () => {
    const { sql, params } = render({ kind: 'all' }, undefined);
    expect(sql).not.toContain('org_id');
    expect(params).toEqual([]);
  });

  it('a site restriction joins the execution device to the allowed sites', () => {
    const { sql, params } = render({ kind: 'orgs', orgIds: [ORG_A] }, [SITE]);
    expect(sql).toContain('d.id = se.device_id AND d.site_id IN ($2)');
    expect(params).toEqual([ORG_A, SITE]);
  });

  it('keeps site params after org params when both are lists', () => {
    const SITE_2 = '44444444-4444-4444-8444-444444444444';
    const { sql, params } = render({ kind: 'orgs', orgIds: [ORG_A, ORG_B] }, [SITE, SITE_2]);
    expect(sql).toContain('se.org_id IN ($1, $2)');
    expect(sql).toContain('d.site_id IN ($3, $4)');
    expect(params).toEqual([ORG_A, ORG_B, SITE, SITE_2]);
  });

  it.each([
    ['no visible orgs', { kind: 'orgs', orgIds: [] } as const, undefined],
    ['no allowed sites', { kind: 'orgs', orgIds: [ORG_A] } as const, [] as string[]],
    ['system scope with no allowed sites', { kind: 'all' } as const, [] as string[]],
  ])('%s yields NULL without reading script_executions', (_label, scope, sites) => {
    const { sql, params } = render(scope, sites);
    expect(sql).toBe('NULL::timestamp');
    expect(params).toEqual([]);
  });
});

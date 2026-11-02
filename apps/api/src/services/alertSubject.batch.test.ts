import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../db', () => ({ db: { select: mocks.select } }));
import { enrichAlertSubjects } from './alertSubject';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let predicates: unknown[];
let results: unknown[][];
beforeEach(() => {
  vi.clearAllMocks();
  predicates = [];
  results = [];
  mocks.select.mockImplementation(() => {
    const chain = {
      from: () => chain,
      leftJoin: () => chain,
      where: (condition: unknown) => { predicates.push(condition); return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve),
    };
    return chain;
  });
});

describe('alert subject batch query bounds', () => {
  it('binds each workload reference and organization once across historical alerts', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => ({
      orgId: index % 2 ? ORG : OTHER, ownerKind: 'backup_workload' as const,
      ownerRef: index % 3 ? 'w1' : 'malformed-workload-ref',
    }));
    // Deliberately over-return a row to prove the org/reference pair is checked after the batch read.
    results = [[{ id: 'w1', orgId: OTHER, dataSources: ['m365_mail'], customerName: 'Other customer' }]];
    const enriched = await enrichAlertSubjects(rows);
    const predicate = new PgDialect().sqlToQuery(predicates[0] as never);
    expect(predicate.params).toHaveLength(4);
    expect(new Set(predicate.params)).toEqual(new Set([ORG, OTHER, 'w1', 'malformed-workload-ref']));
    expect(predicate.sql).toContain('"backup_provider_devices"."id"::text in');
    expect(predicate.sql).toContain('"backup_provider_devices"."org_id" in');
    expect(enriched.find(row => row.orgId === ORG && row.ownerRef === 'w1')?.subjectName).toBe('SaaS backup');
    expect(enriched.find(row => row.orgId === OTHER && row.ownerRef === 'w1')?.subjectName).toContain('Other customer');
  });

  it('deduplicates topology site IDs and organizations in its batch predicate', async () => {
    await enrichAlertSubjects(Array.from({ length: 1000 }, () => ({
      orgId: ORG, ownerKind: 'topology_site' as const, topologySiteId: 'site-1',
    })));
    const predicate = new PgDialect().sqlToQuery(predicates[0] as never);
    expect(predicate.params).toEqual(['site-1', ORG]);
  });
});

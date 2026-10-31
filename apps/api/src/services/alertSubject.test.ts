import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../db', () => ({ db: { select: mocks.select } }));
import { enrichAlertSubjects } from './alertSubject';
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const queries: { where?: unknown; joins: unknown[] }[] = [];
let results: unknown[][];
beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  results = [];
  mocks.select.mockImplementation(() => {
    const query = { joins: [] as unknown[], where: undefined as unknown };
    queries.push(query);
    const chain = {
      from: () => chain,
      leftJoin: (_table: unknown, condition: unknown) => { query.joins.push(condition); return chain; },
      where: (condition: unknown) => { query.where = condition; return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve),
    };
    return chain;
  });
});
describe('enrichAlertSubjects', () => {
  it('pins workload and customer reads to the alert organization', async () => {
    results.push([{ id: 'w1', orgId: ORG, dataSources: ['m365_mail'], customerName: 'Example customer' }]);
    const [row] = await enrichAlertSubjects([{ orgId: ORG, ownerKind: 'backup_workload', ownerRef: 'w1', deviceId: null }]);
    expect(row?.subjectName).toBe('Microsoft 365 mail backup · Example customer');
    const dialect = new PgDialect();
    const predicate = dialect.sqlToQuery(queries[0]?.where as never);
    expect(predicate.sql).toContain('"backup_provider_devices"."org_id" =');
    expect(predicate.sql).toContain('"backup_provider_devices"."id"::text =');
    expect(predicate.params).toEqual([ORG, 'w1']);
    const join = dialect.sqlToQuery(queries[0]?.joins[0] as never).sql;
    expect(join).toContain('"backup_provider_customers"."org_id" = "backup_provider_devices"."org_id"');
    expect(join).toContain('"backup_provider_customers"."connection_id" = "backup_provider_devices"."connection_id"');
  });
  it('does not attribute a foreign workload even under system context', async () => {
    results.push([{ id: 'w1', orgId: OTHER, customerName: 'Foreign customer', dataSources: ['m365_mail'] }]);
    const [row] = await enrichAlertSubjects([{ orgId: ORG, ownerKind: 'backup_workload', ownerRef: 'w1', orgName: 'Example organization' }]);
    expect(row?.subjectName).toBe('SaaS backup · Example organization');
  });
  it('keeps devices query-free and uses the owning site for topology', async () => {
    expect((await enrichAlertSubjects([{ orgId: ORG, deviceName: 'Server', deviceId: 'd1' }]))[0]?.subjectName).toBe('Server');
    expect(mocks.select).not.toHaveBeenCalled();
    results.push([{ id: 's1', orgId: ORG, name: 'Branch' }]);
    const [site] = await enrichAlertSubjects([{ orgId: ORG, ownerKind: 'topology_site', topologySiteId: 's1', deviceId: 'd1' }]);
    expect(site?.subjectName).toBe('Branch');
  });
});

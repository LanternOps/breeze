import { expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { resolveLegacyBaseline, resolveDeviceIdsForPolicy, type DbExecutor } from './legacyBaseline';
function fixture(results: unknown[][]) {
  const predicates: any[] = [];
  function query() {
    const result = results.shift() ?? [];
    const c: any = { then: (yes: any, no: any) => Promise.resolve(result).then(yes, no) };
    for (const name of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
      c[name] = (...args: unknown[]) => {
        if (name === 'where') predicates.push(args[0]);
        if (name.endsWith('Join')) predicates.push(args[1]);
        return c;
      };
    }
    return c;
  }
  return { executor: { select: query, selectDistinct: query } as unknown as DbExecutor, predicates };
}
const device = { id: 'd', orgId: 'o', siteId: 's', deviceRole: 'server', osType: 'windows' };
it('empty rule links fall through to the closest assignment with normalized rules', async () => {
  const f = fixture([[device], [{ partnerId: 'p' }], [], [
    { rule: { id: 'parent-rule' }, assignmentId: 'parent', level: 'organization', priority: 0, createdAt: new Date(0) },
  ], []]);
  expect((await resolveLegacyBaseline('d', f.executor)).rules.map((r) => r.id)).toEqual(['parent-rule']);
  expect(f.predicates.map((p) => new PgDialect().sqlToQuery(p).sql).join(' ')).toContain('"retired_at" is null');
});
it('an empty enabled-watch set clears watches rather than selecting the next policy', async () => {
  const f = fixture([[device], [{ partnerId: 'p' }], [], [], [
    { settingsId: 'parent', level: 'organization', priority: 0, checkIntervalSeconds: 60 },
    { settingsId: 'child', level: 'site', priority: 0, checkIntervalSeconds: 30 },
  ], []]);
  expect((await resolveLegacyBaseline('d', f.executor)).monitoring).toEqual({ settingsId: 'child', checkIntervalSeconds: 30, watches: [] });
  expect(new PgDialect().sqlToQuery(f.predicates.at(-1)).params).toEqual(['child', true]);
});
it('scope follows effective-link consumers and role/OS filters', async () => {
  const f = fixture([[{ id: 'child-device' }]]);
  expect(await resolveDeviceIdsForPolicy('unassigned-parent', f.executor)).toEqual(['child-device']);
  const text = f.predicates.map((p) => new PgDialect().sqlToQuery(p).sql).join(' ');
  for (const column of ['source_policy_id', 'role_filter', 'os_filter', 'partner_id']) expect(text).toContain(column);
});

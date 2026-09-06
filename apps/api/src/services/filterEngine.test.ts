import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { FilterCondition, FilterConditionGroup } from '@breeze/shared/types/filters';

// Capture SQL run inside the filter executors' bounded transaction. Hoisted so
// the vi.mock factory and the tests share the same array.
const dbMock = vi.hoisted(() => ({
  executed: [] as unknown[],
  events: [] as Array<'execute' | 'query'>,
  queryError: undefined as Error | undefined,
}));
vi.mock('../db', () => {
  // A chainable, awaitable stub for the drizzle query builder. Every builder
  // step returns the same object; awaiting it resolves to an empty row set.
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'leftJoin', 'orderBy']) chain[m] = () => chain;
  (chain as { then: unknown }).then = (
    resolve: (rows: unknown[]) => unknown,
    reject: (error: Error) => unknown,
  ) => {
    const error = dbMock.queryError;
    dbMock.queryError = undefined;
    return error ? reject(error) : resolve([]);
  };
  const tx: Record<string, unknown> = {
    execute: async (q: unknown) => {
      dbMock.executed.push(q);
      dbMock.events.push('execute');
      return [{ value: '2s' }];
    },
    select: () => {
      dbMock.events.push('query');
      return chain;
    },
  };
  tx.transaction = async (cb: (t: typeof tx) => unknown) => cb(tx);
  return { db: { transaction: async (cb: (t: typeof tx) => unknown) => cb(tx) } };
});

import {
  buildConditionSQL,
  validateFilter,
  getFieldDefinition,
  escapeLikePattern,
  evaluateFilter,
  evaluateFilterWithPreview,
  deviceMatchesFilter,
} from './filterEngine';

describe('filterEngine input hardening (#1044)', () => {
  it('escapeLikePattern escapes backslash, percent, and underscore', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
    expect(escapeLikePattern('%_\\')).toBe('\\%\\_\\\\');
    expect(escapeLikePattern('plain')).toBe('plain');
  });

  it('validateFilter rejects a matches pattern longer than 250 characters', () => {
    const long = 'a'.repeat(251);
    const res = validateFilter({ field: 'hostname', operator: 'matches', value: long } as FilterCondition);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Regex pattern too long'))).toBe(true);
  });

  it('validateFilter accepts a matches pattern at the 250-character limit', () => {
    const ok = 'a'.repeat(250);
    expect(validateFilter({ field: 'hostname', operator: 'matches', value: ok } as FilterCondition).valid).toBe(true);
  });

  it('validateFilter rejects an unknown field', () => {
    const res = validateFilter({ field: 'totally_made_up', operator: 'equals', value: 'x' } as FilterCondition);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Unknown field'))).toBe(true);
  });
});

const dialect = new PgDialect();
const render = (cond: FilterCondition): string => dialect.sqlToQuery(buildConditionSQL(cond)).sql;

describe('filterEngine virtual EXISTS fields (#968)', () => {
  describe('boolean predicates', () => {
    it('patches.pending equals yes → EXISTS against device_patches WHERE status pending', () => {
      const sql = render({ field: 'patches.pending', operator: 'equals', value: 'yes' });
      expect(sql).toMatch(/exists \(select 1 from device_patches/i);
      expect(sql).toMatch(/status = 'pending'/i);
      expect(sql).not.toMatch(/^not /i);
    });

    it('patches.pending equals no → negated', () => {
      expect(render({ field: 'patches.pending', operator: 'equals', value: 'no' })).toMatch(/^not \(/i);
    });

    it('patches.pending notEquals yes → negated', () => {
      expect(render({ field: 'patches.pending', operator: 'notEquals', value: 'yes' })).toMatch(/^not \(/i);
    });

    it('patches.pending notEquals no → double negative resolves positive', () => {
      expect(render({ field: 'patches.pending', operator: 'notEquals', value: 'no' })).not.toMatch(/^not /i);
    });

    it('boolean false value is treated as the negative', () => {
      expect(render({ field: 'patches.pending', operator: 'equals', value: false })).toMatch(/^not \(/i);
    });

    it('alerts.critical → active + critical against alerts', () => {
      const sql = render({ field: 'alerts.critical', operator: 'equals', value: 'yes' });
      expect(sql).toMatch(/from alerts where device_id/i);
      expect(sql).toMatch(/status = 'active'/i);
      expect(sql).toMatch(/severity = 'critical'/i);
    });

    it('system.rebootRequired → devices.pending_reboot column', () => {
      const sql = render({ field: 'system.rebootRequired', operator: 'equals', value: 'yes' });
      expect(sql).toMatch(/pending_reboot/i);
      expect(sql).not.toMatch(/patch_job_results/i);
    });
  });

  describe('software predicates resolve against software_inventory (not the dead device_software)', () => {
    it('software.installed contains → ILIKE EXISTS against software_inventory', () => {
      const sql = render({ field: 'software.installed', operator: 'contains', value: 'Chrome' });
      expect(sql).toMatch(/exists \(select 1 from "software_inventory"/i);
      expect(sql).toMatch(/ilike/i);
      expect(sql).not.toMatch(/device_software/i);
    });

    it('software.notInstalled contains → negated EXISTS', () => {
      const sql = render({ field: 'software.notInstalled', operator: 'contains', value: 'Chrome' });
      expect(sql).toMatch(/^not \(/i);
      expect(sql).toMatch(/software_inventory/i);
    });

    it('software.installed in [..] → IN list, no array-bind', () => {
      const sql = render({ field: 'software.installed', operator: 'in', value: ['A', 'B'] });
      expect(sql).toMatch(/ in \(/i);
      expect(sql).not.toMatch(/= any\(/i);
    });

    it('software.installed hasAll → AND of two EXISTS', () => {
      const sql = render({ field: 'software.installed', operator: 'hasAll', value: ['A', 'B'] });
      expect((sql.match(/exists/gi) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(sql).toMatch(/ and /i);
    });

    it('software.installed in [] → no-op TRUE (no constraint)', () => {
      expect(render({ field: 'software.installed', operator: 'in', value: [] })).toMatch(/true/i);
    });
  });
});

// #3166: the Architecture filter advertised x64/x86/arm64 while the agent stores
// Go's runtime.GOARCH verbatim (amd64/386/arm64), so x64 and x86 matched nothing.
// arm64 worked only by coincidence of spelling. These pin the projection, not the
// enum list — asserting the enum values alone would have passed while the filter
// stayed broken, which is how this shipped.
describe('filterEngine architecture normalization (#3166)', () => {
  const renderWithParams = (cond: FilterCondition) => {
    const q = dialect.sqlToQuery(buildConditionSQL(cond));
    return { sql: q.sql, params: q.params };
  };

  it('projects the stored GOARCH column into the advertised vocabulary', () => {
    const { sql } = renderWithParams({ field: 'architecture', operator: 'equals', value: 'x64' });

    // The comparison must not hit the raw column directly.
    expect(sql).toMatch(/case lower\("devices"\."architecture"\)/i);
    expect(sql).toMatch(/when 'amd64' then 'x64'/i);
    expect(sql).toMatch(/when '386' then 'x86'/i);
    expect(sql).toMatch(/when 'aarch64' then 'arm64'/i);
  });

  it('compares the caller value unchanged, so x64 is what reaches the predicate', () => {
    const { params } = renderWithParams({ field: 'architecture', operator: 'equals', value: 'x64' });
    expect(params).toContain('x64');
  });

  it('applies to every operator, not just equals', () => {
    for (const operator of ['equals', 'notEquals', 'in', 'notIn'] as const) {
      const value = operator === 'in' || operator === 'notIn' ? ['x64', 'arm64'] : 'x64';
      const { sql } = renderWithParams({ field: 'architecture', operator, value });
      expect.soft(sql, `operator ${operator}`).toMatch(/case lower\("devices"\."architecture"\)/i);
    }
  });

  it('leaves an unrecognised architecture filterable by its raw name', () => {
    // Anything not in the map falls through lower-cased rather than being
    // swallowed, so a future arch is still reachable instead of matching nothing.
    const { sql } = renderWithParams({ field: 'architecture', operator: 'equals', value: 'riscv64' });
    expect(sql).toMatch(/else lower\("devices"\."architecture"\)/i);
  });

  it('still advertises the enum the projection targets', () => {
    const def = getFieldDefinition('architecture');
    expect(def?.enumValues).toEqual(['x64', 'x86', 'arm64']);
  });
});

describe('filterEngine field registration (#968)', () => {
  it('registers the three boolean fields', () => {
    for (const key of ['patches.pending', 'alerts.critical', 'system.rebootRequired']) {
      const def = getFieldDefinition(key);
      expect(def, key).toBeDefined();
      expect(def?.type).toBe('boolean');
      expect(def?.operators).toContain('equals');
    }
  });

  it('validateFilter accepts the boolean fields with equals/notEquals', () => {
    expect(validateFilter({ field: 'patches.pending', operator: 'equals', value: 'yes' } as FilterCondition).valid).toBe(true);
    expect(validateFilter({ field: 'alerts.critical', operator: 'notEquals', value: 'no' } as FilterCondition).valid).toBe(true);
  });

  it('validateFilter rejects an unsupported operator on a boolean field', () => {
    expect(validateFilter({ field: 'patches.pending', operator: 'contains', value: 'x' } as FilterCondition).valid).toBe(false);
  });

  it('validateFilter accepts the expanded software multi-select operators', () => {
    for (const operator of ['in', 'hasAny', 'hasAll', 'equals'] as const) {
      expect(validateFilter({ field: 'software.installed', operator, value: ['A'] } as FilterCondition).valid, operator).toBe(true);
    }
    expect(validateFilter({ field: 'software.notInstalled', operator: 'in', value: ['A'] } as FilterCondition).valid).toBe(true);
  });
});

describe('filterEngine related-table fields via correlated subqueries (no joins)', () => {
  it('hardware.* → EXISTS against device_hardware (1:1)', () => {
    const sql = render({ field: 'hardware.cpuCores', operator: 'greaterThan', value: 4 });
    expect(sql).toMatch(/exists \(select 1 from "device_hardware"/i);
    expect(sql).toMatch(/"device_id" = "devices"\."id"/i);
    expect(sql).toMatch(/> \$\d/);
  });

  it('network.* → EXISTS against device_network (1:many, any interface)', () => {
    const sql = render({ field: 'network.ipAddress', operator: 'contains', value: '10.0' });
    expect(sql).toMatch(/exists \(select 1 from "device_network"/i);
    expect(sql).toMatch(/ilike/i);
  });

  it('metrics.* → latest-sample scalar subquery ordered by timestamp', () => {
    const sql = render({ field: 'metrics.diskPercent', operator: 'greaterThan', value: 90 });
    expect(sql).toMatch(/from "device_metrics"/i);
    expect(sql).toMatch(/"device_metrics"\."disk_percent"/i);
    expect(sql).toMatch(/order by "device_metrics"\."timestamp" desc limit 1/i);
    expect(sql).toMatch(/> \$\d/);
  });

  it('groupId equals → EXISTS membership', () => {
    const sql = render({ field: 'groupId', operator: 'equals', value: 'g1' });
    expect(sql).toMatch(/exists \(select 1 from "device_group_memberships"/i);
    expect(sql).toMatch(/"group_id" = \$\d/i);
  });

  it('groupId in → EXISTS membership ANY', () => {
    const sql = render({ field: 'groupId', operator: 'in', value: ['g1', 'g2'] });
    expect(sql).toMatch(/"group_id" = any\(/i);
  });

  it('device-column fields still compare directly (no subquery)', () => {
    const sql = render({ field: 'hostname', operator: 'contains', value: 'web' });
    expect(sql).not.toMatch(/exists/i);
    expect(sql).toMatch(/ilike/i);
  });

  // Regression: a scalar enum `in` (e.g. Status is any of online/offline, which
  // the unified chip bar emits when two status presets are selected) must build
  // an explicit IN list. The old `= ANY($1)` bound the JS array as a row tuple
  // `($1, $2)` and Postgres 500'd with "op ANY/ALL (array) requires array".
  it('scalar in → explicit IN list, never = ANY(array)', () => {
    const sql = render({ field: 'status', operator: 'in', value: ['online', 'offline'] });
    expect(sql).toMatch(/ in \(/i);
    expect(sql).not.toMatch(/any\s*\(/i);
  });
  it('scalar notIn → explicit NOT IN list', () => {
    const sql = render({ field: 'status', operator: 'notIn', value: ['online', 'offline'] });
    expect(sql).toMatch(/not in \(/i);
    expect(sql).not.toMatch(/all\s*\(/i);
  });
  it('scalar in [] → FALSE (matches nothing)', () => {
    expect(render({ field: 'status', operator: 'in', value: [] })).toMatch(/false/i);
  });
  it('scalar notIn [] → TRUE (matches everything)', () => {
    expect(render({ field: 'status', operator: 'notIn', value: [] })).toMatch(/true/i);
  });
});

describe('filterEngine device-row catalog completion', () => {
  it('registers the new device-column fields', () => {
    for (const key of ['lastUser', 'isHeadless', 'uptimeSeconds', 'watchdogStatus', 'quarantinedAt', 'lastSeenIp']) {
      expect(getFieldDefinition(key), key).toBeDefined();
    }
  });

  it('status enum offers all seven device statuses', () => {
    const def = getFieldDefinition('status');
    expect(def?.enumValues).toEqual(['online', 'offline', 'maintenance', 'decommissioned', 'quarantined', 'updating', 'pending']);
  });

  it('new device-column fields compile as direct comparisons (no subquery)', () => {
    expect(render({ field: 'lastUser', operator: 'equals', value: 'bdunn' })).toMatch(/"last_user" = \$/i);
    expect(render({ field: 'watchdogStatus', operator: 'equals', value: 'failover' })).toMatch(/"watchdog_status" = \$/i);
    expect(render({ field: 'quarantinedAt', operator: 'isNotNull', value: '' })).toMatch(/"quarantined_at" is not null/i);
    expect(render({ field: 'lastUser', operator: 'equals', value: 'x' })).not.toMatch(/exists/i);
  });
});

describe('filterEngine matches validation recurses into nested groups (#1044)', () => {
  it('rejects an over-length matches pattern nested inside groups', () => {
    const nested: FilterConditionGroup = {
      operator: 'AND',
      conditions: [
        { field: 'status', operator: 'equals', value: 'offline' },
        { operator: 'OR', conditions: [
          { field: 'hostname', operator: 'matches', value: 'a'.repeat(251) },
        ] },
      ],
    };
    const res = validateFilter(nested);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Regex pattern too long'))).toBe(true);
  });

  it('accepts a within-limit matches pattern nested inside groups', () => {
    const nested: FilterConditionGroup = {
      operator: 'OR',
      conditions: [
        { operator: 'AND', conditions: [
          { field: 'hostname', operator: 'matches', value: 'web-[0-9]+' },
        ] },
      ],
    };
    expect(validateFilter(nested).valid).toBe(true);
  });
});

describe('filterEngine bounds filter-query execution time (#1044 ReDoS)', () => {
  const dialect = new PgDialect();
  const renderedExecutions = () => dbMock.executed.map((q) => dialect.sqlToQuery(q as never));

  beforeEach(() => {
    dbMock.executed.length = 0;
    dbMock.events.length = 0;
    dbMock.queryError = undefined;
  });

  const matchesFilter: FilterConditionGroup = {
    operator: 'AND',
    conditions: [{ field: 'hostname', operator: 'matches', value: '(a+)+$' }],
  };

  const expectTimeoutWrappedQuery = () => {
    const executions = renderedExecutions();
    expect(executions[0]?.sql).toMatch(/current_setting\('statement_timeout'/i);
    expect(executions[1]?.sql).toMatch(/set_config\('statement_timeout'/i);
    expect(executions[1]?.params).toEqual(['500ms']);

    const firstQueryIndex = dbMock.events.indexOf('query');
    const restoreIndex = dbMock.events.lastIndexOf('execute');
    expect(firstQueryIndex).toBeGreaterThan(1);
    expect(restoreIndex).toBeGreaterThan(firstQueryIndex);
    expect(executions.at(-1)?.sql).toMatch(/set_config\('statement_timeout'/i);
    expect(executions.at(-1)?.params).toEqual(['2s']);
  };

  it('evaluateFilterWithPreview sets a statement_timeout before querying', async () => {
    await evaluateFilterWithPreview(matchesFilter, { orgId: 'org-1', previewLimit: 5 });
    expectTimeoutWrappedQuery();
  });

  it('evaluateFilter sets a statement_timeout before querying', async () => {
    await evaluateFilter(matchesFilter, { orgId: 'org-1' });
    expectTimeoutWrappedQuery();
  });

  it('deviceMatchesFilter sets a statement_timeout before querying', async () => {
    await deviceMatchesFilter('device-1', matchesFilter);
    expectTimeoutWrappedQuery();
  });

  it('restores the captured statement_timeout after a query error', async () => {
    dbMock.queryError = new Error('query failed');

    await expect(evaluateFilter(matchesFilter, { orgId: 'org-1' })).rejects.toThrow('query failed');

    expectTimeoutWrappedQuery();
  });
});

describe('filterEngine datetime binding (#3369)', () => {
  const dialect = new PgDialect();
  const FROM = new Date('2026-01-01T00:00:00.000Z');
  const TO = new Date('2026-02-01T12:30:45.678Z');

  const render = (condition: FilterCondition) => dialect.sqlToQuery(buildConditionSQL(condition));

  /**
   * The bug: `applyOperator` interpolated the filter value bare into a `sql`
   * template. `columnRef` there is an arbitrary `SQL` expression rather than a
   * `Column`, so Drizzle had no encoder to consult and wrapped the value in a
   * `Param` with the NOOP encoder — handing postgres.js a live `Date`, whose
   * Bind step throws ERR_INVALID_ARG_TYPE. Because the request runs inside
   * `withDbAccessContext` (a `begin()` transaction that re-throws at commit),
   * it escaped as an HTTP 500 for the whole request.
   *
   * This is not hypothetical for `between`: `filterValueSchema` parses a range
   * through `z.coerce.date()`, so the advanced filter builder's date-range
   * picker produces real `Date`s on every `POST /devices/filters/preview`.
   */
  it.each([
    ['equals', new Date(FROM)],
    ['notEquals', new Date(FROM)],
    ['before', new Date(FROM)],
    ['after', new Date(FROM)],
    ['lessThan', new Date(FROM)],
    ['lessThanOrEquals', new Date(FROM)],
    ['greaterThan', new Date(FROM)],
    ['greaterThanOrEquals', new Date(FROM)],
  ] as const)('binds no raw Date for a datetime %s condition', (operator, value) => {
    const { params } = render({ field: 'lastSeenAt', operator, value });

    expect(params.length).toBeGreaterThan(0);
    for (const param of params) expect(param).not.toBeInstanceOf(Date);
    expect(params).toContain(FROM.toISOString());
  });

  it('binds no raw Date for a between range and keeps both bounds distinct', () => {
    const { sql: text, params } = render({
      field: 'lastSeenAt',
      operator: 'between',
      value: { from: FROM, to: TO },
    });

    for (const param of params) expect(param).not.toBeInstanceOf(Date);
    expect(params).toEqual([FROM.toISOString(), TO.toISOString()]);
    expect(text).toContain('BETWEEN');
  });

  it('emits no timestamptz cast — the target columns are naive timestamps', () => {
    // `devices.last_seen_at` / `enrolled_at` / `quarantined_at` are all
    // `timestamp` WITHOUT time zone. Casting the bound parameter to
    // `timestamptz` would make Postgres reinterpret the column in the session
    // time zone, shifting every result on any non-UTC deployment — a worse bug
    // than the one being fixed here.
    const { sql: text } = render({
      field: 'lastSeenAt',
      operator: 'between',
      value: { from: FROM, to: TO },
    });

    expect(text).not.toContain('timestamptz');
  });

  it('routes a Date through the related-table and computed-field paths too', () => {
    // These recurse into applyOperator with a correlated subquery / CASE
    // expression as columnRef, which is precisely where a typed helper is
    // unavailable and the bare interpolation used to survive.
    for (const field of ['enrolledAt', 'quarantinedAt']) {
      const { params } = render({ field, operator: 'before', value: new Date(FROM) });
      for (const param of params) expect(param).not.toBeInstanceOf(Date);
    }
  });

  it('routes matches, in/notIn and the group membership path through sqlValue too', () => {
    // `OPERATORS_BY_TYPE` never pairs these operators with a datetime field, and
    // the public route runs `validateFilter` first — but `FilterCondition` types
    // `operator` as any `FilterOperator`, and the internal callers
    // (aiToolsFleet, groupMembership, deploymentTargetResolver) build conditions
    // by hand and call `evaluateFilter` directly without that gate. Defense in
    // depth: a Date reaching these branches must still serialize.
    const at = new Date('2026-01-01T00:00:00.000Z');
    const cases: FilterCondition[] = [
      { field: 'hostname', operator: 'matches', value: at as unknown as string },
      { field: 'lastSeenAt', operator: 'in', value: [at] as unknown as string[] },
      { field: 'lastSeenAt', operator: 'notIn', value: [at] as unknown as string[] },
      { field: 'groupId', operator: 'equals', value: at },
    ];

    for (const condition of cases) {
      const { params } = render(condition);
      for (const param of params) {
        expect(param, `${condition.field}/${condition.operator}`).not.toBeInstanceOf(Date);
      }
      expect(params).toContain(at.toISOString());
    }
  });

  it('still binds ordinary scalars unchanged', () => {
    expect(render({ field: 'hostname', operator: 'equals', value: 'web-01' }).params).toEqual(['web-01']);
    expect(render({ field: 'status', operator: 'in', value: ['online', 'offline'] }).params)
      .toEqual(['online', 'offline']);
  });

  it('binds a numeric between as numbers, not epoch-millisecond timestamps', () => {
    // Companion to the validator fix: `z.coerce.date()` accepted a plain number
    // as epoch-ms, so `{ from: 10, to: 90 }` became 1970-01-01T00:00:00.010Z.
    // Here we assert the engine's own half — numbers stay numbers.
    const { params } = render({
      field: 'metrics.cpuPercent',
      operator: 'between',
      value: { from: 10, to: 90 },
    });

    expect(params).toEqual([10, 90]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { dbMock, state } = vi.hoisted(() => {
  const state = {
    executeCalls: [] as unknown[],
    partnerRows: [{ settings: {}, orgCount: 0 }] as unknown[],
    executeResults: [] as unknown[][],
  };
  const dbMock = {
    select: vi.fn(() => {
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(state.partnerRows)),
      };
      return chain;
    }),
    execute: vi.fn((query: unknown) => {
      state.executeCalls.push(query);
      return Promise.resolve(state.executeResults.shift() ?? []);
    }),
  };
  return { dbMock, state };
});

vi.mock('../../db', () => ({ db: dbMock }));

import { decodeCursor, encodeCursor, listFieldOrgs } from './drilldown';
import { InheritanceBadRequest, InheritanceNotFound } from './aggregate';

const dialect = new PgDialect();
const compile = (query: unknown) => dialect.sqlToQuery(query as SQL);
const ctx = { partnerId: 'p1', accessibleOrgIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'] };
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

beforeEach(() => {
  vi.clearAllMocks();
  state.executeCalls = [];
  state.partnerRows = [{ settings: { security: { requireMfa: true } }, orgCount: 2 }];
  state.executeResults = [];
});

describe('listFieldOrgs', () => {
  it('applies the bucket predicate before LIMIT, fetching limit+1', async () => {
    await listFieldOrgs('security.requireMfa', ctx, { bucket: 'shadowed', cursor: null, limit: 2 });
    const { sql: raw, params } = compile(state.executeCalls[0]);
    const text = raw.replace(/\s+/g, ' ').toLowerCase();
    const where = text.indexOf(' where ');
    const limit = text.lastIndexOf(' limit ');
    expect(where).toBeGreaterThan(-1);
    expect(limit).toBeGreaterThan(where);
    // The own-value predicate (#> on the bound path) sits inside WHERE, before LIMIT.
    const pathAt = text.indexOf('#>', where);
    expect(pathAt).toBeGreaterThan(where);
    expect(pathAt).toBeLessThan(limit);
    expect(params).toContainEqual(['security', 'requireMfa']);
    expect(params[params.length - 1]).toBe(3);
  });

  it('pages with a stable cursor and limit+1 lookahead', async () => {
    state.executeResults = [[
      { id: id(1), name: 'Alpha', sort_name: 'alpha', present: true, value: false },
      { id: id(2), name: 'beta', sort_name: 'beta', present: true, value: false },
      { id: id(3), name: 'Gamma', sort_name: 'gamma', present: true, value: true },
    ]];
    const page = await listFieldOrgs('security.requireMfa', ctx, { bucket: 'ownValue', cursor: null, limit: 2 });
    expect(page.rows.map((r) => r.orgId)).toEqual([id(1), id(2)]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!)).toEqual(['beta', id(2)]);

    state.executeResults = [[{ id: id(3), name: 'Gamma', sort_name: 'gamma', present: true, value: true }]];
    const next = await listFieldOrgs('security.requireMfa', ctx, { bucket: 'ownValue', cursor: page.nextCursor, limit: 2 });
    expect(next.nextCursor).toBeNull();
    const { sql: text, params } = compile(state.executeCalls[1]);
    expect(text).toMatch(/\(lower\("organizations"\."name"\), "organizations"\."id"\) > \(\$\d+, \$\d+::uuid\)/);
    expect(params).toContain('beta');
    expect(params).toContain(id(2));
  });

  it('labels rows with the classifier and projects only allowlisted values', async () => {
    state.executeResults = [[{ id: id(1), name: 'Alpha', sort_name: 'alpha', present: true, value: false }]];
    const page = await listFieldOrgs('security.requireMfa', ctx, { bucket: 'ownValue', cursor: null, limit: 50 });
    expect(page.rows[0]).toEqual({ orgId: id(1), orgName: 'Alpha', ownValue: { set: true, value: false }, inEffect: false });
  });

  it('secret fields return presence only', async () => {
    state.partnerRows = [{ settings: {}, orgCount: 2 }];
    state.executeResults = [
      [{ id: id(1), name: 'Alpha', sort_name: 'alpha' }],
      [{ id: id(9), name: 'Primary', org_id: id(1), present: true, value: 'enc:v1:CANARY-CT-token' }],
    ];
    const page = await listFieldOrgs('notifications.pushoverAppToken', ctx, { bucket: 'ownValue', cursor: null, limit: 50 });
    expect(JSON.stringify(page)).not.toContain('CANARY');
    expect(page.rows[0]!.channels).toEqual([{ channelId: id(9), name: 'Primary', ownValue: { set: true } }]);
  });

  it('unknown field throws InheritanceNotFound', async () => {
    await expect(listFieldOrgs('nope.nothing', ctx, { bucket: 'ownValue', cursor: null, limit: 50 })).rejects.toBeInstanceOf(InheritanceNotFound);
    expect(state.executeCalls).toHaveLength(0);
  });

  it('a field without an org source, or a bucket that does not apply, is a bad request', async () => {
    await expect(listFieldOrgs('regional.dateFormat', ctx, { bucket: 'ownValue', cursor: null, limit: 50 })).rejects.toBeInstanceOf(InheritanceBadRequest);
    await expect(listFieldOrgs('notifications.pushoverAppToken', ctx, { bucket: 'overrides', cursor: null, limit: 50 })).rejects.toBeInstanceOf(InheritanceBadRequest);
    await expect(listFieldOrgs('security.requireMfa', ctx, { bucket: 'clamped', cursor: null, limit: 50 })).rejects.toBeInstanceOf(InheritanceBadRequest);
    // A lock never has overrides; an inherit-with-override field is never shadowed.
    await expect(listFieldOrgs('security.requireMfa', ctx, { bucket: 'overrides', cursor: null, limit: 50 })).rejects.toBeInstanceOf(InheritanceBadRequest);
    await expect(listFieldOrgs('defaults.defaultEnrollmentDeviceCount', ctx, { bucket: 'shadowed', cursor: null, limit: 50 })).rejects.toBeInstanceOf(InheritanceBadRequest);
    expect(state.executeCalls).toHaveLength(0);
  });

  it('a cursor carrying a NUL character is a bad request, not a database error', async () => {
    const cursor = encodeCursor(['a\u0000b', id(1)]);
    await expect(listFieldOrgs('security.requireMfa', ctx, { bucket: 'ownValue', cursor, limit: 50 })).rejects.toBeInstanceOf(InheritanceBadRequest);
    expect(state.executeCalls).toHaveLength(0);
  });

  it('a malformed cursor is a bad request', async () => {
    for (const cursor of ['not-base64!!', encodeCursor(['x', 'not-a-uuid']), Buffer.from('{"a":1}').toString('base64url')]) {
      await expect(listFieldOrgs('security.requireMfa', ctx, { bucket: 'ownValue', cursor, limit: 50 })).rejects.toBeInstanceOf(InheritanceBadRequest);
    }
  });

  it('never selects organizations.settings whole', async () => {
    await listFieldOrgs('eventLogs', ctx, { bucket: 'ownValue', cursor: null, limit: 50 });
    expect(compile(state.executeCalls[0]).sql).not.toMatch(/"organizations"\."settings"(?!\s*#>)/);
  });
});

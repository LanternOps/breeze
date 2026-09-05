import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'where']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import { supportTile, ticketSla } from './ticketReadModel';

const NOW = new Date('2026-09-02T02:00:00Z');
const slaRow = (
  overrides: Partial<Parameters<typeof ticketSla>[0]> = {},
): Parameters<typeof ticketSla>[0] => ({
  priority: 'normal',
  status: 'open',
  createdAt: new Date('2026-09-02T00:00:00Z'),
  firstResponseAt: null,
  resolvedAt: null,
  responseSlaMinutes: 100,
  resolutionSlaMinutes: 240,
  slaBreachedAt: null,
  slaPausedAt: null,
  slaPausedMinutes: 0,
  ...overrides,
});

it('covers every portal SLA status', () => {
  expect(ticketSla(slaRow({ slaBreachedAt: NOW }), NOW).status).toBe('breached');
  expect(ticketSla(slaRow(), new Date('2026-09-02T01:25:00Z')).status).toBe('at_risk');
  expect(ticketSla(slaRow({ slaPausedAt: NOW }), NOW).status).toBe('paused');
  expect(ticketSla(slaRow({ status: 'pending' }), NOW).status).toBe('paused');
  expect(ticketSla(slaRow({ status: 'on_hold' }), NOW).status).toBe('paused');
  expect(ticketSla(slaRow(), new Date('2026-09-02T00:30:00Z')).status).toBe('on_track');
  expect(ticketSla(slaRow(), new Date('2026-09-02T04:30:00Z')).status).toBe('at_risk');
  expect(ticketSla(slaRow({
    status: 'resolved',
    resolvedAt: new Date('2026-09-02T01:30:00Z'),
  }), NOW).status).toBe('met');
  expect(ticketSla(slaRow({
    responseSlaMinutes: null,
    resolutionSlaMinutes: null,
  }), NOW).status).toBe('not_configured');
});

it('reports measured minutes and subtracts accumulated resolution pause', () => {
  expect(ticketSla(slaRow({
    firstResponseAt: new Date('2026-09-02T00:30:00Z'),
    resolvedAt: new Date('2026-09-02T02:00:00Z'),
    status: 'resolved',
    slaPausedMinutes: 20,
  }), NOW)).toEqual({
    firstResponseMinutes: 30,
    resolutionMinutes: 100,
    responseTargetMinutes: 100,
    resolutionTargetMinutes: 240,
    status: 'met',
  });
});

it('reports a resolved ticket as breached when resolution exceeds its target', () => {
  expect(ticketSla(slaRow({
    status: 'resolved',
    resolvedAt: new Date('2026-09-02T06:40:00Z'),
  }), NOW)).toMatchObject({
    resolutionMinutes: 400,
    resolutionTargetMinutes: 240,
    status: 'breached',
  });
});

it('reports a first-response-only ticket as breached when response exceeds its target', () => {
  expect(ticketSla(slaRow({
    firstResponseAt: new Date('2026-09-02T09:00:00Z'),
    resolutionSlaMinutes: null,
  }), NOW)).toMatchObject({
    firstResponseMinutes: 540,
    responseTargetMinutes: 100,
    status: 'breached',
  });
});

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('supportTile', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('returns org-wide open count and response sample', async () => {
    state.rows.push(
      [{ openTickets: 4 }],
      [{ averageFirstResponseMinutes: 35, sampleSize: 2 }],
    );

    await expect(
      supportTile(ORG_ID, {
        timezone: 'UTC',
        now: new Date('2026-09-02T12:00:00Z'),
      }),
    ).resolves.toEqual({
      status: 'ok',
      openTickets: 4,
      averageFirstResponseMinutes: 35,
      sampleSize: 2,
      month: '2026-09',
      timezone: 'UTC',
      asOf: '2026-09-02T12:00:00.000Z',
    });

    const [openQuery, responseQuery] = state.wheres.map((where) =>
      new PgDialect().sqlToQuery(where as SQL),
    );
    expect(openQuery!.sql).toContain('"tickets"."org_id" =');
    expect(openQuery!.sql).toContain('"tickets"."deleted_at" is null');
    expect(openQuery!.sql).not.toContain('date_trunc');
    expect(responseQuery!.sql).toContain('"tickets"."org_id" =');
    expect(responseQuery!.sql).toContain('"tickets"."deleted_at" is null');
    expect(responseQuery!.sql).toContain('date_trunc');
    expect(openQuery!.params).toContain(ORG_ID);
    expect(responseQuery!.params).toContain(ORG_ID);
  });
});

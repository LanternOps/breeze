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

import { portalTicketOwnership } from '../../routes/portal/ticketOwnership';

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
  // #8973 W3: the stored deadlines the write points compute for these targets.
  responseDueAt: new Date('2026-09-02T01:40:00Z'),
  responseWarnAt: new Date('2026-09-02T01:20:00Z'),
  resolutionDueAt: new Date('2026-09-02T04:00:00Z'),
  resolutionWarnAt: new Date('2026-09-02T03:12:00Z'),
  ...overrides,
});

// #8973 W3 (spec §4.3 reader 4, §8.5 correction 1): the portal reads the
// stored deadlines and never invents a priority-default target.
describe('ticketSla reads the stored deadlines (#8973)', () => {
  it('a null target is not_configured even on an urgent ticket (no PRIORITY_SLA_DEFAULTS fallback)', () => {
    const sla = ticketSla(slaRow({
      priority: 'urgent',
      responseSlaMinutes: null, resolutionSlaMinutes: null,
      responseDueAt: null, responseWarnAt: null, resolutionDueAt: null, resolutionWarnAt: null,
    }), NOW);
    expect(sla).toMatchObject({ status: 'not_configured', responseTargetMinutes: null, resolutionTargetMinutes: null });
  });

  it('a single null arm stays null instead of borrowing the priority default', () => {
    const sla = ticketSla(slaRow({ priority: 'urgent', responseSlaMinutes: null, responseDueAt: null, responseWarnAt: null }), NOW);
    expect(sla.responseTargetMinutes).toBeNull();
    expect(sla.resolutionTargetMinutes).toBe(240);
  });

  it('a first response before the stored due is met even when it exceeds the raw target (pause before it)', () => {
    // Target 100, but 20 paused minutes pushed the stored due to +120.
    const sla = ticketSla(slaRow({
      firstResponseAt: new Date('2026-09-02T01:50:00Z'),
      responseDueAt: new Date('2026-09-02T02:00:00Z'),
      resolutionSlaMinutes: null, resolutionDueAt: null, resolutionWarnAt: null,
    }), NOW);
    expect(sla.status).toBe('met');
  });

  it('a completion after the stored due is breached', () => {
    expect(ticketSla(slaRow({
      firstResponseAt: new Date('2026-09-02T01:41:00Z'),
      resolutionSlaMinutes: null, resolutionDueAt: null, resolutionWarnAt: null,
    }), NOW).status).toBe('breached');
  });

  it('a target whose stored deadline is not written yet is still running, never met', () => {
    const sla = ticketSla(slaRow({
      firstResponseAt: new Date('2026-09-02T00:20:00Z'),
      resolutionDueAt: null, resolutionWarnAt: null,
    }), new Date('2026-09-02T05:00:00Z'));
    expect(sla.status).toBe('on_track');
  });

  it('at-risk follows the stored warn point, not elapsed arithmetic', () => {
    // Warn moved early (e.g. by a business calendar): at risk at +50 min.
    const early = slaRow({ responseWarnAt: new Date('2026-09-02T00:50:00Z') });
    expect(ticketSla(early, new Date('2026-09-02T00:55:00Z')).status).toBe('at_risk');
    // Warn moved late (paused minutes folded in): still on track at +85 min.
    const late = slaRow({ responseWarnAt: new Date('2026-09-02T01:40:00Z') });
    expect(ticketSla(late, new Date('2026-09-02T01:25:00Z')).status).toBe('on_track');
  });
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

  it('scopes both the open count and the response sample to ownership', async () => {
    state.rows.push(
      [{ openTickets: 4 }],
      [{ averageFirstResponseMinutes: 35, sampleSize: 2 }],
    );

    await expect(
      supportTile(ORG_ID, {
        timezone: 'UTC',
        now: new Date('2026-09-02T12:00:00Z'),
      }, portalTicketOwnership({ id: 'portal-user-1', contactId: null })),
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
    expect(openQuery!.sql).toContain('"tickets"."submitted_by" =');
    expect(openQuery!.params).toContain('portal-user-1');
    expect(responseQuery!.sql).toContain('"tickets"."submitted_by" =');
    expect(responseQuery!.params).toContain('portal-user-1');
    expect(responseQuery!.params).toContain(ORG_ID);
  });
});

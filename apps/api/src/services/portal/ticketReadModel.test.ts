import { expect, it } from 'vitest';
import { ticketSla } from './ticketReadModel';

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

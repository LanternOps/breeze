import { describe, expect, it } from 'vitest';
import { reportRunRowsToCsv } from './reportRunCsv';
import { TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS } from '../types/ticketSlaPerformance';

describe('reportRunRowsToCsv', () => {
  it('labels SLA performance headers instead of emitting raw row keys', () => {
    const csv = reportRunRowsToCsv('ticket_sla_performance', [
      { priority: 'urgent', ticketsOpened: 3, responseAttainment: 0.5 },
    ]);
    const [header, body] = csv.split('\n');
    expect(header).toBe(
      [
        TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS.priority,
        TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS.ticketsOpened,
        TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS.responseAttainment,
      ].map((label) => `"${label}"`).join(','),
    );
    expect(body).toBe('"urgent","3","0.5"');
  });

  it('keeps raw keys for a report type with no label map', () => {
    expect(reportRunRowsToCsv('device_inventory', [{ hostname: 'a' }])).toBe('"hostname"\n"a"');
  });

  it('returns an empty string for no rows', () => {
    expect(reportRunRowsToCsv('ticket_sla_performance', [])).toBe('');
  });
});

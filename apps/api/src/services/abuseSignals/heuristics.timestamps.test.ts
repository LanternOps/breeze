import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withHostTimeZone } from '../../testUtils/hostTimeZone';

const executeMock = vi.hoisted(() => vi.fn());
vi.mock('../../db', () => ({ db: { execute: executeMock } }));

import { loadPartnerAggregates } from './heuristics';

describe('loadPartnerAggregates timestamps', () => {
  beforeEach(() => executeMock.mockReset());

  it.each(['America/Denver', 'Asia/Tokyo'] as const)(
    'reads partners.created_at text as UTC on a %s host',
    async (zone) => {
      // offsetless `timestamp` text from a raw query; read as UTC
      executeMock.mockResolvedValue([{ id: 'p1', name: 'Acme', created_at: '2026-08-25 18:34:15.123' }]);
      await withHostTimeZone(zone, async () => {
        const [row] = await loadPartnerAggregates();
        expect(row!.partnerCreatedAt.toISOString()).toBe('2026-08-25T18:34:15.123Z');
      });
    },
  );
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, contextLabels } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  contextLabels: [] as Array<string | undefined>,
}));

vi.mock('../../db', () => ({
  db: { execute: executeMock },
  withSystemDbAccessContext: (fn: () => unknown, label?: string) => {
    contextLabels.push(label);
    return fn();
  },
}));

import {
  STATS_WINDOW_DAYS,
  incrementPartnerSendingStat,
  loadAllPartnerSendingWindowStats,
  loadPartnerSendingWindowStats,
} from './deliveryStats';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-09-17T23:45:00.000Z');

/** The queries return postgres.js-shaped results; the helper unwraps `.rows`. */
function rows(value: unknown[]): { rows: unknown[] } {
  return { rows: value };
}

beforeEach(() => {
  vi.clearAllMocks();
  contextLabels.length = 0;
});

describe('incrementPartnerSendingStat', () => {
  it('runs inside a SYSTEM db context — the webhook has no ambient auth transaction', async () => {
    executeMock.mockResolvedValueOnce(rows([{ partner_id: PARTNER }]));
    await incrementPartnerSendingStat(PARTNER, 'delivered', AT);
    expect(contextLabels).toEqual(['emailDomainsDeliveryStatIncrement']);
  });

  it('returns true when the statement affected the partner row', async () => {
    executeMock.mockResolvedValueOnce(rows([{ partner_id: PARTNER }]));
    await expect(incrementPartnerSendingStat(PARTNER, 'bounced', AT)).resolves.toBe(true);
  });

  // The provider tag is attacker-influencable only in the sense that anyone who
  // can forge a signed payload controls it; the statement's row source is a
  // SELECT over `partners`, so an unknown id inserts NOTHING rather than
  // raising 23503 — a caught 23503 would abort the surrounding transaction.
  it('returns false for a partner id that does not exist, without raising', async () => {
    executeMock.mockResolvedValueOnce(rows([]));
    await expect(incrementPartnerSendingStat(PARTNER, 'bounced', AT)).resolves.toBe(false);
  });

  it('refuses a column name that is not one of the six counters', async () => {
    await expect(
      incrementPartnerSendingStat(PARTNER, 'drop table' as never, AT),
    ).rejects.toThrow(/unknown delivery stat column/i);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('keys the row on the UTC calendar day, not the local one', async () => {
    executeMock.mockResolvedValueOnce(rows([{ partner_id: PARTNER }]));
    // 2026-09-17T23:45Z is 2026-09-18 in any timezone east of UTC+1.
    await incrementPartnerSendingStat(PARTNER, 'sent', AT);
    const params = executeMock.mock.calls[0]![0] as { queryChunks?: unknown[] };
    expect(JSON.stringify(params)).toContain('2026-09-17');
  });
});

describe('loadPartnerSendingWindowStats', () => {
  it('uses GREATEST(sent, delivered + bounced + failed) as the denominator', async () => {
    // A self-hoster who did not subscribe email.sent has sent = 0 but real
    // outcome counts; the denominator must still be 100, not 0.
    executeMock.mockResolvedValueOnce(rows([{
      partner_id: PARTNER, sent: '0', delivered: '90', bounced: '8', complained: '1', failed: '2', suppressed: '0',
    }]));
    const stats = await loadPartnerSendingWindowStats(PARTNER, AT);
    expect(stats.messages).toBe(100);
    expect(stats.bounceRate).toBeCloseTo(0.08, 10);
  });

  it('prefers `sent` when it is larger than the outcome sum', async () => {
    executeMock.mockResolvedValueOnce(rows([{
      partner_id: PARTNER, sent: '500', delivered: '90', bounced: '8', complained: '1', failed: '2', suppressed: '0',
    }]));
    const stats = await loadPartnerSendingWindowStats(PARTNER, AT);
    expect(stats.messages).toBe(500);
  });

  it('returns an all-zero row for a partner with no stats at all', async () => {
    executeMock.mockResolvedValueOnce(rows([]));
    const stats = await loadPartnerSendingWindowStats(PARTNER, AT);
    expect(stats).toEqual({
      partnerId: PARTNER, sent: 0, delivered: 0, bounced: 0,
      complained: 0, failed: 0, suppressed: 0, messages: 0, bounceRate: 0,
    });
  });

  it('never divides by zero', async () => {
    executeMock.mockResolvedValueOnce(rows([{
      partner_id: PARTNER, sent: '0', delivered: '0', bounced: '0', complained: '3', failed: '0', suppressed: '0',
    }]));
    const stats = await loadPartnerSendingWindowStats(PARTNER, AT);
    expect(stats.bounceRate).toBe(0);
    expect(stats.complained).toBe(3);
  });

  it('spans exactly STATS_WINDOW_DAYS days ending today', async () => {
    executeMock.mockResolvedValueOnce(rows([]));
    await loadPartnerSendingWindowStats(PARTNER, AT);
    expect(STATS_WINDOW_DAYS).toBe(7);
    // 2026-09-17 minus 6 days == 2026-09-11 inclusive.
    expect(JSON.stringify(executeMock.mock.calls[0]![0])).toContain('2026-09-11');
  });
});

describe('loadAllPartnerSendingWindowStats', () => {
  it('returns one grouped row per partner in ONE query (no N+1)', async () => {
    executeMock.mockResolvedValueOnce(rows([
      { partner_id: 'p1', sent: '10', delivered: '9', bounced: '1', complained: '0', failed: '0', suppressed: '0' },
      { partner_id: 'p2', sent: '0', delivered: '0', bounced: '0', complained: '0', failed: '0', suppressed: '0' },
    ]));
    const all = await loadAllPartnerSendingWindowStats(AT);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(all.map((r) => r.partnerId)).toEqual(['p1', 'p2']);
    expect(all[0]!.messages).toBe(10);
  });
});

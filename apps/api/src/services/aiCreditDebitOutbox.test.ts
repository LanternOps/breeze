/**
 * #9451 / #7717 item 2 — delivery of an owed (outbox) credit debit. The SQL is
 * proven against real Postgres in aiInvocationSettlement.integration.test.ts;
 * this pins the outcome mapping and the reporting: terminal vs retryable,
 * the same key and amount on every send, per-org storm throttling, and ids an
 * operator can act on (the outbox row id rides as a tag; scrubEvent drops
 * message/extra).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  debit: vi.fn(),
  configured: vi.fn(() => true),
  execute: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('./aiCreditDebitClient', () => ({ debitBillingCredits: m.debit, isBillingServiceConfigured: m.configured }));
vi.mock('./sentry', () => ({ captureMessage: m.captureMessage, captureException: m.captureException }));
vi.mock('../db', () => ({
  db: { execute: m.execute },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import {
  __resetCreditDebitOutboxReportsForTests,
  deliverCreditDebit,
  insertCreditDebitIntent,
  invocationDebitIdempotencyKey,
  retryUndeliveredCreditDebits,
  type CreditDebitIntent,
} from './aiCreditDebitOutbox';

const intent = (over: Partial<CreditDebitIntent> = {}): CreditDebitIntent => ({
  id: 'd1', orgId: 'o1', source: 'compute', idempotencyKey: 'ai-compute:run-1:1', costCents: 13, ...over,
});

/** The SQL text of every db.execute call, flattened. */
function executedSql(): string[] {
  return m.execute.mock.calls.map(([q]) => JSON.stringify(q));
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetCreditDebitOutboxReportsForTests();
  m.configured.mockReturnValue(true);
  m.execute.mockResolvedValue([{ attempts: 1, exhausted: false }]);
});

describe('deliverCreditDebit', () => {
  it('sends the stored key and amount, and stamps it debited', async () => {
    m.debit.mockResolvedValue({ kind: 'debited', replayed: false });
    expect(await deliverCreditDebit(intent())).toBe('debited');
    expect(m.debit).toHaveBeenCalledWith('o1', 13, { idempotencyKey: 'ai-compute:run-1:1' });
    expect(executedSql().some((q) => q.includes('debited_at = now()'))).toBe(true);
  });

  it('a 4xx is terminal: stamped failed and reported with the row id', async () => {
    m.debit.mockResolvedValue({ kind: 'rejected', status: 401, code: 'http_401:unauthorized' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deliverCreditDebit(intent())).toBe('rejected');
    error.mockRestore();
    expect(executedSql().some((q) => q.includes('failed_at = now()'))).toBe(true);
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      eventCode: 'ai_credit_debit_rejected',
      tags: expect.objectContaining({ org_id: 'o1', ai_credit_debit_id: 'd1', ai_credit_debit_source: 'compute', ai_billing_http_status: '401' }),
    }));
  });

  it('a retryable failure is counted for the sweep and not reported until exhausted', async () => {
    m.debit.mockResolvedValue({ kind: 'retryable', status: 503, code: 'http_503:deduct_unconfirmed' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await deliverCreditDebit(intent())).toBe('retry_scheduled');
    expect(m.captureMessage).not.toHaveBeenCalled();

    m.execute.mockResolvedValue([{ attempts: 24, exhausted: true }]);
    expect(await deliverCreditDebit(intent())).toBe('retries_exhausted');
    warn.mockRestore();
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ eventCode: 'ai_credit_debit_retries_exhausted' }));
  });

  it('throttles reports per (event, org), not globally', async () => {
    m.debit.mockResolvedValue({ kind: 'rejected', status: 401, code: 'http_401' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await deliverCreditDebit(intent({ orgId: 'o1' }));
    await deliverCreditDebit(intent({ orgId: 'o2' }));
    await deliverCreditDebit(intent({ orgId: 'o1', id: 'd2' }));
    error.mockRestore();
    expect(m.captureMessage.mock.calls.map(([, o]) => o.tags.org_id)).toEqual(['o1', 'o2']);
  });

  it('no billing service: nothing stamped', async () => {
    m.debit.mockResolvedValue({ kind: 'not_configured' });
    expect(await deliverCreditDebit(intent())).toBe('not_configured');
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('never throws: a bookkeeping failure is reported scrubbed, and the row stays for the sweep', async () => {
    m.debit.mockResolvedValue({ kind: 'debited', replayed: false });
    m.execute.mockRejectedValue(Object.assign(new Error('Failed query: UPDATE ... params: secret'), { params: ['secret'] }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await deliverCreditDebit(intent())).toBe('bookkeeping_failed');
    expect(JSON.stringify(error.mock.calls)).not.toContain('secret');
    error.mockRestore();
    expect(m.captureException).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ org_id: 'o1' }));
  });
});

describe('retryUndeliveredCreditDebits', () => {
  it('does nothing (not even a read) without a billing service', async () => {
    m.configured.mockReturnValue(false);
    expect(await retryUndeliveredCreditDebits()).toBe(0);
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('re-sends every undelivered row under its stored key and amount', async () => {
    m.execute.mockResolvedValueOnce([
      { id: 'd1', org_id: 'o1', source: 'compute', idempotency_key: 'ai-compute:r:1', cost_cents: '13.000000' },
      { id: 'd2', org_id: 'o2', source: 'invocation', idempotency_key: 'ai-invocation:i9', cost_cents: '0.250000' },
    ]);
    m.debit.mockResolvedValue({ kind: 'debited', replayed: true });
    expect(await retryUndeliveredCreditDebits()).toBe(2);
    expect(m.debit.mock.calls).toEqual([
      ['o1', 13, { idempotencyKey: 'ai-compute:r:1' }],
      ['o2', 0.25, { idempotencyKey: 'ai-invocation:i9' }],
    ]);
  });
});

describe('insertCreditDebitIntent', () => {
  it('records nothing on a deployment with no billing service (nothing to owe; no backlog to replay later)', async () => {
    m.configured.mockReturnValue(false);
    expect(await insertCreditDebitIntent({ orgId: 'o1', source: 'compute', sourceId: 'r1', idempotencyKey: 'k', costCents: 1 })).toBeNull();
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('a key that already exists yields no intent (ON CONFLICT DO NOTHING)', async () => {
    m.execute.mockResolvedValueOnce([]);
    expect(await insertCreditDebitIntent({ orgId: 'o1', source: 'compute', sourceId: 'r1', idempotencyKey: 'k', costCents: 1 })).toBeNull();
    expect(executedSql()[0]).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
  });
});

describe('keys', () => {
  it('an unreserved settlement is keyed by its first ledger row', () => {
    expect(invocationDebitIdempotencyKey('i1')).toBe('ai-invocation:i1');
  });
});

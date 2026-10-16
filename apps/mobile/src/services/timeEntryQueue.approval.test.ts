import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  },
}));
vi.mock('@sentry/react-native', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { drain, enqueue, readNeedsAttention, readQueue } from './timeEntryQueue';

const SPAN = { startedAt: '2026-10-01T09:00:00.000Z', endedAt: '2026-10-01T09:40:00.000Z' };

beforeEach(() => store.clear());

// Customer work approval (#8196 W05, plan Review Focus 3). The server records
// and HOLDS finished work, it never refuses it, so a queued create/closeEntry
// must not meet APPROVAL_REQUIRED. If any 409 (this code included) ever
// arrives, the row must be parked for the technician, not dropped and not
// retried in a loop.
describe('queue replay and the approval gate', () => {
  it('queues only finished-span writes, so the start-only gate cannot reach a replay', async () => {
    const { QUEUED_KINDS } = await import('./timeEntryQueue');
    expect(QUEUED_KINDS).not.toContain('start');
    expect(QUEUED_KINDS).not.toContain('stop');
  });

  it('a replayed create that comes back held is a normal success (no refusal path involved)', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    const result = await drain(async () => undefined);
    expect(result).toMatchObject({ sent: 1, remaining: 0, needsAttention: [] });
  });

  it('parks an unexpected 409 APPROVAL_REQUIRED with its code, once, and keeps draining the rest', async () => {
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k1' } });
    await enqueue({ kind: 'create', payload: { ...SPAN, ticketId: 'k2' } });
    const send = vi.fn(async (w: { payload: Record<string, unknown> }) => {
      if (w.payload.ticketId === 'k1') {
        throw Object.assign(new Error('Approval needed'), { statusCode: 409, code: 'APPROVAL_REQUIRED' });
      }
    });
    const result = await drain(send);

    expect(send).toHaveBeenCalledTimes(2); // not looped on the refused row
    expect(result).toMatchObject({ sent: 1, remaining: 0, needsAttentionTotal: 1 });
    const parked = await readNeedsAttention();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ status: 409, code: 'APPROVAL_REQUIRED' });
    expect(parked[0].write.payload).toMatchObject({ ticketId: 'k1', ...SPAN }); // work record kept
    await expect(readQueue()).resolves.toEqual([]);

    // A second pass finds nothing to resend.
    send.mockClear();
    await drain(send);
    expect(send).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  insertedValues: null as Record<string, unknown> | null,
  returnedRows: [] as Array<{ id: string }>,
  conflictHandled: false,
  conflictTarget: null as unknown,
  publishUserEvent: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(() => ({}), { raw: () => ({}) }),
}));

vi.mock('../db/schema', () => ({
  userNotifications: {
    id: 'userNotifications.id',
    userId: 'userNotifications.userId',
    dedupeKey: 'userNotifications.dedupeKey',
    read: 'userNotifications.read',
  },
}));

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        state.insertedValues = values;
        return {
          onConflictDoNothing: vi.fn((opts?: { target?: unknown[] }) => {
            state.conflictHandled = true;
            state.conflictTarget = opts?.target ?? null;
            return { returning: vi.fn(async () => state.returnedRows) };
          }),
        };
      }),
    })),
  },
}));

vi.mock('./eventBus', () => ({
  getEventBus: () => ({ publishUserEvent: state.publishUserEvent }),
}));

import { createNotification } from './userNotifications';

const BASE = {
  userId: 'user-1',
  orgId: 'org-1',
  type: 'approval' as const,
  title: 'Approval requested',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.insertedValues = null;
  state.returnedRows = [{ id: 'n-1' }];
  state.conflictHandled = false;
  state.conflictTarget = null;
  state.publishUserEvent.mockResolvedValue('evt-1');
});

describe('createNotification', () => {
  it('writes the row and nudges only the addressed user', async () => {
    const id = await createNotification({ ...BASE, link: '/approvals', dedupeKey: 'k1' });

    expect(id).toBe('n-1');
    expect(state.insertedValues).toMatchObject({
      userId: 'user-1',
      orgId: 'org-1',
      type: 'approval',
      link: '/approvals',
      dedupeKey: 'k1',
    });
    expect(state.publishUserEvent).toHaveBeenCalledWith(
      'notification.created',
      'org-1',
      'user-1',
      { notificationId: 'n-1' },
      'user-notifications',
    );
  });

  it('sends a CONTENT-FREE payload — the id and nothing else', async () => {
    // The WS transport fans out per org, so anything in this payload crosses
    // every socket in the org before the filter runs. Title and message must
    // never be in it; the client refetches through RLS-protected routes.
    await createNotification({
      ...BASE,
      title: 'Reset the production database',
      message: 'requested by alice@example.com',
      metadata: { intentId: 'i-1' },
    });

    const payload = state.publishUserEvent.mock.calls[0]![3] as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['notificationId']);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('production database');
    expect(serialized).not.toContain('alice@example.com');
  });

  it('targets the dedupe index specifically, not any conflict', async () => {
    // An UNTARGETED onConflictDoNothing would silently swallow a conflict on any
    // unique index the table gains later — notifications vanishing with no log.
    // Asserting merely that "a conflict method was called" was vacuous: the mock
    // only exposes returning() through it, so it could not have been false.
    await createNotification({ ...BASE, dedupeKey: 'k1' });

    expect(state.conflictTarget).toEqual([
      'userNotifications.userId',
      'userNotifications.dedupeKey',
    ]);
  });

  it('returns null and publishes nothing when the insert produced no row', async () => {
    state.returnedRows = [];

    // NB: this exercises the null-guard, not deduplication itself — the empty
    // result is set by hand here. That ON CONFLICT actually suppresses a real
    // duplicate on the partial index is proven against Postgres in
    // userNotificationsRls.integration.test.ts.
    const id = await createNotification({ ...BASE, dedupeKey: 'k1' });

    expect(id).toBeNull();
    // A duplicate must not re-ring the bell — that is the whole point of the key.
    expect(state.publishUserEvent).not.toHaveBeenCalled();
  });

  it('still returns the id when the live nudge fails', async () => {
    // The row is committed and the bell polls every 30s, so a Redis failure
    // costs latency, not the notification — and must never fail the caller,
    // who is usually mid-way through creating an intent.
    state.publishUserEvent.mockRejectedValue(new Error('redis down'));

    await expect(createNotification(BASE)).resolves.toBe('n-1');
  });

  it('DOES NOT AWAIT the nudge — a stalled Redis must not block the caller', async () => {
    // The bus publishes on the maxRetriesPerRequest:null connection, whose
    // offline queue means a publish during an outage never resolves AND never
    // rejects. Awaiting it would hang the four-eyes fan-out loop on the first
    // approver, taking the push dispatch behind it down too, and would hold the
    // caller's Postgres transaction open across the stall (the #1105 pattern).
    let settle: (() => void) | undefined;
    state.publishUserEvent.mockReturnValue(new Promise<string>((resolve) => {
      settle = () => resolve('evt');
    }));

    // Resolves without the publish ever settling.
    await expect(createNotification(BASE)).resolves.toBe('n-1');
    expect(state.publishUserEvent).toHaveBeenCalled();
    settle?.();
  });

  it('defaults priority to normal and nullifies absent optional fields', async () => {
    await createNotification(BASE);

    expect(state.insertedValues).toMatchObject({
      priority: 'normal',
      message: null,
      link: null,
      metadata: null,
      dedupeKey: null,
    });
  });
});

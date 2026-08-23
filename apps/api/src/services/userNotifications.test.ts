import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  insertedValues: null as Record<string, unknown> | null,
  returnedRows: [] as Array<{ id: string }>,
  conflictHandled: false,
  publishUserEvent: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(() => ({}), { raw: () => ({}) }),
}));

vi.mock('../db/schema', () => ({
  userNotifications: { id: 'userNotifications.id', userId: 'u', read: 'r' },
}));

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        state.insertedValues = values;
        return {
          onConflictDoNothing: vi.fn(() => {
            state.conflictHandled = true;
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

import { createNotification, createNotifications } from './userNotifications';

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

  it('always uses onConflictDoNothing so a redelivered key is a no-op', async () => {
    await createNotification({ ...BASE, dedupeKey: 'k1' });
    expect(state.conflictHandled).toBe(true);
  });

  it('returns null and publishes nothing when the dedupe key already existed', async () => {
    state.returnedRows = [];

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

describe('createNotifications — fan-out', () => {
  it('one failure does not cost the other recipients their notification', async () => {
    // A four-eyes fan-out notifies every approver. If approver 2's insert
    // throws, approvers 1 and 3 must still be told.
    let call = 0;
    state.publishUserEvent.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error('boom');
      return 'evt';
    });

    const ids = await createNotifications([
      { ...BASE, userId: 'u1' },
      { ...BASE, userId: 'u2' },
      { ...BASE, userId: 'u3' },
    ]);

    // publishUserEvent failures are swallowed inside createNotification, so all
    // three rows land regardless.
    expect(ids).toHaveLength(3);
  });

  it('skips duplicates without treating them as failures', async () => {
    state.returnedRows = [];

    const ids = await createNotifications([{ ...BASE, userId: 'u1', dedupeKey: 'dup' }]);

    expect(ids).toEqual([]);
  });
});

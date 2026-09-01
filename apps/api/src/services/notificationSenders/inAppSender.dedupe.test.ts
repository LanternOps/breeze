import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertValuesMock = vi.hoisted(() => vi.fn());
const onConflictMock = vi.hoisted(() => vi.fn());
const selectQueue = vi.hoisted(() => ({ rows: [] as unknown[][] }));

// The sender issues three selects (org -> partnerId, org users, partner users)
// and one insert. Hand each select its answer in order; capture the insert.
vi.mock('../../db', () => {
  const thenable = () => {
    const rows = selectQueue.rows.shift() ?? [];
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'where', 'limit']) {
      chain[m] = () => chain;
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(rows);
    return chain;
  };
  return {
    db: {
      select: () => thenable(),
      insert: () => ({
        values: (v: unknown) => {
          insertValuesMock(v);
          return { onConflictDoNothing: onConflictMock };
        }
      })
    }
  };
});

import { sendInAppNotification } from './inAppSender';

const PAYLOAD = {
  alertId: 'alert-1',
  alertName: 'Disk full',
  severity: 'high' as const,
  message: 'Disk is above threshold',
  orgId: 'org-1'
};

describe('in-app alert notifications are durably deduped', () => {
  beforeEach(() => {
    insertValuesMock.mockReset();
    onConflictMock.mockReset();
    onConflictMock.mockResolvedValue(undefined);
    selectQueue.rows = [
      [{ partnerId: 'partner-1' }],                        // org lookup
      [{ userId: 'user-a' }, { userId: 'user-b' }],        // org users
      []                                                    // partner users
    ];
  });

  it('stamps a PER-USER dedupe key so two recipients of one alert both get notified', async () => {
    await sendInAppNotification(PAYLOAD);

    const rows = insertValuesMock.mock.calls.at(-1)?.[0] as Array<{ dedupeKey?: string }>;
    // Per-user, never per-alert: a per-alert key would collide across
    // recipients and silently notify only the first one.
    expect(rows.map((r) => r.dedupeKey)).toEqual([
      'alert:alert-1:user-a',
      'alert:alert-1:user-b'
    ]);
  });

  it('tolerates the conflict instead of throwing, because redelivery is expected', async () => {
    await sendInAppNotification(PAYLOAD);

    // The partial unique index (user_id, dedupe_key) is what actually enforces
    // this; the insert must not treat hitting it as an error.
    expect(onConflictMock).toHaveBeenCalledTimes(1);
  });
});

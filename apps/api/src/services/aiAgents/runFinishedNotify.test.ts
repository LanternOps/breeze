import { beforeEach, describe, expect, it, vi } from 'vitest';

const RUN_ID = '00000000-0000-4000-8000-0000000000e1';
const ORG_ID = '00000000-0000-4000-8000-0000000000e2';
const AGENT_ID = '00000000-0000-4000-8000-0000000000e3';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000e4';
const USER_A = '00000000-0000-4000-8000-0000000000e5';
const USER_B = '00000000-0000-4000-8000-0000000000e6';
const INTENT_ID = '00000000-0000-4000-8000-0000000000e7';

// ---------------------------------------------------------------------------
// db mock (same harness shape as runLoop.test.ts / runService.test.ts)
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  ambientContext: undefined as { scope: string } | undefined,
}));

function nextRows(table: string): unknown[] {
  const queue = dbMockState.rowQueues[table];
  if (!queue || queue.length === 0) throw new Error(`No queued rows for table ${table}`);
  return queue.shift() as unknown[];
}

vi.mock('../../db', () => {
  const makeSelect = () => ({
    from: vi.fn((table: unknown) => {
      const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
      const builder: Record<string, unknown> = {
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => nextRows(tableName)).then(resolve, reject),
      };
      return builder;
    }),
  });

  return {
    db: { select: vi.fn(() => makeSelect()) },
    getCurrentDbAccessContext: vi.fn(() => dbMockState.ambientContext),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
      const previous = dbMockState.ambientContext;
      dbMockState.ambientContext = { scope: 'system' };
      try {
        return await fn();
      } finally {
        dbMockState.ambientContext = previous;
      }
    }),
  };
});

const resolveRecipientUserIds = vi.hoisted(() =>
  vi.fn<(agent: unknown, orgId: string) => Promise<string[]>>());
vi.mock('./recipients', () => ({ resolveRecipientUserIds }));

const createNotification = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<string | null>>());
vi.mock('../userNotifications', () => ({ createNotification }));

import { deliverRunFinishedNotifications } from './runFinishedNotify';

function queueRows(table: string, rows: unknown[]): void {
  dbMockState.rowQueues[table] = dbMockState.rowQueues[table] ?? [];
  dbMockState.rowQueues[table]!.push(rows);
}

const baseRun = {
  id: RUN_ID,
  orgId: ORG_ID,
  agentId: AGENT_ID,
  status: 'completed',
  summary: 'Investigated the disk alert.\nFreed 12GB on C:.',
  outcome: { toolExecutionCount: 2 },
  intentIds: [] as string[],
  policySnapshot: { effective: { recipients: { userIds: [], roleIds: [] } } },
};

const baseAgent = { id: AGENT_ID, orgId: ORG_ID, partnerId: PARTNER_ID, name: 'Front Desk Triage' };

beforeEach(() => {
  dbMockState.rowQueues = {};
  dbMockState.ambientContext = undefined;
  resolveRecipientUserIds.mockReset().mockResolvedValue([]);
  createNotification.mockReset().mockResolvedValue('notification-1');
});

describe('deliverRunFinishedNotifications', () => {
  it('creates one notification per resolved recipient with the structured metadata shape', async () => {
    queueRows('ai_agent_runs', [baseRun]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A, USER_B]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification.mock.calls.map(([input]) => (input as { userId: string }).userId))
      .toEqual([USER_A, USER_B]);
    const [firstInput] = createNotification.mock.calls[0]!;
    expect(firstInput).toMatchObject({
      userId: USER_A,
      orgId: ORG_ID,
      type: 'ai',
      title: 'Agent run finished',
      message: 'Front Desk Triage: Investigated the disk alert.',
      link: null,
      dedupeKey: `agent-run:${RUN_ID}`,
      metadata: {
        runId: RUN_ID,
        agentId: AGENT_ID,
        intentIds: [],
        status: 'completed',
        executedActionCount: 2,
        verdict: null,
      },
    });
  });

  it('links to /approvals only when the run left intents pending', async () => {
    queueRows('ai_agent_runs', [{ ...baseRun, status: 'awaiting_approval', intentIds: [INTENT_ID] }]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);

    await deliverRunFinishedNotifications(RUN_ID);

    const [input] = createNotification.mock.calls[0]!;
    expect((input as { link: string | null }).link).toBe('/approvals');
    expect((input as { metadata: { status: string } }).metadata.status).toBe('awaiting_approval');
  });

  it('resolves recipients from the run policy snapshot, not the agent row', async () => {
    queueRows('ai_agent_runs', [{
      ...baseRun,
      policySnapshot: { effective: { recipients: { userIds: [USER_A, USER_B], roleIds: [] } } },
    }]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A, USER_B]);

    await deliverRunFinishedNotifications(RUN_ID);

    expect(resolveRecipientUserIds).toHaveBeenCalledWith(
      { orgId: ORG_ID, partnerId: PARTNER_ID, recipients: { userIds: [USER_A, USER_B], roleIds: [] } },
      ORG_ID,
    );
  });

  it('is a silent no-op when the run no longer exists', async () => {
    queueRows('ai_agent_runs', []);
    await expect(deliverRunFinishedNotifications(RUN_ID)).resolves.toBeUndefined();
    expect(resolveRecipientUserIds).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('is a silent no-op when the run is not (yet) in a terminal status', async () => {
    queueRows('ai_agent_runs', [{ ...baseRun, status: 'running' }]);
    queueRows('ai_agents', [baseAgent]);

    await expect(deliverRunFinishedNotifications(RUN_ID)).resolves.toBeUndefined();

    expect(resolveRecipientUserIds).not.toHaveBeenCalled();
  });

  it('is a silent no-op when zero recipients resolve', async () => {
    queueRows('ai_agent_runs', [baseRun]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([]);

    await expect(deliverRunFinishedNotifications(RUN_ID)).resolves.toBeUndefined();

    expect(createNotification).not.toHaveBeenCalled();
  });

  it('THROWS when recipient resolution fails — the caller decides retry policy', async () => {
    queueRows('ai_agent_runs', [baseRun]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockRejectedValue(new Error('membership lookup failed'));

    await expect(deliverRunFinishedNotifications(RUN_ID)).rejects.toThrow('membership lookup failed');
  });

  it('THROWS when a notification write fails', async () => {
    queueRows('ai_agent_runs', [baseRun]);
    queueRows('ai_agents', [baseAgent]);
    resolveRecipientUserIds.mockResolvedValue([USER_A]);
    createNotification.mockRejectedValue(new Error('notifications table unavailable'));

    await expect(deliverRunFinishedNotifications(RUN_ID)).rejects.toThrow('notifications table unavailable');
  });
});

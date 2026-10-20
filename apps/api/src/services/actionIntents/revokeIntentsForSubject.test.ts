import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const selectQueue: unknown[][] = [];
  const updateQueue: unknown[][] = [];
  return {
    calls,
    selectQueue,
    updateQueue,
    publishMock: vi.fn(),
    cancelledOpMock: vi.fn(),
    linkMock: vi.fn(),
    withSystem: vi.fn(),
  };
});

function selectChain(): unknown {
  const result = h.selectQueue.shift() ?? [];
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit']) chain[m] = () => chain;
  chain.for = (mode: string) => {
    h.calls.push(`select-for-${mode}`);
    return chain;
  };
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(result).then(res, rej);
  return chain;
}

vi.mock('../../db', () => ({
  db: {
    select: () => {
      h.calls.push('select');
      return selectChain();
    },
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            h.calls.push(`cas:${String(v.status)}`);
            return h.updateQueue.shift() ?? [];
          },
        }),
      }),
    }),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>, label?: string) => {
    h.withSystem(label);
    return fn();
  },
}));

vi.mock('../aiOperator/operationService', () => ({
  isTaskLinkedIntent: (i: { taskId?: string | null }) => i.taskId != null,
  markOperationCancelled: (...a: unknown[]) => {
    h.calls.push('markOperationCancelled');
    return h.cancelledOpMock(...a);
  },
}));
vi.mock('../aiOperator/taskOutbox', () => ({
  publishIntentTerminalOutbox: (...a: unknown[]) => {
    h.calls.push('publish');
    return h.publishMock(...a);
  },
}));
vi.mock('../callerVerification/incidentLinks', () => ({
  linkCallerIncidentIntents: (...a: unknown[]) => {
    h.calls.push('link');
    return h.linkMock(...a);
  },
}));

import { revokeIntentsForSubject } from './revokeIntentsForSubject';

const ORG = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';
const BINDING = '33333333-3333-4333-8333-333333333333';

const intent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  orgId: ORG,
  taskId: null,
  ...extra,
});

describe('revokeIntentsForSubject', () => {
  beforeEach(() => {
    h.calls.length = 0;
    h.selectQueue.length = 0;
    h.updateQueue.length = 0;
    h.publishMock.mockReset();
    h.cancelledOpMock.mockReset();
    h.linkMock.mockReset();
    h.withSystem.mockReset();
  });

  it('returns three empty lists without querying for an empty binding set', async () => {
    const r = await revokeIntentsForSubject({ orgId: ORG, bindingIds: [], verificationId: VID });
    expect(r).toEqual({ cancelled: [], alreadyExecuting: [], alreadyDispatched: [] });
    expect(h.withSystem).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it('cancels a won CAS, publishes the outbox event, and links the incident', async () => {
    h.selectQueue.push([intent('i1')]);
    h.updateQueue.push([{ id: 'i1' }]);

    const r = await revokeIntentsForSubject({ orgId: ORG, bindingIds: [BINDING], verificationId: VID });

    expect(r).toEqual({ cancelled: ['i1'], alreadyExecuting: [], alreadyDispatched: [] });
    expect(h.publishMock).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'i1', orgId: ORG, taskId: null },
      'intent_cancelled',
    );
    expect(h.cancelledOpMock).not.toHaveBeenCalled();
    expect(h.linkMock).toHaveBeenCalledWith(ORG, VID, ['i1']);
    expect(h.calls.indexOf('link')).toBeGreaterThan(h.calls.indexOf('publish'));
  });

  it('classifies lost CAS rows and never publishes for them', async () => {
    h.selectQueue.push([intent('exec'), intent('disp'), intent('done')]);
    h.updateQueue.push([], [], []);
    // Re-reads, one per lost CAS.
    h.selectQueue.push([{ status: 'executing', dispatchStartedAt: null }]);
    h.selectQueue.push([{ status: 'executing', dispatchStartedAt: new Date() }]);
    h.selectQueue.push([{ status: 'completed', dispatchStartedAt: null }]);

    const r = await revokeIntentsForSubject({ orgId: ORG, bindingIds: [BINDING], verificationId: VID });

    expect(r).toEqual({ cancelled: [], alreadyExecuting: ['exec'], alreadyDispatched: ['disp'] });
    expect(h.publishMock).not.toHaveBeenCalled();
    expect(h.linkMock).toHaveBeenCalledWith(ORG, VID, ['exec', 'disp', 'done']);
  });

  it('classifies dispatchStartedAt as alreadyDispatched even when no longer executing', async () => {
    h.selectQueue.push([intent('x')]);
    h.updateQueue.push([]);
    h.selectQueue.push([{ status: 'failed', dispatchStartedAt: new Date() }]);

    const r = await revokeIntentsForSubject({ orgId: ORG, bindingIds: [BINDING], verificationId: VID });

    expect(r.alreadyDispatched).toEqual(['x']);
  });

  it('locks the operation row before the intent CAS for task-linked intents', async () => {
    h.selectQueue.push([intent('t1', { taskId: 'task-1' })]);
    h.selectQueue.push([{ id: 'op-1' }]); // operation lock read
    h.updateQueue.push([{ id: 't1' }]);

    const r = await revokeIntentsForSubject({ orgId: ORG, bindingIds: [BINDING], verificationId: VID });

    expect(r.cancelled).toEqual(['t1']);
    const lock = h.calls.indexOf('select-for-update');
    const cas = h.calls.indexOf('cas:cancelled');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(cas);
    expect(h.cancelledOpMock).toHaveBeenCalledWith(expect.anything(), 't1');
    expect(h.calls.indexOf('markOperationCancelled')).toBeGreaterThan(cas);
    expect(h.calls.indexOf('publish')).toBeGreaterThan(cas);
  });

  it('does not lock an operation row for non-task intents', async () => {
    h.selectQueue.push([intent('i1')]);
    h.updateQueue.push([{ id: 'i1' }]);
    await revokeIntentsForSubject({ orgId: ORG, bindingIds: [BINDING], verificationId: VID });
    expect(h.calls).not.toContain('select-for-update');
  });
});

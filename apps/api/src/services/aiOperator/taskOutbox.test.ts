import { describe, it, expect, vi, beforeEach } from 'vitest';

// #5205 W05 (#5210), spec §6.3: `taskOutbox.ts` is the ONE helper every
// terminal writer calls. This suite proves its two contracts in isolation
// (mocked `db`, no real dialect): `enqueueTaskOutbox` names the identity
// unique as its ON CONFLICT target (the dedupe guarantee), and
// `publishIntentTerminalOutbox` writes `intent_outbox` UNCONDITIONALLY but
// only enqueues the task_outbox leg when the intent is task-linked.
const { intentOutboxValuesMock, taskOutboxValuesMock, onConflictDoNothingMock, insertMock } = vi.hoisted(() => {
  const onConflictDoNothingMock = vi.fn(() => Promise.resolve());
  const taskOutboxValuesMock = vi.fn(() => ({ onConflictDoNothing: onConflictDoNothingMock }));
  const intentOutboxValuesMock = vi.fn(() => Promise.resolve());
  return {
    intentOutboxValuesMock,
    taskOutboxValuesMock,
    onConflictDoNothingMock,
    // Discriminates which table's `.insert(...)` call this is by inspecting
    // the table reference identity (set up in the mock factory below).
    insertMock: vi.fn(),
  };
});

vi.mock('../../db', async () => {
  return {
    db: {
      insert: insertMock,
    },
  };
});

// Tool catalog W04 (#5219): the terminal-wake fan-in. Mocked at the module
// boundary; its own after-commit semantics are pinned by flows/wake.test.ts.
const { scheduleFlowRunWakeMock } = vi.hoisted(() => ({ scheduleFlowRunWakeMock: vi.fn() }));
vi.mock('../flows/wake', () => ({ scheduleFlowRunWake: scheduleFlowRunWakeMock }));

vi.mock('../../db/schema/aiOperatorTasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema/aiOperatorTasks')>();
  return { ...actual };
});

import { aiOperatorTaskOutbox } from '../../db/schema/aiOperatorTasks';
import { intentOutbox } from '../../db/schema/actionIntents';
import {
  enqueueTaskOutbox,
  publishIntentTerminalOutbox,
  INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ,
} from './taskOutbox';

beforeEach(() => {
  vi.clearAllMocks();
  insertMock.mockImplementation((table: unknown) => {
    if (table === aiOperatorTaskOutbox) {
      return { values: taskOutboxValuesMock };
    }
    if (table === intentOutbox) {
      return { values: intentOutboxValuesMock };
    }
    throw new Error('insert() called with an unexpected table');
  });
});

describe('enqueueTaskOutbox', () => {
  it('inserts with the identity columns as the ON CONFLICT target (dedupe contract)', async () => {
    await enqueueTaskOutbox(
      { insert: insertMock } as never,
      { orgId: 'org-1', taskId: 'task-1', sourceKind: 'intent', sourceId: 'intent-1', transitionSeq: 1 },
    );

    expect(taskOutboxValuesMock).toHaveBeenCalledWith({
      orgId: 'org-1',
      taskId: 'task-1',
      sourceKind: 'intent',
      sourceId: 'intent-1',
      transitionSeq: 1,
    });
    expect(onConflictDoNothingMock).toHaveBeenCalledWith({
      target: [
        aiOperatorTaskOutbox.orgId,
        aiOperatorTaskOutbox.taskId,
        aiOperatorTaskOutbox.sourceKind,
        aiOperatorTaskOutbox.sourceId,
        aiOperatorTaskOutbox.transitionSeq,
      ],
    });
  });
});

describe('publishIntentTerminalOutbox', () => {
  it('always writes an intent_outbox row with an ids-only payload', async () => {
    await publishIntentTerminalOutbox(
      { insert: insertMock } as never,
      { id: 'intent-1', orgId: 'org-1', taskId: null, requestingFlowRunId: null },
      'intent_completed',
    );

    expect(intentOutboxValuesMock).toHaveBeenCalledWith({
      intentId: 'intent-1',
      eventType: 'intent_completed',
      payload: { intentId: 'intent-1', orgId: 'org-1' },
    });
  });

  it('does NOT enqueue a task_outbox row for a legacy (non-task-linked) intent', async () => {
    await publishIntentTerminalOutbox(
      { insert: insertMock } as never,
      { id: 'intent-1', orgId: 'org-1', taskId: null, requestingFlowRunId: null },
      'intent_failed',
    );

    expect(taskOutboxValuesMock).not.toHaveBeenCalled();
  });

  it('enqueues a task_outbox row for a task-linked intent, with the terminal-status ordinal as transitionSeq', async () => {
    await publishIntentTerminalOutbox(
      { insert: insertMock } as never,
      { id: 'intent-1', orgId: 'org-1', taskId: 'task-1', requestingFlowRunId: null },
      'intent_completed',
    );

    expect(taskOutboxValuesMock).toHaveBeenCalledWith({
      orgId: 'org-1',
      taskId: 'task-1',
      sourceKind: 'intent',
      sourceId: 'intent-1',
      transitionSeq: INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ.intent_completed,
    });
  });

  it('wakes the flow run of a flow-origin intent, once, alongside the intent_outbox row', async () => {
    const runId = '0b5b3f0e-6a55-4a59-9d8e-3c2b1a000001';
    await publishIntentTerminalOutbox(
      { insert: insertMock } as never,
      { id: 'intent-1', orgId: 'org-1', taskId: null, requestingFlowRunId: runId },
      'intent_cancelled',
    );
    expect(intentOutboxValuesMock).toHaveBeenCalledTimes(1);
    expect(scheduleFlowRunWakeMock).toHaveBeenCalledTimes(1);
    expect(scheduleFlowRunWakeMock).toHaveBeenCalledWith(runId);
  });

  it('wakes nothing for a non-flow intent', async () => {
    await publishIntentTerminalOutbox(
      { insert: insertMock } as never,
      { id: 'intent-1', orgId: 'org-1', taskId: null, requestingFlowRunId: null },
      'intent_completed',
    );
    expect(scheduleFlowRunWakeMock).not.toHaveBeenCalled();
  });

  it('gives every terminal event a DISTINCT transitionSeq ordinal', () => {
    const values = Object.values(INTENT_TERMINAL_OUTBOX_TRANSITION_SEQ);
    expect(new Set(values).size).toBe(values.length);
  });
});

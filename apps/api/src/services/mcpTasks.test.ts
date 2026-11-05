/**
 * B-W06 (#6160, D-B49/D-B52): the task projection over an `mcp_api` action
 * intent. Pure: the real `toMcpActionStatus` runs (it is part of the
 * contract — task status comes only from its output).
 */
import { describe, expect, it } from 'vitest';

import type { ActionIntentStatus } from '../db/schema/actionIntents';
import { buildTerminalActionResult, toMcpActionStatus } from './mcpActionStatus';
import {
  MCP_TASK_FOLLOW_UP_TOOLS,
  MCP_TASK_ID_MAX_CHARS,
  MCP_TASK_NOT_FOUND,
  MCP_TASKS_EXTENSION_ID,
  budgetedPollIntervalMs,
  buildCreateTaskResult,
  buildTasksExtensionRequiredData,
  toMcpTask,
  type McpTaskKnobs,
} from './mcpTasks';

const ID = '77777777-7777-4777-8777-777777777777';
const BASE = 'https://app.example.com';
const CREATED = new Date('2026-10-24T10:00:00.000Z');
const EXPIRES = new Date('2026-10-25T10:00:00.000Z');
const KNOBS_1_LIVE: McpTaskKnobs = { pendingPollMs: 30_000, runningPollMs: 5_000, ttlGraceMs: 3_600_000, liveCount: 1, perMinuteLimit: 120 };

type Row = Parameters<typeof toMcpTask>[0];
function intent(over: Partial<Record<keyof Row, unknown>> = {}): Row {
  return {
    id: ID,
    status: 'pending_approval',
    actionName: 'execute_command',
    approvalScope: 'four_eyes',
    createdAt: CREATED,
    expiresAt: EXPIRES,
    decidedAt: null,
    executionStartedAt: null,
    executedAt: null,
    statusChangedAt: new Date('2026-10-24T10:00:01.000Z'),
    result: null,
    errorCode: null,
    ...over,
  } as Row;
}

const ALL_STATUSES: ActionIntentStatus[] = [
  'pending_approval', 'approved', 'executing', 'completed', 'failed', 'rejected', 'expired', 'cancelled',
];

describe('toMcpTask status table (D-B49)', () => {
  it.each([
    ['pending_approval', 'working', 30_000],
    ['approved', 'working', 5_000],
    ['executing', 'working', 5_000],
    ['completed', 'completed', undefined],
    ['failed', 'completed', undefined],
    ['rejected', 'completed', undefined],
    ['expired', 'completed', undefined],
    ['cancelled', 'cancelled', undefined],
  ])('intent %s → task %s (poll %s)', (s, t, poll) => {
    const task = toMcpTask(intent({ status: s }), BASE, KNOBS_1_LIVE);
    expect(task.status).toBe(t);
    expect(task.pollIntervalMs).toBe(poll);
    expect(task.taskId).toBe(ID);
  });

  it('never produces failed or input_required', () => {
    for (const s of ALL_STATUSES) {
      const task = toMcpTask(intent({ status: s, errorCode: 'boom' }), BASE, KNOBS_1_LIVE);
      expect(['working', 'completed', 'cancelled']).toContain(task.status);
    }
  });

  it('pending statusMessage carries the approval URL', () => {
    expect(toMcpTask(intent({ status: 'pending_approval' }), BASE, KNOBS_1_LIVE).statusMessage)
      .toBe(`Waiting for approval in the Breeze mobile or web app: ${BASE}/approvals#intent-${ID}`);
  });

  it('approved/executing statusMessage says it is running', () => {
    expect(toMcpTask(intent({ status: 'approved' }), BASE, KNOBS_1_LIVE).statusMessage).toBe('Approved — running.');
    expect(toMcpTask(intent({ status: 'executing' }), BASE, KNOBS_1_LIVE).statusMessage).toBe('Approved — running.');
  });

  it.each(['completed', 'failed', 'rejected', 'expired'] as const)(
    '%s result equals buildTerminalActionResult(toMcpActionStatus(...))',
    (s) => {
      const row = intent({ status: s, result: s === 'completed' ? { ok: 1 } : null, errorCode: s === 'failed' ? 'boom' : null });
      const task = toMcpTask(row, BASE, KNOBS_1_LIVE);
      expect(task.result).toEqual(buildTerminalActionResult(toMcpActionStatus(row, BASE)));
      expect(JSON.stringify(task.result)).toBe(JSON.stringify(buildTerminalActionResult(toMcpActionStatus(row, BASE))));
      expect(Boolean(task.result!.isError)).toBe(s !== 'completed');
    },
  );

  it('working and cancelled tasks carry no result', () => {
    for (const s of ['pending_approval', 'approved', 'executing', 'cancelled'] as const) {
      expect(toMcpTask(intent({ status: s }), BASE, KNOBS_1_LIVE)).not.toHaveProperty('result');
    }
  });

  it('failed with executedAt → isError result carrying outcomeUncertain true', () => {
    const task = toMcpTask(intent({ status: 'failed', errorCode: 'boom', executedAt: new Date('2026-10-24T10:05:00.000Z') }), BASE, KNOBS_1_LIVE);
    expect(task.status).toBe('completed');
    expect(task.result!.isError).toBe(true);
    expect((task.result!.structuredContent as Record<string, unknown>).outcomeUncertain).toBe(true);
    expect((task.result!.structuredContent as Record<string, unknown>).errorCode).toBe('boom');
  });

  it('secret-bearing task result is withheld', () => {
    const secret = 'S3cr3t-Temp-Pw-9f8e7d';
    const task = toMcpTask(intent({
      status: 'completed', actionName: 'm365_reset_password', result: { temporaryPassword: secret, upn: 'bob@example.com' },
    }), BASE, KNOBS_1_LIVE);
    expect((task.result!.structuredContent as Record<string, unknown>).resultWithheld).toBe('secret_bearing');
    const json = JSON.stringify(task);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('bob@example.com');
  });

  it('completed with result nulled by retention reports status text only', () => {
    const task = toMcpTask(intent({ status: 'completed', result: null }), BASE, KNOBS_1_LIVE);
    expect(task.status).toBe('completed');
    expect(task.result!.isError).toBeUndefined();
    const status = toMcpActionStatus(intent({ status: 'completed', result: null }), BASE);
    expect(task.result!.content).toEqual([{ type: 'text', text: JSON.stringify(status) }]);
    expect(task.result!.structuredContent).not.toHaveProperty('result');
  });
});

describe('follow-up tools (D-B49/D-B56)', () => {
  it('the map is closed', () => {
    expect(Object.keys(MCP_TASK_FOLLOW_UP_TOOLS).sort()).toEqual(['execute_dr_plan', 'manage_patches', 'run_script', 'trigger_backup']);
    expect(Object.isFrozen(MCP_TASK_FOLLOW_UP_TOOLS)).toBe(true);
  });

  it.each([
    ['execute_dr_plan', 'get_dr_execution_status'],
    ['trigger_backup', 'get_backup_status'],
    ['manage_patches', 'manage_patches (action "device_history")'],
  ])('%s completion names %s', (tool, poll) => {
    const task = toMcpTask(intent({ status: 'completed', actionName: tool, result: { jobId: 'j-1' } }), BASE, KNOBS_1_LIVE);
    expect(task.statusMessage).toBe(`Started. The device operation may still be running — check it with ${poll}.`);
  });

  it('run_script names get_script_execution only on timeout', () => {
    const timedOut = toMcpTask(intent({ status: 'completed', actionName: 'run_script', result: { status: 'timeout', executionId: 'e-1' } }), BASE, KNOBS_1_LIVE);
    expect(timedOut.statusMessage).toBe('Started. The device operation may still be running — check it with get_script_execution.');
    const done = toMcpTask(intent({ status: 'completed', actionName: 'run_script', result: { status: 'completed', exitCode: 0 } }), BASE, KNOBS_1_LIVE);
    expect(done).not.toHaveProperty('statusMessage');
  });

  it('no follow-up message on an error outcome or for other tools', () => {
    expect(toMcpTask(intent({ status: 'failed', actionName: 'execute_dr_plan' }), BASE, KNOBS_1_LIVE)).not.toHaveProperty('statusMessage');
    expect(toMcpTask(intent({ status: 'completed', actionName: 'execute_command', result: { ok: 1 } }), BASE, KNOBS_1_LIVE)).not.toHaveProperty('statusMessage');
  });
});

describe('times (D-B49)', () => {
  it('createdAt is the row created_at', () => {
    expect(toMcpTask(intent(), BASE, KNOBS_1_LIVE).createdAt).toBe('2026-10-24T10:00:00.000Z');
  });

  it('lastUpdatedAt prefers statusChangedAt; falls back to the latest stamp when null', () => {
    const decided = new Date('2026-10-24T11:00:00.000Z');
    const started = new Date('2026-10-24T11:00:05.000Z');
    const executed = new Date('2026-10-24T11:00:30.000Z');
    const stamped = new Date('2026-10-24T11:00:31.000Z');
    expect(toMcpTask(intent({ status: 'completed', decidedAt: decided, executionStartedAt: started, executedAt: executed, statusChangedAt: stamped }), BASE, KNOBS_1_LIVE).lastUpdatedAt)
      .toBe('2026-10-24T11:00:31.000Z');
    expect(toMcpTask(intent({ status: 'completed', decidedAt: decided, executionStartedAt: started, executedAt: executed, statusChangedAt: null }), BASE, KNOBS_1_LIVE).lastUpdatedAt)
      .toBe('2026-10-24T11:00:30.000Z');
    expect(toMcpTask(intent({ statusChangedAt: null }), BASE, KNOBS_1_LIVE).lastUpdatedAt).toBe('2026-10-24T10:00:00.000Z');
  });

  it('ttlMs = expiresAt - createdAt + grace', () => {
    expect(toMcpTask(intent(), BASE, KNOBS_1_LIVE).ttlMs).toBe(24 * 3_600_000 + 3_600_000);
    expect(toMcpTask(intent(), BASE, { ...KNOBS_1_LIVE, ttlGraceMs: 60_000 }).ttlMs).toBe(24 * 3_600_000 + 60_000);
  });
});

describe('budget (D-B52)', () => {
  it('poll interval honours the message budget', () => {
    expect(budgetedPollIntervalMs(5_000, 20, 120)).toBe(20_000);
    expect(budgetedPollIntervalMs(30_000, 1, 120)).toBe(30_000);
  });

  it('20 live tasks on one credential stay within half of a 120/min budget', () => {
    for (const base of [1_000, 5_000, 30_000]) {
      const interval = budgetedPollIntervalMs(base, 20, 120);
      expect(interval).toBeGreaterThanOrEqual(20_000);
      expect((20 * 60_000) / interval).toBeLessThanOrEqual(60);
    }
  });

  it('degenerate inputs never divide by zero or go below the base', () => {
    expect(budgetedPollIntervalMs(5_000, 0, 120)).toBe(5_000);
    expect(budgetedPollIntervalMs(5_000, 3, 1)).toBe(180_000);
    expect(budgetedPollIntervalMs(5_000, 3, 0)).toBe(180_000);
    expect(budgetedPollIntervalMs(5_000, 3, -10)).toBe(180_000);
  });

  it('the task poll interval uses the live count', () => {
    expect(toMcpTask(intent({ status: 'executing' }), BASE, { ...KNOBS_1_LIVE, liveCount: 20 }).pollIntervalMs).toBe(20_000);
    expect(toMcpTask(intent({ status: 'pending_approval' }), BASE, { ...KNOBS_1_LIVE, liveCount: 20 }).pollIntervalMs).toBe(30_000);
    expect(toMcpTask(intent({ status: 'pending_approval' }), BASE, { ...KNOBS_1_LIVE, liveCount: 60 }).pollIntervalMs).toBe(60_000);
  });
});

describe('wire helpers', () => {
  it('buildCreateTaskResult has resultType task and no result', () => {
    const task = toMcpTask(intent(), BASE, KNOBS_1_LIVE);
    expect(buildCreateTaskResult(task)).toEqual({
      resultType: 'task',
      taskId: ID,
      status: 'working',
      statusMessage: `Waiting for approval in the Breeze mobile or web app: ${BASE}/approvals#intent-${ID}`,
      createdAt: '2026-10-24T10:00:00.000Z',
      lastUpdatedAt: '2026-10-24T10:00:01.000Z',
      ttlMs: 25 * 3_600_000,
      pollIntervalMs: 30_000,
    });
    const done = toMcpTask(intent({ status: 'completed', result: { ok: 1 } }), BASE, KNOBS_1_LIVE);
    expect(buildCreateTaskResult(done)).not.toHaveProperty('result');
    expect(buildCreateTaskResult(done).resultType).toBe('task');
  });

  it('not-found, id cap, extension id and the -32021 data', () => {
    expect(MCP_TASK_NOT_FOUND).toEqual({ reason: 'not_found' });
    expect(MCP_TASK_ID_MAX_CHARS).toBe(64);
    expect(MCP_TASKS_EXTENSION_ID).toBe('io.modelcontextprotocol/tasks');
    expect(buildTasksExtensionRequiredData()).toEqual({
      requiredCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
    });
  });
});

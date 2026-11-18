import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const RUN_ID = '00000000-0000-4000-8000-0000000000c1';
const AGENT_ID = '00000000-0000-4000-8000-0000000000c2';
const ORG_ID = '00000000-0000-4000-8000-0000000000c3';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000c4';
const SESSION_ID = '00000000-0000-4000-8000-0000000000c5';
const EXISTING_SESSION_ID = '00000000-0000-4000-8000-0000000000c6';
const EXECUTION_ID = '00000000-0000-4000-8000-0000000000c7';

interface CapturedInsert {
  table: string;
  values: Record<string, unknown>;
}
interface CapturedUpdate {
  table: string;
  values: Record<string, unknown>;
  where?: SQL;
}
interface CapturedSelect {
  table: string;
  where?: SQL;
}

const dbMockState = vi.hoisted(() => ({
  inserts: [] as CapturedInsert[],
  /** FIFO of rows returned by the NEXT insert().returning() for a table. */
  insertReturningQueues: {} as Record<string, unknown[][]>,
  updates: [] as CapturedUpdate[],
  /** FIFO of rows returned by the NEXT update().returning() for a table. */
  updateReturningQueues: {} as Record<string, unknown[][]>,
  selects: [] as CapturedSelect[],
  /** FIFO of rows returned by the NEXT select() for a table. */
  selectQueues: {} as Record<string, unknown[][]>,
  systemContextDepth: 0,
  ambientContext: undefined as { scope: string } | undefined,
  contextDuringWrites: [] as string[],
}));

function shift(queues: Record<string, unknown[][]>, table: string): unknown[] {
  const q = queues[table];
  if (!q || q.length === 0) throw new Error(`No queued rows for ${table}`);
  return q.shift() as unknown[];
}

function tableName(table: unknown): string {
  return String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
}

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn((table: unknown) => {
      const name = tableName(table);
      return {
        values: vi.fn((values: Record<string, unknown>) => {
          dbMockState.inserts.push({ table: name, values });
          dbMockState.contextDuringWrites.push(
            dbMockState.systemContextDepth > 0 ? 'system' : 'none',
          );
          return {
            returning: vi.fn(async () => shift(dbMockState.insertReturningQueues, name)),
          };
        }),
      };
    }),
    update: vi.fn((table: unknown) => {
      const name = tableName(table);
      return {
        set: vi.fn((values: Record<string, unknown>) => {
          dbMockState.contextDuringWrites.push(
            dbMockState.systemContextDepth > 0 ? 'system' : 'none',
          );
          return {
            where: vi.fn((cond: SQL) => {
              dbMockState.updates.push({ table: name, values, where: cond });
              return {
                returning: vi.fn(async () => shift(dbMockState.updateReturningQueues, name)),
                // Plain updates (completeToolExecution, closeAgentRunSession)
                // don't call .returning() — awaiting the builder itself resolves.
                then: (resolve: (v: unknown) => unknown) => Promise.resolve().then(() => resolve(undefined)),
              };
            }),
          };
        }),
      };
    }),
    select: vi.fn((cols: unknown) => ({
      from: vi.fn((table: unknown) => {
        const name = tableName(table);
        const captured: CapturedSelect = { table: name };
        dbMockState.selects.push(captured);
        void cols;
        const builder = {
          where: vi.fn((cond: SQL) => {
            captured.where = cond;
            return builder;
          }),
          limit: vi.fn(() => Promise.resolve(shift(dbMockState.selectQueues, name))),
        };
        return builder;
      }),
    })),
  },
  getCurrentDbAccessContext: vi.fn(() => dbMockState.ambientContext),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const previous = dbMockState.ambientContext;
    dbMockState.ambientContext = { scope: 'system' };
    dbMockState.systemContextDepth += 1;
    try {
      return await fn();
    } finally {
      dbMockState.systemContextDepth -= 1;
      dbMockState.ambientContext = previous;
    }
  }),
}));

import {
  closeAgentRunSession,
  completeToolExecution,
  createAgentRunSession,
  LEDGER_ERROR_WITHOUT_TEXT,
  reconcileHungExecutions,
  recordRunAssistantTurn,
  recordRunTaskPrompt,
  startToolExecution,
  toolErrorTextForLedger,
} from './executionLedger';
import { redactSensitiveToolInput } from '../aiToolOutput';

const dialect = new PgDialect();
function compiled(cond: SQL | undefined): string {
  if (!cond) return '';
  return dialect.sqlToQuery(cond).sql;
}

beforeEach(() => {
  dbMockState.inserts = [];
  dbMockState.insertReturningQueues = {};
  dbMockState.updates = [];
  dbMockState.updateReturningQueues = {};
  dbMockState.selects = [];
  dbMockState.selectQueues = {};
  dbMockState.systemContextDepth = 0;
  dbMockState.ambientContext = undefined;
  dbMockState.contextDuringWrites = [];
  vi.clearAllMocks();
});

describe('createAgentRunSession', () => {
  it('inserts an ai_sessions row with type agent, agentId, and no userId, then CAS-links the run', async () => {
    dbMockState.insertReturningQueues.ai_sessions = [[{ id: SESSION_ID }]];
    dbMockState.updateReturningQueues.ai_agent_runs = [[{ id: RUN_ID }]];

    const result = await createAgentRunSession({
      runId: RUN_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      model: 'claude-sonnet-4-5-20250929',
      maxTurns: 40,
    });

    expect(result).toBe(SESSION_ID);
    expect(dbMockState.inserts).toHaveLength(1);
    const insertedValues = dbMockState.inserts[0]!.values;
    expect(insertedValues).toMatchObject({
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      agentId: AGENT_ID,
      type: 'agent',
      model: 'claude-sonnet-4-5-20250929',
      maxTurns: 40,
      status: 'active',
    });
    expect(insertedValues).not.toHaveProperty('userId');

    // Exactly one update against ai_agent_runs — the CAS.
    const casUpdate = dbMockState.updates.find((u) => u.table === 'ai_agent_runs');
    expect(casUpdate).toBeDefined();
    expect(casUpdate!.values).toEqual({ sessionId: SESSION_ID });
    const casSql = compiled(casUpdate!.where);
    expect(casSql).toContain('session_id');

    // All writes ran under a system db context.
    expect(dbMockState.contextDuringWrites.every((c) => c === 'system')).toBe(true);
  });

  it('on a CAS miss, closes the orphaned session and returns the run\'s EXISTING session id', async () => {
    dbMockState.insertReturningQueues.ai_sessions = [[{ id: SESSION_ID }]];
    // CAS update returns zero rows: some other attempt already stamped session_id.
    dbMockState.updateReturningQueues.ai_agent_runs = [[]];
    dbMockState.selectQueues.ai_agent_runs = [[{ sessionId: EXISTING_SESSION_ID }]];

    const result = await createAgentRunSession({
      runId: RUN_ID,
      agentId: AGENT_ID,
      orgId: ORG_ID,
      deviceId: null,
      model: 'claude-sonnet-4-5-20250929',
      maxTurns: 40,
    });

    expect(result).toBe(EXISTING_SESSION_ID);

    // The just-inserted orphan session was closed, not left dangling active.
    const sessionClose = dbMockState.updates.find(
      (u) => u.table === 'ai_sessions' && u.values.status === 'closed',
    );
    expect(sessionClose).toBeDefined();
  });
});

describe('startToolExecution / completeToolExecution round-trip', () => {
  it('inserts an executing row and returns its id, then completes it', async () => {
    dbMockState.insertReturningQueues.ai_tool_executions = [[{ id: EXECUTION_ID }]];

    const id = await startToolExecution({
      sessionId: SESSION_ID,
      toolName: 'get_device_details',
      toolInput: {
        deviceId: DEVICE_ID,
        providerConfig: { accessKey: 'synthetic-access', secretKey: 'synthetic-secret' },
      },
    });
    expect(id).toBe(EXECUTION_ID);

    const insertedValues = dbMockState.inserts[0]!.values;
    expect(insertedValues).toMatchObject({
      sessionId: SESSION_ID,
      toolName: 'get_device_details',
      toolInput: {
        deviceId: DEVICE_ID,
        providerConfig: { accessKey: '[REDACTED]', secretKey: '[REDACTED]' },
      },
      status: 'executing',
    });
    // Output is never written at start.
    expect(insertedValues).not.toHaveProperty('toolOutput');

    await completeToolExecution({ executionId: EXECUTION_ID, isError: false, durationMs: 120 });

    const completion = dbMockState.updates.find((u) => u.table === 'ai_tool_executions');
    expect(completion).toBeDefined();
    expect(completion!.values).toMatchObject({ status: 'completed', durationMs: 120 });
    expect(completion!.values.completedAt).toBeInstanceOf(Date);
    // Tool output is deliberately never persisted (redaction lands in Part B).
    expect(completion!.values).not.toHaveProperty('toolOutput');
  });

  it('marks a failed call with status failed', async () => {
    await completeToolExecution({ executionId: EXECUTION_ID, isError: true, durationMs: 50 });
    const completion = dbMockState.updates.find((u) => u.table === 'ai_tool_executions');
    expect(completion!.values).toMatchObject({ status: 'failed', durationMs: 50 });
  });

  // #10411: a failed row used to carry no reason at all.
  it('persists the error text on a failed call', async () => {
    await completeToolExecution({
      executionId: EXECUTION_ID, isError: true, durationMs: 50,
      output: JSON.stringify({ error: 'Device is offline', stdout: 'device output' }),
    });
    const completion = dbMockState.updates.find((u) => u.table === 'ai_tool_executions');
    expect(completion!.values).toMatchObject({ status: 'failed', errorMessage: 'Device is offline' });
    expect(completion!.values).not.toHaveProperty('toolOutput');
  });

  it('never writes error text onto a completed call', async () => {
    await completeToolExecution({
      executionId: EXECUTION_ID, isError: false, durationMs: 50,
      output: JSON.stringify({ error: 'a field named error on a success' }),
    });
    const completion = dbMockState.updates.find((u) => u.table === 'ai_tool_executions');
    expect(completion!.values).not.toHaveProperty('errorMessage');
    expect(completion!.values).not.toHaveProperty('toolOutput');
  });
});

describe('toolErrorTextForLedger (#10411)', () => {
  it('takes the result\'s own `error` string', () => {
    expect(toolErrorTextForLedger(JSON.stringify({ error: 'Device is offline', stdout: 'secret-ish output' })))
      .toBe('Device is offline');
  });

  it('bounds a long error string', () => {
    const text = toolErrorTextForLedger(JSON.stringify({ error: 'x'.repeat(5_000) }));
    expect(text.length).toBeLessThanOrEqual(1_000);
  });

  it('never falls back to the raw output when there is no `error` string', () => {
    expect(toolErrorTextForLedger('plain stdout that happened to fail')).toBe(LEDGER_ERROR_WITHOUT_TEXT);
    expect(toolErrorTextForLedger(JSON.stringify({ status: 'failed', stdout: 'device output' }))).toBe(LEDGER_ERROR_WITHOUT_TEXT);
  });
});

describe('reconcileHungExecutions', () => {
  it('only touches in-flight (executing) rows of the given session', async () => {
    dbMockState.updateReturningQueues.ai_tool_executions = [[{ id: EXECUTION_ID }, { id: 'exec-2' }]];

    const count = await reconcileHungExecutions(SESSION_ID);

    expect(count).toBe(2);
    const update = dbMockState.updates.find((u) => u.table === 'ai_tool_executions');
    expect(update!.values).toMatchObject({
      status: 'failed',
      errorMessage: 'run finished with execution unresolved',
    });
    const sql = compiled(update!.where);
    expect(sql).toContain('session_id');
    expect(sql).toContain('status');
  });

  it('returns 0 when nothing was in-flight', async () => {
    dbMockState.updateReturningQueues.ai_tool_executions = [[]];
    const count = await reconcileHungExecutions(SESSION_ID);
    expect(count).toBe(0);
  });
});

describe('closeAgentRunSession', () => {
  it('closes the session for a completed run', async () => {
    await closeAgentRunSession(SESSION_ID, 'completed');
    const update = dbMockState.updates.find((u) => u.table === 'ai_sessions');
    expect(update!.values).toMatchObject({ status: 'closed' });
  });

  it('closes the session for a failed run (same terminal DB state — no failed status on ai_sessions)', async () => {
    await closeAgentRunSession(SESSION_ID, 'failed');
    const update = dbMockState.updates.find((u) => u.table === 'ai_sessions');
    expect(update!.values).toMatchObject({ status: 'closed' });
  });
});

describe('run transcript (#11971)', () => {
  const rowsWritten = () => dbMockState.inserts
    .filter((i) => i.table === 'ai_messages')
    .flatMap((i) => (Array.isArray(i.values) ? i.values : [i.values]) as Array<Record<string, unknown>>);

  it('recordRunTaskPrompt stores what the run was told as the session\'s user message, in a system context', async () => {
    await recordRunTaskPrompt(SESSION_ID, 'Investigate alert A on device D.');

    expect(rowsWritten()).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, role: 'user', content: 'Investigate alert A on device D.' }),
    ]);
    expect(dbMockState.contextDuringWrites).toEqual(['system']);
  });

  it('recordRunAssistantTurn stores the answer and each Breeze tool call, inputs redacted, in turn order', async () => {
    await recordRunAssistantTurn(SESSION_ID, {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'private reasoning', signature: 'sig' },
          { type: 'text', text: 'Checking the device.' },
          { type: 'tool_use', id: 'tu-1', name: 'mcp__breeze__get_device_details', input: { deviceId: DEVICE_ID, password: 'hunter2' } },
          { type: 'tool_use', id: 'tu-2', name: 'ToolSearch', input: { query: 'disk' } },
          { type: 'text', text: 'Then deciding.' },
        ],
        usage: { input_tokens: 1200, output_tokens: 80 },
      },
    });

    const rows = rowsWritten();
    expect(dbMockState.inserts.filter((i) => i.table === 'ai_messages')).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sessionId: SESSION_ID,
      role: 'assistant',
      content: 'Checking the device.\n\nThen deciding.',
      contentBlocks: [
        { type: 'text', text: 'Checking the device.' },
        { type: 'tool_use', id: 'tu-1', name: 'mcp__breeze__get_device_details', input: redactSensitiveToolInput({ deviceId: DEVICE_ID, password: 'hunter2' }) },
        { type: 'tool_use', id: 'tu-2', name: 'ToolSearch', input: { query: 'disk' } },
        { type: 'text', text: 'Then deciding.' },
      ],
      inputTokens: 1200,
      outputTokens: 80,
    });
    // The SDK's own ToolSearch builtin gets no tool row (same as chat, A-W04).
    expect(rows[1]).toMatchObject({
      sessionId: SESSION_ID,
      role: 'tool_use',
      toolName: 'get_device_details',
      toolInput: redactSensitiveToolInput({ deviceId: DEVICE_ID, password: 'hunter2' }),
      toolUseId: 'tu-1',
    });
    const written = JSON.stringify(rows.map(({ createdAt: _c, ...rest }) => rest));
    expect(written).not.toContain('hunter2');
    expect(written).not.toContain('private reasoning');
    // One statement, so the rows' order must come from the row clock, not now().
    for (const row of rows) expect(compiled(row.createdAt as SQL)).toBe('clock_timestamp()');
    expect(dbMockState.contextDuringWrites).toEqual(['system']);
  });

  it('recordRunAssistantTurn writes nothing for a message with no content', async () => {
    await recordRunAssistantTurn(SESSION_ID, { type: 'assistant', message: {} });
    await recordRunAssistantTurn(SESSION_ID, { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }] } });

    expect(rowsWritten()).toEqual([]);
  });
});

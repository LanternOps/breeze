/**
 * Unit coverage for the retention job's wiring and failure handling. The
 * scrub SQL itself (idempotence, transcript coupling, live-session deferral,
 * policy semantics, read_artifact refusal) is proven against real Postgres in
 * __tests__/integration/aiToolOutputRetention.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  add: vi.fn(),
  getRepeatableJobs: vi.fn(),
  removeRepeatableByKey: vi.fn(),
  attach: vi.fn(),
  processor: { current: null as null | ((job: { data: Record<string, unknown> }) => Promise<unknown>) },
  execute: vi.fn(),
  selectResults: [] as unknown[][],
  recordRetentionRun: vi.fn(),
  warnOnRetentionBacklog: vi.fn(),
  deleteSession: vi.fn(),
  captureMessage: vi.fn(),
  systemLabels: [] as string[],
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = (...a: unknown[]) => m.add(...a);
    getRepeatableJobs = () => m.getRepeatableJobs();
    removeRepeatableByKey = (...a: unknown[]) => m.removeRepeatableByKey(...a);
    close = vi.fn();
  },
  Worker: class {
    constructor(_n: string, p: (job: { data: Record<string, unknown> }) => Promise<unknown>) { m.processor.current = p; }
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));
vi.mock('../db', () => ({
  db: {
    execute: (...a: unknown[]) => m.execute(...a),
    select: () => ({ from: async () => m.selectResults.shift() ?? [] }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown, label?: string) => { m.systemLabels.push(label ?? ''); return fn(); },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: (...a: unknown[]) => m.attach(...a) }));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: (...a: unknown[]) => m.recordRetentionRun(...a) }));
vi.mock('./retentionBatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./retentionBatch')>()),
  warnOnRetentionBacklog: (...a: unknown[]) => m.warnOnRetentionBacklog(...a),
}));
vi.mock('../services/sentry', () => ({ captureMessage: (...a: unknown[]) => m.captureMessage(...a) }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ deleteSession: (...a: unknown[]) => m.deleteSession(...a) }));

import {
  deleteSdkTranscript,
  initializeAiToolOutputRetention,
  runAiToolOutputRetention,
  SEARCH_EVENT_MAX_AGE_DAYS,
  tombstone,
} from './aiToolOutputRetention';
import { JOB_SCHEDULES } from './scheduleRegistry';

const ORG_OK = '11111111-1111-4111-8111-111111111111';
const ORG_BAD = '22222222-2222-4222-8222-222222222222';
const PARTNER = '33333333-3333-4333-8333-333333333333';

/** postgres-js shape: an array of rows carrying `.count`. */
const rows = <T>(r: T[], count = r.length) => Object.assign([...r], { count });

beforeEach(() => {
  vi.clearAllMocks();
  m.selectResults = [];
  m.systemLabels = [];
  m.getRepeatableJobs.mockResolvedValue([]);
});

describe('tombstone', () => {
  it('is the marker the tool cards key on, stamped with the scrub time', () => {
    expect(tombstone(new Date('2026-10-01T00:00:00Z'))).toEqual({ _retention: 'scrubbed', at: '2026-10-01T00:00:00.000Z' });
  });
});

describe('initializeAiToolOutputRetention', () => {
  it('schedules the registry slot and attaches observability under its registry name', async () => {
    await initializeAiToolOutputRetention();
    expect(m.attach).toHaveBeenCalledWith(expect.anything(), 'aiToolOutputRetention');
    expect(m.add).toHaveBeenCalledWith(
      'ai-tool-output-retention',
      expect.objectContaining({ batchSize: expect.any(Number), maxBatches: expect.any(Number) }),
      expect.objectContaining({ jobId: 'ai-tool-output-retention', repeat: { pattern: JOB_SCHEDULES['ai-tool-output-retention'] } }),
    );
  });
});

describe('runAiToolOutputRetention', () => {
  it('a failing org is counted and skipped; the next org is still scrubbed and its transcripts deleted', async () => {
    m.selectResults = [
      [{ id: ORG_BAD, partnerId: PARTNER }, { id: ORG_OK, partnerId: PARTNER }],
      [],
    ];
    m.execute.mockImplementation(async (q: { queryChunks?: unknown[] }) => {
      const params = JSON.stringify(q);
      if (params.includes(ORG_BAD)) throw new Error('boom');
      if (params.includes('ai_tool_search_events') || params.includes('ToolSearch')) return rows([], 0);
      if (params.includes('ai_run_artifacts') || params.includes('action_intents')) return rows([], 0);
      if (params.includes('ai_tool_executions')) return rows([{ scrubbed: 0, cleared: [] }]);
      return rows([{ scrubbed: 2, cleared: ['sdk-1'] }]);
    });
    const deleteTranscript = vi.fn(async () => 'deleted' as const);

    const summary = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, deleteTranscript });

    expect(summary).toMatchObject({ orgsScanned: 2, orgsScrubbed: 1, orgsFailed: 1, incomplete: true });
    expect(summary.totals).toMatchObject({ messages: 2, sessions: 1 });
    expect(deleteTranscript).toHaveBeenCalledWith('sdk-1');
    expect(m.recordRetentionRun).toHaveBeenCalledWith('ai_tool_output_retention', { rowsDeleted: 2, incomplete: true });
  });

  it('nulls action_intents.result in the same run and counts it (#9050)', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], []];
    const statements: string[] = [];
    m.execute.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes('ai_tool_search_events') || s.includes('ToolSearch')) return rows([], 0);
      if (s.includes('action_intents')) { statements.push(s); return rows([], 3); }
      if (s.includes('ai_run_artifacts')) return rows([], 0);
      return rows([{ scrubbed: 0, cleared: [] }]);
    });

    const summary = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, deleteTranscript: vi.fn() });

    expect(summary.totals.intents).toBe(3);
    expect(m.recordRetentionRun).toHaveBeenCalledWith('ai_tool_output_retention', { rowsDeleted: 3, incomplete: false });
    // Terminal statuses only, and only rows that still carry a result.
    expect(statements[0]).toContain('result IS NOT NULL');
    expect(statements[0]).not.toContain('pending_approval');
  });

  it('a missing summary row is an error, never "0 scrubbed"', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], []];
    m.execute.mockResolvedValue(rows([], 0));

    const summary = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, deleteTranscript: vi.fn() });

    expect(summary.orgsFailed).toBe(1);
    expect(summary.incomplete).toBe(true);
  });

  it('warns on a batch-capped backlog and reports the run incomplete', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], []];
    m.execute.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes('ai_tool_search_events') || s.includes('ToolSearch')) return rows([], 0);
      if (s.includes('ai_run_artifacts') || s.includes('action_intents')) return rows([], 0);
      if (s.includes('ai_tool_executions')) return rows([{ scrubbed: 0, cleared: [] }]);
      return rows([{ scrubbed: 1, cleared: [] }]);
    });

    const summary = await runAiToolOutputRetention({ batchSize: 1, maxBatches: 1, deleteTranscript: vi.fn() });

    expect(summary.incomplete).toBe(true);
    expect(m.warnOnRetentionBacklog).toHaveBeenCalledWith(
      '[AiToolOutputRetention]', 'ai_tool_output.ai_messages', { deleted: 1, batches: 1, hasMore: true }, `org=${ORG_OK}`,
    );
  });
});

describe('runAiToolOutputRetention: retain-on-doubt branches', () => {
  const quietOrg = () => {
    m.execute.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes('ai_tool_search_events') || s.includes('ToolSearch')) return rows([], 0);
      if (s.includes('ai_run_artifacts') || s.includes('action_intents')) return rows([], 0);
      if (s.includes('ai_tool_executions')) return rows([{ scrubbed: 0, cleared: [] }]);
      return rows([{ scrubbed: 1, cleared: ['sdk-x'] }]);
    });
  };

  it('skips an org with an unusable retention value without touching its rows, and reports it', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], [{ id: 'p', orgId: null, partnerId: PARTNER, toolOutputRetentionDays: 0 }]];

    const summary = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, deleteTranscript: vi.fn() });

    expect(summary).toMatchObject({ orgsSkipped: 1, orgsScrubbed: 0, incomplete: true });
    expect(m.execute).not.toHaveBeenCalled();
    expect(m.captureMessage).toHaveBeenCalledWith(expect.any(String), { eventCode: 'ai_tool_output_retention_incomplete' });
  });

  it('a failed transcript delete marks the run incomplete and reports it; a throwing deleter is a failure, not a failed org', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], []];
    quietOrg();
    const failing = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, deleteTranscript: vi.fn(async () => 'failed' as const) });
    expect(failing).toMatchObject({ orgsFailed: 0, incomplete: true, transcripts: { failed: 1 } });
    expect(m.captureMessage).toHaveBeenCalledTimes(1);

    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], []];
    const throwing = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, deleteTranscript: vi.fn(async () => { throw new Error('boom'); }) });
    expect(throwing).toMatchObject({ orgsFailed: 0, orgsScrubbed: 1, incomplete: true, transcripts: { failed: 1 } });
    expect(throwing.totals.messages).toBe(1);
  });

  it('a clean run does not report to Sentry', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], []];
    quietOrg();
    const summary = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, deleteTranscript: vi.fn(async () => 'not_found' as const) });
    expect(summary.incomplete).toBe(false);
    expect(m.captureMessage).not.toHaveBeenCalled();
  });
});

// #12421 W01: tool-discovery rows are deleted at the org's tool-output window,
// capped at SEARCH_EVENT_MAX_AGE_DAYS even for keep-forever orgs, with no
// live-session deferral; the same pass blanks aged ToolSearch inputs inside
// assistant content_blocks. The SQL itself is proven on real Postgres.
describe('runAiToolOutputRetention: tool search events (#12421 W01)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = new Date('2027-02-01T00:00:00.000Z');
  const searchStatements: string[] = [];
  const blankStatements: string[] = [];
  function route(opts: { searchRows?: number[]; blankRows?: number[] } = {}) {
    const searchRows = [...(opts.searchRows ?? [0])];
    const blankRows = [...(opts.blankRows ?? [0])];
    searchStatements.length = 0;
    blankStatements.length = 0;
    m.execute.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes('ai_tool_search_events')) { searchStatements.push(s); return rows([], searchRows.shift() ?? 0); }
      if (s.includes('ToolSearch')) { blankStatements.push(s); return rows([], blankRows.shift() ?? 0); }
      if (s.includes('ai_run_artifacts') || s.includes('action_intents')) return rows([], 0);
      return rows([{ scrubbed: 0, cleared: [] }]);
    });
  }
  const cutoffOf = (statement: string) => statement.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)?.[0];
  const iso = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
  const policy = (days: number | null) => [{ id: 'p', orgId: null, partnerId: PARTNER, toolOutputRetentionDays: days }];

  it('is 180 days', () => {
    expect(SEARCH_EVENT_MAX_AGE_DAYS).toBe(180);
  });

  it('an org with retention 30 deletes search rows older than 30 days and blanks ToolSearch inputs at the same age', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], policy(30)];
    route({ searchRows: [4], blankRows: [2] });
    const summary = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, now: NOW, deleteTranscript: vi.fn() });
    expect(searchStatements).toHaveLength(1);
    expect(cutoffOf(searchStatements[0]!)).toBe(iso(30));
    expect(searchStatements[0]).toContain(ORG_OK);
    expect(cutoffOf(blankStatements[0]!)).toBe(iso(30));
    expect(summary).toMatchObject({ searchEventsDeleted: 4, toolSearchInputsBlanked: 2, incomplete: false });
    expect(m.recordRetentionRun).toHaveBeenCalledWith('ai_tool_output_retention', { rowsDeleted: 4, incomplete: false });
  });

  it('an org with retention 400 uses the 180-day ceiling', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], policy(400)];
    route();
    await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, now: NOW, deleteTranscript: vi.fn() });
    expect(cutoffOf(searchStatements[0]!)).toBe(iso(180));
    expect(cutoffOf(blankStatements[0]!)).toBe(iso(180));
  });

  it('a keep-forever org still gets the 180-day pass while its tool outputs are skipped', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], policy(null)];
    route({ searchRows: [3] });
    const summary = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, now: NOW, deleteTranscript: vi.fn() });
    expect(summary).toMatchObject({ orgsKeptForever: 1, orgsScrubbed: 0, searchEventsDeleted: 3 });
    expect(cutoffOf(searchStatements[0]!)).toBe(iso(180));
    // Only the two discovery passes ran: no tool-output scrub statement.
    expect(m.execute).toHaveBeenCalledTimes(2);
  });

  it('the search-event delete carries no live-session deferral', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], policy(30)];
    route();
    await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, now: NOW, deleteTranscript: vi.fn() });
    // The tool-output scrub's quiet-window predicate reads ai_messages; this delete never does.
    expect(searchStatements[0]).not.toContain('ai_messages');
  });

  it('a batch cap with rows remaining sets incomplete and warns, for each of the two passes', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], policy(30)];
    route({ searchRows: [1, 1], blankRows: [1, 1] });
    const summary = await runAiToolOutputRetention({ batchSize: 1, maxBatches: 2, now: NOW, deleteTranscript: vi.fn() });
    expect(summary.incomplete).toBe(true);
    expect(m.warnOnRetentionBacklog).toHaveBeenCalledWith(
      '[AiToolOutputRetention]', 'ai_tool_output.ai_tool_search_events', { deleted: 2, batches: 2, hasMore: true }, `org=${ORG_OK}`,
    );
    expect(m.warnOnRetentionBacklog).toHaveBeenCalledWith(
      '[AiToolOutputRetention]', 'ai_tool_output.ai_messages.tool_search_input', { deleted: 2, batches: 2, hasMore: true }, `org=${ORG_OK}`,
    );
  });

  it('each batch runs in its own fresh system context, labelled per pass', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], policy(30)];
    route({ searchRows: [1, 0], blankRows: [1, 1, 0] });
    await runAiToolOutputRetention({ batchSize: 1, maxBatches: 5, now: NOW, deleteTranscript: vi.fn() });
    expect(m.systemLabels.filter((l) => l === 'aiToolOutputRetention.ai_tool_search_events')).toHaveLength(2);
    expect(m.systemLabels.filter((l) => l === 'aiToolOutputRetention.tool_search_inputs')).toHaveLength(3);
  });

  it('an org with an unusable retention value is skipped before the discovery passes', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], policy(0)];
    route();
    const summary = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, now: NOW, deleteTranscript: vi.fn() });
    expect(summary.orgsSkipped).toBe(1);
    expect(m.execute).not.toHaveBeenCalled();
  });

  it('a failing discovery pass counts the org failed but its tool outputs are still scrubbed', async () => {
    m.selectResults = [[{ id: ORG_OK, partnerId: PARTNER }], policy(30)];
    m.execute.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes('ai_tool_search_events')) throw new Error('boom');
      if (s.includes('ToolSearch')) return rows([], 0);
      if (s.includes('ai_run_artifacts') || s.includes('action_intents')) return rows([], 0);
      if (s.includes('ai_tool_executions')) return rows([{ scrubbed: 0, cleared: [] }]);
      return rows([{ scrubbed: 2, cleared: [] }]);
    });
    const summary = await runAiToolOutputRetention({ batchSize: 100, maxBatches: 5, now: NOW, deleteTranscript: vi.fn() });
    expect(summary).toMatchObject({ orgsFailed: 1, orgsScrubbed: 1, incomplete: true });
    expect(summary.totals.messages).toBe(2);
  });
});

describe('deleteSdkTranscript', () => {
  it('classifies deleted / not on this filesystem / failed', async () => {
    m.deleteSession.mockResolvedValueOnce(undefined);
    expect(await deleteSdkTranscript('a')).toBe('deleted');
    m.deleteSession.mockRejectedValueOnce(new Error('Session a not found in any project directory'));
    expect(await deleteSdkTranscript('a')).toBe('not_found');
    m.deleteSession.mockRejectedValueOnce(new Error('Session a not found (no projects directory)'));
    expect(await deleteSdkTranscript('a')).toBe('not_found');
    m.deleteSession.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    expect(await deleteSdkTranscript('a')).toBe('failed');
    // Only the SDK's own message for THIS id counts as "not on this disk".
    m.deleteSession.mockRejectedValueOnce(new Error('Config file not found'));
    expect(await deleteSdkTranscript('a')).toBe('failed');
  });
});

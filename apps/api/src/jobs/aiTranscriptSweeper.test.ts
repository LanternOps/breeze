/**
 * #9050: unit coverage for the per-process SDK transcript sweeper. Filesystem
 * behaviour runs against a real temp dir; only the DB lookup, BullMQ and the
 * SDK deleter are mocked. The invariant under test: a transcript whose id is
 * still referenced by `ai_sessions.sdk_session_id` (or is younger than the
 * grace period) is NEVER deleted.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  add: vi.fn(),
  getRepeatableJobs: vi.fn(),
  removeRepeatableByKey: vi.fn(),
  attach: vi.fn(),
  queueNames: [] as string[],
  workerNames: [] as string[],
  processor: { current: null as null | ((job: { data: Record<string, unknown> }) => Promise<unknown>) },
  liveIds: new Set<string>(),
  lookups: [] as string[][],
  lookupError: null as Error | null,
  captureMessage: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(n: string) { m.queueNames.push(n); }
    add = (...a: unknown[]) => m.add(...a);
    getRepeatableJobs = () => m.getRepeatableJobs();
    removeRepeatableByKey = (...a: unknown[]) => m.removeRepeatableByKey(...a);
    close = vi.fn();
  },
  Worker: class {
    constructor(n: string, p: (job: { data: Record<string, unknown> }) => Promise<unknown>) {
      m.workerNames.push(n);
      m.processor.current = p;
    }
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));
vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async (cond: { __ids?: string[] }) => {
          if (m.lookupError) throw m.lookupError;
          const ids = cond.__ids ?? [];
          m.lookups.push(ids);
          return ids.filter((i) => m.liveIds.has(i)).map((i) => ({ sdkSessionId: i }));
        },
      }),
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('drizzle-orm', async (importOriginal) => ({
  ...(await importOriginal<typeof import('drizzle-orm')>()),
  inArray: (_col: unknown, ids: string[]) => ({ __ids: ids }),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureMessage: (...a: unknown[]) => m.captureMessage(...a) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: (...a: unknown[]) => m.attach(...a) }));
vi.mock('./aiToolOutputRetention', () => ({ deleteSdkTranscript: vi.fn() }));

import {
  initializeAiTranscriptSweeper,
  shutdownAiTranscriptSweeper,
  sweepOrphanTranscripts,
  type TranscriptDeleter,
} from './aiTranscriptSweeper';

const HOUR = 3600_000;
const NOW = new Date('2026-10-18T04:38:00.000Z');
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dir: string;

function transcript(id: string, ageMs: number, project = 'proj-a'): string {
  const projectDir = path.join(dir, project);
  mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${id}.jsonl`);
  writeFileSync(file, '{}\n');
  const t = new Date(NOW.getTime() - ageMs);
  utimesSync(file, t, t);
  return file;
}

const recordingDeleter = (calls: string[]): TranscriptDeleter => async (id) => {
  calls.push(id);
  return 'deleted';
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'transcripts-'));
  vi.clearAllMocks();
  m.liveIds = new Set();
  m.lookups = [];
  m.lookupError = null;
  m.queueNames = [];
  m.workerNames = [];
  m.getRepeatableJobs.mockResolvedValue([]);
});
afterEach(async () => {
  await shutdownAiTranscriptSweeper();
  rmSync(dir, { recursive: true, force: true });
});

describe('sweepOrphanTranscripts', () => {
  it('deletes a transcript no session references once it is past the grace period', async () => {
    transcript(ID(1), 48 * HOUR);
    const calls: string[] = [];
    const s = await sweepOrphanTranscripts({ projectsDir: dir, now: NOW, graceMs: 24 * HOUR, deleteTranscript: recordingDeleter(calls) });
    expect(calls).toEqual([ID(1)]);
    expect(s).toMatchObject({ scanned: 1, orphans: 1, deleted: 1, referenced: 0, withinGrace: 0, failed: 0 });
  });

  it('keeps a transcript whose id is still in ai_sessions, however old', async () => {
    transcript(ID(2), 400 * HOUR);
    m.liveIds.add(ID(2));
    const calls: string[] = [];
    const s = await sweepOrphanTranscripts({ projectsDir: dir, now: NOW, graceMs: 24 * HOUR, deleteTranscript: recordingDeleter(calls) });
    expect(calls).toEqual([]);
    expect(s).toMatchObject({ scanned: 1, referenced: 1, orphans: 0, deleted: 0 });
  });

  it('respects the grace period: a fresh unreferenced transcript is neither looked up nor deleted', async () => {
    transcript(ID(3), 2 * HOUR);
    const calls: string[] = [];
    const s = await sweepOrphanTranscripts({ projectsDir: dir, now: NOW, graceMs: 24 * HOUR, deleteTranscript: recordingDeleter(calls) });
    expect(calls).toEqual([]);
    expect(m.lookups).toEqual([]);
    expect(s).toMatchObject({ scanned: 1, withinGrace: 1, deleted: 0 });
  });

  it('splits a mixed directory correctly across projects and ignores non-transcript files', async () => {
    transcript(ID(4), 72 * HOUR, 'proj-a');
    transcript(ID(5), 72 * HOUR, 'proj-b');
    transcript(ID(6), 72 * HOUR, 'proj-b');
    m.liveIds.add(ID(6));
    writeFileSync(path.join(dir, 'proj-a', 'notes.txt'), 'x');
    writeFileSync(path.join(dir, 'proj-a', 'not-a-uuid.jsonl'), '{}');
    writeFileSync(path.join(dir, 'stray.jsonl'), '{}');
    const calls: string[] = [];
    await sweepOrphanTranscripts({ projectsDir: dir, now: NOW, graceMs: 24 * HOUR, deleteTranscript: recordingDeleter(calls) });
    expect(calls.sort()).toEqual([ID(4), ID(5)]);
  });

  it('looks ids up in batches', async () => {
    for (let i = 10; i < 15; i += 1) transcript(ID(i), 72 * HOUR);
    await sweepOrphanTranscripts({ projectsDir: dir, now: NOW, graceMs: 24 * HOUR, batchSize: 2, deleteTranscript: recordingDeleter([]) });
    expect(m.lookups.map((b) => b.length)).toEqual([2, 2, 1]);
  });

  it('deletes NOTHING when the session lookup fails (fail closed)', async () => {
    transcript(ID(7), 72 * HOUR);
    m.lookupError = new Error('db down');
    const calls: string[] = [];
    await expect(
      sweepOrphanTranscripts({ projectsDir: dir, now: NOW, graceMs: 24 * HOUR, deleteTranscript: recordingDeleter(calls) }),
    ).rejects.toThrow('db down');
    expect(calls).toEqual([]);
  });

  it('counts not_found and failed outcomes and keeps going after a throwing deleter', async () => {
    transcript(ID(8), 72 * HOUR);
    transcript(ID(9), 72 * HOUR);
    transcript(ID(20), 72 * HOUR);
    const outcomes: Record<string, 'not_found' | 'failed' | 'throw'> = { [ID(8)]: 'not_found', [ID(9)]: 'failed', [ID(20)]: 'throw' };
    const s = await sweepOrphanTranscripts({
      projectsDir: dir, now: NOW, graceMs: 24 * HOUR,
      deleteTranscript: async (id) => {
        const o = outcomes[id]!;
        if (o === 'throw') throw new Error('boom');
        return o;
      },
    });
    expect(s).toMatchObject({ orphans: 3, deleted: 0, notFound: 1, failed: 2 });
  });

  it('is a no-op when the projects directory does not exist', async () => {
    const s = await sweepOrphanTranscripts({ projectsDir: path.join(dir, 'missing'), now: NOW, graceMs: 24 * HOUR, deleteTranscript: recordingDeleter([]) });
    expect(s).toMatchObject({ scanned: 0, deleted: 0 });
    expect(existsSync(dir)).toBe(true);
  });
});

describe('initializeAiTranscriptSweeper wiring', () => {
  it('runs a worker that attaches under the stable manifest name and schedules the nightly job', async () => {
    await initializeAiTranscriptSweeper();
    expect(m.attach).toHaveBeenCalledWith(expect.anything(), 'aiTranscriptSweeper');
    expect(m.add).toHaveBeenCalledTimes(1);
    expect(m.add.mock.calls[0]![2]).toMatchObject({ repeat: { pattern: '38 4 * * *' } });
  });

  it('uses a per-host queue so every API container sweeps its OWN disk', async () => {
    await initializeAiTranscriptSweeper();
    expect(m.workerNames[0]).toMatch(/^ai-transcript-sweeper-[A-Za-z0-9_-]+$/);
    expect(m.queueNames[0]).toBe(m.workerNames[0]);
  });
});

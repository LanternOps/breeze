import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whereParams, whereText, type RecordedOp } from '../testUtils/recordingDb';

/**
 * #10057: scheduled and manual (non-sweep) scans the agent will never answer.
 * The sweep pump finalizes sweep children; nothing finalized these, so a
 * vanished agent left the row `running` (or a manual scan `queued`) forever,
 * holding the device's concurrency slot and blocking sweep admission.
 */

const h = vi.hoisted(() => ({
  respond: (_op: unknown): unknown => [],
  recording: null as null | ReturnType<typeof import('../testUtils/recordingDb').createRecordingDb>,
}));

vi.mock('../db', async () => {
  const { createRecordingDb } = await import('../testUtils/recordingDb');
  h.recording = createRecordingDb((op) => h.respond(op));
  return { db: h.recording.db };
});

import { finalizeOrphanedDeviceScans } from './securityScanOrphanFinalize';

const NOW = new Date('2026-10-28T12:00:00.000Z');
const isUndelivered = (o: RecordedOp) => o.kind === 'execute' && whereText(o).includes('executed_at is null');
const isStale = (o: RecordedOp) => o.kind === 'execute' && whereText(o).includes('coalesce(');

const ops = () => h.recording!.ops;
const undeliveredStmt = () => ops().find(isUndelivered)!;
const staleStmt = () => ops().find(isStale)!;

let warn: ReturnType<typeof vi.spyOn>;
const priorGrace = process.env.SECURITY_SWEEP_RUNNING_GRACE_MINUTES;

beforeEach(() => {
  h.recording!.ops.length = 0;
  h.respond = () => [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.SECURITY_SWEEP_RUNNING_GRACE_MINUTES;
});

afterEach(() => {
  warn.mockRestore();
  if (priorGrace === undefined) delete process.env.SECURITY_SWEEP_RUNNING_GRACE_MINUTES;
  else process.env.SECURITY_SWEEP_RUNNING_GRACE_MINUTES = priorGrace;
});

describe('finalizeOrphanedDeviceScans (#10057)', () => {
  it('runs the undelivered rule, then the clock, as two statements', async () => {
    await finalizeOrphanedDeviceScans(NOW);
    expect(ops()).toHaveLength(2);
    expect(isUndelivered(ops()[0]!)).toBe(true);
    expect(isStale(ops()[1]!)).toBe(true);
  });

  it('undelivered: a non-sweep scan whose command terminalized before delivery → expired', async () => {
    await finalizeOrphanedDeviceScans(NOW);
    const text = whereText(undeliveredStmt());
    expect(text).toContain(`set status = 'expired'`);
    // Non-sweep only: sweep children belong to the pump's own finalize.
    expect(text).toContain('s.sweep_id is null');
    // A manual "Scan now" row stays `queued` until its result; a claimed
    // scheduled scan is `running`. Both are waiting on the agent.
    expect(text).toContain(`s.status in ('queued', 'running')`);
    // Looked up by command id (payloads are erased on terminalization), and
    // never across devices.
    expect(text).toContain('c.id = s.command_id');
    expect(text).toContain('c.device_id = s.device_id');
    expect(text).toContain(`c.status in ('expired', 'cancelled', 'failed')`);
    expect(whereParams(undeliveredStmt())).toContain(NOW.toISOString());
  });

  it('clock: no result 720 + grace minutes after delivery → failed', async () => {
    await finalizeOrphanedDeviceScans(NOW);
    const text = whereText(staleStmt());
    expect(text).toContain(`set status = 'failed'`);
    expect(text).toContain('s.sweep_id is null');
    // A running scan, or a manual scan whose command row exists. A queued row
    // with no command is still waiting for its claim job; that is not orphaned.
    expect(text).toContain(`s.status = 'running'`);
    expect(text).toContain(`s.status = 'queued' and s.command_id is not null`);
    // Measured from delivery: a manual scan's command can legitimately wait
    // days for an offline device (its deliver_by), and the reaper expires it.
    expect(text).toContain(`c.status = 'pending'`);
    expect(text).toContain('c.executed_at');
    expect(text).toContain('s.started_at');
    const ceiling = new Date(NOW.getTime() - (720 + 65) * 60_000).toISOString();
    expect(whereParams(staleStmt())).toContain(ceiling);
  });

  it('clock honours SECURITY_SWEEP_RUNNING_GRACE_MINUTES, like the sweep pump', async () => {
    process.env.SECURITY_SWEEP_RUNNING_GRACE_MINUTES = '10';
    await finalizeOrphanedDeviceScans(NOW);
    const ceiling = new Date(NOW.getTime() - (720 + 10) * 60_000).toISOString();
    expect(whereParams(staleStmt())).toContain(ceiling);
  });

  it('returns the counts and warns only when it finalized something', async () => {
    expect(await finalizeOrphanedDeviceScans(NOW)).toEqual({ expired: 0, failed: 0 });
    expect(warn).not.toHaveBeenCalled();

    h.respond = (op) => {
      const o = op as RecordedOp;
      if (isUndelivered(o)) return [{ id: 's1' }];
      if (isStale(o)) return [{ id: 's2' }, { id: 's3' }];
      return [];
    };
    expect(await finalizeOrphanedDeviceScans(NOW)).toEqual({ expired: 1, failed: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ expired: ['s1'], failed: ['s2', 's3'] });
  });
});

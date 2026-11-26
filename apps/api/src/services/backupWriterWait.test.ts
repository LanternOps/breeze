import { describe, expect, it } from 'vitest';
import { computeWriterWaits, type WriterWaitSession } from './backupWriterWait';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const OPTS = { transferMarginMs: 15 * 60_000, deleteSettleMs: 5 * 60_000 };
const min = (m: number) => new Date(NOW.getTime() + m * 60_000);

function session(over: Partial<WriterWaitSession>): WriterWaitSession {
  return {
    id: 's-new',
    jobId: 'job-1',
    reservationSnapshotId: 'snap-1',
    revokedAt: null,
    createdAt: min(-1),
    urlHorizonAt: null,
    deletingSince: null,
    readOnly: false,
    resumedAt: null,
    ...over,
  };
}

describe('computeWriterWaits', () => {
  it('reports when the interrupted run URLs plus the transfer margin have all lapsed', () => {
    // The old run's last URL expires 3 min from now; plus the margin the new run may write at +18.
    const waits = computeWriterWaits(
      [session({}), session({ id: 's-old', jobId: 'job-0', createdAt: min(-30), revokedAt: min(-1), urlHorizonAt: min(3) })],
      ['job-1'],
      NOW,
      OPTS,
    );
    expect(waits.get('job-1')?.toISOString()).toBe(min(18).toISOString());
  });

  it('reports nothing once the horizon has passed', () => {
    const waits = computeWriterWaits(
      [session({}), session({ id: 's-old', jobId: 'job-0', urlHorizonAt: min(-16) })],
      ['job-1'],
      NOW,
      OPTS,
    );
    expect(waits.has('job-1')).toBe(false);
  });

  it('ignores sessions of other reservations and a job with no write session', () => {
    const waits = computeWriterWaits(
      [session({}), session({ id: 's-x', jobId: 'job-9', reservationSnapshotId: 'snap-2', urlHorizonAt: min(3) })],
      ['job-1', 'job-2'],
      NOW,
      OPTS,
    );
    expect(waits.size).toBe(0);
  });

  it('does not count a delete marker against a session that never resumed (the gate only checks it on resume)', () => {
    const waits = computeWriterWaits(
      [session({}), session({ id: 's-old', jobId: 'job-0', deletingSince: min(-1) })],
      ['job-1'],
      NOW,
      OPTS,
    );
    expect(waits.size).toBe(0);
  });

  it('ignores a stale delete marker and a horizon that is exactly now', () => {
    const waits = computeWriterWaits(
      [
        session({ resumedAt: min(-1) }),
        session({ id: 's-a', jobId: 'job-0', deletingSince: min(-6) }),
        session({ id: 's-b', jobId: 'job-0', urlHorizonAt: min(-15) }),
      ],
      ['job-1'],
      NOW,
      OPTS,
    );
    expect(waits.size).toBe(0);
  });

  it('skips a read-only completion session, which never uploads', () => {
    const waits = computeWriterWaits(
      [session({ readOnly: true }), session({ id: 's-old', jobId: 'job-0', urlHorizonAt: min(3) })],
      ['job-1'],
      NOW,
      OPTS,
    );
    expect(waits.size).toBe(0);
  });

  it('answers several jobs in one call', () => {
    const waits = computeWriterWaits(
      [
        session({}),
        session({ id: 's-old', jobId: 'job-0', urlHorizonAt: min(3) }),
        session({ id: 's-2', jobId: 'job-2', reservationSnapshotId: 'snap-2' }),
      ],
      ['job-1', 'job-2'],
      NOW,
      OPTS,
    );
    expect([...waits.keys()]).toEqual(['job-1']);
  });

  it('waits out an in-flight delete through another session on resume', () => {
    // Delete marker 1 min ago + 5 min settle = 4 min left.
    const waits = computeWriterWaits(
      [session({ resumedAt: min(-1) }), session({ id: 's-old', jobId: 'job-0', deletingSince: min(-1) })],
      ['job-1'],
      NOW,
      OPTS,
    );
    expect(waits.get('job-1')?.toISOString()).toBe(min(4).toISOString());
  });

  it('takes the later of the URL and delete horizons', () => {
    const waits = computeWriterWaits(
      [
        session({ resumedAt: min(-1) }),
        session({ id: 's-a', jobId: 'job-0', urlHorizonAt: min(3) }),
        session({ id: 's-b', jobId: 'job-0', deletingSince: min(-1) }),
      ],
      ['job-1'],
      NOW,
      OPTS,
    );
    expect(waits.get('job-1')?.toISOString()).toBe(min(18).toISOString());
  });

  it('measures from the job newest session; its own superseded generation counts as another writer', () => {
    const waits = computeWriterWaits(
      [
        session({ id: 's-gen1', createdAt: min(-20), revokedAt: min(-10), urlHorizonAt: min(-12) }),
        session({ id: 's-gen2', createdAt: min(-1) }),
      ],
      ['job-1'],
      NOW,
      OPTS,
    );
    expect(waits.get('job-1')?.toISOString()).toBe(min(3).toISOString());
  });

  it('reports nothing for a job whose newest write session is revoked', () => {
    const waits = computeWriterWaits(
      [session({ revokedAt: min(-1) }), session({ id: 's-old', jobId: 'job-0', urlHorizonAt: min(3) })],
      ['job-1'],
      NOW,
      OPTS,
    );
    expect(waits.size).toBe(0);
  });
});

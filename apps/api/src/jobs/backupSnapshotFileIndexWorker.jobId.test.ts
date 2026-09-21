import { describe, expect, it } from 'vitest';
import { Job } from 'bullmq';
import { hydrationJobId } from './backupSnapshotFileIndexWorker';

// Real bullmq validator, no mocks: bullmq 5.x refuses a custom jobId that
// contains ':' unless it splits into exactly three parts (legacy repeatable
// ids). `hydrate:<uuid>` has two parts, so every enqueue threw
// "Custom Id cannot contain :" — the BMR recovery create route surfaced it as
// a 500 and the result-persistence path swallowed it, leaving
// file_index_status stuck at 'agent' forever (found in the 2026-09-21 lab pass).
function validate(jobId: string): void {
  const queueStub = { opts: {}, toKey: (k: string) => k, keys: {}, client: Promise.resolve(null) } as never;
  const job = new Job(queueStub, 'hydrate', { snapshotDbId: 'x', reason: 'result' }, { jobId });
  (job as unknown as { validateOptions(jobData: { data: string }): void }).validateOptions({ data: '{}' });
}

describe('hydrationJobId', () => {
  it('is accepted by bullmq custom-jobId validation', () => {
    expect(() => validate(hydrationJobId('4f0d3c0e-1111-4222-8333-444455556666'))).not.toThrow();
  });

  it('control: the legacy hydrate:<id> form is what bullmq rejects', () => {
    expect(() => validate('hydrate:4f0d3c0e-1111-4222-8333-444455556666')).toThrow(/cannot contain :/);
  });

  it('is stable per snapshot and distinct across snapshots', () => {
    expect(hydrationJobId('a')).toBe(hydrationJobId('a'));
    expect(hydrationJobId('a')).not.toBe(hydrationJobId('b'));
  });
});

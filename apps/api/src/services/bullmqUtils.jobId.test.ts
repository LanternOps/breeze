import { describe, expect, it } from 'vitest';
import { Job } from 'bullmq';
import { bullmqJobId } from './bullmqUtils';

// Real bullmq validator, no mocks. bullmq 5.x (`Job.validateOptions`) refuses a
// custom jobId that contains ':' unless it splits into exactly three parts (a
// compatibility carve-out for legacy repeatable ids, marked for removal in its
// next breaking release). The failure is a thrown `Custom Id cannot contain :`
// from `queue.add`, which most enqueue call sites catch and log — so a bad id
// silently disables whatever it was enqueueing.
function validate(jobId: string): void {
  const queueStub = { opts: {}, toKey: (k: string) => k, keys: {}, client: Promise.resolve(null) } as never;
  const job = new Job(queueStub, 'job', {}, { jobId });
  (job as unknown as { validateOptions(jobData: { data: string }): void }).validateOptions({ data: '{}' });
}

const UUID = '4f0d3c0e-1111-4222-8333-444455556666';

describe('bullmqJobId', () => {
  it.each([
    // DNS policy domain edits: schedulePolicySync never reached the provider.
    [`sync-policy:${UUID}`],
    // Sending-domain auto-suspension: the bounce/complaint kill switch never ran.
    [`autosuspend:${UUID}`],
    // A "3-part" id is only accepted while no part itself contains ':'.
    [`offline-detect:10:2026-10-09T12:00:00.000Z`],
  ])('control: bullmq rejects the colon-shaped id %s', (id) => {
    expect(() => validate(id)).toThrow(/cannot contain :/);
  });

  it.each([
    [['sync-policy', UUID], `sync-policy-${UUID}`],
    [['autosuspend', UUID], `autosuspend-${UUID}`],
    [['baseline-compare', UUID, UUID], `baseline-compare-${UUID}-${UUID}`],
    [['offline-detect', 10, 'abc12'], 'offline-detect-10-abc12'],
  ] as const)('joins %j with "-" into an id bullmq accepts', (parts, expected) => {
    const id = bullmqJobId(...parts);
    expect(id).toBe(expected);
    expect(() => validate(id)).not.toThrow();
  });

  it('neutralises a ":" inside a caller-supplied part, so no input can produce a rejected id', () => {
    const id = bullmqJobId('offline-detect', '10', '2026-10-09T12:00:00.000Z');
    expect(id).not.toContain(':');
    expect(() => validate(id)).not.toThrow();
    // ...and any number of parts, not only the 3-part carve-out.
    const many = bullmqJobId('a:b', 'c:d:e', 'f');
    expect(many).not.toContain(':');
    expect(() => validate(many)).not.toThrow();
  });

  it('is deterministic, so getJob/remove lookups find what add() stored', () => {
    expect(bullmqJobId('sync-policy', UUID)).toBe(bullmqJobId('sync-policy', UUID));
    expect(bullmqJobId('sync-policy', UUID)).not.toBe(bullmqJobId('sync-policy', UUID.replace('4f0d', '5f0d')));
  });

  it('refuses inputs bullmq would reject or that cannot identify anything', () => {
    expect(() => bullmqJobId()).toThrow();
    expect(() => bullmqJobId('')).toThrow();
    // bullmq also rejects an all-integer custom id ("Custom Id cannot be integers").
    expect(() => bullmqJobId(42)).toThrow();
  });
});

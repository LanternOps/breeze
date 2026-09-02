/**
 * Fixture for `jobs/scheduleRegistry.contract.test.ts`. NOT a real job.
 *
 * The contract test scans real source for BullMQ repeatable registrations. Its
 * assertions are only worth anything if the *discovery* half works, and no
 * mutation of an already-discovered call site can prove that — the scanner had
 * already found those. So this file deliberately contains the three shapes the
 * scanner must catch, and the test points a second scan at this directory and
 * asserts each one is found and flagged.
 *
 * `.fixture.ts` is excluded from the production scan, so these do not count as
 * real registrations. Nothing imports this file at runtime.
 */

/** Legacy API: the exact epoch-aligned registration that caused the stampede. */
export const fixtureEpochAlignedOptions = {
  repeat: { every: 24 * 60 * 60 * 1000 },
  removeOnComplete: { count: 5 },
};

interface FixtureQueue {
  upsertJobScheduler(id: string, repeat: unknown, job: unknown): Promise<void>;
}

/** Job Scheduler API: repeat options sit at the top level, not under `repeat`. */
export async function registerFixtureScheduler(queue: FixtureQueue): Promise<void> {
  await queue.upsertJobScheduler(
    'fixture-scheduler',
    { every: 6 * 60 * 60 * 1000 },
    { name: 'fixture', data: {} },
  );
}

/** An opaque repeat option — must be reported as unresolved, never skipped. */
declare const fixtureOpaqueRepeat: { every: number };

export const fixtureOpaqueOptions = {
  repeat: fixtureOpaqueRepeat,
};

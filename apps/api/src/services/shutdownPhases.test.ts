import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runShutdownPhases, type ShutdownPhase } from './shutdownPhases';

describe('runShutdownPhases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs phases strictly sequentially — no phase B task starts before every phase A task settles', async () => {
    const log: string[] = [];

    let resolveA0: () => void = () => {};
    const phases: ShutdownPhase[] = [
      {
        name: 'A',
        tasks: [
          () =>
            new Promise<void>((resolve) => {
              log.push('A0-start');
              resolveA0 = () => {
                log.push('A0-end');
                resolve();
              };
            }),
          async () => {
            log.push('A1-start');
            log.push('A1-end');
          },
        ],
      },
      {
        name: 'B',
        tasks: [
          async () => {
            log.push('B0-start');
            log.push('B0-end');
          },
        ],
      },
    ];

    const promise = runShutdownPhases(phases);
    // Let the microtask queue drain so A1 (sync-ish) settles but A0 is still
    // pending on its manual resolve.
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['A0-start', 'A1-start', 'A1-end']);
    expect(log).not.toContain('B0-start');

    resolveA0();
    await promise;

    expect(log).toEqual(['A0-start', 'A1-start', 'A1-end', 'A0-end', 'B0-start', 'B0-end']);
  });

  it('runs tasks within a phase concurrently — both start before either resolves', async () => {
    const log: string[] = [];
    let resolve0: () => void = () => {};
    let resolve1: () => void = () => {};

    const phases: ShutdownPhase[] = [
      {
        name: 'A',
        tasks: [
          () =>
            new Promise<void>((resolve) => {
              log.push('task0-start');
              resolve0 = () => {
                log.push('task0-end');
                resolve();
              };
            }),
          () =>
            new Promise<void>((resolve) => {
              log.push('task1-start');
              resolve1 = () => {
                log.push('task1-end');
                resolve();
              };
            }),
        ],
      },
    ];

    const promise = runShutdownPhases(phases);
    await vi.advanceTimersByTimeAsync(0);
    // Both tasks must have started before either resolved.
    expect(log).toEqual(['task0-start', 'task1-start']);

    resolve0();
    resolve1();
    await promise;

    expect(log).toContain('task0-end');
    expect(log).toContain('task1-end');
  });

  it('isolates a rejected task — records the failure, phase B still runs', async () => {
    const log: string[] = [];
    const phases: ShutdownPhase[] = [
      {
        name: 'A',
        tasks: [
          async () => {
            throw new Error('task0 boom');
          },
          async () => {
            log.push('task1-ran');
          },
        ],
      },
      {
        name: 'B',
        tasks: [
          async () => {
            log.push('B-ran');
          },
        ],
      },
    ];

    const report = await runShutdownPhases(phases);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.phase).toBe('A');
    expect(report.failures[0]!.index).toBe(0);
    expect(report.failures[0]!.error).toBeInstanceOf(Error);
    expect((report.failures[0]!.error as Error).message).toBe('task0 boom');
    expect(log).toEqual(['task1-ran', 'B-ran']);
  });

  it('continues to the next phase on timeout, records timedOutPhases, actually runs phase B, and never produces an unhandled rejection from the straggler', async () => {
    let rejectStraggler: (err: unknown) => void = () => {};
    const log: string[] = [];
    const phases: ShutdownPhase[] = [
      {
        name: 'A',
        timeoutMs: 50,
        tasks: [
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectStraggler = reject;
            }),
        ],
      },
      {
        name: 'B',
        tasks: [
          async () => {
            log.push('B-ran');
          },
        ],
      },
    ];

    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);

    try {
      const promise = runShutdownPhases(phases);
      await vi.advanceTimersByTimeAsync(50);
      const report = await promise;

      expect(report.timedOutPhases).toEqual(['A']);
      // The headline safety property: a stuck phase A task must not prevent
      // phase B from actually running.
      expect(log).toEqual(['B-ran']);
      // A timed-out phase must not itself be recorded as a failure.
      expect(report.failures).toEqual([]);

      // Now let the straggler reject — after the phase (and the whole run)
      // has already moved on. It must be handled, not unhandled.
      rejectStraggler(new Error('straggler boom'));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('captures a synchronous throw the same as a rejection', async () => {
    const phases: ShutdownPhase[] = [
      {
        name: 'A',
        tasks: [
          () => {
            throw new Error('sync boom');
          },
        ],
      },
    ];

    const report = await runShutdownPhases(phases);

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.phase).toBe('A');
    expect(report.failures[0]!.index).toBe(0);
    expect((report.failures[0]!.error as Error).message).toBe('sync boom');
  });

  it('skips empty phases silently', async () => {
    const log: string[] = [];
    const phases: ShutdownPhase[] = [
      { name: 'empty', tasks: [] },
      {
        name: 'nonempty-phase',
        tasks: [
          async () => {
            log.push('ran');
          },
        ],
      },
    ];

    const logFn = vi.fn();
    const report = await runShutdownPhases(phases, { log: logFn });

    expect(log).toEqual(['ran']);
    expect(report.failures).toEqual([]);
    expect(report.timedOutPhases).toEqual([]);
    // The empty phase must never be logged as running.
    expect(logFn.mock.calls.some((call) => String(call[0]).includes('phase empty'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { runAuthSessionTransition, terminateSessionGeneration } from './sessionGeneration';

describe('runAuthSessionTransition', () => {
  it('preserves FIFO ordering and releases after rejection', async () => {
    const events: string[] = [];
    let release!: () => void;
    const first = runAuthSessionTransition(async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => { release = resolve; });
      events.push('first-end');
      throw new Error('expected');
    });
    const second = runAuthSessionTransition(async () => {
      events.push('second');
      return 2;
    });

    while (events.length === 0) await Promise.resolve();
    expect(events).toEqual(['first-start']);
    release();
    await expect(first).rejects.toThrow('expected');
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(['first-start', 'first-end', 'second']);
  });

  it('cancels a hung operation at a terminal generation boundary and releases the queue', async () => {
    let started = false;
    const hung = runAuthSessionTransition(() => {
      started = true;
      return new Promise<never>(() => undefined);
    });
    while (!started) await Promise.resolve();
    terminateSessionGeneration();
    const hungOutcome = await Promise.race([
      hung.then(() => 'resolved', (error) => (error as Error).name),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out-hung'), 100)),
    ]);
    expect(hungOutcome).toBe('SessionGenerationStaleError');
    const nextOutcome = await Promise.race([
      runAuthSessionTransition(async () => 'next'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed-out-next'), 100)),
    ]);
    expect(nextOutcome).toBe('next');
  });
});

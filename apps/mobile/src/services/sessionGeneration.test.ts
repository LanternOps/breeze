import { describe, expect, it } from 'vitest';
import { runAuthSessionTransition } from './sessionGeneration';

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
});

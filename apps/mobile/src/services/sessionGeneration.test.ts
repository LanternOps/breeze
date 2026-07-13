import { describe, expect, it, vi } from 'vitest';
import {
  captureSessionGeneration,
  runAuthSessionTransition,
  runAuthStorageForSessionGeneration,
  terminateSessionGeneration,
} from './sessionGeneration';

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

describe('runAuthStorageForSessionGeneration', () => {
  it('rejects a queued native binding write after a terminal boundary', async () => {
    const generation = captureSessionGeneration();
    let releaseFirst!: () => void;
    const first = runAuthStorageForSessionGeneration(generation, async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const firstOutcome = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'));
    const staleWrite = runAuthStorageForSessionGeneration(generation, async () => {
      throw new Error('stale binding write ran');
    });
    const staleOutcome = staleWrite.catch((error: unknown) => error);

    terminateSessionGeneration();
    releaseFirst();

    await expect(firstOutcome).resolves.toMatchObject({ name: 'SessionGenerationStaleError' });
    await expect(staleOutcome).resolves.toMatchObject({ name: 'SessionGenerationStaleError' });
  });

  it('rejects when a terminal boundary lands while the native binding write is pending', async () => {
    const generation = captureSessionGeneration();
    let releaseWrite!: () => void;
    const write = runAuthStorageForSessionGeneration(generation, async () => {
      await new Promise<void>((resolve) => { releaseWrite = resolve; });
    });
    const outcome = write.catch((error: unknown) => error);

    await vi.waitFor(() => expect(releaseWrite).toBeTypeOf('function'));
    terminateSessionGeneration();
    releaseWrite();

    await expect(outcome).resolves.toMatchObject({ name: 'SessionGenerationStaleError' });
  });
});

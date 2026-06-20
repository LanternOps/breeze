import { UnrecoverableError } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { assertQueueJobName, parseQueueJobData } from './bullmqValidation';

// A minimal discriminated-union schema standing in for a real queue schema.
const schema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('do-thing'), id: z.string().min(1) }).strict(),
]);

describe('parseQueueJobData', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns the parsed payload for a well-formed job', () => {
    const result = parseQueueJobData(
      'test-queue',
      { id: 'job-1', name: 'do-thing', data: { type: 'do-thing', id: 'x' } },
      schema,
    );
    expect(result).toEqual({ type: 'do-thing', id: 'x' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('throws UnrecoverableError (dead-letters, not retries) on a malformed payload', () => {
    let thrown: unknown;
    try {
      parseQueueJobData(
        'test-queue',
        // missing required `id` → fails .min(1)
        { id: 'job-2', name: 'do-thing', data: { type: 'do-thing', id: '' } },
        schema,
      );
    } catch (err) {
      thrown = err;
    }

    // Must be specifically UnrecoverableError so BullMQ dead-letters the job
    // instead of infinitely retrying it (the #1422 trap).
    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect((thrown as Error).message).toContain('test-queue');
  });

  it('throws UnrecoverableError when the discriminator type is unknown', () => {
    expect(() =>
      parseQueueJobData(
        'test-queue',
        { id: 'job-3', name: 'do-thing', data: { type: 'mystery' } },
        schema,
      ),
    ).toThrow(UnrecoverableError);
  });

  it('logs the rejection so the dead-lettered payload is traceable', () => {
    expect(() =>
      parseQueueJobData(
        'test-queue',
        { id: 'job-4', name: 'do-thing', data: { type: 'do-thing', id: '' } },
        schema,
      ),
    ).toThrow(UnrecoverableError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('test-queue');
    expect(logged).toContain('job-4');
    expect(logged).toContain('Rejecting malformed job');
  });

  it('falls back to "unknown" in the log when the job has no id', () => {
    expect(() =>
      parseQueueJobData(
        'test-queue',
        { id: undefined, name: 'do-thing', data: { type: 'do-thing', id: '' } },
        schema,
      ),
    ).toThrow(UnrecoverableError);

    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('unknown');
  });
});

describe('assertQueueJobName', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('is a no-op when the BullMQ job name matches the expected payload type', () => {
    expect(() =>
      assertQueueJobName('test-queue', { id: 'job-1', name: 'do-thing' }, 'do-thing'),
    ).not.toThrow();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('throws UnrecoverableError when the job name mismatches the discriminated type', () => {
    let thrown: unknown;
    try {
      assertQueueJobName('test-queue', { id: 'job-2', name: 'wrong-name' }, 'do-thing');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect((thrown as Error).message).toContain('wrong-name');
    expect((thrown as Error).message).toContain('do-thing');
  });

  it('logs the name mismatch before throwing', () => {
    expect(() =>
      assertQueueJobName('test-queue', { id: 'job-3', name: 'wrong-name' }, 'do-thing'),
    ).toThrow(UnrecoverableError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(logged).toContain('test-queue');
    expect(logged).toContain('job-3');
  });
});

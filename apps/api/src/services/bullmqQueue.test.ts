import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the most recently constructed mock Queue so we can assert on the
// wrapped add/addBulk. The mock Queue records constructor args and exposes
// add/addBulk/close as spies.
const { addMock, addBulkMock, closeMock, ctorCalls } = vi.hoisted(() => ({
  addMock: vi.fn(async () => ({ id: 'job-1' })),
  addBulkMock: vi.fn(async () => []),
  closeMock: vi.fn(),
  ctorCalls: [] as Array<{ name: string; opts: unknown }>,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    addBulk = addBulkMock;
    close = closeMock;
    constructor(name: string, opts: unknown) {
      ctorCalls.push({ name, opts });
    }
  },
}));

vi.mock('./redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

const { assertSpy } = vi.hoisted(() => ({ assertSpy: vi.fn() }));
vi.mock('../db', () => ({
  assertOutsideHeldDbContext: assertSpy,
}));

import { createInstrumentedQueue } from './bullmqQueue';

describe('createInstrumentedQueue', () => {
  beforeEach(() => {
    addMock.mockClear();
    addBulkMock.mockClear();
    assertSpy.mockClear();
    ctorCalls.length = 0;
  });

  it('constructs a Queue with the shared BullMQ connection by default', () => {
    createInstrumentedQueue('my-queue');
    expect(ctorCalls).toHaveLength(1);
    expect(ctorCalls[0]!.name).toBe('my-queue');
    expect(ctorCalls[0]!.opts).toMatchObject({ connection: { host: 'localhost', port: 6379 } });
  });

  it('merges caller opts (e.g. defaultJobOptions) over the default connection', () => {
    createInstrumentedQueue('my-queue', { defaultJobOptions: { attempts: 5 } });
    expect(ctorCalls[0]!.opts).toMatchObject({
      connection: { host: 'localhost', port: 6379 },
      defaultJobOptions: { attempts: 5 },
    });
  });

  it('fires the #1105 tripwire before each add() and forwards args/result', async () => {
    const q = createInstrumentedQueue('my-queue');
    const result = await q.add('job-name', { foo: 'bar' });
    expect(assertSpy).toHaveBeenCalledWith('bullmq.add(my-queue)');
    expect(addMock).toHaveBeenCalledWith('job-name', { foo: 'bar' });
    expect(result).toEqual({ id: 'job-1' });
  });

  it('fires the #1105 tripwire before addBulk() too', async () => {
    const q = createInstrumentedQueue('my-queue');
    await q.addBulk([{ name: 'a', data: {} }]);
    expect(assertSpy).toHaveBeenCalledWith('bullmq.addBulk(my-queue)');
    expect(addBulkMock).toHaveBeenCalledWith([{ name: 'a', data: {} }]);
  });
});

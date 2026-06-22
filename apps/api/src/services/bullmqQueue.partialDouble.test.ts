import { describe, expect, it, vi } from 'vitest';

// Pins the contract that createInstrumentedQueue tolerates a partial Queue
// double that omits a method (here: `addBulk`). This is exercised indirectly by
// the adopted worker tests (whose mock Queues stub `add` but not `addBulk`), but
// asserting it locally keeps the `typeof queue.add === 'function'` guard in
// bullmqQueue.ts from going silently uncovered if those tests are refactored.
const { addMock } = vi.hoisted(() => ({ addMock: vi.fn(async () => ({ id: 'j1' })) }));

vi.mock('bullmq', () => ({
  // No `addBulk` on purpose — the real-world partial double.
  Queue: class {
    add = addMock;
  },
}));

vi.mock('./redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

const { assertSpy } = vi.hoisted(() => ({ assertSpy: vi.fn() }));
vi.mock('../db', () => ({ assertOutsideHeldDbContext: assertSpy }));

import { createInstrumentedQueue } from './bullmqQueue';

describe('createInstrumentedQueue with a partial Queue double (no addBulk)', () => {
  it('constructs without throwing and still instruments the present add()', async () => {
    let q!: ReturnType<typeof createInstrumentedQueue>;
    expect(() => {
      q = createInstrumentedQueue('partial');
    }).not.toThrow();

    await q.add('name', { x: 1 });
    expect(assertSpy).toHaveBeenCalledWith('bullmq.add(partial)');
    expect(addMock).toHaveBeenCalledWith('name', { x: 1 });
    expect((q as unknown as { addBulk?: unknown }).addBulk).toBeUndefined();
  });
});

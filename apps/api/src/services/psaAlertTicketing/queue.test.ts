import { beforeEach, expect, it, vi } from 'vitest';
const add = vi.hoisted(() => vi.fn());
vi.mock('../bullmqQueue', () => ({ createInstrumentedQueue: () => ({ add }) }));
import { wakeMapping } from './queue';
beforeEach(() => vi.clearAllMocks());
it('keys duplicate wakes by mapping and due second while allowing an active job successor', async () => {
  const at = new Date('2026-10-31T12:00:00Z');
  await wakeMapping('mapping', 'create', at);
  await wakeMapping('mapping', 'close', at);
  await wakeMapping('mapping', 'create', new Date(at.getTime() + 1000));
  const options = add.mock.calls.map((call) => call[2]);
  expect(options[0].jobId).toBe(options[1].jobId);
  expect(options[0].jobId).toContain('mapping');
  expect(options[2].jobId).not.toBe(options[0].jobId);
});

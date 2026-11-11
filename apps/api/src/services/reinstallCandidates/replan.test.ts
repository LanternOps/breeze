import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(),
  runAfterDbContextCommit: vi.fn(),
}));

import { planAndWriteWithOneReplan } from './index';

describe('planAndWriteWithOneReplan (finding 6: re-plan once on source_changed)', () => {
  it('writes the first plan when the source did not change', async () => {
    const plan = vi.fn().mockResolvedValue({ n: 1 });
    const write = vi.fn().mockResolvedValue('ok');
    expect(await planAndWriteWithOneReplan(plan, write)).toEqual({ plan: { n: 1 }, written: 'ok' });
    expect(plan).toHaveBeenCalledTimes(1);
  });

  it('re-plans once from the new state when the write finds the source changed', async () => {
    const plan = vi.fn().mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce({ n: 2 });
    const write = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('ok');
    expect(await planAndWriteWithOneReplan(plan, write)).toEqual({ plan: { n: 2 }, written: 'ok' });
    expect(write).toHaveBeenNthCalledWith(2, { n: 2 });
  });

  it('stops when the re-plan has nothing to write', async () => {
    const plan = vi.fn().mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce({ skip: 'identical' });
    const write = vi.fn().mockResolvedValue(null);
    expect(await planAndWriteWithOneReplan(plan, write)).toEqual({ skip: 'identical' });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('gives up after a second miss', async () => {
    const plan = vi.fn().mockResolvedValue({ n: 1 });
    const write = vi.fn().mockResolvedValue(null);
    expect(await planAndWriteWithOneReplan(plan, write)).toEqual({ skip: 'source_changed' });
    expect(plan).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
  });
});

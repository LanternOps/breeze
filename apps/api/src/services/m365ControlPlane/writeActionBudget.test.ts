import { describe, it, expect, vi, beforeEach } from 'vitest';

const exec = vi.fn();
vi.mock('../redis', () => ({
  getRedis: () => ({ multi: () => ({ incr: () => ({ expire: () => ({ incr: () => ({ expire: () => ({ exec }) }) }) }) }) }),
}));

import { consumeM365WriteActionBudget, M365_WRITE_ACTIONS_PER_MINUTE } from './writeActionBudget';

beforeEach(() => exec.mockReset());

describe('consumeM365WriteActionBudget', () => {
  it('allows when under both windows', async () => {
    exec.mockResolvedValue([[null, 1], [null, 'OK'], [null, 1], [null, 'OK']]);
    expect(await consumeM365WriteActionBudget('conn-1')).toEqual({ allowed: true });
  });
  it('denies (fail-closed) over the per-minute window', async () => {
    exec.mockResolvedValue([[null, M365_WRITE_ACTIONS_PER_MINUTE + 1], [null, 'OK'], [null, 1], [null, 'OK']]);
    const r = await consumeM365WriteActionBudget('conn-1');
    expect(r.allowed).toBe(false);
  });
  it('fails closed when redis multi returns null', async () => {
    exec.mockResolvedValue(null);
    expect((await consumeM365WriteActionBudget('conn-1')).allowed).toBe(false);
  });
});

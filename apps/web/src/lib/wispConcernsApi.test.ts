import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const runAction = vi.fn();
vi.mock('@/lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runAction')>();
  return { ...actual, runAction: (o: unknown) => runAction(o) };
});

import { dismissWispConcern, listWispConcerns, resolveWispConcern, snoozeWispConcern } from './wispConcernsApi';

beforeEach(() => {
  vi.clearAllMocks();
  runAction.mockImplementation(async (o: { request: () => Promise<unknown> }) => { await o.request(); return {}; });
  fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ concerns: [{ id: 'c1' }] }) });
});

describe('listWispConcerns', () => {
  it('requests grantId and status and returns concerns', async () => {
    const out = await listWispConcerns('g1', ['open', 'snoozed']);
    expect(fetchWithAuth).toHaveBeenCalledWith('/wisp/concerns?grantId=g1&status=open,snoozed');
    expect(out).toEqual([{ id: 'c1' }]);
  });
  it('omits status when none given', async () => {
    await listWispConcerns('g1');
    expect(fetchWithAuth).toHaveBeenCalledWith('/wisp/concerns?grantId=g1');
  });
  it('throws on a non-OK response', async () => {
    fetchWithAuth.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(listWispConcerns('g1')).rejects.toThrow();
  });
  it('throws when the body has no concerns array (a contract break is not an empty list)', async () => {
    fetchWithAuth.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    await expect(listWispConcerns('g1')).rejects.toThrow(/no concerns array/);
  });
});

describe('mutations go through runAction', () => {
  const call = () => fetchWithAuth.mock.calls[0]!;
  it('snooze', async () => {
    const until = new Date('2026-10-25T09:00:00Z');
    await snoozeWispConcern('c1', 'g1', until);
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction.mock.calls[0]![0].successMessage).toBe('Snoozed');
    expect(call()[0]).toBe('/wisp/concerns/c1/snooze');
    expect(call()[1].method).toBe('POST');
    expect(JSON.parse(call()[1].body)).toEqual({ grantId: 'g1', until: until.toISOString() });
  });
  it('dismiss', async () => {
    await dismissWispConcern('c1', 'g1');
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction.mock.calls[0]![0].successMessage).toBe('Dismissed');
    expect(call()[0]).toBe('/wisp/concerns/c1/dismiss');
    expect(call()[1].method).toBe('POST');
    expect(JSON.parse(call()[1].body)).toEqual({ grantId: 'g1' });
  });
  it('resolve', async () => {
    await resolveWispConcern('c1', 'g1', 'fixed it');
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction.mock.calls[0]![0].successMessage).toBe('Resolved');
    expect(call()[0]).toBe('/wisp/concerns/c1/resolve');
    expect(JSON.parse(call()[1].body)).toEqual({ grantId: 'g1', outcome: 'fixed it' });
  });
});

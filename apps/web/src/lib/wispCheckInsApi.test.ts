/**
 * Wisp check-in timers W05 (#10996): the check-in list and cancel calls are
 * grant-addressed (the thread id), never the org switcher's org, and the
 * cancel mutates through runAction.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), showToast: vi.fn() }));
vi.mock('../stores/auth', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('../components/shared/Toast', () => ({ showToast: h.showToast }));

import { cancelWispCheckIn, listWispCheckIns } from './wispCheckInsApi';

const res = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const checkIn = { id: 'ci-1', threadId: 'th-1', status: 'scheduled', dueAt: '2026-11-05T14:32:00.000Z', instruction: 'x', subject: null, firedAt: null, createdAt: '2026-11-05T14:00:00.000Z' };

describe('wispCheckInsApi', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists a thread’s check-ins without the ambient org, and throws on a body without the array', async () => {
    h.fetchWithAuth.mockResolvedValueOnce(res(200, { data: { checkIns: [checkIn] } }));
    expect(await listWispCheckIns('th/1')).toEqual([checkIn]);
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread/th%2F1/check-ins', { skipOrgIdInjection: true });
    h.fetchWithAuth.mockResolvedValueOnce(res(200, { data: {} }));
    await expect(listWispCheckIns('th-1')).rejects.toThrow(/no checkIns array/);
    h.fetchWithAuth.mockResolvedValueOnce(res(404, {}));
    await expect(listWispCheckIns('th-1')).rejects.toThrow(/404/);
  });

  it('cancelWispCheckIn goes through runAction with the cancelled copy (204)', async () => {
    h.fetchWithAuth.mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error('no body'); } } as unknown as Response);
    await cancelWispCheckIn('th-1', 'ci/1');
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/wisp/thread/th-1/check-ins/ci%2F1', { method: 'DELETE', skipOrgIdInjection: true });
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Check-in cancelled' }));
  });

  it('a failed cancel is an ActionError toasted once with the cancelFailed fallback', async () => {
    h.fetchWithAuth.mockResolvedValue(res(500, {}));
    await expect(cancelWispCheckIn('th-1', 'ci-1')).rejects.toMatchObject({ name: 'ActionError', status: 500 });
    expect(h.showToast).toHaveBeenCalledTimes(1);
    expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Could not cancel the check-in.' }));
  });
});

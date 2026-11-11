import { beforeEach, expect, it, vi } from 'vitest';
const capture = vi.hoisted(() => vi.fn());
vi.mock('../services/sentry', () => ({ captureException: capture }));
import { makeReconcile } from './psaTicketingReconciler';
import { connectwiseAlertTicketingStoredSchema } from '@breeze/shared';
const config = connectwiseAlertTicketingStoredSchema.parse({ enabled: true, boardId: 1, openStatusId: 2, closedStatusId: 3 });
beforeEach(() => vi.clearAllMocks());
it('isolates target and candidate failures, always wakes due rows, and logs tick counts', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const candidates = vi.fn(async (id: string) => { if(id === 'bad-target') throw new Error('target failed'); return ['bad-candidate', 'good']; });
  const admit = vi.fn(async (id: string) => { if(id === 'bad-candidate') throw new Error('candidate failed'); return 'admitted' as const; });
  const wake = vi.fn(async (id: string) => { if(id === 'bad-wake') throw new Error('wake failed'); });
  await makeReconcile({ targets: async () => ['bad-target', 'good-target'].map(connectionId => ({ connectionId, config, rev: 1, enabledAt: new Date() })), candidates, admit, wakeDue: async () => ['bad-wake', 'good-wake'], wake })();
  expect(admit).toHaveBeenCalledWith('good', 'auto');
  expect(wake).toHaveBeenCalledWith('good-wake');
  expect(capture).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ psa_connection_id: 'bad-target' }));
  expect(capture).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ psa_connection_id: 'good-target' }));
  expect(info).toHaveBeenCalledWith('[psa-ticketing] reconciler tick', { targets: 2, admitted: 1, woken: 1, errors: 3 });
  error.mockRestore(); info.mockRestore();
});
it('runs wakeDue even if loading targets fails', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const wakeDue = vi.fn(async () => ['mapping']), wake = vi.fn(async () => {});
  await makeReconcile({ targets: async () => { throw new Error('target load failed'); }, candidates: async () => [], admit: vi.fn(), wakeDue, wake })();
  expect(wakeDue).toHaveBeenCalledOnce(); expect(wake).toHaveBeenCalledWith('mapping');
  error.mockRestore();
});

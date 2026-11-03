import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { ActionError } from '../../lib/runAction';
import { moveDevicesToSite, summarizeBulkSiteMove } from './bulkSiteMove';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const devices = [
  { id: 'd1', hostname: 'FRONTDESK-01', displayName: null, siteId: 's1' },
  { id: 'd2', hostname: 'LAB-02', displayName: 'Lab PC', siteId: 's2' },
  { id: 'd3', hostname: 'SERVER-03', displayName: null, siteId: 's1' },
];

beforeEach(() => vi.clearAllMocks());

describe('moveDevicesToSite', () => {
  it('POSTs one request to /devices/bulk/site with each row\'s current site as expectedSiteId', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(200, { results: [], summary: { moved: 0, total: 0 } }));
    await moveDevicesToSite({ siteId: 's9', devices, errorFallback: 'Failed' });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchWithAuth).mock.calls[0]!;
    expect(url).toBe('/devices/bulk/site');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      siteId: 's9',
      devices: [{ id: 'd1', expectedSiteId: 's1' }, { id: 'd2', expectedSiteId: 's2' }, { id: 'd3', expectedSiteId: 's1' }],
    });
  });

  it('a whole-batch 400 throws an ActionError and toasts (runAction), never resolves', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(400, { error: 'Selected devices belong to more than one organization', code: 'mixed_org' }));
    await expect(moveDevicesToSite({ siteId: 's9', devices, errorFallback: 'Failed' })).rejects.toBeInstanceOf(ActionError);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('MFA required (403 MFA_REQUIRED) goes through runAction\'s errors:<code> path', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(403, { error: 'MFA required', code: 'MFA_REQUIRED' }));
    const err = await moveDevicesToSite({ siteId: 's9', devices, errorFallback: 'Failed' }).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).code).toBe('MFA_REQUIRED');
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Multi-factor authentication is required' }));
  });

  it('a 401 calls onUnauthorized and does not toast', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(401, { error: 'Unauthorized' }));
    const onUnauthorized = vi.fn();
    const err = await moveDevicesToSite({ siteId: 's9', devices, errorFallback: 'Failed', onUnauthorized }).catch((e) => e);
    expect((err as ActionError).status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a 200 whose body is not the per-device shape is a failure, not a silent success', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(json(200, { ok: true }));
    await expect(moveDevicesToSite({ siteId: 's9', devices, errorFallback: 'Failed' })).rejects.toBeInstanceOf(ActionError);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Failed' }));
  });
});

describe('summarizeBulkSiteMove — the 200 body decides the tone, never the status', () => {
  it('every device moved (or already there) → success', () => {
    const s = summarizeBulkSiteMove({
      results: [{ id: 'd1', outcome: 'moved' }, { id: 'd2', outcome: 'already_there' }, { id: 'd3', outcome: 'moved' }],
      summary: { moved: 2, total: 3 },
    }, devices);
    expect(s).toEqual({ tone: 'success', moved: 2, total: 3, failed: [] });
  });

  it('some moved, some refused → warning naming the failures by display name, grouped by reason', () => {
    const s = summarizeBulkSiteMove({
      results: [{ id: 'd1', outcome: 'moved' }, { id: 'd2', outcome: 'conflict' }, { id: 'd3', outcome: 'forbidden' }],
      summary: { moved: 1, total: 3 },
    }, devices);
    expect(s).toEqual({
      tone: 'warning', moved: 1, total: 3,
      failed: [{ outcome: 'conflict', names: ['Lab PC'] }, { outcome: 'forbidden', names: ['SERVER-03'] }],
    });
  });

  it('every device was already at the target (moved 0, no failures) → success, not error', () => {
    const s = summarizeBulkSiteMove({
      results: [{ id: 'd1', outcome: 'already_there' }, { id: 'd2', outcome: 'already_there' }],
      summary: { moved: 0, total: 2 },
    }, devices);
    expect(s).toEqual({ tone: 'success', moved: 0, total: 2, failed: [] });
  });

  it('none moved, some already there and some refused → error naming only the refused', () => {
    const s = summarizeBulkSiteMove({
      results: [{ id: 'd1', outcome: 'already_there' }, { id: 'd2', outcome: 'conflict' }],
      summary: { moved: 0, total: 2 },
    }, devices);
    expect(s).toEqual({ tone: 'error', moved: 0, total: 2, failed: [{ outcome: 'conflict', names: ['Lab PC'] }] });
  });

  it('none moved → error', () => {
    const s = summarizeBulkSiteMove({
      results: [{ id: 'd1', outcome: 'not_found' }, { id: 'd2', outcome: 'error' }],
      summary: { moved: 0, total: 2 },
    }, devices);
    expect(s).toEqual({
      tone: 'error', moved: 0, total: 2,
      failed: [{ outcome: 'not_found', names: ['FRONTDESK-01'] }, { outcome: 'error', names: ['Lab PC'] }],
    });
  });

  it('an id the client did not send is named by its id rather than dropped', () => {
    const s = summarizeBulkSiteMove({ results: [{ id: 'zz', outcome: 'error' }], summary: { moved: 0, total: 1 } }, devices);
    expect(s.failed).toEqual([{ outcome: 'error', names: ['zz'] }]);
  });

  it('groups same-reason failures together in a fixed reason order, keeping request order within a group', () => {
    const s = summarizeBulkSiteMove({
      results: [
        { id: 'd1', outcome: 'error' },
        { id: 'd2', outcome: 'conflict', message: "The device's site changed since it was read" },
        { id: 'd3', outcome: 'conflict' },
      ],
      summary: { moved: 0, total: 3 },
    }, devices);
    expect(s.failed).toEqual([
      { outcome: 'conflict', names: ['Lab PC', 'SERVER-03'] },
      { outcome: 'error', names: ['FRONTDESK-01'] },
    ]);
  });

  it('an outcome this client does not know (a newer server) is reported as an error, not dropped', () => {
    const s = summarizeBulkSiteMove({
      results: [{ id: 'd1', outcome: 'quarantined' as never }],
      summary: { moved: 0, total: 1 },
    }, devices);
    expect(s).toEqual({ tone: 'error', moved: 0, total: 1, failed: [{ outcome: 'error', names: ['FRONTDESK-01'] }] });
  });
});

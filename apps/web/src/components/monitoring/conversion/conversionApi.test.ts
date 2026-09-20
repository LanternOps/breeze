import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import {
  conversionPaths, convertBody, fetchPendingCounts, fetchPolicyPreview,
  readConvertResult, readPartnerConvertResult, retireBody,
} from './conversionApi';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 300, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

beforeEach(() => vi.clearAllMocks());

describe('conversionApi (W05c1 contract)', () => {
  it('keeps every leaf under /monitor-definitions/conversion/', () => {
    const leaves = [
      conversionPaths.preview('p1'), conversionPaths.convert('p1'), conversionPaths.revert('c1'),
      conversionPaths.retire(), conversionPaths.partnerConvertAll(), conversionPaths.pending('o1'), conversionPaths.pending(null),
    ];
    for (const leaf of leaves) expect(leaf.startsWith('/monitor-definitions/conversion/')).toBe(true);
    expect(conversionPaths.pending('org 1')).toBe('/monitor-definitions/conversion/pending?orgId=org%201');
    expect(conversionPaths.pending(null)).toBe('/monitor-definitions/conversion/pending');
  });

  it('pins the shipped leaves and encodes IDs and ledger filters', () => {
    expect(conversionPaths.preview('p/1')).toBe('/monitor-definitions/conversion/policies/p%2F1/preview');
    expect(conversionPaths.convert('p/1')).toBe('/monitor-definitions/conversion/policies/p%2F1/convert');
    expect(conversionPaths.revert('c/1')).toBe('/monitor-definitions/conversion/c%2F1/revert');
    expect(conversionPaths.retire()).toBe('/monitor-definitions/conversion/retire');
    expect(conversionPaths.partnerPreview()).toBe('/monitor-definitions/conversion/partner/preview');
    expect(conversionPaths.partnerConvertAll()).toBe('/monitor-definitions/conversion/partner/convert-all');
    expect(conversionPaths.ledger({ orgId: 'o/1', policyId: 'p1', cursor: 'c1', limit: 25 }))
      .toBe('/monitor-definitions/conversion/ledger?orgId=o%2F1&policyId=p1&cursor=c1&limit=25');
  });

  it('stops polling on preview_failed and allows a fresh retry', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json({ data: { status: 'running', progress: { checked: 0, total: 700 } } }, 202))
      .mockResolvedValueOnce(json({ error: 'preview_failed' }, 500));
    try {
      const result = expect(fetchPolicyPreview('p1')).rejects.toThrow('preview_failed');
      await vi.advanceTimersByTimeAsync(1000);
      await result;
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const complete = { policyId: 'p1', previewHash: 'ready', items: [], inheritanceMode: 'cumulative',
        equivalence: { devicesChecked: 700, deltas: [] } };
      fetchMock.mockResolvedValueOnce(json({ data: complete }));
      await expect(fetchPolicyPreview('p1')).resolves.toEqual(complete);
    } finally { vi.useRealTimers(); }
  });

  it('cancels polling during the delay without making another request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(json({ data: { status: 'running', progress: { checked: 0, total: 700 } } }, 202));
    try {
      const result = expect(fetchPolicyPreview('p1', { signal: controller.signal }))
        .rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await result;
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        '/monitor-definitions/conversion/policies/p1/preview', { signal: controller.signal });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('polls a large-policy preview until complete and reports progress', async () => {
    vi.useFakeTimers();
    const complete = { policyId: 'p1', previewHash: 'ready', items: [], inheritanceMode: 'cumulative',
      equivalence: { devicesChecked: 700, deltas: [] } };
    fetchMock.mockResolvedValueOnce(json({ data: { status: 'running', progress: { checked: 200, total: 700 } } }, 202))
      .mockResolvedValueOnce(json({ data: complete }));
    const onProgress = vi.fn();
    try {
      const promise = fetchPolicyPreview('p1', { onProgress });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toEqual(complete);
      expect(onProgress).toHaveBeenCalledWith({ checked: 200, total: 700 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('never accepts a pending result as a confirmation hash', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(fetchPolicyPreview('p1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetchPolicyPreview unwraps { data } and returns the PolicyConversionPreview', async () => {
    const preview = { policyId: 'p1', previewHash: 'h', items: [], inheritanceMode: 'cumulative', equivalence: { devicesChecked: 0, deltas: [] } };
    fetchMock.mockResolvedValue(json({ data: preview }));
    await expect(fetchPolicyPreview('p1')).resolves.toEqual(preview);
    expect(fetchMock).toHaveBeenCalledWith('/monitor-definitions/conversion/policies/p1/preview');
  });

  it('fetchPolicyPreview throws the API message on a non-2xx', async () => {
    fetchMock.mockResolvedValue(json({ error: 'PREREQUISITE_MISSING', message: 'offline fix not deployed' }, 409));
    await expect(fetchPolicyPreview('p1')).rejects.toThrow(/offline fix not deployed/);
  });

  it('fetchPendingCounts returns { policies, rows }', async () => {
    fetchMock.mockResolvedValue(json({ data: { policies: 3, rows: 12 } }));
    await expect(fetchPendingCounts('org-1')).resolves.toEqual({ policies: 3, rows: 12 });
    expect(fetchMock).toHaveBeenCalledWith('/monitor-definitions/conversion/pending?orgId=org-1');
  });

  it('builds the convert and retire bodies exactly as the contract names them', () => {
    expect(convertBody('h')).toEqual({ previewHash: 'h' });
    expect(convertBody('h', ['s1', 's2'])).toEqual({ previewHash: 'h', sourceIds: ['s1', 's2'] });
    expect(retireBody('config_policy_alert_rules', 's1', 'operator')).toEqual({ sourceTable: 'config_policy_alert_rules', sourceId: 's1', reason: 'operator' });
  });

  it('reads convert results from a wrapped or bare body', () => {
    const result = { conversionIds: ['c1'], retired: 1, monitorsCreated: 2 };
    expect(readConvertResult({ data: result })).toEqual(result);
    expect(readConvertResult(result)).toEqual(result);
    expect(readPartnerConvertResult({ data: { policies: 2, converted: 5, unconvertible: 1 } })).toEqual({ policies: 2, converted: 5, unconvertible: 1 });
  });
});

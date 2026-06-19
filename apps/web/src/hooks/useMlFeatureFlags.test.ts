import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMlFeatureFlags } from './useMlFeatureFlags';
import { fetchWithAuth } from '../stores/auth';

vi.mock('../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const disabledFlag = {
  flag: 'ml.anomalies.enabled' as const,
  enabled: false,
  defaultEnabled: false,
  source: 'org_settings',
};

describe('useMlFeatureFlags', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
  });

  it('parses the mlFeatureFlags response shape', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ mlFeatureFlags: { 'ml.anomalies.enabled': disabledFlag } }),
    );

    const { result } = renderHook(() => useMlFeatureFlags());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.flags['ml.anomalies.enabled']?.enabled).toBe(false);
    expect(result.current.isDisabled('ml.anomalies.enabled')).toBe(true);
    expect(result.current.isDisabled('ml.rca.enabled')).toBe(false);
  });

  it('parses the alternative data response shape', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ data: { 'ml.anomalies.enabled': disabledFlag } }),
    );

    const { result } = renderHook(() => useMlFeatureFlags());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.flags['ml.anomalies.enabled']?.enabled).toBe(false);
    expect(result.current.isDisabled('ml.anomalies.enabled')).toBe(true);
  });

  it('fails OPEN on a non-ok response: records the error but leaves every flag enabled', async () => {
    // INTENTIONAL fail-open contract: when the flag endpoint errors we set
    // loaded=true with no flags, so isDisabled(...) returns false for every
    // flag and ML features stay visible rather than disappearing on a transient
    // config-load failure. This test pins that behavior so a future change that
    // flips it to fail-closed is a conscious decision, not an accident.
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ error: 'boom' }, false, 500));

    const { result } = renderHook(() => useMlFeatureFlags());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toContain('500');
    expect(result.current.flags).toEqual({});
    expect(result.current.isDisabled('ml.anomalies.enabled')).toBe(false);
  });

  it('fails OPEN when the request rejects', async () => {
    fetchWithAuthMock.mockRejectedValueOnce(new Error('network down'));

    const { result } = renderHook(() => useMlFeatureFlags());

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toBe('network down');
    expect(result.current.isDisabled('ml.device_reliability.enabled')).toBe(false);
  });

  it('treats flags as not-disabled until loaded resolves', () => {
    fetchWithAuthMock.mockReturnValueOnce(new Promise<Response>(() => {}));

    const { result } = renderHook(() => useMlFeatureFlags());

    expect(result.current.loaded).toBe(false);
    expect(result.current.isDisabled('ml.anomalies.enabled')).toBe(false);
  });
});

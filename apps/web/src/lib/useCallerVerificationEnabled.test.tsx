import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useFeaturesStore } from '@/stores/featuresStore';
import { useCallerVerificationEnabled } from './useCallerVerificationEnabled';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchMock }));

beforeEach(() => {
  fetchMock.mockReset();
  useFeaturesStore.setState((s) => ({ loaded: false, features: { ...s.features, callerVerification: false } }));
});

it.each([{}, { callerVerification: false }, { callerVerification: 'true' }])('fails closed for %j', async (features) => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ features })));
  const { result } = renderHook(useCallerVerificationEnabled);
  await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
  expect(result.current).toBe(false);
});

it('opens only after the true runtime flag and closes on reset', async () => {
  fetchMock.mockResolvedValue(new Response('{"features":{"callerVerification":true}}'));
  const { result } = renderHook(useCallerVerificationEnabled);
  expect(result.current).toBe(false);
  await waitFor(() => expect(result.current).toBe(true));
  act(() => useFeaturesStore.setState({ loaded: false }));
  expect(result.current).toBe(false);
});

it('hides on config failure', async () => {
  fetchMock.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(useCallerVerificationEnabled);
  await waitFor(() => expect(useFeaturesStore.getState().loaded).toBe(true));
  expect(result.current).toBe(false);
});

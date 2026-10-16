// Regression for #8879. React schedules a non-urgent render's passive effects
// (useEffect) as a separate Scheduler task. On a loaded CI shard, RTL's
// post-`findBy` drain can win that race, so the test's first keystroke arrives
// while the form's mount effects are still pending. React flushes them ahead of
// the keystroke's re-render, and an effect that resets the field's text from its
// prop then overwrote what was just typed. This file makes that ordering
// deterministic by delaying Scheduler tasks (it schedules through setImmediate
// under jsdom), so a typed value must survive pending mount effects.
import '@/lib/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { getPolicy, putPolicy, type PolicyResponse } from '@/lib/api/callerVerification';
import { CallerVerificationPolicyForm } from './CallerVerificationPolicyForm';
import { policy, policyValues } from './testFixtures';

const delayed = vi.hoisted(() => {
  const real = globalThis.setImmediate;
  const state = { real, pending: 0 };
  globalThis.setImmediate = ((fn: (...a: unknown[]) => void, ...args: unknown[]) => {
    state.pending += 1;
    return setTimeout(() => { state.pending -= 1; fn(...args); }, 25);
  }) as unknown as typeof setImmediate;
  return state;
});
afterAll(() => { globalThis.setImmediate = delayed.real; });

vi.mock('@/lib/api/callerVerification', () => ({ getPolicy: vi.fn(), putPolicy: vi.fn() }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));
afterEach(() => { vi.clearAllMocks(); });

const response: PolicyResponse = { row: null, defaults: policyValues, baseline: policyValues, effective: policy };

it('keeps a value typed while the mount effects are still pending, and commits it on blur', async () => {
  vi.mocked(getPolicy).mockResolvedValue(response);
  vi.mocked(putPolicy).mockResolvedValue(response);
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'partner' }} />);
  const ttl = await screen.findByTestId('cv-policy-verificationTtlMinutes');
  // Control: React work is still queued, so the race this file exists for is live.
  // If the Scheduler stops routing through setImmediate this fails instead of
  // passing vacuously.
  expect(delayed.pending).toBeGreaterThan(0);
  fireEvent.change(ttl, { target: { value: '2' } });
  expect(ttl).toHaveValue(2);
  fireEvent.blur(ttl);
  expect(ttl).toHaveValue(5);
  await act(async () => { fireEvent.click(screen.getByTestId('cv-policy-save')); });
  expect(vi.mocked(putPolicy).mock.calls[0][1].verificationTtlMinutes).toBe(5);
});

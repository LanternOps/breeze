// Regression for #8879. React schedules a non-urgent render's passive effects
// (useEffect) as a separate Scheduler task. On a loaded CI shard, RTL's
// post-`findBy` drain can win that race, so the test's first keystroke arrives
// while the form's mount effects are still pending. React flushes them ahead of
// the keystroke's re-render, and an effect that reset the field's text from its
// prop then overwrote what was just typed. This file removes the timing: React's
// Scheduler (which posts its tasks with setImmediate under jsdom) is driven by
// hand, so the keystroke always lands with the mount effects still queued.
import '@/lib/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { getPolicy, putPolicy, type PolicyResponse } from '@/lib/api/callerVerification';
import { CallerVerificationPolicyForm } from './CallerVerificationPolicyForm';
import { policy, policyValues } from './testFixtures';

const scheduler = vi.hoisted(() => {
  const real = globalThis.setImmediate;
  const queue: Array<() => void> = [];
  globalThis.setImmediate = ((fn: (...a: unknown[]) => void, ...args: unknown[]) => {
    queue.push(() => fn(...args));
    return 0;
  }) as unknown as typeof setImmediate;
  return { real, queue, drain: () => { while (queue.length) queue.shift()!(); } };
});
afterEach(() => { act(() => scheduler.drain()); vi.clearAllMocks(); });
afterAll(() => { globalThis.setImmediate = scheduler.real; });

vi.mock('@/lib/api/callerVerification', () => ({ getPolicy: vi.fn(), putPolicy: vi.fn() }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => true }));

const response: PolicyResponse = { row: null, defaults: policyValues, baseline: policyValues, effective: policy };
const TTL = 'cv-policy-verificationTtlMinutes';

/** Runs queued Scheduler tasks one at a time until the loaded form has committed. */
async function runSchedulerUntilLoaded(): Promise<HTMLElement> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false; // as RTL's own async utils do, so React schedules normally
  try {
    for (let i = 0; i < 100; i += 1) {
      const field = screen.queryByTestId(TTL);
      if (field) return field;
      await Promise.resolve();
      scheduler.queue.shift()?.();
    }
    throw new Error('the policy form never committed');
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

it('keeps a value typed while the mount effects are still pending, and commits it on blur', async () => {
  vi.mocked(getPolicy).mockResolvedValue(response);
  vi.mocked(putPolicy).mockResolvedValue(response);
  render(<CallerVerificationPolicyForm owner={{ ownerScope: 'partner' }} />);
  const ttl = await runSchedulerUntilLoaded();
  // Control: the loaded render's passive effects are still queued, so the race
  // this file exists for is live. If React's Scheduler stops posting through
  // setImmediate the form never commits or nothing is queued, and this test
  // fails instead of passing vacuously.
  expect(scheduler.queue.length).toBeGreaterThan(0);
  fireEvent.change(ttl, { target: { value: '2' } });
  expect(ttl).toHaveValue(2);
  fireEvent.blur(ttl);
  expect(ttl).toHaveValue(5);
  await act(async () => { fireEvent.click(screen.getByTestId('cv-policy-save')); });
  expect(vi.mocked(putPolicy).mock.calls[0][1].verificationTtlMinutes).toBe(5);
});

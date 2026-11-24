import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const gate = vi.hoisted(() => ({ value: { enabled: false, loaded: false } }));
vi.mock('../../stores/featuresStore', () => ({
  useFlowsGate: () => gate.value,
}));

const auth = vi.hoisted(() => ({ wait: vi.fn<() => Promise<void>>() }));
vi.mock('../../stores/auth', () => ({
  waitForPendingRefresh: () => auth.wait(),
}));

import AutomationsRedirect from './AutomationsRedirect';

describe('AutomationsRedirect', () => {
  const replace = vi.fn();
  const original = window.location;

  beforeEach(() => {
    replace.mockReset();
    auth.wait.mockReset();
    auth.wait.mockResolvedValue(undefined);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, replace },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  it('/automations sends Flows-on users to /flows and Flows-off users to /jobs', async () => {
    gate.value = { enabled: true, loaded: true };
    const on = render(<AutomationsRedirect />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/flows'));
    expect(replace).toHaveBeenCalledTimes(1);
    on.unmount();

    replace.mockReset();
    gate.value = { enabled: false, loaded: true };
    render(<AutomationsRedirect />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/jobs'));
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does not navigate before the gate has loaded', async () => {
    gate.value = { enabled: true, loaded: false };
    const view = render(<AutomationsRedirect />);
    await new Promise((r) => setTimeout(r, 20));
    expect(replace).not.toHaveBeenCalled();

    // Once the gate answers, it goes exactly once.
    gate.value = { enabled: true, loaded: true };
    view.rerender(<AutomationsRedirect />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/flows'));
    view.rerender(<AutomationsRedirect />);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('waits for a pending token refresh before navigating, then goes exactly once', async () => {
    let settle!: () => void;
    auth.wait.mockReturnValue(new Promise<void>((r) => { settle = r; }));
    gate.value = { enabled: true, loaded: true };
    const view = render(<AutomationsRedirect />);
    await new Promise((r) => setTimeout(r, 20));
    expect(replace).not.toHaveBeenCalled();

    settle();
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/flows'));
    view.rerender(<AutomationsRedirect />);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('still navigates (to /jobs) when the pending refresh rejects', async () => {
    auth.wait.mockRejectedValue(new Error('refresh failed'));
    gate.value = { enabled: false, loaded: true };
    render(<AutomationsRedirect />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/jobs'));
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does not hang on a refresh that never settles', async () => {
    vi.useFakeTimers();
    try {
      auth.wait.mockReturnValue(new Promise<void>(() => {}));
      gate.value = { enabled: true, loaded: true };
      render(<AutomationsRedirect />);
      await vi.advanceTimersByTimeAsync(1000);
      expect(replace).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(replace).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledWith('/flows');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not navigate after unmount while the refresh is pending', async () => {
    let settle!: () => void;
    auth.wait.mockReturnValue(new Promise<void>((r) => { settle = r; }));
    gate.value = { enabled: true, loaded: true };
    render(<AutomationsRedirect />).unmount();
    settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(replace).not.toHaveBeenCalled();
  });
});

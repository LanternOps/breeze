import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const gate = vi.hoisted(() => ({ value: { enabled: false, loaded: false } }));
vi.mock('../../stores/featuresStore', () => ({
  useFlowsGate: () => gate.value,
}));

import AutomationsRedirect from './AutomationsRedirect';

describe('AutomationsRedirect', () => {
  const replace = vi.fn();
  const original = window.location;

  beforeEach(() => {
    replace.mockReset();
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
});

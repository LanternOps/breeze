import '@/lib/i18n';

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureException = vi.fn();
const setTag = vi.fn();
const setContext = vi.fn();
vi.mock('@sentry/astro', () => ({
  withScope: (cb: (scope: { setTag: typeof setTag; setContext: typeof setContext; captureException: typeof captureException }) => void) =>
    cb({ setTag, setContext, captureException }),
}));

import IslandErrorBoundary from './IslandErrorBoundary';

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('kaboom from Bomb');
  return <div data-testid="bomb-alive">alive</div>;
}

// #8982: the device-detail island went fully blank ~1 s after first paint —
// React 18 unmounting the root on an uncaught render error, with nothing on
// screen and nothing reported. This boundary is what turns that into a
// visible, retryable, Sentry-reported failure.
describe('IslandErrorBoundary', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // React logs the caught error itself; keep the test output readable.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
  });

  it('renders children when nothing throws', () => {
    render(
      <IslandErrorBoundary island="device-detail">
        <Bomb explode={false} />
      </IslandErrorBoundary>,
    );
    expect(screen.getByTestId('bomb-alive')).toBeTruthy();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('shows the error message and a retry instead of a blank page when a child throws', () => {
    render(
      <IslandErrorBoundary island="device-detail">
        <Bomb explode />
      </IslandErrorBoundary>,
    );
    const fallback = screen.getByTestId('island-error-fallback');
    expect(fallback.textContent).toContain('kaboom from Bomb');
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('reports the error to Sentry tagged with the island name and the component stack', () => {
    render(
      <IslandErrorBoundary island="device-detail">
        <Bomb explode />
      </IslandErrorBoundary>,
    );
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(setTag).toHaveBeenCalledWith('island', 'device-detail');
    const ctx = setContext.mock.calls.find((c) => c[0] === 'react');
    expect(ctx?.[1]?.componentStack).toContain('Bomb');
  });

  it('retry re-mounts the children so a transient failure recovers', () => {
    function Harness() {
      const [count, setCount] = useState(0);
      return (
        <>
          <button type="button" data-testid="arm" onClick={() => setCount((c) => c + 1)}>
            arm
          </button>
          <IslandErrorBoundary island="device-detail">
            {/* throws only on the first mount */}
            <Bomb explode={count === 0} />
          </IslandErrorBoundary>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByTestId('island-error-fallback')).toBeTruthy();
    fireEvent.click(screen.getByTestId('arm'));
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByTestId('bomb-alive')).toBeTruthy();
    expect(screen.queryByTestId('island-error-fallback')).toBeNull();
  });
});

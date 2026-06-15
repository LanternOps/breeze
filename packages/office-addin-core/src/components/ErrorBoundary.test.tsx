import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

afterEach(cleanup);

function Boom({ when }: { when: boolean }) {
  if (when) throw new Error('kaboom from a host adapter');
  return <div data-testid="ok">all good</div>;
}

describe('ErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeTruthy();
  });

  it('catches a render error and surfaces the message instead of blanking', () => {
    // React logs the caught error to console.error — silence it for a clean run.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom when={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-message').textContent).toContain(
      'kaboom from a host adapter',
    );
    spy.mockRestore();
  });

  it('lets the user retry (clears the error so children re-render)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Flaky() {
      // Throws on first render, succeeds after the boundary resets.
      return <Boom when={!(globalThis as { __recovered?: boolean }).__recovered} />;
    }
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-message')).toBeTruthy();
    (globalThis as { __recovered?: boolean }).__recovered = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByTestId('ok')).toBeTruthy();
    delete (globalThis as { __recovered?: boolean }).__recovered;
    spy.mockRestore();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import AiErrorBanner from './AiErrorBanner';
import type { AiRetryTarget } from '@/lib/aiErrors';

const target = (over: Partial<AiRetryTarget> = {}): AiRetryTarget => ({
  sessionId: 's1', content: 'hi', code: 'timeout', detail: null, mode: 'retry', error: 'raw error', ...over,
});

function setup(props: Partial<React.ComponentProps<typeof AiErrorBanner>> = {}) {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <AiErrorBanner
      error="raw error" retryTarget={target()} busy={false}
      onRetry={onRetry} onDismiss={onDismiss} dismissLabel="Dismiss"
      className="c" textClassName="t" buttonClassName="b" {...props}
    />,
  );
  return { onRetry, onDismiss };
}

describe('AiErrorBanner', () => {
  it('shows a timeout headline and retries once on click', () => {
    const { onRetry } = setup();
    expect(screen.getByText('This response timed out')).toBeTruthy();
    fireEvent.click(screen.getByTestId('ai-error-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('ai-error-retry').textContent).toBe('Try again');
  });

  it('shows a disconnect headline', () => {
    setup({ retryTarget: target({ code: 'disconnect', mode: 'reload_first' }) });
    expect(screen.getByText('The connection was interrupted before the response finished.')).toBeTruthy();
    expect(screen.getByTestId('ai-error-retry')).toBeTruthy();
  });

  it('renders the detail line', () => {
    setup({ retryTarget: target({ detail: 'upstream said no' }) });
    expect(screen.getByTestId('ai-error-detail').textContent).toBe('upstream said no');
  });

  it('shows the error text and no button for a non-retryable code', () => {
    setup({ retryTarget: target({ code: 'budget_exceeded' as any }) });
    expect(screen.getByText('raw error')).toBeTruthy();
    expect(screen.queryByTestId('ai-error-retry')).toBeNull();
  });

  it('shows the error text and no button for a null target', () => {
    setup({ retryTarget: null });
    expect(screen.getByText('raw error')).toBeTruthy();
    expect(screen.queryByTestId('ai-error-retry')).toBeNull();
  });

  it('hides the button while busy', () => {
    setup({ busy: true });
    expect(screen.queryByTestId('ai-error-retry')).toBeNull();
  });

  it('renders children and dismisses', () => {
    const { onDismiss } = setup({ children: <span data-testid="extra">x</span>, testId: 'bn' });
    expect(screen.getByTestId('extra')).toBeTruthy();
    expect(screen.getByTestId('bn')).toBeTruthy();
    fireEvent.click(screen.getByText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

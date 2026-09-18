import '@/lib/i18n';
import { i18n } from '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PollConfigSummary, formatInterval } from './PollConfigSummary';
import type { TFn } from './reachabilityCopy';

const props = { collection: null, snmpDevice: null, templateName: null, timezone: 'UTC' };

describe('PollConfigSummary', () => {
  it.each([[3600, 'every 1 hr'], [90, 'every 90 sec'], [null, 'Unknown']] as const)('formats interval %s', (seconds, expected) => {
    expect(formatInterval(seconds, i18n.getFixedT('en', 'devices') as unknown as TFn)).toBe(expected);
  });
  it('opens the monitoring editor', async () => {
    const onEdit = vi.fn();
    render(<PollConfigSummary {...props} onEdit={onEdit} />);
    await userEvent.click(screen.getByTestId('network-detail-edit-poll-config'));
    expect(onEdit).toHaveBeenCalledOnce();
  });
  it('shows the template failure and retries instead of an unknown template', async () => {
    const onRetry = vi.fn();
    render(<PollConfigSummary {...props} templateError onRetry={onRetry} />);
    expect(screen.getByTestId('network-detail-template-error')).toHaveClass('text-destructive');
    expect(screen.getByTestId('network-detail-poll-template')).not.toHaveTextContent('—');
    await userEvent.click(screen.getByTestId('network-detail-template-retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

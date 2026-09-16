import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NetworkChecksSection } from './NetworkChecksSection';
import type { NetworkCheckSummary } from './useAssetMonitoring';

const check: NetworkCheckSummary = {
  id: 'ping', name: 'Ping', monitorType: 'icmp_ping', target: '192.0.2.1', isActive: true,
  lastStatus: 'online', lastChecked: new Date(Date.now() - 4 * 60_000).toISOString(), lastResponseMs: 12,
  lastError: null, consecutiveFailures: 0,
};

describe('NetworkChecksSection', () => {
  it('shows status, ping and age on one line', () => {
    render(<NetworkChecksSection checks={[check]} timezone="UTC" onAddCheck={vi.fn()} />);
    expect(screen.getByTestId('network-detail-check-ping').textContent).toMatch(/Online · 12\.0\s?ms · 4 min/);
  });
  it('shows paused and the last error', () => {
    render(<NetworkChecksSection checks={[{ ...check, isActive: false, lastError: 'Timed out' }]} timezone="UTC" onAddCheck={vi.fn()} />);
    expect(screen.getByTestId('network-detail-check-ping')).toHaveTextContent('Paused');
    expect(screen.getByTestId('network-detail-check-error-ping')).toHaveTextContent('Timed out');
  });
  it('invokes the empty-state add check action', async () => {
    const onAddCheck = vi.fn();
    render(<NetworkChecksSection checks={[]} timezone="UTC" onAddCheck={onAddCheck} />);
    await userEvent.click(screen.getByTestId('network-detail-add-check'));
    expect(onAddCheck).toHaveBeenCalledOnce();
  });
  it('shows failure and retry instead of the empty state', async () => {
    const onRetry = vi.fn();
    render(<NetworkChecksSection checks={[]} timezone="UTC" onAddCheck={vi.fn()} checksError onRetry={onRetry} />);
    expect(screen.queryByTestId('network-detail-checks-empty')).toBeNull();
    expect(screen.getByTestId('network-detail-checks-error')).toHaveClass('text-destructive');
    await userEvent.click(screen.getByTestId('network-detail-checks-retry'));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

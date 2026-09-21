import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalBanner } from './ApprovalBanner';

describe('ApprovalBanner', () => {
  it('renders nothing when the asset is approved', () => {
    const { container } = render(
      <ApprovalBanner approvalStatus="approved" onApprove={vi.fn()} onDismiss={vi.fn()} busy={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('explains the consequence and offers both actions when pending', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onDismiss = vi.fn().mockResolvedValue(undefined);
    render(
      <ApprovalBanner approvalStatus="pending" onApprove={onApprove} onDismiss={onDismiss} busy={false} />,
    );

    const banner = screen.getByTestId('network-detail-approval-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner.textContent).toContain('nothing is monitored yet');

    await userEvent.click(screen.getByTestId('network-detail-approve'));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByTestId('network-detail-dismiss'));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('offers only Approve when dismissed', () => {
    render(
      <ApprovalBanner approvalStatus="dismissed" onApprove={vi.fn()} onDismiss={vi.fn()} busy={false} />,
    );
    expect(screen.getByTestId('network-detail-approval-banner').textContent).toContain('hidden from device lists');
    expect(screen.getByTestId('network-detail-approve')).toBeInTheDocument();
    expect(screen.queryByTestId('network-detail-dismiss')).toBeNull();
  });

  it('disables both actions while a decision is in flight', () => {
    render(
      <ApprovalBanner approvalStatus="pending" onApprove={vi.fn()} onDismiss={vi.fn()} busy />,
    );
    expect(screen.getByTestId('network-detail-approve')).toBeDisabled();
    expect(screen.getByTestId('network-detail-dismiss')).toBeDisabled();
  });
});

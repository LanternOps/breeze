import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScriptProposalsPanel } from './ScriptProposalsPanel';
import type { ScriptProposalsMetrics } from './ScriptProposalsPanel';

const metrics = (o: Partial<ScriptProposalsMetrics> = {}): ScriptProposalsMetrics => ({
  perDay: [
    { date: '2026-09-10', count: 3 },
    { date: '2026-09-11', count: 1 },
  ],
  reviewerDisagreements: { humanRejectedAfterApprove: 2, humanApprovedAfterReject: 1 },
  ...o,
});

describe('ScriptProposalsPanel', () => {
  it('renders proposals-per-day and reviewer-disagreement counts', () => {
    render(<ScriptProposalsPanel data={metrics()} loading={false} />);
    expect(screen.getByText('2')).toBeTruthy(); // humanRejectedAfterApprove
    expect(screen.getByText('1')).toBeTruthy(); // humanApprovedAfterReject
  });

  it('renders nothing for unattended/lane fields when they are absent', () => {
    render(<ScriptProposalsPanel data={metrics()} loading={false} />);
    expect(screen.queryByTestId('script-proposals-unattended-card')).toBeNull();
    expect(screen.queryByTestId('script-proposals-lane-card')).toBeNull();
  });

  it('shows an empty state with no data', () => {
    render(<ScriptProposalsPanel data={null} loading={false} />);
    expect(screen.getByText(/no script proposals/i)).toBeTruthy();
  });

  it('renders the unattended-runs and lane-state cards once the fields are present', () => {
    render(
      <ScriptProposalsPanel
        data={metrics({ unattendedRuns: 7, laneState: 'closed' })}
        loading={false}
      />,
    );
    expect(screen.getByTestId('script-proposals-unattended-card')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByTestId('script-proposals-lane-card')).toBeTruthy();
  });

  it('shows the "open" copy when the lane has paused itself', () => {
    render(<ScriptProposalsPanel data={metrics({ unattendedRuns: 0, laneState: 'open' })} loading={false} />);
    expect(screen.getByText(/paused after repeated failed verifications/i)).toBeTruthy();
  });
});

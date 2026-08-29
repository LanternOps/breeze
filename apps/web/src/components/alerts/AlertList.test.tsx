import { fireEvent, render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';
import type { AlertAiVerdictSummaryDto } from '@breeze/shared';
import AlertList, { type Alert } from './AlertList';

const baseAlert: Alert = {
  id: 'a-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-07-17T00:00:00Z',
  orgId: 'org-1',
  orgName: 'Acme Corp',
};

const baseVerdict: AlertAiVerdictSummaryDto = {
  id: 'verdict-1',
  classification: 'actionable',
  confidence: 0.72,
  rationale: 'Disk usage climbing steadily with no self-heal.',
  patternKind: null,
  feedback: null,
  suggestedIntentId: null,
  createdAt: '2026-08-28T00:00:00Z',
};

describe('AlertList — Organization column follows fleet view', () => {
  it('hides the Organization column in single-org scope', () => {
    render(<AlertList alerts={[baseAlert]} showOrgColumn={false} />);
    expect(screen.queryByRole('columnheader', { name: 'Organization' })).toBeNull();
    // The org name is not rendered as a cell when the column is off.
    expect(screen.queryByText('Acme Corp')).toBeNull();
  });

  it('shows the Organization column and each alert’s org in fleet view', () => {
    render(<AlertList alerts={[baseAlert]} showOrgColumn />);
    expect(screen.getByRole('columnheader', { name: 'Organization' })).toBeTruthy();
    expect(screen.getByText('Acme Corp')).toBeTruthy();
  });

  it('renders an em-dash for an alert with no org name in fleet view', () => {
    render(<AlertList alerts={[{ ...baseAlert, orgName: null }]} showOrgColumn />);
    // Two em-dashes: org name is null AND this alert carries no aiVerdict.
    expect(screen.getAllByText('—')).toHaveLength(2);
  });

  it('spans the empty-state row across the extra column when the org column is shown', () => {
    const { container } = render(<AlertList alerts={[]} showOrgColumn />);
    const emptyCell = container.querySelector('td[colspan]');
    expect(emptyCell?.getAttribute('colspan')).toBe('9');
  });
});

describe('AlertList — AI verdict column', () => {
  it('renders the verdict badge when the alert carries an aiVerdict', () => {
    render(<AlertList alerts={[{ ...baseAlert, aiVerdict: baseVerdict }]} />);
    expect(screen.getByTestId('alert-verdict-badge')).toBeTruthy();
  });

  it('renders an em-dash when the alert has no aiVerdict', () => {
    render(<AlertList alerts={[baseAlert]} />);
    expect(screen.queryByTestId('alert-verdict-badge')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
  });
});

describe('AlertList — hide AI-flagged noise toggle', () => {
  it('calls onHideAiNoiseChange(true) when the toggle is checked', () => {
    const onHideAiNoiseChange = vi.fn();
    render(
      <AlertList alerts={[baseAlert]} hideAiNoise={false} onHideAiNoiseChange={onHideAiNoiseChange} />
    );
    // The toggle lives in the collapsible filter panel.
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByTestId('alert-hide-ai-noise-toggle'));
    expect(onHideAiNoiseChange).toHaveBeenCalledWith(true);
  });

  it('reflects a checked hideAiNoise prop', () => {
    render(<AlertList alerts={[baseAlert]} hideAiNoise onHideAiNoiseChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    expect(screen.getByTestId('alert-hide-ai-noise-toggle')).toBeChecked();
  });

  it('counts as an active filter — shows "Clear all" even with no other filter set', () => {
    render(<AlertList alerts={[baseAlert]} hideAiNoise onHideAiNoiseChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    expect(screen.getByText('Clear all')).toBeTruthy();
  });

  it('"Clear all" also turns hideAiNoise off', () => {
    const onHideAiNoiseChange = vi.fn();
    render(
      <AlertList alerts={[baseAlert]} hideAiNoise onHideAiNoiseChange={onHideAiNoiseChange} />
    );
    fireEvent.click(screen.getByRole('button', { name: /filters/i }));
    fireEvent.click(screen.getByText('Clear all'));
    expect(onHideAiNoiseChange).toHaveBeenCalledWith(false);
  });
});

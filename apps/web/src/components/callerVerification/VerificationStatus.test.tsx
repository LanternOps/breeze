import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { VerificationStatus } from './VerificationStatus';
import { row, USER } from './testFixtures';

it('shows the initiator the match number, request code and caller script', () => {
  render(<VerificationStatus row={row} userId={USER} />);
  expect(screen.getByTestId('cv-match')).toHaveTextContent('42');
  expect(screen.getByTestId('cv-reverse')).toHaveTextContent('7 3 1 9');
  expect(screen.getByTestId('cv-script')).toHaveTextContent('tap 42');
  expect(screen.getByTestId('cv-script')).toHaveTextContent('7 3 1 9');
  expect(screen.getByText('Sent to +1 •••• 12')).toBeVisible();
});

it('never shows challenge numbers to another technician', () => {
  const { secrets: _s, ...other } = row;
  render(<VerificationStatus row={other} userId="someone-else" />);
  expect(screen.queryByTestId('cv-match')).toBeNull();
  expect(screen.getByText(/Only the starting technician sees/)).toBeVisible();
});

it('uses grant freshness, not challenge expiry, for a verified row', () => {
  render(<VerificationStatus userId={USER} now={Date.parse('2026-09-19T12:15:00Z')}
    row={{ ...row, status: 'verified', decidedAt: '2026-09-19T12:01:00Z', usableUntil: '2026-09-19T12:30:00Z' }} />);
  expect(screen.getByText(/expires in 15 min/)).toBeVisible();
});

it('shows a verified row past its usable window as expired', () => {
  render(<VerificationStatus userId={USER} now={Date.parse('2026-09-19T13:00:00Z')}
    row={{ ...row, status: 'verified', usableUntil: '2026-09-19T12:30:00Z' }} />);
  expect(screen.getByText('Verification expired')).toBeVisible();
});

it('renders concrete terminal-state copy and never a raw code', () => {
  const view = render(<VerificationStatus row={{ ...row, status: 'undeliverable', undeliverableReason: 'sms_failed' }} />);
  expect(screen.getByText('The text message could not be sent.')).toBeVisible();
  view.rerender(<VerificationStatus row={{ ...row, status: 'wrong_choice', remainingAttempts: 1 }} />);
  expect(screen.getByText('Remaining attempts this hour: 1')).toBeVisible();
  view.rerender(<VerificationStatus row={{ ...row, status: 'rejected_by_user', incidentId: row.id }} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Treat this call as suspicious');
  expect(screen.getByRole('link', { name: 'View incident' })).toHaveAttribute('href', `/incidents/${row.id}`);
  for (const status of ['expired', 'cancelled', 'revoked'] as const) {
    view.rerender(<VerificationStatus row={{ ...row, status }} />);
    expect(document.body.textContent).not.toContain(`status.${status}`);
    expect(document.body.textContent).not.toContain('result.');
  }
});

it('reports consumption with the consumed action', () => {
  render(<VerificationStatus row={{ ...row, status: 'verified', consumedAt: row.createdAt, consumedAction: 'reset_password' }} />);
  expect(screen.getByText('Already used for Reset password.')).toBeVisible();
});

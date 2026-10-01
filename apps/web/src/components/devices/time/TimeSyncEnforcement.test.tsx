import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import '@/lib/i18n';
import TimeSyncEnforcement from './TimeSyncEnforcement';
it('shows no result without implying successful enforcement', () => {
  render(<TimeSyncEnforcement report={null} />);
  expect(screen.getByText('No enforcement result reported yet')).toBeTruthy();
});
it('renders outcome, reason, before, after, time and error for each kind', () => {
  render(
    <TimeSyncEnforcement
      report={{
        ntp: {
          resultId: '11111111-1111-4111-8111-111111111111',
          fingerprint: 'sha256:test',
          at: '2026-09-28T12:00:00Z',
          outcome: 'failed',
          reason: 'readback_mismatch',
          before: { type: 'NoSync' },
          after: { type: 'NTP' },
          error: 'readback failed',
        },
        timezone: null,
      }}
    />,
  );
  expect(screen.getByTestId('time-sync-enforcement-ntp').textContent).toContain(
    'Read-back did not match',
  );
  expect(screen.getByText('readback failed')).toBeTruthy();
  expect(screen.getByTestId('time-sync-before-ntp').textContent).toContain(
    'NoSync',
  );
  expect(screen.getByTestId('time-sync-after-ntp').textContent).toContain(
    'NTP',
  );
  expect(
    screen.getByTestId('time-sync-enforcement-at-ntp').getAttribute('datetime'),
  ).toBe('2026-09-28T12:00:00Z');
});
it('shows Group Policy conflict as skipped', () => {
  render(
    <TimeSyncEnforcement
      report={{
        ntp: {
          resultId: '11111111-1111-4111-8111-111111111111',
          fingerprint: 'sha256:test',
          at: '2026-09-28T12:00:00Z',
          outcome: 'skipped',
          reason: 'conflict_gpo',
          before: {},
          after: {},
          error: null,
        },
        timezone: null,
      }}
    />,
  );
  expect(
    screen.getByText('Skipped because Group Policy takes precedence'),
  ).toBeTruthy();
});

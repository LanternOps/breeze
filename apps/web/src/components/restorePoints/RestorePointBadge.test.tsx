import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RESTORE_POINT_STATUSES, type RestorePointStatus } from '@breeze/shared';
import RestorePointBadge, { type RestorePointBadgeOutcome } from './RestorePointBadge';

function outcome(over: Partial<RestorePointBadgeOutcome> = {}): RestorePointBadgeOutcome {
  return {
    status: 'created',
    attemptedAt: '2026-09-02T14:03:00Z',
    message: undefined,
    ...over,
  };
}

const CASES: Array<[Exclude<RestorePointStatus, 'requested'>, RegExp]> = [
  ['created', /restore point creation confirmed/i],
  ['existing_accepted', /existing point reused/i],
  ['skipped_disabled', /system restore is turned off/i],
  ['skipped_definition_only', /definitions[- ]only/i],
  ['unsupported', /not available on this device/i],
  ['busy', /volume snapshot service was in use/i],
  ['insufficient_privileges', /not enough privileges/i],
  ['verification_failed', /could not be verified/i],
  ['failed', /failed/i],
];

describe('RestorePointBadge', () => {
  it.each(CASES)('renders %s with its approved copy', (status, pattern) => {
    render(<RestorePointBadge outcome={outcome({ status })} />);
    expect(screen.getByTestId('restore-point-badge').textContent).toMatch(pattern);
  });

  it('covers every status in the shared union (a new status must get copy)', () => {
    const covered = new Set<string>(['requested', ...CASES.map(([s]) => s)]);
    expect([...RESTORE_POINT_STATUSES].filter((s) => !covered.has(s))).toEqual([]);
  });

  it('never renders a recoverability promise, for any status', () => {
    for (const status of RESTORE_POINT_STATUSES) {
      const { container, unmount } = render(
        <RestorePointBadge outcome={outcome({ status, message: 'x', existingPointAgeMinutes: 240, frequencyMinutes: 1440 })} />,
      );
      const text = (container.textContent ?? '').toLowerCase();
      expect(text).not.toContain('rollback available');
      expect(text).not.toContain('you can roll back');
      expect(text).not.toContain('backup');
      unmount();
    }
  });

  it('renders existing_accepted as NEUTRAL, naming the age and the Windows limit', () => {
    render(
      <RestorePointBadge
        outcome={outcome({ status: 'existing_accepted', existingPointAgeMinutes: 240, frequencyMinutes: 1440 })}
      />,
    );
    const badge = screen.getByTestId('restore-point-badge');
    expect(badge.textContent).toMatch(/created 4h ago/);
    expect(badge.textContent).toMatch(/every 24h/);
    expect(badge.className).not.toMatch(/red|destructive|warning/);
    expect(badge.getAttribute('data-tone')).toBe('neutral');
  });

  it('degrades existing_accepted copy when the age or limit is missing', () => {
    render(<RestorePointBadge outcome={outcome({ status: 'existing_accepted' })} />);
    expect(screen.getByTestId('restore-point-badge').textContent).toBe('Existing point reused');
  });

  it('renders created as positive with the confirmation time', () => {
    render(<RestorePointBadge outcome={outcome({ status: 'created' })} />);
    const badge = screen.getByTestId('restore-point-badge');
    expect(badge.getAttribute('data-tone')).toBe('positive');
    expect(badge.textContent).toMatch(/confirmed \d{1,2}:\d{2}/);
  });

  it.each([
    ['skipped_disabled', 'warning'],
    ['busy', 'warning'],
    ['insufficient_privileges', 'warning'],
    ['verification_failed', 'warning'],
    ['failed', 'danger'],
    ['unsupported', 'neutral'],
    ['skipped_definition_only', 'neutral'],
    ['requested', 'neutral'],
  ] as const)('tones %s as %s', (status, tone) => {
    render(<RestorePointBadge outcome={outcome({ status })} />);
    expect(screen.getByTestId('restore-point-badge').getAttribute('data-tone')).toBe(tone);
  });

  it('renders nothing when there is no outcome', () => {
    const { container } = render(<RestorePointBadge outcome={undefined} />);
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(<RestorePointBadge outcome={null} />);
    expect(c2.firstChild).toBeNull();
  });

  it('shows the requested state as pending rather than as success', () => {
    render(<RestorePointBadge outcome={outcome({ status: 'requested' })} />);
    const badge = screen.getByTestId('restore-point-badge');
    expect(badge.textContent).toMatch(/awaiting the device/i);
    expect(badge.textContent).not.toMatch(/confirmed/i);
  });

  it('includes the failure message for failed, falling back when it is empty', () => {
    const { unmount } = render(<RestorePointBadge outcome={outcome({ status: 'failed', message: 'VSS timed out' })} />);
    expect(screen.getByTestId('restore-point-badge').textContent).toBe('Failed — VSS timed out');
    unmount();
    render(<RestorePointBadge outcome={outcome({ status: 'failed', message: '   ' })} />);
    expect(screen.getByTestId('restore-point-badge').textContent).toBe('Failed');
  });

  it('truncates a very long agent message', () => {
    render(<RestorePointBadge outcome={outcome({ status: 'failed', message: 'x'.repeat(2000) })} />);
    const text = screen.getByTestId('restore-point-badge').textContent ?? '';
    expect(text.length).toBeLessThan(400);
    expect(text.endsWith('…')).toBe(true);
  });

  it('renders the message as text, never as HTML', () => {
    const { container } = render(
      <RestorePointBadge outcome={outcome({ status: 'failed', message: '<img src=x onerror=alert(1)><b>bold</b>' })} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByTestId('restore-point-badge').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('falls back to neutral generic copy for a status this console does not know (version skew)', () => {
    render(<RestorePointBadge outcome={outcome({ status: 'some_future_status' })} />);
    const badge = screen.getByTestId('restore-point-badge');
    expect(badge.textContent).toMatch(/not recognised/i);
    expect(badge.getAttribute('data-tone')).toBe('neutral');
    expect(badge.textContent).not.toContain('some_future_status');
  });
});

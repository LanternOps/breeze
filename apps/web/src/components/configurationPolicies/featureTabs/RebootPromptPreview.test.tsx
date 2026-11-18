import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import RebootPromptPreview, {
  computeRebootPreviewTimes,
  type RebootPromptPreviewSettings,
} from './RebootPromptPreview';

// 10:00 UTC; times are formatted in UTC below so the assertions do not depend
// on the machine's time zone.
const NOW = Date.UTC(2026, 9, 27, 10, 0, 0);
const MINUTE = 60_000;

const base: RebootPromptPreviewSettings = {
  rebootDelayMinutes: 15,
  rebootAllowDeferral: false,
  rebootMaxDeferrals: 3,
  rebootDeferralMinutes: 60,
  rebootPromptTitle: null,
  rebootPromptBody: null,
  rebootPromptButton: null,
};

function renderPreview(overrides: Partial<RebootPromptPreviewSettings> = {}) {
  return render(
    <RebootPromptPreview
      settings={{ ...base, ...overrides }}
      locale="en-US"
      timeZone="UTC"
      now={NOW}
    />,
  );
}

describe('RebootPromptPreview', () => {
  it('shows the built-in English copy when the operator text is empty', () => {
    renderPreview({ rebootPromptTitle: null, rebootPromptBody: '', rebootPromptButton: '   ' });
    // Must match the agent's English catalog copy exactly.
    expect(screen.getByTestId('reboot-preview-title')).toHaveTextContent('Restart to finish installing updates');
    expect(screen.getByTestId('reboot-preview-body')).toHaveTextContent(
      'Your IT support team needs to restart this computer to finish installing updates.',
    );
    expect(screen.getByTestId('reboot-preview-consequence')).toHaveTextContent(
      'If you do nothing, this computer restarts at 10:15 AM. Save your work before then.',
    );
    expect(screen.getByTestId('reboot-preview-restart-now')).toHaveTextContent('Restart now');
  });

  it('preview shows operator button label', () => {
    renderPreview({
      rebootPromptTitle: 'Patch Tuesday restart',
      rebootPromptBody: 'Please save your files.',
      rebootPromptButton: 'Restart right away',
    });
    expect(screen.getByTestId('reboot-preview-title')).toHaveTextContent('Patch Tuesday restart');
    expect(screen.getByTestId('reboot-preview-body')).toHaveTextContent('Please save your files.');
    expect(screen.getByTestId('reboot-preview-restart-now')).toHaveTextContent('Restart right away');
    // Operator copy never fills the consequence line.
    expect(screen.getByTestId('reboot-preview-consequence')).toHaveTextContent(
      'If you do nothing, this computer restarts at 10:15 AM.',
    );
  });

  it('falls back to the built-in text for an operator field the agent would drop', () => {
    // The agent drops (never truncates) a field that fails validation; the
    // preview must show what the device will actually show.
    renderPreview({ rebootPromptTitle: '<b>Restart</b>', rebootPromptButton: 'Go {{now}}' });
    expect(screen.getByTestId('reboot-preview-title')).toHaveTextContent('Restart to finish installing updates');
    expect(screen.getByTestId('reboot-preview-restart-now')).toHaveTextContent('Restart now');
  });

  it('previews {{countdown}} as a sample countdown, never as markup', () => {
    renderPreview({ rebootPromptBody: 'Restarting in {{countdown}}. Again: {{countdown}}.' });
    const body = screen.getByTestId('reboot-preview-body');
    expect(body).toHaveTextContent('Restarting in 15:00. Again: 15:00.');
    expect(body.textContent).not.toContain('{{');
    expect(body.innerHTML).not.toContain('<');
  });

  it('preview hides Postpone when deferral off', () => {
    renderPreview({ rebootAllowDeferral: false });
    expect(screen.queryByTestId('reboot-preview-postpone')).not.toBeInTheDocument();
    expect(screen.queryByTestId('reboot-preview-deadline')).not.toBeInTheDocument();
  });

  it('shows OK as the default when deferral off', () => {
    // The real card (5A) pairs the restart button with an OK that only
    // dismisses it; OK is the default, never the restart.
    renderPreview({ rebootAllowDeferral: false, rebootPromptButton: 'Restart right away' });
    const ok = screen.getByTestId('reboot-preview-ok');
    expect(ok).toHaveTextContent(/^OK/);
    expect(ok).toHaveAttribute('data-default', 'true');
    expect(ok).toContainElement(screen.getByTestId('reboot-preview-default-marker'));
    const restart = screen.getByTestId('reboot-preview-restart-now');
    expect(restart).toHaveTextContent('Restart right away');
    expect(restart).toHaveAttribute('data-default', 'false');
  });

  it('shows Postpone until the next slot, marked as the default, when deferral is on', () => {
    renderPreview({ rebootAllowDeferral: true, rebootDeferralMinutes: 60, rebootMaxDeferrals: 3 });
    const postpone = screen.getByTestId('reboot-preview-postpone');
    // Added to the scheduled restart (10:15), not to now: 11:15.
    expect(postpone).toHaveTextContent('Postpone until 11:15 AM');
    expect(postpone).toHaveAttribute('data-default', 'true');
    expect(screen.queryByTestId('reboot-preview-ok')).not.toBeInTheDocument();
    expect(screen.getByTestId('reboot-preview-restart-now')).toHaveAttribute('data-default', 'false');
    expect(screen.getByTestId('reboot-preview-default-marker')).toHaveTextContent('Default');
    // The deadline the API derives: scheduled + max × interval = 13:15.
    expect(screen.getByTestId('reboot-preview-deadline')).toHaveTextContent('1:15 PM');
  });
});

describe('computeRebootPreviewTimes', () => {
  it('mirrors the agent: base is the scheduled time, clamped to the deadline', () => {
    const times = computeRebootPreviewTimes(
      { rebootDelayMinutes: 15, rebootAllowDeferral: true, rebootMaxDeferrals: 2, rebootDeferralMinutes: 30 },
      NOW,
    );
    expect(times.restartAtMs).toBe(NOW + 15 * MINUTE);
    expect(times.postponeUntilMs).toBe(NOW + 45 * MINUTE);
    expect(times.deadlineMs).toBe(NOW + 75 * MINUTE);
  });

  it('offers no Postpone when deferral is off or the budget is empty', () => {
    for (const settings of [
      { rebootDelayMinutes: 15, rebootAllowDeferral: false, rebootMaxDeferrals: 3, rebootDeferralMinutes: 60 },
      { rebootDelayMinutes: 15, rebootAllowDeferral: true, rebootMaxDeferrals: 0, rebootDeferralMinutes: 60 },
      { rebootDelayMinutes: 15, rebootAllowDeferral: true, rebootMaxDeferrals: 3, rebootDeferralMinutes: 0 },
    ]) {
      const times = computeRebootPreviewTimes(settings, NOW);
      expect(times.postponeUntilMs).toBeNull();
      expect(times.deadlineMs).toBeNull();
    }
  });
});

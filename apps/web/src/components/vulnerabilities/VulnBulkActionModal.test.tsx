import { describe, it, expect, vi } from 'vitest';
import '@/lib/i18n';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';

import { VulnBulkActionModal, formatSelectionPreview, localEndOfDayIso } from './VulnBulkActionModal';

describe('localEndOfDayIso', () => {
  it('serializes the picked date as end-of-day in the local timezone', () => {
    expect(localEndOfDayIso('2030-01-01')).toBe(new Date(2030, 0, 1, 23, 59, 59, 999).toISOString());
  });
});

describe('formatSelectionPreview', () => {
  it('lists up to three device names, appending CVE ids only when provided', () => {
    expect(formatSelectionPreview([{ deviceName: 'WS-01' }])).toBe('WS-01');
    expect(
      formatSelectionPreview([
        { deviceName: 'WS-01', cveId: 'CVE-2026-0001' },
        { deviceName: 'WS-02', cveId: null },
        { deviceName: 'WS-03' },
      ]),
    ).toBe('WS-01 (CVE-2026-0001), WS-02, WS-03');
  });

  it('collapses everything past the third entry into "and N more"', () => {
    expect(
      formatSelectionPreview([
        { deviceName: 'WS-01' },
        { deviceName: 'WS-02' },
        { deviceName: 'WS-03' },
        { deviceName: 'WS-04' },
        { deviceName: 'WS-05' },
      ]),
    ).toBe('WS-01, WS-02, WS-03 and 2 more');
  });
});

describe('VulnBulkActionModal', () => {
  it('remediate: shows finding/device counts, the true consequence, and submits an empty payload', () => {
    const onSubmit = vi.fn();
    render(
      <VulnBulkActionModal kind="remediate" count={3} deviceCount={2} busy={false} onCancel={() => {}} onSubmit={onSubmit} />,
    );
    expect(screen.getByTestId('vuln-bulk-modal')).toHaveTextContent('Remediate findings — 3 findings');
    expect(screen.getByTestId('vuln-bulk-consequence')).toHaveTextContent(
      'Installs the approved patch for each CVE on 2 devices (3 findings). Findings without an approved, applicable patch are skipped.',
    );
    // No free-text inputs on the confirmation.
    expect(screen.queryByTestId('vuln-bulk-text')).toBeNull();
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it('accept: consequence says findings hide until the date and do NOT auto-reopen', () => {
    render(
      <VulnBulkActionModal kind="accept" count={2} deviceCount={2} busy={false} onCancel={() => {}} onSubmit={() => {}} />,
    );
    const consequence = screen.getByTestId('vuln-bulk-consequence');
    expect(consequence).toHaveTextContent(
      'Hides 2 findings on 2 devices from the open queue until the date you set.',
    );
    // Expiry does not reopen findings (no sweep exists) — the copy must not claim it does.
    expect(consequence).toHaveTextContent('They do not reopen automatically — expiring acceptances surface in the “Accepted, expiring soon” card.');
  });

  it('mitigate: consequence says the note is the compensating control and devices are untouched', () => {
    render(
      <VulnBulkActionModal kind="mitigate" count={1} deviceCount={1} busy={false} onCancel={() => {}} onSubmit={() => {}} />,
    );
    expect(screen.getByTestId('vuln-bulk-consequence')).toHaveTextContent(
      'Marks 1 finding on 1 device mitigated, with your note recorded as the compensating control. Breeze does not change the devices.',
    );
  });

  it('shows a compact selection summary when selection is provided, and omits it otherwise', () => {
    const { rerender } = render(
      <VulnBulkActionModal kind="accept" count={1} deviceCount={1} busy={false} onCancel={() => {}} onSubmit={() => {}} />,
    );
    expect(screen.queryByTestId('vuln-bulk-selection')).toBeNull();
    rerender(
      <VulnBulkActionModal
        kind="accept"
        count={4}
        deviceCount={4}
        selection={[
          { deviceName: 'WS-01', cveId: 'CVE-2026-0001' },
          { deviceName: 'WS-02' },
          { deviceName: 'WS-03' },
          { deviceName: 'WS-04' },
        ]}
        busy={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByTestId('vuln-bulk-selection')).toHaveTextContent('WS-01 (CVE-2026-0001), WS-02, WS-03 and 1 more');
  });

  it('accept: requires reason + date, serializes acceptedUntil as local end-of-day', () => {
    const onSubmit = vi.fn();
    render(
      <VulnBulkActionModal kind="accept" count={1} deviceCount={1} busy={false} onCancel={() => {}} onSubmit={onSubmit} />,
    );
    expect(screen.getByTestId('vuln-bulk-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('vuln-bulk-text'), { target: { value: 'compensating control' } });
    fireEvent.change(screen.getByTestId('vuln-bulk-until'), { target: { value: '2030-06-15' } });
    fireEvent.click(screen.getByTestId('vuln-bulk-submit'));
    expect(onSubmit).toHaveBeenCalledWith({
      reason: 'compensating control',
      acceptedUntil: new Date(2030, 5, 15, 23, 59, 59, 999).toISOString(),
    });
  });

  it('is a named dialog, closes on Escape, and restores focus to the trigger', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
            open
          </button>
          {open && (
            <VulnBulkActionModal
              kind="mitigate"
              count={1}
              deviceCount={1}
              busy={false}
              onCancel={() => setOpen(false)}
              onSubmit={() => {}}
            />
          )}
        </div>
      );
    }
    render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    // aria-labelledby points at the visible heading.
    expect(dialog).toHaveAccessibleName('Mark mitigated — 1 finding');
    // Initial focus moves into the dialog.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(screen.getByTestId('vuln-bulk-modal'), { key: 'Escape' });
    expect(screen.queryByTestId('vuln-bulk-modal')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('renders an inline error alert when errorMessage is set', () => {
    const { rerender } = render(
      <VulnBulkActionModal kind="remediate" count={1} deviceCount={1} busy={false} onCancel={() => {}} onSubmit={() => {}} />,
    );
    expect(screen.queryByTestId('vuln-bulk-error')).toBeNull();
    rerender(
      <VulnBulkActionModal
        kind="remediate"
        count={1}
        deviceCount={1}
        busy={false}
        errorMessage="No available patch"
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    const alert = screen.getByTestId('vuln-bulk-error');
    expect(alert).toHaveTextContent('No available patch');
    expect(alert).toHaveAttribute('role', 'alert');
  });

  it('disables both buttons while busy', () => {
    render(
      <VulnBulkActionModal kind="remediate" count={1} deviceCount={1} busy onCancel={() => {}} onSubmit={() => {}} />,
    );
    expect(screen.getByTestId('vuln-bulk-submit')).toBeDisabled();
    expect(screen.getByTestId('vuln-bulk-cancel')).toBeDisabled();
  });
});

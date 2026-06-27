import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import OrgDefaultsEditor from './OrgDefaultsEditor';

const ORG = 'Acme Corp';

describe('OrgDefaultsEditor — maintenance window', () => {
  it('defaults an unconfigured org to the explicit "always (24/7)" state and saves it durably', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} onSave={onSave} />);

    // Always mode is selected by default; the window fields are hidden.
    expect(screen.getByTestId('maintenance-mode-always')).toBeChecked();
    expect(screen.queryByTestId('maintenance-start')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].maintenanceWindow).toBe('24/7');
  });

  it('hydrates a stored window into structured day/start/end fields', () => {
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        defaults={{ maintenanceWindow: 'Sun 02:00-04:00' }}
      />,
    );
    expect(screen.getByTestId('maintenance-mode-window')).toBeChecked();
    expect((screen.getByTestId('maintenance-day') as HTMLSelectElement).value).toBe('Sun');
    expect((screen.getByTestId('maintenance-start') as HTMLInputElement).value).toBe('02:00');
    expect((screen.getByTestId('maintenance-end') as HTMLInputElement).value).toBe('04:00');
  });

  it('builds a canonical window string from the structured inputs on save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} onSave={onSave} />);

    await user.click(screen.getByTestId('maintenance-mode-window'));
    await user.selectOptions(screen.getByTestId('maintenance-day'), 'Wed');
    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave).toHaveBeenCalledTimes(1);
    // Default seeded times are 02:00–04:00.
    expect(onSave.mock.calls[0][0].maintenanceWindow).toBe('Wed 02:00-04:00');
  });

  it('blocks saving an invalid window (start === end) and shows an error', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        defaults={{ maintenanceWindow: '02:00-04:00' }}
      />,
    );

    // Force end to equal start → invalid, zero-length window.
    const end = screen.getByTestId('maintenance-end') as HTMLInputElement;
    await user.clear(end);
    await user.type(end, '02:00');

    expect(screen.getByTestId('maintenance-error')).toBeInTheDocument();
    expect(screen.getByTestId('save-defaults')).toBeDisabled();

    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('treats a legacy "24/7" sentinel as the always state on load', () => {
    render(
      <OrgDefaultsEditor organizationName={ORG} defaults={{ maintenanceWindow: '24/7' }} />,
    );
    expect(screen.getByTestId('maintenance-mode-always')).toBeChecked();
  });

  it('resets an invalid stored window to the always-state, warns, and marks dirty so the fix persists', async () => {
    const user = userEvent.setup();
    const onDirty = vi.fn();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        defaults={{ maintenanceWindow: '0000-2359' }}
        onDirty={onDirty}
        onSave={onSave}
      />,
    );
    // The malformed value failed open at runtime (update anytime), so the editor
    // resets it to the always-state — a careless Save preserves that, not a
    // surprise restrictive window. The operator is told it was ignored.
    expect(screen.getByTestId('maintenance-stored-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('maintenance-mode-always')).toBeChecked();
    // Marked dirty on mount so saving overwrites the invalid stored value.
    expect(onDirty).toHaveBeenCalled();
    // Saving persists the durable always sentinel, replacing the bad value.
    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave.mock.calls[0][0].maintenanceWindow).toBe('24/7');
  });

  it('does not show the invalid-stored notice for a clean window', () => {
    render(
      <OrgDefaultsEditor organizationName={ORG} defaults={{ maintenanceWindow: 'Sun 02:00-04:00' }} />,
    );
    expect(screen.queryByTestId('maintenance-stored-invalid')).not.toBeInTheDocument();
  });
});

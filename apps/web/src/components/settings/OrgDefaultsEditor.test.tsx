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

describe('OrgDefaultsEditor — enrollment defaults (#2776)', () => {
  it('includes the enrollment defaults in the saved payload', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} onSave={onSave} locked={[]} />);

    await user.selectOptions(screen.getByTestId('org-default-enrollment-ttl'), '10080');
    const count = screen.getByTestId('org-default-enrollment-device-count');
    await user.clear(count);
    await user.type(count, '25');
    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultEnrollmentTtlMinutes: 10080,
        defaultEnrollmentDeviceCount: 25,
      }),
    );
  });

  it('hydrates the stored org values', () => {
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        defaults={{ defaultEnrollmentTtlMinutes: 43200, defaultEnrollmentDeviceCount: 7 }}
      />,
    );
    expect((screen.getByTestId('org-default-enrollment-ttl') as HTMLSelectElement).value).toBe('43200');
    expect((screen.getByTestId('org-default-enrollment-device-count') as HTMLInputElement).value).toBe('7');
  });

  it('omits an unset enrollment default from the payload so the partner value is inherited', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} onSave={onSave} />);

    await user.click(screen.getByTestId('save-defaults'));

    const payload = onSave.mock.calls[0][0];
    expect(payload.defaultEnrollmentTtlMinutes).toBeUndefined();
    expect(payload.defaultEnrollmentDeviceCount).toBeUndefined();
  });

  it('never offers an editable link-lifetime cap — the cap is partner-only', () => {
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        onSave={vi.fn()}
        locked={['defaults.maxEnrollmentLinkTtlMinutes']}
        partnerMaxEnrollmentTtlMinutes={1440}
      />,
    );
    expect(screen.queryByTestId('org-max-enrollment-ttl')).toBeNull();
    expect(screen.getByTestId('org-max-enrollment-ttl-readonly')).toBeInTheDocument();
  });

  it('does not surface a cap notice when the partner has not set one', () => {
    render(<OrgDefaultsEditor organizationName={ORG} onSave={vi.fn()} locked={[]} />);
    expect(screen.queryByTestId('org-max-enrollment-ttl-readonly')).toBeNull();
  });

  it('never sends maxEnrollmentLinkTtlMinutes, even when the org blob still carries a stale one', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        onSave={onSave}
        defaults={{ maxEnrollmentLinkTtlMinutes: 525600 }}
        locked={['defaults.maxEnrollmentLinkTtlMinutes']}
        partnerMaxEnrollmentTtlMinutes={60}
      />,
    );

    await user.click(screen.getByTestId('save-defaults'));
    // Sending it back would 403 against the partner lock (assertNotLocked).
    expect('maxEnrollmentLinkTtlMinutes' in onSave.mock.calls[0][0]).toBe(false);
  });

  it('offers only TTL options at or below the partner cap', () => {
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        onSave={vi.fn()}
        locked={['defaults.maxEnrollmentLinkTtlMinutes']}
        partnerMaxEnrollmentTtlMinutes={10080}
      />,
    );

    const select = screen.getByTestId('org-default-enrollment-ttl') as HTMLSelectElement;
    const values = Array.from(select.options).map(o => o.value);
    // '' is the "inherit from partner" entry; 30 days / 90 days / 1 year are
    // above the 7-day cap and would be silently clamped at read time.
    expect(values).toEqual(['', '60', '1440', '10080']);
  });

  it('shows a stored over-cap default as its own option instead of misreporting it', () => {
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        onSave={vi.fn()}
        defaults={{ defaultEnrollmentTtlMinutes: 525600 }}
        locked={['defaults.maxEnrollmentLinkTtlMinutes']}
        partnerMaxEnrollmentTtlMinutes={1440}
      />,
    );

    const select = screen.getByTestId('org-default-enrollment-ttl') as HTMLSelectElement;
    // The stored value is what is displayed — dropping it would leave the
    // select on the blank "inherit" entry, reporting an override as absent.
    expect(select.value).toBe('525600');
    expect([...select.options].map(o => o.value)).toEqual(['', '60', '1440', '525600']);
  });

  it('never rewrites a stored over-cap default when an unrelated field is saved', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        onSave={onSave}
        defaults={{ defaultEnrollmentTtlMinutes: 525600 }}
        locked={['defaults.maxEnrollmentLinkTtlMinutes']}
        partnerMaxEnrollmentTtlMinutes={1440}
      />,
    );

    // This editor rebuilds the WHOLE defaults blob on save, so clamping here
    // would let someone editing their maintenance window silently destroy an
    // enrollment preference they never touched — irreversibly, if the partner
    // later raises the cap. resolveEnrollmentDefaults clamps at read time.
    await user.click(screen.getByTestId('maintenance-mode-window'));
    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave.mock.calls[0][0].defaultEnrollmentTtlMinutes).toBe(525600);
  });

  it('leaves the full option set when the partner has set no cap', () => {
    render(<OrgDefaultsEditor organizationName={ORG} onSave={vi.fn()} locked={[]} />);

    const select = screen.getByTestId('org-default-enrollment-ttl') as HTMLSelectElement;
    expect(Array.from(select.options).map(o => o.value)).toEqual([
      '', '60', '1440', '10080', '43200', '129600', '525600',
    ]);
  });
});

// Issue #2752: this editor was the only org settings editor with no lock
// awareness — its four siblings (security/notifications/eventLogs/branding) all
// disable partner-locked fields. Because it always posted the whole category from
// hard-coded seeds, a partner-set `autoEnrollment` collided with the server-side
// lock guard and 403'd every save in the category.
describe('OrgDefaultsEditor — partner locks', () => {
  const ENFORCED = { enabled: false, requireApproval: false, sendWelcome: false };

  it('disables the auto-enrollment checkboxes and flags them as partner-managed', () => {
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        locked={['defaults.autoEnrollment']}
        effectiveDefaults={{ autoEnrollment: ENFORCED }}
      />,
    );

    expect(screen.getByTestId('auto-enrollment-enabled')).toBeDisabled();
    expect(screen.getByTestId('auto-enrollment-require-approval')).toBeDisabled();
    expect(screen.getByTestId('auto-enrollment-send-welcome')).toBeDisabled();
    expect(screen.getByTestId('auto-enrollment-locked')).toBeInTheDocument();
  });

  it('seeds a locked field from the effective (partner) value, not the hard-coded default', () => {
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        locked={['defaults.autoEnrollment']}
        effectiveDefaults={{ autoEnrollment: ENFORCED }}
      />,
    );

    // The hard-coded default would have been enabled=true / sendWelcome=true.
    expect(screen.getByTestId('auto-enrollment-enabled')).not.toBeChecked();
    expect(screen.getByTestId('auto-enrollment-send-welcome')).not.toBeChecked();
  });

  it('echoes the partner value back verbatim on save so the write is a permitted no-op', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        onSave={onSave}
        // The org's own stored value diverges from the partner's — it is inert
        // while the lock holds, and must not be what we post.
        defaults={{ autoEnrollment: { enabled: true, requireApproval: true, sendWelcome: true } }}
        locked={['defaults.autoEnrollment']}
        effectiveDefaults={{ autoEnrollment: ENFORCED }}
      />,
    );

    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].autoEnrollment).toEqual(ENFORCED);
  });

  it('leaves unlocked fields editable and org-owned', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        onSave={onSave}
        locked={['defaults.autoEnrollment']}
        effectiveDefaults={{ autoEnrollment: ENFORCED, deviceGroup: 'Critical Infrastructure' }}
      />,
    );

    const group = screen.getByTestId('default-device-group') as HTMLSelectElement;
    expect(group).toBeEnabled();
    await user.selectOptions(group, 'Contractors');
    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave.mock.calls[0][0].deviceGroup).toBe('Contractors');
    // The locked field still rides along unchanged — that is the payload shape
    // the API now accepts.
    expect(onSave.mock.calls[0][0].autoEnrollment).toEqual(ENFORCED);
  });

  it('never treats agentVersionPins as locked — it is inherit-with-override (#2124)', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        onSave={onSave}
        // The API advertises a partner pin in `locked`, but the org may override it.
        locked={['defaults.agentVersionPins']}
        effectiveDefaults={{ agentVersionPins: { agent: '0.87.0' } }}
        defaults={{ agentVersionPins: { agent: '0.88.0' } }}
      />,
    );

    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave.mock.calls[0][0].agentVersionPins).toEqual({ agent: '0.88.0' });
  });

  it('locks the maintenance-window controls and preserves the partner string exactly', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        onSave={onSave}
        locked={['defaults.maintenanceWindow']}
        effectiveDefaults={{ maintenanceWindow: 'Sun 02:00-04:00' }}
      />,
    );

    expect(screen.getByTestId('maintenance-mode-always')).toBeDisabled();
    expect(screen.getByTestId('maintenance-mode-window')).toBeChecked();
    expect(screen.getByTestId('maintenance-day')).toBeDisabled();

    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave.mock.calls[0][0].maintenanceWindow).toBe('Sun 02:00-04:00');
  });

  it('is unaffected when nothing is locked', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} onSave={onSave} locked={[]} />);

    expect(screen.getByTestId('auto-enrollment-enabled')).toBeEnabled();
    expect(screen.queryByTestId('auto-enrollment-locked')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave.mock.calls[0][0].autoEnrollment).toEqual({
      enabled: true,
      requireApproval: false,
      sendWelcome: true,
    });
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: fetchWithAuthMock }));

import OrgDefaultsEditor from './OrgDefaultsEditor';

const ORG = 'Acme Corp';
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const GDYN = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
});

describe('OrgDefaultsEditor — default device group picker (#9617)', () => {
  const groupsResponse = {
    ok: true,
    json: async () => ({
      data: [
        { id: G1, name: 'Servers', type: 'static' },
        { id: G2, name: 'Laptops', type: 'static' },
        { id: GDYN, name: 'Windows 11 (dynamic)', type: 'dynamic' },
      ],
    }),
  };

  it("lists the org's real static groups (not hard-coded names) and saves the group id", async () => {
    fetchWithAuthMock.mockResolvedValue(groupsResponse);
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} organizationId="org-1" onSave={onSave} />);

    await screen.findByRole('option', { name: 'Servers' });
    expect(fetchWithAuthMock).toHaveBeenCalledWith(expect.stringContaining('/device-groups?orgId=org-1'));
    expect(screen.getByRole('option', { name: 'Laptops' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Windows 11 (dynamic)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Contractors' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('default-device-group'), G2);
    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave.mock.calls[0][0].deviceGroup).toBe(G2);
  });

  it('treats a legacy display-string value as unset and saves no deviceGroup', async () => {
    fetchWithAuthMock.mockResolvedValue(groupsResponse);
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        organizationId="org-1"
        defaults={{ deviceGroup: 'Contractors' }}
        onSave={onSave}
      />,
    );
    await screen.findByRole('option', { name: 'Servers' });
    expect((screen.getByTestId('default-device-group') as HTMLSelectElement).value).toBe('');
    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave.mock.calls[0][0].deviceGroup).toBeUndefined();
  });

  it('shows a stored id missing from the list as unavailable, not as None, and keeps it on save', async () => {
    fetchWithAuthMock.mockResolvedValue(groupsResponse);
    const user = userEvent.setup();
    const onSave = vi.fn();
    const GONE = '44444444-4444-4444-8444-444444444444';
    render(<OrgDefaultsEditor organizationName={ORG} organizationId="org-1" defaults={{ deviceGroup: GONE }} onSave={onSave} />);
    await screen.findByRole('option', { name: 'Servers' });
    expect((screen.getByTestId('default-device-group') as HTMLSelectElement).value).toBe(GONE);
    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave.mock.calls[0][0].deviceGroup).toBe(GONE);
  });

  it('pre-selects a stored group id and no longer renders alert-threshold or send-welcome controls', async () => {
    fetchWithAuthMock.mockResolvedValue(groupsResponse);
    render(<OrgDefaultsEditor organizationName={ORG} organizationId="org-1" defaults={{ deviceGroup: G1 }} />);
    await waitFor(() =>
      expect((screen.getByTestId('default-device-group') as HTMLSelectElement).value).toBe(G1),
    );
    expect(screen.queryByRole('combobox', { name: 'Default alert severity' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('auto-enrollment-send-welcome')).not.toBeInTheDocument();
  });
});

describe('OrgDefaultsEditor filter selects accessible name (#7156)', () => {
  it('gives the device-group and agent-update-policy selects a real accessible name', () => {
    render(<OrgDefaultsEditor organizationName={ORG} onSave={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Default device group' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Agent update policy' })).toBeInTheDocument();
  });
});

describe('OrgDefaultsEditor — maintenance window', () => {
  it('shows an unconfigured org in the "always (24/7)" state without saving it as an override', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} onSave={onSave} />);

    // Always mode is selected by default; the window fields are hidden.
    expect(screen.getByTestId('maintenance-mode-always')).toBeChecked();
    expect(screen.queryByTestId('maintenance-start')).not.toBeInTheDocument();

    // No stored window already means "update anytime" to the resolver, so an
    // untouched control writes nothing (#9945).
    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect('maintenanceWindow' in onSave.mock.calls[0][0]).toBe(false);
  });

  it('saves the 24/7 sentinel when the admin switches a stored window back to always', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} defaults={{ maintenanceWindow: 'Sun 02:00-04:00' }} onSave={onSave} />);

    await user.click(screen.getByTestId('maintenance-mode-always'));
    await user.click(screen.getByTestId('save-defaults'));
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
    // Saving drops the bad value, so the field inherits again (the resolver
    // reads a missing window as "anytime") rather than becoming a 24/7
    // override the admin never chose (#9945).
    await user.click(screen.getByTestId('save-defaults'));
    expect('maintenanceWindow' in onSave.mock.calls[0][0]).toBe(false);
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
  const ENFORCED = { enabled: false, requireApproval: false };

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

    // The hard-coded default would have been enabled=true.
    expect(screen.getByTestId('auto-enrollment-enabled')).not.toBeChecked();
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
        defaults={{ autoEnrollment: { enabled: true, requireApproval: true } }}
        locked={['defaults.autoEnrollment']}
        effectiveDefaults={{ autoEnrollment: ENFORCED }}
      />,
    );

    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0].autoEnrollment).toEqual(ENFORCED);
  });

  it('leaves unlocked fields editable and org-owned', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: G1, name: 'Servers', type: 'static' }] }),
    });
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        organizationId="org-1"
        onSave={onSave}
        locked={['defaults.autoEnrollment']}
        effectiveDefaults={{ autoEnrollment: ENFORCED }}
      />,
    );

    const group = screen.getByTestId('default-device-group') as HTMLSelectElement;
    expect(group).toBeEnabled();
    await screen.findByRole('option', { name: 'Servers' });
    await user.selectOptions(group, G1);
    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave.mock.calls[0][0].deviceGroup).toBe(G1);
    // The org never stored autoEnrollment, so the partner's locked value is not
    // copied onto the org row (#9945).
    expect('autoEnrollment' in onSave.mock.calls[0][0]).toBe(false);
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
        // An inert org value from before the lock; re-posting it would 403.
        defaults={{ maintenanceWindow: 'Mon 01:00-02:00' }}
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
    // Untouched and never stored: nothing is written (#9945).
    expect('autoEnrollment' in onSave.mock.calls[0][0]).toBe(false);
  });
});

// Issue #9945: the editor used to rebuild the whole `defaults` blob from its
// controls on every save, so changing one field wrote every displayed default
// as an explicit org override (`{}` became six keys). The save payload must
// carry only what the org already stored plus what the admin actually changed.
describe('OrgDefaultsEditor — only changed fields become overrides (#9945)', () => {
  it('saves exactly the one field the admin changed on an org with no overrides', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: G1, name: 'Servers', type: 'static' }] }),
    });
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} organizationId="org-1" defaults={{}} onSave={onSave} />);

    await screen.findByRole('option', { name: 'Servers' });
    await user.selectOptions(screen.getByTestId('default-device-group'), G1);
    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave.mock.calls[0][0]).toEqual({ deviceGroup: G1 });
  });

  it('writes nothing when Save is clicked without changes', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} onSave={onSave} />);

    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave.mock.calls[0][0]).toEqual({});
  });

  it('keeps untouched stored overrides verbatim and adds only the edited field', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const stored = {
      policyDefaults: { deviceCompliance: 'lenient', dataProtection: 'strict', accessControl: 'standard' },
      // Legacy value the UI folds into "auto" for display; untouched, it must
      // not be rewritten.
      agentUpdatePolicy: 'staged',
      maintenanceWindow: 'Sun 02:00-04:00',
    };
    render(<OrgDefaultsEditor organizationName={ORG} defaults={stored} onSave={onSave} />);

    await user.selectOptions(screen.getByTestId('org-default-enrollment-ttl'), '1440');
    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave.mock.calls[0][0]).toEqual({ ...stored, defaultEnrollmentTtlMinutes: 1440 });
  });

  it('does not write an empty agentVersionPins object for an org that never pinned', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} defaults={{}} onSave={onSave} />);

    await user.click(screen.getByTestId('auto-enrollment-require-approval'));
    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave.mock.calls[0][0]).toEqual({ autoEnrollment: { enabled: true, requireApproval: true } });
  });

  it('does not materialise a locked partner value the org never stored', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        onSave={onSave}
        defaults={{}}
        locked={['defaults.autoEnrollment']}
        effectiveDefaults={{ autoEnrollment: { enabled: false, requireApproval: false } }}
      />,
    );

    await user.click(screen.getByTestId('save-defaults'));
    expect('autoEnrollment' in onSave.mock.calls[0][0]).toBe(false);
  });

  it('labels an unset field as inherited and offers no reset', () => {
    render(<OrgDefaultsEditor organizationName={ORG} defaults={{}} />);

    expect(screen.getByTestId('defaults-source-agentUpdatePolicy')).toHaveTextContent('Inherited default');
    expect(screen.queryByTestId('defaults-reset-agentUpdatePolicy')).toBeNull();
  });

  it('labels a stored override and resets it back to inherited on save', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        defaults={{
          agentUpdatePolicy: 'manual',
          maintenanceWindow: 'Sun 02:00-04:00',
          policyDefaults: { deviceCompliance: 'lenient', dataProtection: 'strict', accessControl: 'standard' },
          autoEnrollment: { enabled: false, requireApproval: true },
          deviceGroup: G1,
        }}
        onSave={onSave}
      />,
    );

    expect(screen.getByTestId('defaults-source-agentUpdatePolicy')).toHaveTextContent('Set for this organization');
    for (const field of ['agentUpdatePolicy', 'maintenanceWindow', 'policyDefaults', 'autoEnrollment']) {
      await user.click(screen.getByTestId(`defaults-reset-${field}`));
    }

    // The controls fall back to the inherited values.
    expect(screen.getByRole('combobox', { name: 'Agent update policy' })).toHaveValue('auto');
    expect(screen.getByTestId('maintenance-mode-always')).toBeChecked();
    expect(screen.getByTestId('auto-enrollment-enabled')).toBeChecked();
    expect(screen.getByTestId('defaults-source-agentUpdatePolicy')).toHaveTextContent('Inherited default');

    await user.click(screen.getByTestId('save-defaults'));
    expect(onSave.mock.calls[0][0]).toEqual({ deviceGroup: G1 });
  });

  it('turns a field back into an override when it is edited after a reset', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OrgDefaultsEditor organizationName={ORG} defaults={{ agentUpdatePolicy: 'manual' }} onSave={onSave} />);

    await user.click(screen.getByTestId('defaults-reset-agentUpdatePolicy'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent update policy' }), 'manual');
    expect(screen.getByTestId('defaults-source-agentUpdatePolicy')).toHaveTextContent('Set for this organization');
    await user.click(screen.getByTestId('save-defaults'));

    expect(onSave.mock.calls[0][0]).toEqual({ agentUpdatePolicy: 'manual' });
  });

  it('shows no inheritance control on a partner-locked field', () => {
    render(
      <OrgDefaultsEditor
        organizationName={ORG}
        defaults={{ agentUpdatePolicy: 'manual' }}
        locked={['defaults.agentUpdatePolicy']}
        effectiveDefaults={{ agentUpdatePolicy: 'auto' }}
      />,
    );
    expect(screen.queryByTestId('defaults-source-agentUpdatePolicy')).toBeNull();
    expect(screen.queryByTestId('defaults-reset-agentUpdatePolicy')).toBeNull();
  });
});

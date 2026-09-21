import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SecurityTab from './SecurityTab';
import type { FeatureLink, FeatureTabProps } from './types';

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network.
const saveMock = vi.fn(
  async (
    _existingId: string | null,
    _payload: { featureType: string; featurePolicyId: string | null; inlineSettings: Record<string, unknown> },
  ) => ({ id: 'link-1' }),
);
const removeMock = vi.fn(async () => true);

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

const onLinkChanged = vi.fn();

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged,
};

function parentLinkWith(overrides: Partial<FeatureLink['inlineSettings']>): FeatureLink {
  return {
    id: 'link-parent',
    featureType: 'security',
    featurePolicyId: null,
    inlineSettings: { autoQuarantine: false, ...overrides },
  };
}

describe('SecurityTab inheritance (#5080)', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    onLinkChanged.mockClear();
  });

  it('shows Configured (inherited) and seeds the form from parentLink when only a parent link exists', () => {
    render(<SecurityTab {...baseProps} parentLink={parentLinkWith({ autoQuarantine: false })} />);

    expect(screen.getByText(/Configured \(inherited\)/i)).toBeTruthy();
    // autoQuarantine defaults to true; the parent link's distinctive override
    // (false) must be reflected, read-only, in the form.
    const toggle = screen.getByText('Auto-quarantine').closest('div')?.parentElement
      ?.querySelector('button');
    expect(toggle?.className).not.toContain('bg-emerald-500/80');
  });

  it('Override saves a copy of the inherited settings as the policy\'s own link', () => {
    render(<SecurityTab {...baseProps} parentLink={parentLinkWith({ autoQuarantine: false })} />);

    fireEvent.click(screen.getByRole('button', { name: /override/i }));

    expect(saveMock).toHaveBeenCalled();
    const [existingId, payload] = saveMock.mock.calls[0] as unknown as [
      string | null,
      { featureType: string; featurePolicyId: string | null; inlineSettings: Record<string, unknown> },
    ];
    expect(existingId).toBeNull();
    expect(payload.featureType).toBe('security');
    expect(payload.featurePolicyId).toBeNull();
    expect(payload.inlineSettings).toMatchObject({ autoQuarantine: false });
  });

  it('Revert to Parent removes the override', async () => {
    const existingLink: FeatureLink = {
      id: 'link-own',
      featureType: 'security',
      featurePolicyId: null,
      inlineSettings: { autoQuarantine: true },
    };
    render(
      <SecurityTab
        {...baseProps}
        existingLink={existingLink}
        parentLink={parentLinkWith({ autoQuarantine: false })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /revert to parent/i }));
    // #5314: Revert to Parent now asks for confirmation first.
    fireEvent.click(screen.getByTestId('feature-tab-revert-confirm'));

    expect(removeMock).toHaveBeenCalledWith('link-own');
    // The detail page's own featureLinks state must be told the override is
    // gone (#5080) — otherwise it stays stale after a successful revert.
    await waitFor(() => expect(onLinkChanged).toHaveBeenCalledWith(null, 'security'));
  });

  it('sends featurePolicyId: null on a plain (non-inherited) save', () => {
    render(<SecurityTab {...baseProps} linkedPolicyId="parent-1" />);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(saveMock).toHaveBeenCalled();
    const [, payload] = saveMock.mock.calls[0] as unknown as [string | null, { featurePolicyId: string | null }];
    expect(payload.featurePolicyId).toBeNull();
  });
});

describe('SecurityTab scan settings (#6263 W01)', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    onLinkChanged.mockClear();
  });

  it('saves only the SecurityScanSettings keys', async () => {
    render(<SecurityTab {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const inlineSettings = saveMock.mock.calls.at(-1)![1].inlineSettings;
    expect(Object.keys(inlineSettings).sort()).toEqual([
      'autoQuarantine', 'exclusions', 'maxFileSizeMb', 'scanDayOfMonth', 'scanDayOfWeek',
      'scanHour', 'scanMinute', 'scanTimeoutMinutes', 'scanType', 'scheduledScans',
    ]);
  });

  it('renders no control for the five removed toggles', () => {
    render(<SecurityTab {...baseProps} />);
    // Asserted on the visible labels, not on testids: the ToggleRows being
    // deleted carry no data-testid today, so a testid assertion would pass
    // vacuously both before and after the change.
    for (const label of [
      'Real-time protection', 'Behavioral monitoring', 'Cloud lookup',
      'Block untrusted USB devices', 'Notify user',
    ]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('drops values an older policy saved for the removed toggles', async () => {
    render(<SecurityTab {...baseProps} existingLink={{
      id: 'link-1', featureType: 'security', featurePolicyId: null,
      inlineSettings: { realTimeProtection: true, blockUntrustedUsb: true, autoQuarantine: false },
    } as never} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const inlineSettings = saveMock.mock.calls.at(-1)![1].inlineSettings;
    expect(inlineSettings).not.toHaveProperty('realTimeProtection');
    expect(inlineSettings).not.toHaveProperty('blockUntrustedUsb');
    expect(inlineSettings.autoQuarantine).toBe(false); // a kept value survives
  });

  it('offers scan type, size cap and timeout', () => {
    render(<SecurityTab {...baseProps} />);
    expect(screen.getByTestId('security-scan-type')).toBeTruthy();
    expect(screen.getByTestId('security-max-file-size-mb')).toBeTruthy();
    expect(screen.getByTestId('security-scan-timeout-minutes')).toBeTruthy();
  });
});

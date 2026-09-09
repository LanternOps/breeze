import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SecurityTab from './SecurityTab';
import type { FeatureLink, FeatureTabProps } from './types';

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network.
const saveMock = vi.fn(async () => ({ id: 'link-1' }));
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
    inlineSettings: { blockUntrustedUsb: true, ...overrides },
  };
}

describe('SecurityTab inheritance (#5080)', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    onLinkChanged.mockClear();
  });

  it('shows Configured (inherited) and seeds the form from parentLink when only a parent link exists', () => {
    render(<SecurityTab {...baseProps} parentLink={parentLinkWith({ blockUntrustedUsb: true })} />);

    expect(screen.getByText(/Configured \(inherited\)/i)).toBeTruthy();
    // blockUntrustedUsb defaults to false; the parent link's distinctive
    // override (true) must be reflected, read-only, in the form.
    const toggle = screen.getByText('Block untrusted USB devices').closest('div')?.parentElement
      ?.querySelector('button');
    expect(toggle?.className).toContain('bg-emerald-500/80');
  });

  it('Override saves a copy of the inherited settings as the policy\'s own link', () => {
    render(<SecurityTab {...baseProps} parentLink={parentLinkWith({ blockUntrustedUsb: true })} />);

    fireEvent.click(screen.getByRole('button', { name: /override/i }));

    expect(saveMock).toHaveBeenCalled();
    const [existingId, payload] = saveMock.mock.calls[0] as unknown as [
      string | null,
      { featureType: string; featurePolicyId: string | null; inlineSettings: Record<string, unknown> },
    ];
    expect(existingId).toBeNull();
    expect(payload.featureType).toBe('security');
    expect(payload.featurePolicyId).toBeNull();
    expect(payload.inlineSettings).toMatchObject({ blockUntrustedUsb: true });
  });

  it('Revert to Parent removes the override', async () => {
    const existingLink: FeatureLink = {
      id: 'link-own',
      featureType: 'security',
      featurePolicyId: null,
      inlineSettings: { blockUntrustedUsb: false },
    };
    render(
      <SecurityTab
        {...baseProps}
        existingLink={existingLink}
        parentLink={parentLinkWith({ blockUntrustedUsb: true })}
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

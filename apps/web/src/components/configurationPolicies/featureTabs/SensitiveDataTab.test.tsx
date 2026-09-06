import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SensitiveDataTab from './SensitiveDataTab';
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

function parentLinkWith(overrides: Record<string, unknown>): FeatureLink {
  return {
    id: 'link-parent',
    featureType: 'sensitive_data',
    featurePolicyId: null,
    inlineSettings: { workers: 4, ...overrides },
  };
}

describe('SensitiveDataTab inheritance (#5080)', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    onLinkChanged.mockClear();
  });

  it('shows Configured (inherited) and seeds the form from parentLink when only a parent link exists', () => {
    const { container } = render(
      <SensitiveDataTab {...baseProps} parentLink={parentLinkWith({ workers: 17 })} />,
    );

    expect(screen.getByText(/Configured \(inherited\)/i)).toBeTruthy();
    // Distinctive setting from the parent link (workers defaults to 4).
    expect(container.textContent).toContain('17workers');
  });

  it('Override saves a copy of the inherited settings as the policy\'s own link', () => {
    render(<SensitiveDataTab {...baseProps} parentLink={parentLinkWith({ workers: 17 })} />);

    fireEvent.click(screen.getByRole('button', { name: /override/i }));

    expect(saveMock).toHaveBeenCalled();
    const [existingId, payload] = saveMock.mock.calls[0] as unknown as [
      string | null,
      { featureType: string; featurePolicyId: string | null; inlineSettings: Record<string, unknown> },
    ];
    expect(existingId).toBeNull();
    expect(payload.featureType).toBe('sensitive_data');
    expect(payload.featurePolicyId).toBeNull();
    expect(payload.inlineSettings).toMatchObject({ workers: 17 });
  });

  it('Revert to Parent removes the override', async () => {
    const existingLink: FeatureLink = {
      id: 'link-own',
      featureType: 'sensitive_data',
      featurePolicyId: null,
      inlineSettings: { workers: 8 },
    };
    render(
      <SensitiveDataTab
        {...baseProps}
        existingLink={existingLink}
        parentLink={parentLinkWith({ workers: 17 })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /revert to parent/i }));

    expect(removeMock).toHaveBeenCalledWith('link-own');
    // The detail page's own featureLinks state must be told the override is
    // gone (#5080) — otherwise it stays stale after a successful revert.
    await waitFor(() => expect(onLinkChanged).toHaveBeenCalledWith(null, 'sensitive_data'));
  });

  it('sends featurePolicyId: null on a plain (non-inherited) save', () => {
    render(<SensitiveDataTab {...baseProps} linkedPolicyId="parent-1" />);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(saveMock).toHaveBeenCalled();
    const [, payload] = saveMock.mock.calls[0] as unknown as [string | null, { featurePolicyId: string | null }];
    expect(payload.featurePolicyId).toBeNull();
  });
});

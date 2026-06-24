import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import HelperTab from './HelperTab';

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: vi.fn(async () => ({ id: 'link-1' })),
    remove: vi.fn(async () => true),
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

import type { FeatureTabProps, FeatureLink } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

const helperLink = (enabled: boolean): FeatureLink => ({
  id: 'link-1',
  featureType: 'helper',
  featurePolicyId: null,
  inlineSettings: { enabled },
});

describe('HelperTab', () => {
  it('keeps tray-menu options visible but disabled when deploy is off (#1863)', () => {
    render(<HelperTab {...baseProps} />);

    // The toggles are discoverable (rendered), not hidden...
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.length).toBe(3);
    // ...but disabled until deploy is enabled, with a hint explaining why.
    expect(checkboxes.every((c) => c.disabled)).toBe(true);
    expect(screen.getByText(/Enable "Deploy Breeze Assist to devices" above/i)).toBeTruthy();
  });

  it('shows a "Saved (not deployed)" badge when a link exists but deploy is off', () => {
    render(<HelperTab {...baseProps} existingLink={helperLink(false)} />);
    expect(screen.getByText('Saved (not deployed)')).toBeTruthy();
    expect(screen.queryByText('Configured')).toBeNull();
  });

  it('shows "Configured" and enables the toggles when deploy is on', () => {
    render(<HelperTab {...baseProps} existingLink={helperLink(true)} />);
    expect(screen.getByText('Configured')).toBeTruthy();
    expect(screen.queryByText('Saved (not deployed)')).toBeNull();
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.every((c) => !c.disabled)).toBe(true);
  });
});

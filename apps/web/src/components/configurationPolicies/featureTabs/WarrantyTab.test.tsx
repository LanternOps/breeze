import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WarrantyTab from './WarrantyTab';

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

import type { FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

describe('WarrantyTab', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  // #5080: `featurePolicyId` means a standalone entity id (update ring,
  // backup profile, ...) — Warranty is inline settings, so it must never
  // carry the parent CONFIG policy's own id.
  it('sends featurePolicyId: null even when a parent config policy is linked', () => {
    render(<WarrantyTab {...baseProps} linkedPolicyId="parent-1" />);

    const saveButton = screen
      .getAllByRole('button')
      .find((b) => /^save$/i.test(b.textContent?.trim() ?? '')) as HTMLButtonElement;
    fireEvent.click(saveButton);

    expect(saveMock).toHaveBeenCalled();
    const call = saveMock.mock.calls[0] as unknown as [unknown, { featurePolicyId: string | null }];
    expect(call[1].featurePolicyId).toBeNull();
  });
});

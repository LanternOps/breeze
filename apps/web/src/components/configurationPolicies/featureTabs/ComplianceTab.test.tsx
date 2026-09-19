import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ComplianceTab from './ComplianceTab';

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

describe('ComplianceTab', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  // #5080: `featurePolicyId` means a standalone entity id (update ring,
  // backup profile, ...) — Compliance rules are inline settings (per-rule
  // remediation pickers reference scripts/software, not a policy-level
  // entity), so it must never carry the parent CONFIG policy's own id.
  it('sends featurePolicyId: null even when a parent config policy is linked', async () => {
    render(<ComplianceTab {...baseProps} linkedPolicyId="parent-1" />);

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const call = saveMock.mock.calls[0] as unknown as [unknown, { featurePolicyId: string | null }];
    expect(call[1].featurePolicyId).toBeNull();
  });
});

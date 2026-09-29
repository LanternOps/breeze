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

  // A rule set is identified by (feature link, name) across saves — the
  // evaluator's state and the compliance alert key on it — so two rule sets
  // with one name are refused. The API answers 400; the tab says so first.
  it('refuses to save two rule sets with the same name and says which name', async () => {
    const rule = { type: 'disk_space_minimum', minGb: 5 };
    const existingLink = {
      id: 'link-1',
      featureType: 'compliance',
      inlineSettings: {
        items: [
          { name: 'Baseline', rules: [rule], enforcementLevel: 'warn', checkIntervalMinutes: 60 },
          { name: 'Baseline', rules: [rule], enforcementLevel: 'warn', checkIntervalMinutes: 60 },
        ],
      },
    } as unknown as FeatureTabProps['existingLink'];
    render(<ComplianceTab {...baseProps} existingLink={existingLink} />);

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(await screen.findByText(/More than one rule set is named "Baseline"/)).toBeTruthy();
    expect(saveMock).not.toHaveBeenCalled();
  });

  // The tab's own default name must never be the duplicate: with "Compliance
  // Rule Set 1" deleted and "…2" left, a new set used to be named "…2" again.
  it('names a new rule set so it never repeats a name already in the list', async () => {
    const rule = { type: 'disk_space_minimum', minGb: 5 };
    const existingLink = {
      id: 'link-1',
      featureType: 'compliance',
      inlineSettings: {
        items: [{ name: 'Compliance Rule Set 2', rules: [rule], enforcementLevel: 'warn', checkIntervalMinutes: 60 }],
      },
    } as unknown as FeatureTabProps['existingLink'];
    render(<ComplianceTab {...baseProps} existingLink={existingLink} />);

    fireEvent.click(screen.getByRole('button', { name: /Add Compliance Rule/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const call = saveMock.mock.calls[0] as unknown as [unknown, { inlineSettings: { items: Array<{ name: string }> } }];
    const names = call[1].inlineSettings.items.map((i) => i.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from '../../../stores/auth';
import { i18n } from '@/lib/i18n';
import PolicyFeatureEditor from './PolicyFeatureEditor';
import type { FeatureLink } from '../featureTabs/types';

const fetchMock = vi.mocked(fetchWithAuth);

// The page re-reads the policy after Activate, an Apply or a details save, and
// every parent link arrives as a new object (#12470 review). A tab re-seeds its
// form when its parentLink changes, so an unlocked inherited feature must not
// lose its unsaved edits to a re-read that changed nothing.
const parentWarranty = (): FeatureLink => ({
  id: 'parent-warranty',
  featureType: 'warranty',
  featurePolicyId: null,
  inlineSettings: { warnDays: 30 },
});

const editor = (parent: FeatureLink) => (
  <PolicyFeatureEditor
    featureType="warranty"
    policyId="pol-child"
    featureLinks={[]}
    parentFeatureLinks={[parent]}
    linkedPolicyId="pol-parent"
    orgId="org-1"
    partnerId={null}
    onLinkChanged={vi.fn()}
  />
);

describe('PolicyFeatureEditor', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    await i18n.changeLanguage('en');
  });

  it('a re-read with the same parent settings keeps unsaved edits on an unlocked inherited feature', () => {
    const view = render(editor(parentWarranty()));
    fireEvent.click(screen.getByTestId('feature-tab-change-for-policy'));
    const field = screen.getAllByRole('spinbutton')[0] as HTMLInputElement;
    fireEvent.change(field, { target: { value: '45' } });
    expect(field.value).toBe('45');
    // The same parent link, as a new object.
    view.rerender(editor(parentWarranty()));
    expect((screen.getAllByRole('spinbutton')[0] as HTMLInputElement).value).toBe('45');
  });

  it('a parent link whose settings really changed still reaches the tab', () => {
    const view = render(editor(parentWarranty()));
    const before = (screen.getAllByRole('spinbutton')[0] as HTMLInputElement).value;
    view.rerender(editor({ ...parentWarranty(), inlineSettings: { warnDays: 60 } }));
    const after = (screen.getAllByRole('spinbutton')[0] as HTMLInputElement).value;
    expect(after).not.toBe(before);
  });
});

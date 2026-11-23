import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every tab's footer follows one rule (#12263, plan W03c F1): Remove when only
// this policy has the feature, Reset to parent when the parent has it too.
// The red case is a CHILD policy (linkedPolicyId set) whose parent lacks the
// feature: before F1, 21 tabs offered "Revert to parent" there and no Remove.
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(() => ({}), { getState: () => ({}) }),
}));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../lib/api/onedrive', () => ({
  fetchM365ConnectionStatus: vi.fn().mockResolvedValue({ connected: false }),
  fetchOneDriveLibraries: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/scriptsFetch', () => ({ fetchAllScripts: vi.fn().mockResolvedValue([]) }));
vi.mock('../../monitoring/conversion/NeedsConversionPanel', () => ({ default: () => null }));
vi.mock('../../monitoring/conversion/ConversionLedger', () => ({ default: () => null }));
vi.mock('./WakeStatusPanel', () => ({ default: () => null }));

import { fetchWithAuth } from '../../../stores/auth';
import { i18n } from '@/lib/i18n';
import PolicyFeatureEditor from '../page/PolicyFeatureEditor';
import { FEATURE_META, type FeatureLink, type FeatureType } from './types';

const FEATURE_TYPES = Object.keys(FEATURE_META) as FeatureType[];
const fetchMock = vi.mocked(fetchWithAuth);
const ok = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload), headers: new Headers() }) as unknown as Response;

const link = (featureType: FeatureType, id: string): FeatureLink => ({
  id,
  featureType,
  featurePolicyId: null,
  inlineSettings: {},
});

const removeLabel = () => i18n.t('common:actions.remove');
const resetLabel = () =>
  i18n.t('policies:configurationPolicies.featureTabs.featureTabShell.revertToParent');
// Footer buttons only: a tab body can hold its own row-level "Remove" buttons.
const footerButton = (name: string) =>
  screen.queryAllByRole('button', { name }).filter((b) => b.closest('[data-testid="feature-tab-footer"]'));

const renderEditor = (featureType: FeatureType, parent: boolean) =>
  render(
    <PolicyFeatureEditor
      featureType={featureType}
      policyId="pol-child"
      featureLinks={[link(featureType, `own-${featureType}`)]}
      parentFeatureLinks={parent ? [link(featureType, `parent-${featureType}`)] : []}
      linkedPolicyId="pol-parent"
      orgId="org-1"
      partnerId={null}
      onLinkChanged={vi.fn()}
    />,
  );

describe('every tab wires its footer through featureEditAction (#12263)', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ok({ data: [] }));
    await i18n.changeLanguage('en');
  });
  afterEach(() => cleanup());

  it.each(FEATURE_TYPES)('%s: own only (parent lacks it) offers Remove, not Reset', async (featureType) => {
    renderEditor(featureType, false);
    await waitFor(() => expect(footerButton(removeLabel())).toHaveLength(1));
    expect(footerButton(resetLabel())).toHaveLength(0);
  });

  it.each(FEATURE_TYPES)('%s: own plus parent offers Reset, not Remove', async (featureType) => {
    renderEditor(featureType, true);
    await waitFor(() => expect(footerButton(resetLabel())).toHaveLength(1));
    expect(footerButton(removeLabel())).toHaveLength(0);
  });
});

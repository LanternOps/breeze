import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

// Change for this policy (plan W03c F2): on every tab an inherited feature is
// locked, unlocking writes nothing, and Save then creates this policy's own
// link with exactly one POST.
const PARENT_POLICY_ID: Partial<Record<FeatureType, string>> = {
  // Tabs whose link is a reference to a feature policy, not inline settings.
  peripheral_control: 'fp-peripheral',
  software_policy: 'fp-software',
};

// Backup needs a destination and Vendor updates needs a valid stored config
// with its gates, so their own tests cover this path (BackupTab.test.tsx
// "changing an inherited link for this policy…", VendorUpdatesTab.test.tsx
// "…creates its own link from inherited values on Save").
const OWN_TEST_COVERS: FeatureType[] = ['backup', 'oem_updates'];

// The linked peripheral policy's summary, read when the tab shows its link.
const getResponse = (url: string) =>
  url.startsWith('/peripherals/policies/')
    ? ok({ data: { name: 'USB block', deviceClass: 'usb_storage', action: 'block', targetType: 'all', isActive: true, exceptions: [] } })
    : ok({ data: [] });

describe('every tab: Change for this policy, then Save creates the own link (#12470)', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) => getResponse(String(url)));
    await i18n.changeLanguage('en');
  });
  afterEach(() => cleanup());

  const writes = () =>
    fetchMock.mock.calls.filter(([, init]) => {
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      return method !== 'GET';
    });

  it.each(FEATURE_TYPES.filter((t) => !OWN_TEST_COVERS.includes(t)))('%s', async (featureType) => {
    const parent: FeatureLink = {
      ...link(featureType, `parent-${featureType}`),
      featurePolicyId: PARENT_POLICY_ID[featureType] ?? null,
    };
    render(
      <PolicyFeatureEditor
        featureType={featureType}
        policyId="pol-child"
        featureLinks={[]}
        parentFeatureLinks={[parent]}
        linkedPolicyId="pol-parent"
        orgId="org-1"
        partnerId={null}
        onLinkChanged={vi.fn()}
      />,
    );
    const change = await screen.findByTestId('feature-tab-change-for-policy');
    const footer = () => screen.getByTestId('feature-tab-footer');
    expect(within(footer()).queryByRole('button', { name: /^save/i })).toBeNull();
    fireEvent.click(change);
    await new Promise((r) => setTimeout(r, 20));
    expect(writes()).toEqual([]);
    const save = within(footer()).getByRole('button', { name: /^save/i });
    fetchMock.mockImplementation(async (url, init) =>
      (init as RequestInit | undefined)?.method === 'POST'
        ? ok({ data: { ...link(featureType, `own-${featureType}`), featurePolicyId: parent.featurePolicyId } })
        : getResponse(String(url)),
    );
    fireEvent.click(save);
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [url, init] = writes()[0] as [string, RequestInit];
    expect(url).toBe('/configuration-policies/pol-child/features');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body)).featureType).toBe(featureType);
  });
});

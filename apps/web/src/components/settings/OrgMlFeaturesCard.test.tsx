import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }) }));
const runAction = vi.hoisted(() => vi.fn());
vi.mock('@/lib/runAction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/runAction')>('@/lib/runAction');
  return { ...actual, runAction };
});
const fetchWithAuth = vi.hoisted(() => vi.fn());
const handleSessionExpired = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth, handleSessionExpired }));

import OrgMlFeaturesCard from './OrgMlFeaturesCard';

function flagsResponse(overrides: Record<string, Partial<{ enabled: boolean; inheritedEnabled: boolean; source: string }>> = {}) {
  const base = (flag: string) => ({ flag, enabled: false, defaultEnabled: false, inheritedEnabled: false, source: 'default', ...(overrides[flag] ?? {}) });
  return {
    ok: true,
    json: async () => ({
      mlFeatureFlags: {
        'ml.anomalies.enabled': base('ml.anomalies.enabled'),
        'ml.anomalies.create_alerts': base('ml.anomalies.create_alerts'),
      },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runAction.mockResolvedValue({});
});

describe('OrgMlFeaturesCard', () => {
  it('loads the resolved flags for THIS org and shows the inherited value next to "Inherit"', async () => {
    fetchWithAuth.mockResolvedValue(flagsResponse({ 'ml.anomalies.enabled': { enabled: true, inheritedEnabled: true, source: 'partner_settings' } }));
    const { getByTestId, findByText } = render(<OrgMlFeaturesCard orgId="o1" settings={{}} onSaved={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/config/ml-feature-flags?orgId=o1'));
    const select = getByTestId('org-ml-anomalies-enabled') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('inherit'));
    await findByText((text) => text.startsWith('orgSettingsPage.ai.mlFeatures.inheritOn'));
  });

  it('shows the org override when settings.ml.anomalies.enabled is set', async () => {
    fetchWithAuth.mockResolvedValue(flagsResponse());
    const { getByTestId } = render(
      <OrgMlFeaturesCard orgId="o1" settings={{ ml: { anomalies: { enabled: false } } }} onSaved={vi.fn()} />,
    );
    expect((getByTestId('org-ml-anomalies-enabled') as HTMLSelectElement).value).toBe('off');
  });

  it('PATCHes the org with the full settings object, only touching the chosen key, and drops the key on "inherit"', async () => {
    fetchWithAuth.mockResolvedValue(flagsResponse());
    const onSaved = vi.fn();
    const settings = { branding: { theme: 'dark' }, ml: { anomalies: { enabled: false, create_alerts: true } } };
    const { getByTestId } = render(<OrgMlFeaturesCard orgId="o1" settings={settings} onSaved={onSaved} />);

    fireEvent.change(getByTestId('org-ml-anomalies-enabled'), { target: { value: 'on' } });
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
    await runAction.mock.calls[0]![0].request();
    expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/organizations/o1', {
      method: 'PATCH',
      body: JSON.stringify({ settings: { branding: { theme: 'dark' }, ml: { anomalies: { enabled: true, create_alerts: true } } } }),
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    fireEvent.change(getByTestId('org-ml-anomalies-create-alerts'), { target: { value: 'inherit' } });
    await waitFor(() => expect(runAction).toHaveBeenCalledTimes(2));
    await runAction.mock.calls[1]![0].request();
    const lastBody = JSON.parse(fetchWithAuth.mock.calls.at(-1)![1].body);
    expect(lastBody.settings.ml.anomalies).toEqual({ enabled: true });
  });

  it('renders a platform-disabled notice instead of editable controls under the global kill switch', async () => {
    fetchWithAuth.mockResolvedValue(flagsResponse({ 'ml.anomalies.enabled': { source: 'global_kill_switch' } }));
    const { findByTestId } = render(<OrgMlFeaturesCard orgId="o1" settings={{}} onSaved={vi.fn()} />);
    await findByTestId('org-ml-kill-switch-notice');
    expect((await findByTestId('org-ml-anomalies-enabled') as HTMLSelectElement).disabled).toBe(true);
  });
});

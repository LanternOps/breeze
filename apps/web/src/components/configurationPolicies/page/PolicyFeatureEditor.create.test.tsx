import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign((sel: (s: { user: unknown }) => unknown) => sel({ user: null }), {
    getState: () => ({ user: null }),
    subscribe: () => () => {},
  }),
}));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { fetchWithAuth } from '../../../stores/auth';
import { i18n } from '@/lib/i18n';
import PolicyFeatureEditor from './PolicyFeatureEditor';
import { FEATURE_META, type FeatureType } from '../featureTabs/types';
import { PolicyCreateContext } from '../featureTabs/policyCreateContext';

const fetchMock = vi.mocked(fetchWithAuth);
const FEATURES = Object.keys(FEATURE_META) as FeatureType[];

// The create page (W03d C1) mounts every feature editor with no policy id.
// None of them may send a request to a malformed `/configuration-policies//…`
// URL, or write anything, before a Save.
describe('every feature editor on the create page', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      ({ ok: true, status: 200, json: async () => ({ data: [] }) }) as unknown as Response,
    );
    await i18n.changeLanguage('en');
  });

  it.each(FEATURES)('%s sends no write and no request without a policy id', async (featureType) => {
    const ensurePolicy = vi.fn();
    render(
      <PolicyCreateContext.Provider value={{ ensurePolicy, reportFirstFeatureSave: vi.fn() }}>
        <PolicyFeatureEditor
          featureType={featureType}
          policyId=""
          featureLinks={[]}
          parentFeatureLinks={[]}
          linkedPolicyId={null}
          orgId={null}
          partnerId="p-1"
          onLinkChanged={vi.fn()}
        />
      </PolicyCreateContext.Provider>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((u) => u.includes('/configuration-policies//') || /\/configuration-policies\/(\?|$)/.test(u))).toEqual([]);
    const writes = fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET');
    expect(writes).toEqual([]);
    expect(ensurePolicy).not.toHaveBeenCalled();
  });
});

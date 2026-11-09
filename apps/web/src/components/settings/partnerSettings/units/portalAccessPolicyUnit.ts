import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import { PORTAL_ACCESS_POLICY_ERROR_CODES, type PortalAccessPolicyView } from '@breeze/shared';
import { isPortalAccessPolicyView, type PortalAccessPolicyDraft } from '../../portalAccess/types';
import { saveSlice, useDraftSaveUnit, useDraftSlice, type Loader } from '../partnerSettingsDraftStore';

/**
 * Partner-wide portal access policy (portal registration W3, #11380) as a
 * header-Save unit. `view` is the server's answer; `draft` holds only the
 * fields the partner changed (`null` = back to the Breeze default).
 */
export type PortalAccessPolicyUnitValue = { view: PortalAccessPolicyView; draft: PortalAccessPolicyDraft };

const POLICY_URL = '/orgs/partners/me/portal-access-policy';

export const loadPortalAccessPolicy: Loader<PortalAccessPolicyUnitValue> = async () => {
  const res = await fetchWithAuth(POLICY_URL);
  if (!res.ok) throw new Error(`Portal access policy load failed: ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  if (!isPortalAccessPolicyView(body.data)) throw new Error('Portal access policy load returned an unexpected body');
  return { value: { view: body.data, draft: {} } };
};

export function usePortalAccessPolicyDraft() {
  return useDraftSlice<PortalAccessPolicyUnitValue>('portalAccessPolicy', loadPortalAccessPolicy);
}

const isDirty = (_baseline: PortalAccessPolicyUnitValue, draft: PortalAccessPolicyUnitValue) =>
  Object.keys(draft.draft).length > 0;

const save = () => saveSlice<PortalAccessPolicyUnitValue>('portalAccessPolicy', async (value) => {
  const body = await runAction<{ data: PortalAccessPolicyView }>({
    request: () => fetchWithAuth(POLICY_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value.draft),
    }),
    errorFallback: i18n.t('settings:portalAccessPolicy.errors.save'),
    // No successMessage: the header Save shows one aggregate success toast.
    parseSuccess: (data) => {
      const saved = (data as { data?: unknown } | null)?.data;
      if (!isPortalAccessPolicyView(saved)) throw new Error('unexpected portal access policy body');
      return { data: saved };
    },
    friendly: (code) => {
      if (code === PORTAL_ACCESS_POLICY_ERROR_CODES.METHOD_UNAVAILABLE) return i18n.t('settings:portalAccessPolicy.errors.methodUnavailable');
      if (code === PORTAL_ACCESS_POLICY_ERROR_CODES.SSO_ONLY_NEEDS_SSO) return i18n.t('settings:portalAccessPolicy.errors.ssoOnlyNeedsSso');
      return undefined;
    },
    onUnauthorized: handleSessionExpired,
  });
  return { value: { view: body.data, draft: {} } };
}, { errorFallback: i18n.t('settings:portalAccessPolicy.errors.save') });

/** Partner portal access policy (`PATCH /orgs/partners/me/portal-access-policy`) as a header-Save unit. */
export function usePortalAccessPolicyUnit() {
  return useDraftSaveUnit<PortalAccessPolicyUnitValue>('portalAccessPolicy', save, { isDirty });
}

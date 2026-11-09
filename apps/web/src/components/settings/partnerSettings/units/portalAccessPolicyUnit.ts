import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import { PORTAL_ACCESS_POLICY_ERROR_CODES, type PortalAccessPolicyView } from '@breeze/shared';
import { isPortalAccessPolicyView, type PortalAccessPolicyDraft } from '../../portalAccess/types';
import { confirmRequiredImpact, isConfirmRequiredStatus, withAcknowledge } from '../../portalAccess/ssoOnlyActions';
import { requestSsoOnlyConfirm } from '../../portalAccess/ssoOnlyConfirmRequests';
import { showToast } from '../../../shared/Toast';
import { saveSlice, useDraftSaveUnit, useDraftSlice, type Loader } from '../partnerSettingsDraftStore';

/**
 * Partner-wide portal access policy (portal registration W3, #11380) as a
 * header-Save unit. `view` is the server's answer; `draft` holds only the
 * fields the partner changed (`null` = back to the Breeze default).
 */
export type PortalAccessPolicyUnitValue = {
  view: PortalAccessPolicyView;
  draft: PortalAccessPolicyDraft;
  /** The form shows a session length that is not a valid value: the tab is invalid until it is fixed. */
  hoursInvalid?: boolean;
};

const SESSION_HOURS_FIELD_ID = 'portal-access-policy-session-hours';

const validate = (value: PortalAccessPolicyUnitValue) => (value.hoursInvalid
  ? { isValid: false, invalidCount: 1, firstInvalidFieldId: SESSION_HOURS_FIELD_ID }
  : { isValid: true, invalidCount: 0, firstInvalidFieldId: null });

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

/** The person declined the `sso_only` confirmation: a cancelled outcome, nothing written. */
class SsoOnlySaveDeclinedError extends Error {
  constructor() {
    super('sso_only save declined');
    this.name = 'SsoOnlySaveDeclinedError';
  }
}

function patchPolicy(draft: PortalAccessPolicyUnitValue['draft'], acknowledge: string | null) {
  return runAction<{ data: PortalAccessPolicyView }>({
    request: () => fetchWithAuth(withAcknowledge(POLICY_URL, acknowledge), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
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
    // The confirmation 409 opens the dialog instead of a toast.
    suppressErrorToast: (status, code) => isConfirmRequiredStatus(status, code),
    onUnauthorized: handleSessionExpired,
  });
}

/**
 * W4 D12: a save that flips some org to effective `sso_only` is refused with
 * 409 and the impact. The person confirms it in the page's dialog
 * (`SsoOnlyConfirmHost`), and the save is re-sent acknowledging that digest; a
 * newer impact on the re-send asks again. Declining is a cancelled outcome.
 */
const save = () => saveSlice<PortalAccessPolicyUnitValue>('portalAccessPolicy', async (value) => {
  let acknowledge: string | null = null;
  for (;;) {
    try {
      const body = await patchPolicy(value.draft, acknowledge);
      return { value: { view: body.data, draft: {} } };
    } catch (err) {
      const impact = confirmRequiredImpact(err);
      if (!impact) {
        if (err instanceof ActionError && isConfirmRequiredStatus(err.status, err.code)) {
          // A 409 we cannot read the impact from: say so rather than fail silently.
          showToast({ type: 'error', message: i18n.t('settings:portalAccessPolicy.errors.save') });
        }
        throw err;
      }
      const confirmed = await requestSsoOnlyConfirm(impact, { changed: acknowledge !== null });
      if (!confirmed) throw new SsoOnlySaveDeclinedError();
      acknowledge = impact.impactDigest;
    }
  }
}, {
  errorFallback: i18n.t('settings:portalAccessPolicy.errors.save'),
  classifyError: (err) => (err instanceof SsoOnlySaveDeclinedError ? 'cancelled' : 'failed'),
});

/** Partner portal access policy (`PATCH /orgs/partners/me/portal-access-policy`) as a header-Save unit. */
export function usePortalAccessPolicyUnit() {
  return useDraftSaveUnit<PortalAccessPolicyUnitValue>('portalAccessPolicy', save, { isDirty, validate });
}

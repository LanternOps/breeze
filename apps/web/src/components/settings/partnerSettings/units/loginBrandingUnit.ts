import type { LoginContextBranding } from '@breeze/shared';
import { fetchWithAuth } from '../../../../stores/auth';
import { runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { saveSlice, useDraftSaveUnit, useDraftSlice, type Loader } from '../partnerSettingsDraftStore';

/** The Login page card's fields as typed. */
export type LoginBrandingValue = { logoUrl: string; accentColor: string; headline: string };

const toLogin = () => { void navigateTo('/login', { replace: true }); };

/**
 * GET /partners/me/login-branding. A failed load leaves the slice in `error`,
 * which keeps the unit clean: the PUT is full-replace, so saving over an
 * unloaded form would wipe the stored branding.
 */
export const loadLoginBranding: Loader<LoginBrandingValue> = async () => {
  const res = await fetchWithAuth('/partners/me/login-branding');
  if (res.status === 401) {
    toLogin();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`login branding load failed: ${res.status}`);
  const body = (await res.json().catch(() => null)) as { data?: LoginContextBranding | null } | null;
  const data = body?.data ?? null;
  return { value: { logoUrl: data?.logoUrl ?? '', accentColor: data?.accentColor ?? '', headline: data?.headline ?? '' } };
};

export function useLoginBrandingDraft() {
  return useDraftSlice<LoginBrandingValue>('loginBranding', loadLoginBranding);
}

const save = () => saveSlice<LoginBrandingValue>('loginBranding', async (value) => {
  await runAction<{ data: LoginContextBranding }>({
    // Full-replace: always send all three fields. A blank field goes as null
    // (cleared), never omitted. No successMessage: the header Save shows one
    // aggregate success toast.
    request: () =>
      fetchWithAuth('/partners/me/login-branding', {
        method: 'PUT',
        body: JSON.stringify({
          logoUrl: value.logoUrl.trim() || null,
          accentColor: value.accentColor.trim() || null,
          headline: value.headline.trim() || null,
        }),
      }),
    errorFallback: i18n.t('settings:loginBranding.saveFailed'),
    onUnauthorized: toLogin,
  });
}, { errorFallback: i18n.t('settings:loginBranding.saveFailed') });

/** Login page branding (`PUT /partners/me/login-branding`) as a header-Save unit. */
export function useLoginBrandingUnit() {
  return useDraftSaveUnit<LoginBrandingValue>('loginBranding', save);
}

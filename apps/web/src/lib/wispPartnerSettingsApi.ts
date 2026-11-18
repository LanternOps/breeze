// Wisp W08 (web): the partner's "Wisp enabled" switch (w00 A35, spec §17.2 (4)).
// Server contract: W08a `routes/wispPartnerSettings.ts` — GET for any Wisp
// user, PUT for partner admins only (403 `partner_admin_required`). The
// setting is partner-level: never the switcher's org (`skipOrgIdInjection`).
import type { WispPartnerSettings } from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';
import { i18n } from './i18n';

/** `GET /wisp/partner-settings` → `enabled`. Throws on a failed or malformed read. */
export async function getWispPartnerEnabled(): Promise<boolean> {
  const res = await fetchWithAuth('/wisp/partner-settings', { skipOrgIdInjection: true });
  if (!res.ok) throw new Error(`wisp partner settings read failed: ${res.status}`);
  const body = (await res.json().catch(() => null)) as { data?: Partial<WispPartnerSettings> } | null;
  if (typeof body?.data?.enabled !== 'boolean') throw new Error('wisp partner settings read: malformed payload');
  return body.data.enabled;
}

/** `PUT /wisp/partner-settings { enabled }` → the stored value (autosave; runAction toasts). */
export async function setWispPartnerEnabled(enabled: boolean): Promise<boolean> {
  const body = await runAction<{ data?: Partial<WispPartnerSettings> } | null>({
    request: () => fetchWithAuth('/wisp/partner-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
      skipOrgIdInjection: true,
    }),
    errorFallback: i18n.t('ai:wisp.partnerSwitch.saveFailed'),
    successMessage: enabled ? i18n.t('ai:wisp.partnerSwitch.savedOn') : i18n.t('ai:wisp.partnerSwitch.savedOff'),
  });
  // Like the read: a 2xx without the stored value is a contract break, not "saved as asked".
  if (typeof body?.data?.enabled !== 'boolean') throw new Error('wisp partner settings write: malformed payload');
  return body.data.enabled;
}

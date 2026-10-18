import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellRing } from 'lucide-react';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { showToast } from '../shared/Toast';

/**
 * Settings rule 9 home of "customer org admins receive connection health
 * notices" (spec 2026-10-15 §6, W5): partner default → org override. Blank
 * ("Inherit") always shows the inherited value and where it comes from (rule
 * 4). Each control saves itself with a toast (rule 7: switches with immediate
 * effect). Hidden for org scope by the page, and hidden here when the caller
 * may not read it. The API reports canManage* so a control is read-only
 * exactly when its save would be refused.
 */

const BASE = '/connection-health/settings';
type Choice = 'inherit' | 'on' | 'off';

type SettingsResponse = {
  partner: { customerAdminsNotified: boolean | null; enabled: boolean };
  org: null | {
    orgId: string;
    customerAdminsNotified: boolean | null;
    enabled: boolean;
    source: 'org' | 'partner' | 'default';
    inheritedEnabled: boolean;
    inheritedSource: 'partner' | 'default';
  };
  canManagePartner: boolean;
  canManageOrg: boolean;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'error' }
  /** `forOrg` ties the data to the org it was loaded for (see the post-save reload). */
  | { kind: 'ready'; data: SettingsResponse; forOrg: string | null };

const isSettings = (b: unknown): b is SettingsResponse => {
  const s = b as Partial<SettingsResponse> | null;
  return !!s && typeof s.partner === 'object' && s.partner !== null && typeof s.partner.enabled === 'boolean'
    && typeof s.canManagePartner === 'boolean' && typeof s.canManageOrg === 'boolean';
};

const choiceOf = (v: boolean | null): Choice => (v === null ? 'inherit' : v ? 'on' : 'off');
const valueOf = (c: Choice): boolean | null => (c === 'inherit' ? null : c === 'on');

export default function ConnectionHealthSettingsCard({ orgId }: { orgId: string | null }) {
  const { t } = useTranslation('integrations');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async (): Promise<LoadState> => {
    try {
      const res = await fetchWithAuth(orgId ? `${BASE}?orgId=${encodeURIComponent(orgId)}` : BASE);
      if (res.status === 401 || res.status === 403) return { kind: 'hidden' };
      if (!res.ok) throw new Error(String(res.status));
      const body: unknown = await res.json();
      if (!isSettings(body)) throw new Error('unexpected response');
      return { kind: 'ready', data: body, forOrg: orgId };
    } catch (err) {
      console.error('[ConnectionHealthSettingsCard] failed to load settings', err);
      return { kind: 'error' };
    }
  }, [orgId]);

  // A reload for the SAME org keeps the current controls while it runs; a
  // different org starts from loading. The cancel flag drops a stale result
  // when the org changes mid-flight.
  useEffect(() => {
    let cancelled = false;
    setState((s) => (s.kind === 'ready' && s.forOrg === orgId ? s : { kind: 'loading' }));
    void load().then((next) => { if (!cancelled) setState(next); });
    return () => { cancelled = true; };
  }, [load, reloadKey]);

  const save = useCallback(async (
    path: string,
    value: boolean | null,
    optimistic: (d: SettingsResponse) => SettingsResponse,
  ) => {
    if (state.kind !== 'ready' || saving) return;
    const previous = state.data;
    const forOrg = state.forOrg;
    setState({ kind: 'ready', data: optimistic(previous), forOrg });
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(path, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerAdminsNotified: value }),
        }),
        successMessage: t('connectionHealthSettings.saved'),
        errorFallback: t('connectionHealthSettings.saveFailed'),
      });
      // The inherited value and its source can change with either level.
      // Reloaded through the effect, so an org switched mid-save is never
      // overwritten by this org's result.
      setReloadKey((k) => k + 1);
    } catch (err) {
      setState((s) => (s.kind === 'ready' && s.forOrg === forOrg ? { kind: 'ready', data: previous, forOrg } : s));
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('connectionHealthSettings.saveFailed') });
      }
    } finally {
      setSaving(false);
    }
  }, [state, saving, t]);

  if (state.kind === 'hidden') return null;

  const data = state.kind === 'ready' ? state.data : null;
  const ready = data !== null;

  const onPartnerToggle = (next: boolean) =>
    void save(`${BASE}/partner`, next, (d) => ({
      ...d,
      partner: { customerAdminsNotified: next, enabled: next },
    }));

  const onOrgChoice = (choice: Choice) => {
    if (!orgId) return;
    void save(`${BASE}/orgs/${encodeURIComponent(orgId)}`, valueOf(choice), (d) => (d.org
      ? { ...d, org: { ...d.org, customerAdminsNotified: valueOf(choice) } }
      : d));
  };

  const inheritLabel = () => {
    if (!data?.org) return t('connectionHealthSettings.inherit');
    const from = data.org.inheritedSource === 'partner'
      ? t('connectionHealthSettings.fromPartner')
      : t('connectionHealthSettings.fromDefault');
    return data.org.inheritedEnabled
      ? t('connectionHealthSettings.inheritOn', { from })
      : t('connectionHealthSettings.inheritOff', { from });
  };

  return (
    <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="connection-health-settings-card">
      <div className="flex items-center gap-2">
        <BellRing className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-semibold">{t('connectionHealthSettings.title')}</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('connectionHealthSettings.description')}</p>

      {state.kind === 'error' && (
        <div className="mt-3 flex items-center gap-3 text-sm text-destructive" role="alert">
          <span>{t('connectionHealthSettings.loadFailed')}</span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="rounded-md border px-2 py-1 text-xs font-medium text-foreground"
            data-testid="connection-health-settings-retry"
          >
            {t('connectionHealthSettings.retry')}
          </button>
        </div>
      )}

      <div className="mt-3 space-y-3">
        <label className="flex items-start justify-between gap-4 rounded-md border bg-muted/30 p-3">
          <span>
            <span className="block text-sm font-medium">{t('connectionHealthSettings.partnerLabel')}</span>
            <span className="block text-xs text-muted-foreground">{t('connectionHealthSettings.partnerDescription')}</span>
            {ready && !data.canManagePartner && (
              <span className="mt-1 block text-xs text-muted-foreground" data-testid="connection-health-partner-readonly">
                {t('connectionHealthSettings.partnerReadOnly')}
              </span>
            )}
          </span>
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            // Unknown state (loading, or the load failed) renders unchecked, never a guessed value.
            checked={ready ? data.partner.enabled : false}
            disabled={!ready || saving || !data.canManagePartner}
            onChange={(e) => onPartnerToggle(e.target.checked)}
            data-testid="connection-health-partner-toggle"
          />
        </label>

        {orgId ? (
          <div className="flex items-start justify-between gap-4 rounded-md border bg-muted/30 p-3">
            <span>
              <span className="block text-sm font-medium">{t('connectionHealthSettings.orgLabel')}</span>
              <span className="block text-xs text-muted-foreground">{t('connectionHealthSettings.orgDescription')}</span>
            </span>
            <select
              data-testid="connection-health-org-select"
              aria-label={t('connectionHealthSettings.orgLabel')}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={data?.org ? choiceOf(data.org.customerAdminsNotified) : 'inherit'}
              disabled={!data?.org || saving || !data.canManageOrg}
              onChange={(e) => onOrgChoice(e.target.value as Choice)}
            >
              <option value="inherit">{inheritLabel()}</option>
              <option value="on">{t('connectionHealthSettings.on')}</option>
              <option value="off">{t('connectionHealthSettings.off')}</option>
            </select>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="connection-health-select-org-hint">
            {t('connectionHealthSettings.selectOrg')}
          </p>
        )}
      </div>
    </div>
  );
}

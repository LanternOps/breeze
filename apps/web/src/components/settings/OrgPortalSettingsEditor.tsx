import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';

type PortalSettings = {
  enableTickets: boolean;
  enableAssetCheckout: boolean;
  enableSelfService: boolean;
  enablePasswordReset: boolean;
  supportEmail: string | null;
  supportPhone: string | null;
  welcomeMessage: string | null;
  footerText: string | null;
};

type ToggleKey = 'enableTickets' | 'enableAssetCheckout' | 'enableSelfService' | 'enablePasswordReset';

const TOGGLES: Array<{ key: ToggleKey; labelKey: string; descriptionKey: string }> = [
  {
    key: 'enableTickets',
    labelKey: 'orgPortalSettingsEditor.features.toggles.enableTickets.label',
    descriptionKey: 'orgPortalSettingsEditor.features.toggles.enableTickets.description',
  },
  {
    key: 'enableAssetCheckout',
    labelKey: 'orgPortalSettingsEditor.features.toggles.enableAssetCheckout.label',
    descriptionKey: 'orgPortalSettingsEditor.features.toggles.enableAssetCheckout.description',
  },
  {
    key: 'enableSelfService',
    labelKey: 'orgPortalSettingsEditor.features.toggles.enableSelfService.label',
    descriptionKey: 'orgPortalSettingsEditor.features.toggles.enableSelfService.description',
  },
  {
    key: 'enablePasswordReset',
    labelKey: 'orgPortalSettingsEditor.features.toggles.enablePasswordReset.label',
    descriptionKey: 'orgPortalSettingsEditor.features.toggles.enablePasswordReset.description',
  },
];

type OrgPortalSettingsEditorProps = {
  orgId: string;
  onDirty: () => void;
  onSave: () => void;
};

export default function OrgPortalSettingsEditor({ orgId, onDirty, onSave }: OrgPortalSettingsEditorProps) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState<PortalSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth(`/orgs/organizations/${orgId}/portal-settings`);
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`portal settings load failed: ${res.status}`);
      setDraft((await res.json()).data ?? null);
    } catch (err) {
      console.warn('[OrgPortalSettingsEditor] load failed', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const update = (patch: Partial<PortalSettings>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    onDirty();
  };

  const save = useCallback(async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/orgs/organizations/${orgId}/portal-settings`, {
          method: 'PATCH',
          body: JSON.stringify({
            enableTickets: draft.enableTickets,
            enableAssetCheckout: draft.enableAssetCheckout,
            enableSelfService: draft.enableSelfService,
            enablePasswordReset: draft.enablePasswordReset,
            supportEmail: draft.supportEmail?.trim() || null,
            supportPhone: draft.supportPhone?.trim() || null,
            welcomeMessage: draft.welcomeMessage?.trim() || null,
            footerText: draft.footerText?.trim() || null
          })
        }),
        errorFallback: t('orgPortalSettingsEditor.errors.save'),
        successMessage: t('orgPortalSettingsEditor.toasts.saved'),
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      onSave();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSaving(false);
    }
  }, [draft, saving, orgId, onSave, t]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t('orgPortalSettingsEditor.loading')}</p>;
  }

  if (loadError || !draft) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-portal-load-error">
        {t('orgPortalSettingsEditor.errors.load')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="org-portal-settings">
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('orgPortalSettingsEditor.features.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('orgPortalSettingsEditor.features.description')}
        </p>
        <div className="mt-4 space-y-3">
          {TOGGLES.map(({ key, labelKey, descriptionKey }) => (
            <label key={key} className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
              <input
                type="checkbox"
                checked={draft[key]}
                onChange={(e) => update({ [key]: e.target.checked } as Partial<PortalSettings>)}
                className="mt-0.5"
                data-testid={`org-portal-toggle-${key}`}
              />
              <span>
                <span className="block text-sm font-medium">
                  {t(labelKey)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(descriptionKey)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('orgPortalSettingsEditor.support.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('orgPortalSettingsEditor.support.description')}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="portal-support-email">{t('orgPortalSettingsEditor.support.email')}</label>
            <input
              id="portal-support-email"
              type="email"
              value={draft.supportEmail ?? ''}
              onChange={(e) => update({ supportEmail: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-portal-support-email"
            />
          </div>
          <div>
            <label className="text-sm font-medium" htmlFor="portal-support-phone">{t('orgPortalSettingsEditor.support.phone')}</label>
            <input
              id="portal-support-phone"
              type="tel"
              value={draft.supportPhone ?? ''}
              onChange={(e) => update({ supportPhone: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-portal-support-phone"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-medium" htmlFor="portal-welcome">{t('orgPortalSettingsEditor.support.welcomeMessage')}</label>
            <textarea
              id="portal-welcome"
              rows={3}
              value={draft.welcomeMessage ?? ''}
              onChange={(e) => update({ welcomeMessage: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-portal-welcome"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-sm font-medium" htmlFor="portal-footer">{t('orgPortalSettingsEditor.support.footerText')}</label>
            <input
              id="portal-footer"
              value={draft.footerText ?? ''}
              onChange={(e) => update({ footerText: e.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="org-portal-footer"
            />
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          data-testid="org-portal-save"
        >
          {saving ? t('common:states.saving') : t('orgPortalSettingsEditor.save')}
        </button>
      </div>
    </div>
  );
}

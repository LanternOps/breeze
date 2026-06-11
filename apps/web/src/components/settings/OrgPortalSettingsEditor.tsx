import { useCallback, useEffect, useState } from 'react';
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

const TOGGLES: Array<{ key: ToggleKey; label: string; description: string }> = [
  { key: 'enableTickets', label: 'Ticket submission', description: 'Customers can open and track support tickets from the portal.' },
  { key: 'enableAssetCheckout', label: 'Asset checkout', description: 'Customers can check devices out and back in.' },
  { key: 'enableSelfService', label: 'Self-service', description: 'Customers can use self-service tools in the portal.' },
  { key: 'enablePasswordReset', label: 'Password reset', description: 'Customers can reset their portal password themselves.' }
];

type OrgPortalSettingsEditorProps = {
  orgId: string;
  onDirty: () => void;
  onSave: () => void;
};

export default function OrgPortalSettingsEditor({ orgId, onDirty, onSave }: OrgPortalSettingsEditorProps) {
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
      if (!res.ok) throw new Error('load failed');
      setDraft((await res.json()).data ?? null);
    } catch {
      setLoadError(true);
    }
    setLoading(false);
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
        errorFallback: 'Failed to save portal settings',
        successMessage: 'Portal settings saved',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      onSave();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSaving(false);
    }
  }, [draft, saving, orgId, onSave]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading portal settings…</p>;
  }

  if (loadError || !draft) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-portal-load-error">
        Portal settings failed to load.{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="org-portal-settings">
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Portal features</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Control what this customer can do in their portal. Each organization is independent.
        </p>
        <div className="mt-4 space-y-3">
          {TOGGLES.map(({ key, label, description }) => (
            <label key={key} className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
              <input
                type="checkbox"
                checked={draft[key]}
                onChange={(e) => update({ [key]: e.target.checked } as Partial<PortalSettings>)}
                className="mt-0.5"
                data-testid={`org-portal-toggle-${key}`}
              />
              <span>
                <span className="block text-sm font-medium">{label}</span>
                <span className="block text-xs text-muted-foreground">{description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Support contact</h2>
        <p className="mt-1 text-sm text-muted-foreground">Shown to customers in the portal.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium" htmlFor="portal-support-email">Support email</label>
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
            <label className="text-sm font-medium" htmlFor="portal-support-phone">Support phone</label>
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
            <label className="text-sm font-medium" htmlFor="portal-welcome">Welcome message</label>
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
            <label className="text-sm font-medium" htmlFor="portal-footer">Footer text</label>
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
          {saving ? 'Saving…' : 'Save portal settings'}
        </button>
      </div>
    </div>
  );
}

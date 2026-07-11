import { useCallback } from 'react';
import { Plus, Trash2, MonitorPlay, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { isAllowedLauncherScheme } from '@breeze/shared';
import type { InheritableRemoteAccessSettings, RemoteAccessProvider } from '@breeze/shared';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';

const SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;

// Inline validation for a provider's URL template. Mirrors the server guard
// (orgs.ts: allowed scheme + the {id} placeholder) so a partner admin sees a
// problem immediately instead of only on save. See #714/#680.
export function urlTemplateError(template: string, translate?: (key: string) => string): string | null {
  const message = (key: string, fallback: string) => translate?.(key) ?? fallback;
  if (template.length === 0) return null;
  if (!SCHEME_PREFIX.test(template)) {
    return message('partnerRemoteAccess.errors.schemeRequired', 'URL template must start with a scheme followed by a colon (e.g. rustdesk:, https:)');
  }
  if (!isAllowedLauncherScheme(template)) {
    return message('partnerRemoteAccess.errors.schemeBlocked', 'That URL scheme is not permitted — javascript:, data:, vbscript:, file:, about:, chrome:, jar:, blob:, view-source: and filesystem: are blocked.');
  }
  if (!template.includes('{id}')) {
    return message('partnerRemoteAccess.errors.idRequired', 'URL template must include the {id} placeholder for the per-device value.');
  }
  return null;
}

type Props = {
  data: InheritableRemoteAccessSettings;
  onChange: (data: InheritableRemoteAccessSettings) => void;
};

function makeProviderId(): string {
  // crypto.randomUUID is widely supported in the browsers Breeze targets and
  // gives a 122-bit-entropy id; Math.random().toString(36).slice(2,10) gave
  // ~48 bits and is collidable on large provider lists (issue #714).
  return `provider-${crypto.randomUUID()}`;
}

function emptyProvider(): RemoteAccessProvider {
  return {
    id: makeProviderId(),
    name: '',
    urlTemplate: '',
    customFieldKey: '',
    password: '',
    enabled: true,
  };
}

export default function PartnerRemoteAccessTab({ data, onChange }: Props) {
  const { t } = useTranslation('settings');
  const providers = data.providers ?? [];
  const defaultProviderId = data.defaultProviderId ?? '';
  const [revealPassword, setRevealPassword] = useState<Record<string, boolean>>({});

  const updateProvider = useCallback(
    (idx: number, patch: Partial<RemoteAccessProvider>) => {
      const next = [...providers];
      next[idx] = { ...next[idx], ...patch };
      onChange({ ...data, providers: next });
    },
    [providers, data, onChange],
  );

  const addProvider = () => {
    // Don't auto-promote the new provider to default — adding a provider
    // shouldn't silently switch the partner off the built-in launcher.
    // The user picks the default explicitly via the radio.
    onChange({ ...data, providers: [...providers, emptyProvider()] });
  };

  const removeProvider = (idx: number) => {
    const removed = providers[idx];
    const next = providers.filter((_, i) => i !== idx);
    // If we removed the current default, fall back to built-in (empty default)
    // rather than silently picking another provider.
    const nextDefault = removed.id === defaultProviderId ? '' : defaultProviderId;
    onChange({ ...data, providers: next, defaultProviderId: nextDefault });
  };

  const setDefault = (id: string) => {
    onChange({ ...data, defaultProviderId: id });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <MonitorPlay className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">{t('partnerRemoteAccess.title')}</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            <Trans i18nKey="partnerRemoteAccess.description" t={t} components={{ connect: <span className="font-medium" /> }} />
          </p>
        </div>
        <button
          type="button"
          onClick={addProvider}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          {t('partnerRemoteAccess.addProvider')}
        </button>
      </div>

      {/* Built-in option — selecting this falls the Connect Desktop button
          back to Breeze's bundled WebRTC desktop session. Always present so
          users can return to the default once they've added providers. */}
      <div
        className={`rounded-lg border p-4 ${!defaultProviderId ? 'border-primary bg-primary/5' : ''}`}
      >
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="radio"
            name="defaultProvider"
            checked={!defaultProviderId}
            onChange={() => onChange({ ...data, defaultProviderId: '' })}
            className="h-4 w-4"
          />
          {t('partnerRemoteAccess.builtIn')}
        </label>
        <p className="mt-1 ml-6 text-xs text-muted-foreground">
          {t('partnerRemoteAccess.builtInDescription')}
        </p>
      </div>

      {providers.length === 0 ? (
        <div className="rounded-md border border-dashed bg-muted/40 p-6 text-center text-sm text-muted-foreground">
          <Trans i18nKey="partnerRemoteAccess.empty" t={t} components={{ add: <span className="font-medium" /> }} />
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((p, idx) => {
            const templateError = urlTemplateError(p.urlTemplate, t);
            const isDefault = p.id === defaultProviderId;
            return (
              <div
                key={p.id}
                className={`rounded-lg border p-4 ${isDefault ? 'border-primary bg-primary/5' : ''}`}
              >
                <div className="mb-3 flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="radio"
                      name="defaultProvider"
                      checked={isDefault}
                      onChange={() => setDefault(p.id)}
                      className="h-4 w-4"
                    />
                    {t('partnerRemoteAccess.default')}
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) => updateProvider(idx, { enabled: e.target.checked })}
                      className="h-4 w-4 rounded border"
                    />
                    {t('common:states.enabled')}
                  </label>
                  <div className="ml-auto" />
                  <button
                    type="button"
                    onClick={() => removeProvider(idx)}
                    title={t('partnerRemoteAccess.removeProvider')}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-sm font-medium">{t('partnerRemoteAccess.displayName')}</label>
                    <input
                      type="text"
                      value={p.name}
                      placeholder={t('partnerRemoteAccess.displayNamePlaceholder')}
                      onChange={(e) => updateProvider(idx, { name: e.target.value })}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    />
                  </div>

                  <div className="space-y-1 sm:col-span-2">
                    <label className="text-sm font-medium">{t('partnerRemoteAccess.urlTemplate')}</label>
                    <input
                      type="text"
                      value={p.urlTemplate}
                      placeholder={t('partnerRemoteAccess.urlPlaceholder')}
                      onChange={(e) => updateProvider(idx, { urlTemplate: e.target.value })}
                      className={`h-10 w-full rounded-md border bg-background px-3 text-sm font-mono ${templateError ? 'border-destructive' : ''}`}
                    />
                    {templateError ? (
                      <p className="text-xs text-destructive">{templateError}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t('partnerRemoteAccess.templateHint')}</p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <label className="text-sm font-medium">{t('partnerRemoteAccess.customFieldKey')}</label>
                    <input
                      type="text"
                      value={p.customFieldKey}
                      placeholder={t('partnerRemoteAccess.fieldPlaceholder')}
                      onChange={(e) => updateProvider(idx, { customFieldKey: e.target.value })}
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      <Trans i18nKey="partnerRemoteAccess.customFieldHelp" t={t} components={{ code: <code /> }} />
                    </p>
                  </div>

                  <div className="space-y-1">
                    <label className="text-sm font-medium">
                      {t('partnerRemoteAccess.presetPassword')} <span className="text-muted-foreground font-normal">({t('common:labels.optional')})</span>
                    </label>
                    <div className="relative">
                      <input
                        type={revealPassword[p.id] ? 'text' : 'password'}
                        value={p.password ?? ''}
                        onChange={(e) => updateProvider(idx, { password: e.target.value })}
                        placeholder={t('partnerRemoteAccess.passwordPlaceholder')}
                        className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm font-mono"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setRevealPassword((prev) => ({ ...prev, [p.id]: !prev[p.id] }))
                        }
                        className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                        title={revealPassword[p.id] ? t('partnerRemoteAccess.hidePassword') : t('partnerRemoteAccess.showPassword')}
                      >
                        {revealPassword[p.id] ? (
                          <EyeOff className="h-3.5 w-3.5" />
                        ) : (
                          <Eye className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('partnerRemoteAccess.passwordHelp')}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

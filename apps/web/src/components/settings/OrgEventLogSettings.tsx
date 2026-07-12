import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Database, Save, Key, Link, ScrollText, Info } from 'lucide-react';
import { useOrgStore } from '../../stores/orgStore';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '@/lib/apiError';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';

type LogForwardingData = {
  enabled: boolean;
  elasticsearchUrl: string;
  elasticsearchApiKey?: string;
  elasticsearchUsername?: string;
  elasticsearchPassword?: string;
  indexPrefix: string;
};

type AuthMethod = 'apiKey' | 'basic';

type OrgEventLogSettingsProps = {
  onDirty?: () => void;
  locked?: string[];
};

export default function OrgEventLogSettings({ onDirty, locked }: OrgEventLogSettingsProps) {
  const { t } = useTranslation('settings');
  const isLocked = (field: string) => locked?.includes(`eventLogs.${field}`) ?? false;
  const allFieldsLocked = ['enabled', 'elasticsearchUrl', 'elasticsearchApiKey', 'elasticsearchUsername', 'elasticsearchPassword', 'indexPrefix'].every(f => isLocked(f));
  const { currentOrgId } = useOrgStore();

  const [enabled, setEnabled] = useState(false);
  const [elasticsearchUrl, setElasticsearchUrl] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('apiKey');
  const [elasticsearchApiKey, setElasticsearchApiKey] = useState('');
  const [elasticsearchUsername, setElasticsearchUsername] = useState('');
  const [elasticsearchPassword, setElasticsearchPassword] = useState('');
  const [indexPrefix, setIndexPrefix] = useState('breeze-logs');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!currentOrgId) return;

    const load = async () => {
      try {
        setLoading(true);
        const response = await fetchWithAuth(`/agents/org/${currentOrgId}/settings/log-forwarding`);
        if (!response.ok) {
          if (response.status === 401) {
            void navigateTo('/login', { replace: true });
            return;
          }
          throw new Error(t('orgEventLogSettings.errors.loadForwarding'));
        }
        const data = await response.json();
        const lf = data.settings?.logForwarding as LogForwardingData | undefined;
        if (lf) {
          setEnabled(lf.enabled ?? false);
          setElasticsearchUrl(lf.elasticsearchUrl || '');
          setIndexPrefix(lf.indexPrefix || 'breeze-logs');
          if (lf.elasticsearchUsername) {
            setAuthMethod('basic');
            setElasticsearchUsername(lf.elasticsearchUsername);
            setElasticsearchPassword(lf.elasticsearchPassword || '');
          } else {
            setAuthMethod('apiKey');
            setElasticsearchApiKey(lf.elasticsearchApiKey || '');
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : t('orgEventLogSettings.errors.load'));
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [currentOrgId, t]);

  const markDirty = () => {
    onDirty?.();
  };

  const handleSave = async () => {
    if (!currentOrgId) return;

    setSaving(true);
    setError(undefined);

    try {
      const body: Record<string, unknown> = {
        enabled,
        elasticsearchUrl,
        indexPrefix,
      };

      if (authMethod === 'apiKey') {
        body.elasticsearchApiKey = elasticsearchApiKey;
      } else {
        body.elasticsearchUsername = elasticsearchUsername;
        body.elasticsearchPassword = elasticsearchPassword;
      }

      const response = await fetchWithAuth(`/agents/org/${currentOrgId}/settings/log-forwarding`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(extractApiError(data, t('orgEventLogSettings.errors.saveForwarding')));
      }

      showToast({ message: t('orgEventLogSettings.toasts.saved'), type: 'success' });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('orgEventLogSettings.errors.save'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Log Forwarding Section */}
      <section className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              <h2 className="text-lg font-semibold">{t('orgEventLogSettings.title')}</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('orgEventLogSettings.description')}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || allFieldsLocked}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? t('common:states.saving') : t('orgEventLogSettings.save')}
          </button>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {/* Enable toggle */}
        <label className={`flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-4 py-3 text-sm ${isLocked('enabled') ? 'opacity-60' : ''}`}>
          <div>
            <p className="font-medium">{t('orgEventLogSettings.enable.title')}</p>
            <p className="text-xs text-muted-foreground">
              {t('orgEventLogSettings.enable.description')}
            </p>
            {isLocked('enabled') && (
              <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgEventLogSettings.managedByPartner')}</span>
            )}
          </div>
          <input
            type="checkbox"
            checked={enabled}
            disabled={isLocked('enabled')}
            onChange={event => {
              setEnabled(event.target.checked);
              markDirty();
            }}
            className="h-4 w-4"
          />
        </label>

        {/* Connection fields — only shown when enabled */}
        {enabled ? (
          <div className="space-y-4">
            <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Link className="h-4 w-4" />
                {t('orgEventLogSettings.connection.title')}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('orgEventLogSettings.connection.endpointUrl')}</label>
                <input
                  type="text"
                  value={elasticsearchUrl}
                  disabled={isLocked('elasticsearchUrl')}
                  onChange={event => {
                    setElasticsearchUrl(event.target.value);
                    markDirty();
                  }}
                  placeholder={t('orgEventLogSettings.connection.endpointPlaceholder')}
                  className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('elasticsearchUrl') ? 'opacity-60' : ''}`}
                />
                <p className="text-xs text-muted-foreground">
                  {t('orgEventLogSettings.connection.endpointDescription')}
                </p>
                {isLocked('elasticsearchUrl') && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgEventLogSettings.managedByPartner')}</span>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">{t('orgEventLogSettings.connection.indexPrefix')}</label>
                <input
                  type="text"
                  value={indexPrefix}
                  disabled={isLocked('indexPrefix')}
                  onChange={event => {
                    setIndexPrefix(event.target.value);
                    markDirty();
                  }}
                  placeholder={t('orgEventLogSettings.connection.indexPlaceholder')}
                  className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('indexPrefix') ? 'opacity-60' : ''}`}
                />
                <p className="text-xs text-muted-foreground">
                  {t('orgEventLogSettings.connection.indexDescription', {
                    index: indexPrefix ? `${indexPrefix}-YYYY.MM.DD` : 'breeze-logs-YYYY.MM.DD',
                  })}
                </p>
                {isLocked('indexPrefix') && (
                  <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgEventLogSettings.managedByPartner')}</span>
                )}
              </div>
            </div>

            <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Key className="h-4 w-4" />
                {t('orgEventLogSettings.authentication.title')}
              </div>

              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="authMethod"
                    checked={authMethod === 'apiKey'}
                    onChange={() => {
                      setAuthMethod('apiKey');
                      markDirty();
                    }}
                    className="h-4 w-4"
                  />
                  {t('orgEventLogSettings.authentication.apiKey')}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="authMethod"
                    checked={authMethod === 'basic'}
                    onChange={() => {
                      setAuthMethod('basic');
                      markDirty();
                    }}
                    className="h-4 w-4"
                  />
                  {t('orgEventLogSettings.authentication.usernamePassword')}
                </label>
              </div>

              {authMethod === 'apiKey' ? (
                <div className="space-y-2">
                  <label className="text-sm font-medium">{t('orgEventLogSettings.authentication.apiKey')}</label>
                  <input
                    type="password"
                    value={elasticsearchApiKey}
                    disabled={isLocked('elasticsearchApiKey')}
                    onChange={event => {
                      setElasticsearchApiKey(event.target.value);
                      markDirty();
                    }}
                    placeholder={t('orgEventLogSettings.authentication.apiKeyPlaceholder')}
                    className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('elasticsearchApiKey') ? 'opacity-60' : ''}`}
                  />
                  {isLocked('elasticsearchApiKey') && (
                    <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgEventLogSettings.managedByPartner')}</span>
                  )}
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('orgEventLogSettings.authentication.username')}</label>
                    <input
                      type="text"
                      value={elasticsearchUsername}
                      disabled={isLocked('elasticsearchUsername')}
                      onChange={event => {
                        setElasticsearchUsername(event.target.value);
                        markDirty();
                      }}
                      placeholder={t('orgEventLogSettings.authentication.usernamePlaceholder')}
                      className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('elasticsearchUsername') ? 'opacity-60' : ''}`}
                    />
                    {isLocked('elasticsearchUsername') && (
                      <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgEventLogSettings.managedByPartner')}</span>
                    )}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">{t('orgEventLogSettings.authentication.password')}</label>
                    <input
                      type="password"
                      value={elasticsearchPassword}
                      disabled={isLocked('elasticsearchPassword')}
                      onChange={event => {
                        setElasticsearchPassword(event.target.value);
                        markDirty();
                      }}
                      placeholder={t('orgEventLogSettings.authentication.passwordPlaceholder')}
                      className={`h-10 w-full rounded-md border bg-background px-3 text-sm ${isLocked('elasticsearchPassword') ? 'opacity-60' : ''}`}
                    />
                    {isLocked('elasticsearchPassword') && (
                      <span className="text-xs text-amber-600 dark:text-amber-400 italic">{t('orgEventLogSettings.managedByPartner')}</span>
                    )}
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                {t('orgEventLogSettings.authentication.credentialsDescription')}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('orgEventLogSettings.disabledDescription')}
          </p>
        )}
      </section>

      {/* Event Log Collection Info */}
      <section className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div className="space-y-2">
            <h3 className="text-base font-semibold">{t('orgEventLogSettings.collection.title')}</h3>
            <p className="text-sm text-muted-foreground">
              {t('orgEventLogSettings.collection.description')}
            </p>
            <a
              href="/configuration-policies"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              <ScrollText className="h-4 w-4" />
              {t('orgEventLogSettings.collection.link')}
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

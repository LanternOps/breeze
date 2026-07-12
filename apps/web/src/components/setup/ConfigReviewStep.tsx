import { useEffect, useState } from 'react';
import { CheckCircle, AlertTriangle, Loader2, Mail, Globe, Shield, Puzzle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

interface ConfigStatus {
  email: { configured: boolean; provider: string; from: string };
  domain: { breezeDomain: string; publicUrl: string; corsOrigins: string };
  security: { httpsForced: boolean; mfaEnabled: boolean; registrationEnabled: boolean };
  integrations: { sms: boolean; ai: boolean; mtls: boolean; storage: boolean; sentry: boolean };
}

interface ConfigReviewStepProps {
  onNext: () => void;
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        ok
          ? 'bg-green-500/10 text-green-700 dark:text-green-400'
          : 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400'
      )}
    >
      {ok ? <CheckCircle className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
      {label}
    </span>
  );
}

function ConfigCard({
  icon: Icon,
  title,
  children
}: {
  icon: typeof Mail;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="space-y-2 text-sm">{children}</div>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default function ConfigReviewStep({ onNext }: ConfigReviewStepProps) {
  const { t } = useTranslation('auth');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [config, setConfig] = useState<ConfigStatus>();

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const res = await fetchWithAuth('/system/config-status');
      if (res.ok) {
        setConfig(await res.json());
      } else {
        setError(t('setup.config.errors.loadFailedWithStatus', { status: res.status }));
      }
    } catch {
      setError(t('setup.config.errors.connectionFailed'));
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error || t('setup.config.errors.unavailable')}
        </div>
        <div className="flex justify-end">
          <button
            onClick={onNext}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
          >
            {t('setup.common.continue')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t('setup.config.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('setup.config.description')}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ConfigCard icon={Mail} title={t('setup.config.cards.email')}>
          <ConfigRow
            label={t('setup.config.rows.status')}
            value={<StatusBadge ok={config.email.configured} label={config.email.configured ? t('setup.config.status.configured') : t('setup.config.status.notConfigured')} />}
          />
          <ConfigRow
            label={t('setup.config.rows.provider')}
            value={<span className="font-mono text-xs">{config.email.provider}</span>}
          />
          {config.email.from && (
            <ConfigRow
              label={t('setup.config.rows.from')}
              value={<span className="font-mono text-xs">{config.email.from}</span>}
            />
          )}
        </ConfigCard>

        <ConfigCard icon={Globe} title={t('setup.config.cards.domain')}>
          <ConfigRow
            label={t('setup.config.rows.publicUrl')}
            value={
              <StatusBadge
                ok={!!config.domain.publicUrl}
                label={config.domain.publicUrl || t('setup.config.status.notSet')}
              />
            }
          />
          {config.domain.breezeDomain && (
            <ConfigRow
              label={t('setup.config.rows.domain')}
              value={<span className="font-mono text-xs">{config.domain.breezeDomain}</span>}
            />
          )}
        </ConfigCard>

        <ConfigCard icon={Shield} title={t('setup.config.cards.security')}>
          <ConfigRow
            label={t('setup.config.rows.https')}
            value={<StatusBadge ok={config.security.httpsForced} label={config.security.httpsForced ? t('setup.config.status.forced') : t('setup.config.status.optional')} />}
          />
          <ConfigRow
            label={t('setup.config.rows.mfa')}
            value={<StatusBadge ok={config.security.mfaEnabled} label={config.security.mfaEnabled ? t('setup.config.status.enabled') : t('setup.config.status.disabled')} />}
          />
          <ConfigRow
            label={t('setup.config.rows.registration')}
            value={
              <StatusBadge
                ok={!config.security.registrationEnabled}
                label={config.security.registrationEnabled ? t('setup.config.status.open') : t('setup.config.status.closed')}
              />
            }
          />
        </ConfigCard>

        <ConfigCard icon={Puzzle} title={t('setup.config.cards.integrations')}>
          <ConfigRow
            label={t('setup.config.rows.sms')}
            value={<StatusBadge ok={config.integrations.sms} label={config.integrations.sms ? t('setup.config.status.connected') : t('setup.config.status.notConfigured')} />}
          />
          <ConfigRow
            label={t('setup.config.rows.ai')}
            value={<StatusBadge ok={config.integrations.ai} label={config.integrations.ai ? t('setup.config.status.connected') : t('setup.config.status.notConfigured')} />}
          />
          <ConfigRow
            label={t('setup.config.rows.mtls')}
            value={<StatusBadge ok={config.integrations.mtls} label={config.integrations.mtls ? t('setup.config.status.enabled') : t('setup.config.status.notConfigured')} />}
          />
          <ConfigRow
            label={t('setup.config.rows.storage')}
            value={<StatusBadge ok={config.integrations.storage} label={config.integrations.storage ? t('setup.config.status.connected') : t('setup.config.status.notConfigured')} />}
          />
          <ConfigRow
            label={t('setup.config.rows.sentry')}
            value={<StatusBadge ok={config.integrations.sentry} label={config.integrations.sentry ? t('setup.config.status.connected') : t('setup.config.status.notConfigured')} />}
          />
        </ConfigCard>
      </div>

      <div className="flex justify-end pt-2">
        <button
          onClick={onNext}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          {t('setup.common.continue')}
        </button>
      </div>
    </div>
  );
}

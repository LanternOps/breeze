import { useEffect, useState } from 'react';
import { CheckCircle, AlertTriangle, Loader2, Mail, Globe, Shield, Puzzle } from 'lucide-react';
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
        setError(`Failed to load configuration (HTTP ${res.status})`);
      }
    } catch {
      setError('Unable to reach the server. Check your connection.');
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
          {error || 'Configuration unavailable'}
        </div>
        <div className="flex justify-end">
          <button
            onClick={onNext}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Configuration Review</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review your environment configuration. These settings are controlled via environment variables.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ConfigCard icon={Mail} title="Email">
          <ConfigRow
            label="Status"
            value={<StatusBadge ok={config.email.configured} label={config.email.configured ? 'Configured' : 'Not configured'} />}
          />
          <ConfigRow
            label="Provider"
            value={<span className="font-mono text-xs">{config.email.provider}</span>}
          />
          {config.email.from && (
            <ConfigRow
              label="From"
              value={<span className="font-mono text-xs">{config.email.from}</span>}
            />
          )}
        </ConfigCard>

        <ConfigCard icon={Globe} title="Domain">
          <ConfigRow
            label="Public URL"
            value={
              <StatusBadge
                ok={!!config.domain.publicUrl}
                label={config.domain.publicUrl || 'Not set'}
              />
            }
          />
          {config.domain.breezeDomain && (
            <ConfigRow
              label="Domain"
              value={<span className="font-mono text-xs">{config.domain.breezeDomain}</span>}
            />
          )}
        </ConfigCard>

        <ConfigCard icon={Shield} title="Security">
          <ConfigRow
            label="HTTPS"
            value={<StatusBadge ok={config.security.httpsForced} label={config.security.httpsForced ? 'Forced' : 'Optional'} />}
          />
          <ConfigRow
            label="MFA"
            value={<StatusBadge ok={config.security.mfaEnabled} label={config.security.mfaEnabled ? 'Enabled' : 'Disabled'} />}
          />
          <ConfigRow
            label="Registration"
            value={
              <StatusBadge
                ok={!config.security.registrationEnabled}
                label={config.security.registrationEnabled ? 'Open' : 'Closed'}
              />
            }
          />
        </ConfigCard>

        <ConfigCard icon={Puzzle} title="Integrations">
          <ConfigRow
            label="SMS (Twilio)"
            value={<StatusBadge ok={config.integrations.sms} label={config.integrations.sms ? 'Connected' : 'Not configured'} />}
          />
          <ConfigRow
            label="AI"
            value={<StatusBadge ok={config.integrations.ai} label={config.integrations.ai ? 'Connected' : 'Not configured'} />}
          />
          <ConfigRow
            label="mTLS"
            value={<StatusBadge ok={config.integrations.mtls} label={config.integrations.mtls ? 'Enabled' : 'Not configured'} />}
          />
          <ConfigRow
            label="Storage"
            value={<StatusBadge ok={config.integrations.storage} label={config.integrations.storage ? 'Connected' : 'Not configured'} />}
          />
          <ConfigRow
            label="Sentry"
            value={<StatusBadge ok={config.integrations.sentry} label={config.integrations.sentry ? 'Connected' : 'Not configured'} />}
          />
        </ConfigCard>
      </div>

      <div className="flex justify-end pt-2">
        <button
          onClick={onNext}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

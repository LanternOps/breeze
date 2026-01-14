import { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Cloud,
  Database,
  HardDrive,
  KeyRound,
  Lock,
  Plug,
  RefreshCw,
  Server,
  ShieldCheck,
  Timer
} from 'lucide-react';
import { cn } from '@/lib/utils';

type ProviderId = 's3' | 'azure' | 'local' | 'gcs';

type ScheduleType = 'daily' | 'weekly' | 'cron';

type RetentionPreset = 'standard' | 'extended' | 'compliance';

const steps = ['Provider', 'Settings', 'Schedule', 'Retention'];

const providers = [
  {
    id: 's3' as ProviderId,
    name: 'AWS S3',
    description: 'Highly durable object storage with lifecycle policies.',
    icon: Cloud,
    badge: 'Recommended'
  },
  {
    id: 'azure' as ProviderId,
    name: 'Azure Blob',
    description: 'Enterprise storage with hot/cool/archive tiers.',
    icon: Server,
    badge: 'Fast restore'
  },
  {
    id: 'gcs' as ProviderId,
    name: 'Google Cloud Storage',
    description: 'Unified buckets with regional redundancy.',
    icon: Database,
    badge: 'Multi-region'
  },
  {
    id: 'local' as ProviderId,
    name: 'Local Vault',
    description: 'On-premises vault for air-gapped storage.',
    icon: HardDrive,
    badge: 'Offline'
  }
];

const retentionPresets = [
  {
    id: 'standard' as RetentionPreset,
    name: 'Standard',
    description: '30 days + 12 versions'
  },
  {
    id: 'extended' as RetentionPreset,
    name: 'Extended',
    description: '90 days + 36 versions'
  },
  {
    id: 'compliance' as RetentionPreset,
    name: 'Compliance',
    description: '365 days + 120 versions'
  }
];

export default function BackupConfigEditor() {
  const [activeStep, setActiveStep] = useState(0);
  const [provider, setProvider] = useState<ProviderId>('s3');
  const [scheduleType, setScheduleType] = useState<ScheduleType>('daily');
  const [retentionPreset, setRetentionPreset] = useState<RetentionPreset>('standard');
  const [encryptionEnabled, setEncryptionEnabled] = useState(true);

  const nextStep = () => setActiveStep((prev) => Math.min(prev + 1, steps.length - 1));
  const prevStep = () => setActiveStep((prev) => Math.max(prev - 1, 0));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Backup Configuration Editor</h2>
        <p className="text-sm text-muted-foreground">
          Build a reusable backup config with provider, schedule, and retention rules.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {steps.map((step, index) => (
              <button
                key={step}
                onClick={() => setActiveStep(index)}
                className={cn(
                  'rounded-full border px-4 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors',
                  index === activeStep
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted bg-muted/40 text-muted-foreground hover:text-foreground'
                )}
              >
                {index + 1}. {step}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Timer className="h-4 w-4" />
            Estimated setup: 4-6 minutes
          </div>
        </div>

        <div className="mt-6">
          {activeStep === 0 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Choose a provider</h3>
                <p className="text-sm text-muted-foreground">
                  Select the storage backend where backups will be stored.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {providers.map((option) => {
                  const Icon = option.icon;
                  const selected = provider === option.id;
                  return (
                    <button
                      key={option.id}
                      onClick={() => setProvider(option.id)}
                      className={cn(
                        'rounded-lg border p-4 text-left transition-all',
                        selected
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'border-muted bg-muted/20 hover:border-primary/40'
                      )}
                    >
                      <div className="flex items-start justify-between">
                        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                          <Icon className="h-5 w-5 text-foreground" />
                        </span>
                        <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground">
                          {option.badge}
                        </span>
                      </div>
                      <h4 className="mt-3 text-sm font-semibold text-foreground">{option.name}</h4>
                      <p className="text-xs text-muted-foreground">{option.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {activeStep === 1 && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Provider settings</h3>
                <p className="text-sm text-muted-foreground">
                  Configure credentials, bucket, and path for {provider.toUpperCase()}.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Display name</label>
                  <input
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    defaultValue="Production Backups"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Region / Endpoint</label>
                  <input
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    defaultValue={provider === 'azure' ? 'eastus2' : 'us-east-1'}
                  />
                </div>
              </div>

              {(provider === 's3' || provider === 'gcs') && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Bucket name</label>
                    <input
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      defaultValue="backup-prod-primary"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Base path</label>
                    <input
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      defaultValue="/daily"
                    />
                  </div>
                </div>
              )}

              {provider === 'azure' && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Storage account</label>
                    <input
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      defaultValue="acmebackups"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Container</label>
                    <input
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      defaultValue="protected-assets"
                    />
                  </div>
                </div>
              )}

              {provider === 'local' && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Local path</label>
                    <input
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      defaultValue="/vault/backups"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Retention tier</label>
                    <select className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                      <option>Warm storage</option>
                      <option>Cold storage</option>
                      <option>Archive only</option>
                    </select>
                  </div>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Access key</label>
                  <input
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    defaultValue="AKIA-****-9822"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Secret key</label>
                  <input
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    type="password"
                    defaultValue="hidden-secret"
                  />
                </div>
              </div>

              <div className="rounded-md border border-dashed bg-muted/30 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Plug className="h-4 w-4 text-primary" />
                    Test connection
                  </div>
                  <button className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent">
                    <RefreshCw className="h-3.5 w-3.5" />
                    Run test
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Last tested 2 hours ago - Latency 218ms - TLS verified
                </p>
              </div>
            </div>
          )}

          {activeStep === 2 && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Schedule builder</h3>
                <p className="text-sm text-muted-foreground">
                  Define how often backups run and set maintenance windows.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {(['daily', 'weekly', 'cron'] as ScheduleType[]).map((option) => (
                  <button
                    key={option}
                    onClick={() => setScheduleType(option)}
                    className={cn(
                      'rounded-lg border px-4 py-3 text-left text-sm font-semibold transition-colors',
                      scheduleType === option
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-muted bg-muted/20 text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <span className="block text-xs uppercase tracking-wide text-muted-foreground">
                      {option === 'cron' ? 'Custom' : option}
                    </span>
                    <span className="block text-sm font-semibold">
                      {option === 'daily' && 'Every day'}
                      {option === 'weekly' && 'Specific weekdays'}
                      {option === 'cron' && 'Cron expression'}
                    </span>
                  </button>
                ))}
              </div>

              {scheduleType === 'daily' && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Start time</label>
                    <input
                      type="time"
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      defaultValue="02:00"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Window length</label>
                    <select className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                      <option>2 hours</option>
                      <option>4 hours</option>
                      <option>6 hours</option>
                    </select>
                  </div>
                </div>
              )}

              {scheduleType === 'weekly' && (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
                      <button
                        key={day}
                        className={cn(
                          'rounded-full border px-3 py-1 text-xs font-medium',
                          ['Mon', 'Wed', 'Fri'].includes(day)
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-muted bg-muted/20 text-muted-foreground'
                        )}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">Start time</label>
                      <input
                        type="time"
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        defaultValue="01:30"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-muted-foreground">Timezone</label>
                      <select className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                        <option>UTC-05:00 (EST)</option>
                        <option>UTC-08:00 (PST)</option>
                        <option>UTC+01:00 (CET)</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {scheduleType === 'cron' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Cron expression</label>
                    <input
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      defaultValue="0 2 * * *"
                    />
                  </div>
                  <div className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
                    Runs daily at 2:00 AM. Next: Tomorrow 02:00 UTC.
                  </div>
                </div>
              )}

              <div className="rounded-md border border-dashed bg-muted/30 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  Backup window protection
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Jobs pause automatically during maintenance windows and resume after approvals.
                </p>
              </div>
            </div>
          )}

          {activeStep === 3 && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Retention & encryption</h3>
                <p className="text-sm text-muted-foreground">
                  Control how long backups are kept and protect them with encryption.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {retentionPresets.map((preset) => (
                  <button
                    key={preset.id}
                    onClick={() => setRetentionPreset(preset.id)}
                    className={cn(
                      'rounded-lg border px-4 py-3 text-left',
                      retentionPreset === preset.id
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-muted bg-muted/20 text-muted-foreground'
                    )}
                  >
                    <div className="text-sm font-semibold">{preset.name}</div>
                    <div className="text-xs text-muted-foreground">{preset.description}</div>
                  </button>
                ))}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Keep backups (days)</label>
                  <input
                    type="number"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    defaultValue={90}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Max versions</label>
                  <input
                    type="number"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    defaultValue={36}
                  />
                </div>
              </div>

              <div className="rounded-md border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Lock className="h-4 w-4 text-primary" />
                    Encryption at rest
                  </div>
                  <button
                    onClick={() => setEncryptionEnabled((prev) => !prev)}
                    aria-pressed={encryptionEnabled}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-semibold',
                      encryptionEnabled
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted bg-muted/30 text-muted-foreground'
                    )}
                  >
                    {encryptionEnabled ? 'Enabled' : 'Disabled'}
                  </button>
                </div>
                <div className="mt-3 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Encryption key</label>
                    <input
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      defaultValue="kms/prod/backup-key"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Key rotation</label>
                    <select className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                      <option>Every 90 days</option>
                      <option>Every 180 days</option>
                      <option>Manual only</option>
                    </select>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <KeyRound className="h-3.5 w-3.5" />
                  Keys are stored in the secure vault and never logged.
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <button
            onClick={prevStep}
            disabled={activeStep === 0}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className="flex items-center gap-2">
            <button className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent">
              Save draft
            </button>
            <button
              onClick={nextStep}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {activeStep === steps.length - 1 ? 'Publish config' : 'Continue'}
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

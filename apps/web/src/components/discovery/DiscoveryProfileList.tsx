import { Loader2, Play, Pencil, Trash2, List } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';

export type DiscoveryProfileStatus = 'active' | 'paused' | 'draft' | 'error';

export type DiscoveryProfile = {
  id: string;
  name: string;
  subnets: string[];
  methods: string[];
  schedule: string;
  status: DiscoveryProfileStatus;
  lastRun?: string;
  nextRun?: string;
};

type DiscoveryProfileListProps = {
  profiles: DiscoveryProfile[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onEdit?: (profile: DiscoveryProfile) => void;
  onDelete?: (profile: DiscoveryProfile) => void;
  onRun?: (profile: DiscoveryProfile) => void | Promise<void>;
  runningProfileId?: string | null;
  onViewJobs?: (profileId: string) => void;
};

const statusConfig: Record<DiscoveryProfileStatus, { color: string }> = {
  active: { color: 'bg-success/15 text-success border-success/30' },
  paused: { color: 'bg-warning/15 text-warning border-warning/30' },
  draft: { color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' },
  error: { color: 'bg-destructive/15 text-destructive border-destructive/30' }
};

export default function DiscoveryProfileList({
  profiles,
  loading = false,
  error,
  onRetry,
  onEdit,
  onDelete,
  onRun,
  runningProfileId,
  onViewJobs
}: DiscoveryProfileListProps) {
  const { t } = useTranslation('discovery');

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-xs">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('discoveryProfileList.loading')}</p>
        </div>
      </div>
    );
  }

  if (error && profiles.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t('discoveryProfileList.tryAgain')}
          </button>
        )}
      </div>
    );
  }

  // Row pieces shared by the desktop table and the mobile cards.
  const renderSubnets = (profile: DiscoveryProfile) => (
    <div className="flex flex-wrap gap-1">
      {profile.subnets.map(subnet => (
        <span
          key={subnet}
          className="rounded-full border border-muted bg-muted/60 px-2 py-0.5 text-xs"
        >
          {subnet}
        </span>
      ))}
    </div>
  );

  const renderMethods = (profile: DiscoveryProfile) => (
    <div className="flex flex-wrap gap-1">
      {profile.methods.map(method => (
        <span
          key={method}
          className="rounded-full border border-muted bg-background px-2 py-0.5 text-xs text-muted-foreground"
        >
          {method.toUpperCase()}
        </span>
      ))}
    </div>
  );

  const renderSchedule = (profile: DiscoveryProfile) => (
    <>
      <div className="text-sm">{profile.schedule}</div>
      {profile.nextRun && (
        <div className="text-xs text-muted-foreground">{t('discoveryProfileList.nextRun', { time: profile.nextRun })}</div>
      )}
    </>
  );

  const renderStatus = (profile: DiscoveryProfile) => (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
        statusConfig[profile.status].color
      }`}
    >
      {t(/* i18n-dynamic */ `discoveryProfileList.status.${profile.status}`)}
    </span>
  );

  const renderActions = (profile: DiscoveryProfile) => {
    const runLabel = runningProfileId === profile.id
      ? t('discoveryProfileList.actions.runningProfile', { name: profile.name })
      : t('discoveryProfileList.actions.runProfile', { name: profile.name });
    return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => onViewJobs?.(profile.id)}
        className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
        title={t('discoveryProfileList.actions.viewJobs')}
      >
        <List className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onRun?.(profile)}
        disabled={runningProfileId === profile.id}
        aria-label={runLabel}
        aria-busy={runningProfileId === profile.id}
        className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        title={runningProfileId === profile.id ? t('discoveryProfileList.actions.running') : t('discoveryProfileList.actions.runNow')}
      >
        {runningProfileId === profile.id ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
      </button>
      <button
        type="button"
        onClick={() => onEdit?.(profile)}
        className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
        title={t('discoveryProfileList.actions.editProfile')}
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onDelete?.(profile)}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10"
        title={t('discoveryProfileList.actions.deleteProfile')}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
    );
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('discoveryProfileList.title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('discoveryProfileList.configuredCount', { count: profiles.length })}
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {t('discoveryProfileList.scheduleHint')}
        </div>
      </div>

      {error && profiles.length > 0 && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <ResponsiveTable
        className="mt-6"
        table={
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">{t('discoveryProfileList.columns.profile')}</th>
                <th className="px-4 py-3">{t('discoveryProfileList.columns.subnets')}</th>
                <th className="px-4 py-3">{t('discoveryProfileList.columns.methods')}</th>
                <th className="px-4 py-3">{t('discoveryProfileList.columns.schedule')}</th>
                <th className="px-4 py-3">{t('common:labels.status')}</th>
                <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {profiles.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {t('discoveryProfileList.empty')}
                  </td>
                </tr>
              ) : (
                profiles.map(profile => (
                  <tr key={profile.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium">{profile.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {profile.lastRun ? t('discoveryProfileList.lastRun', { time: profile.lastRun }) : t('discoveryProfileList.notRunYet')}
                      </div>
                    </td>
                    <td className="px-4 py-3">{renderSubnets(profile)}</td>
                    <td className="px-4 py-3">{renderMethods(profile)}</td>
                    <td className="px-4 py-3">{renderSchedule(profile)}</td>
                    <td className="px-4 py-3">{renderStatus(profile)}</td>
                    <td className="px-4 py-3">{renderActions(profile)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        }
        cards={
          profiles.length === 0 ? (
            <DataCard>
              <p className="py-2 text-center text-sm text-muted-foreground">
                {t('discoveryProfileList.empty')}
              </p>
            </DataCard>
          ) : (
            profiles.map(profile => (
              <DataCard key={profile.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{profile.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {profile.lastRun ? t('discoveryProfileList.lastRun', { time: profile.lastRun }) : t('discoveryProfileList.notRunYet')}
                    </div>
                  </div>
                  {renderStatus(profile)}
                </div>
                <div className="mt-3 space-y-2 border-t pt-3">
                  <CardField label={t('discoveryProfileList.columns.subnets')}>{renderSubnets(profile)}</CardField>
                  <CardField label={t('discoveryProfileList.columns.methods')}>{renderMethods(profile)}</CardField>
                  <CardField label={t('discoveryProfileList.columns.schedule')}>
                    <div>{renderSchedule(profile)}</div>
                  </CardField>
                </div>
                <CardActions>{renderActions(profile)}</CardActions>
              </DataCard>
            ))
          )
        }
      />
    </div>
  );
}

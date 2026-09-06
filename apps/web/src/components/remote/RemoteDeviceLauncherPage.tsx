import { useState } from 'react';
import { ArrowLeft, Loader2, Monitor, RefreshCcw, Search } from 'lucide-react';
import { navigateTo } from '@/lib/navigation';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { useDeviceOptions } from '../../hooks/useDeviceOptions';

type LauncherMode = 'terminal' | 'files';

type RemoteDeviceLauncherPageProps = {
  mode: LauncherMode;
};

type ModeConfig = {
  titleKey: string;
  descriptionKey: string;
  actionLabelKey: string;
  pathPrefix: string;
};

const MODE_CONFIG: Record<LauncherMode, ModeConfig> = {
  terminal: {
    titleKey: 'remoteDeviceLauncherPage.modes.terminal.title',
    descriptionKey: 'remoteDeviceLauncherPage.modes.terminal.description',
    actionLabelKey: 'remoteDeviceLauncherPage.modes.terminal.action',
    pathPrefix: '/remote/terminal'
  },
  files: {
    titleKey: 'remoteDeviceLauncherPage.modes.files.title',
    descriptionKey: 'remoteDeviceLauncherPage.modes.files.description',
    actionLabelKey: 'remoteDeviceLauncherPage.modes.files.action',
    pathPrefix: '/remote/files'
  }
};

function formatOs(osType?: string): string {
  if (!osType) return '-';
  if (osType === 'darwin' || osType === 'macos') return 'macOS';
  return osType.charAt(0).toUpperCase() + osType.slice(1);
}

function formatLastSeen(value?: string): string {
  if (!value) return '-';
  return formatDateTime(value, { fallback: '-' });
}

export default function RemoteDeviceLauncherPage({ mode }: RemoteDeviceLauncherPageProps) {
  const { t } = useTranslation('remote');
  const config = MODE_CONFIG[mode];
  const [query, setQuery] = useState('');
  const deviceOptions = useDeviceOptions({ search: query, status: 'online', limit: 100 });

  const handleLaunch = (deviceId: string) => {
    void navigateTo(`${config.pathPrefix}/${deviceId}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <a
          href="/remote"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          aria-label={t('remoteDeviceLauncherPage.backToRemoteAccess')}
        >
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t(/* i18n-dynamic */ config.titleKey)}</h1>
          <p className="text-muted-foreground">{t(/* i18n-dynamic */ config.descriptionKey)}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('remoteDeviceLauncherPage.searchPlaceholder')}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>
          <button
            type="button"
            onClick={deviceOptions.retry}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted"
          >
            <RefreshCcw className="h-4 w-4" />
            {t('common:actions.refresh')}
          </button>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        {deviceOptions.state === 'loading' || deviceOptions.state === 'stale' ? (
          <div className="flex u-min-h-px-220 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : deviceOptions.state === 'error' ? (
          <div className="flex u-min-h-px-220 flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-sm text-red-600">{deviceOptions.error?.message ?? t('remoteDeviceLauncherPage.errors.loadDevices')}</p>
            <button
              type="button"
              onClick={deviceOptions.retry}
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              {t('common:actions.retry')}
            </button>
          </div>
        ) : deviceOptions.options.length === 0 ? (
          <div className="flex u-min-h-px-220 flex-col items-center justify-center gap-3 p-8 text-center">
            <Monitor className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {query.trim() ? t('remoteDeviceLauncherPage.noSearchMatches') : t('remoteDeviceLauncherPage.noOnlineDevices')}
            </p>
            <a
              href="/devices"
              className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              {t('remoteDeviceLauncherPage.openDeviceList')}
            </a>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{t('common:labels.device')}</th>
                  <th className="px-4 py-3">{t('remoteDeviceLauncherPage.os')}</th>
                  <th className="px-4 py-3">{t('common:labels.status')}</th>
                  <th className="px-4 py-3">{t('remoteDeviceLauncherPage.lastSeen')}</th>
                  <th className="px-4 py-3 text-right">{t('remoteDeviceLauncherPage.action')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {deviceOptions.options.map((device) => (
                  <tr key={device.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">{device.displayName || device.hostname}</p>
                        <p className="text-xs text-muted-foreground font-mono">{device.hostname}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{formatOs(device.osType)}</td>
                    <td className="px-4 py-3 text-sm">
                      <span className="inline-flex items-center rounded-full border border-green-500/40 bg-green-500/20 px-2.5 py-1 text-xs font-medium text-green-700">
                        {device.status || t('common:states.online')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{formatLastSeen()}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleLaunch(device.id)}
                        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                      >
                        {t(/* i18n-dynamic */ config.actionLabelKey)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {deviceOptions.page?.hasMore && (
        <button
          type="button"
          onClick={() => void deviceOptions.loadMore()}
          className="text-sm font-medium text-primary hover:underline"
        >
          Load more
        </button>
      )}
    </div>
  );
}

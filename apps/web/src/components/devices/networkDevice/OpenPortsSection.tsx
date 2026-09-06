// The "Open ports" card: the port/service list (capped behind a "Show all"
// toggle so a wide scan can't dominate the section), plus the per-port Open
// Web UI trigger and the insecure/kind badges. Owns its own expand/collapse
// state since nothing outside this card needs it.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describePort } from '../../discovery/portCatalog';
import type { OpenPortEntry } from '../../discovery/DiscoveredAssetList';
import { Section } from './primitives';
import { PORT_KIND_LABEL_KEYS } from './format';
import { ProxyConnectPopover } from './ProxyConnectPopover';
import type { DeviceOption } from './types';

// A wide scan can turn up dozens of open ports; cap the row list at this many
// before it dominates the section, behind a "Show all" toggle.
const PORTS_VISIBLE_LIMIT = 12;

export function OpenPortsSection({
  openPorts,
  assetId,
  assetIp,
  suggestedBridgeDeviceId,
  devices,
  devicesError,
  onRetryDevices,
  onAnnounce,
}: {
  openPorts: OpenPortEntry[];
  assetId: string;
  assetIp: string;
  suggestedBridgeDeviceId: string | null;
  devices: DeviceOption[];
  devicesError: boolean;
  onRetryDevices: () => void;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation('devices');
  const [portsExpanded, setPortsExpanded] = useState(false);
  const visiblePorts = portsExpanded ? openPorts : openPorts.slice(0, PORTS_VISIBLE_LIMIT);

  return (
    <Section
      title={
        <>
          {t('networkDeviceDetailPage.sections.openPorts')}{' '}
          <span className="font-normal text-muted-foreground">
            · <span data-testid="network-detail-ports-count">{openPorts.length}</span>
          </span>
        </>
      }
      testId="network-detail-ports"
    >
      {openPorts.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('networkDeviceDetailPage.emptyPorts')}</p>
      ) : (
        <>
          <div className="divide-y divide-border">
            {visiblePorts.map((p, index) => {
              const info = describePort(p.port, p.service);
              const kindLabelKey = PORT_KIND_LABEL_KEYS[info.kind];
              const kindLabel = kindLabelKey ? t(/* i18n-dynamic */ kindLabelKey) : '';
              return (
                <div
                  key={`${p.port}-${(p as { protocol?: string }).protocol ?? 'tcp'}-${index}`}
                  className="flex items-center gap-3 py-1.5"
                >
                  <span
                    data-testid="network-detail-port-number"
                    className="w-14 shrink-0 text-right font-mono tabular-nums text-sm"
                  >
                    {p.port}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm" title={info.label}>
                    {info.label}
                  </span>
                  {info.kind === 'web' ? (
                    <ProxyConnectPopover
                      assetId={assetId}
                      assetIp={assetIp}
                      port={p.port}
                      service={p.service}
                      suggestedBridgeDeviceId={suggestedBridgeDeviceId}
                      devices={devices}
                      devicesError={devicesError}
                      onRetryDevices={onRetryDevices}
                      onAnnounce={onAnnounce}
                    />
                  ) : info.risky ? (
                    <span
                      className="shrink-0 rounded-full border border-warning/30 bg-warning/15 px-2 py-0.5 text-xs text-warning"
                      title={t('networkDeviceDetailPage.ports.insecureHint')}
                    >
                      {t('networkDeviceDetailPage.ports.insecure')}
                    </span>
                  ) : kindLabel ? (
                    <span className="shrink-0 text-xs text-muted-foreground">{kindLabel}</span>
                  ) : null}
                </div>
              );
            })}
          </div>
          {openPorts.length > PORTS_VISIBLE_LIMIT && (
            <button
              type="button"
              data-testid="network-detail-ports-toggle"
              onClick={() => setPortsExpanded((expanded) => !expanded)}
              className="mt-2 text-xs text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              {portsExpanded
                ? t('networkDeviceDetailPage.showFewerPorts')
                : t('networkDeviceDetailPage.showAllPorts', { count: openPorts.length })}
            </button>
          )}
        </>
      )}
    </Section>
  );
}

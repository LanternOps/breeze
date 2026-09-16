import { useEffect, useState } from 'react';
import type { Device } from '@/lib/api';
import type { HardwareLifecycleSummary } from '@breeze/shared';
import { cn } from '@/lib/utils';
import { DeviceList } from './DeviceList';
import { PageHeader } from './ui';
import { LifecyclePage } from '../lifecycle/LifecyclePage';

type Tab = 'devices' | 'lifecycle';

export interface DevicesPageLifecycle {
  run: { id: string; generatedAt: string } | null;
  summary: HardwareLifecycleSummary | null;
}

/**
 * `/devices` is two views of the same machines: the live register (online,
 * protection) and the hardware lifecycle plan (age, warranty, replace-by).
 * The plan used to live under Reports, one hop away from the list it
 * describes; here it sits behind a tab so a customer who came to check on a
 * machine can see when it is due for replacement without leaving the page.
 *
 * Which tab is open is hash state (`#lifecycle`), per the repo convention
 * for transient UI state. Any other hash — including the `#<deviceId>` a
 * lifecycle row links to — means the register, so that link both switches
 * tabs and lands DeviceList's own scroll-and-highlight effect on the row.
 *
 * `lifecycle === null` means the MSP has not turned the plan on for this
 * org: no tab bar, just the register as before. The server-side gate on
 * `/portal/reports/lifecycle/latest` is the real enforcement.
 */
export function DevicesPage({
  devices,
  error,
  lifecycle,
}: {
  devices: Device[];
  error?: string | null;
  lifecycle: DevicesPageLifecycle | null;
}) {
  // SSR and the first client render both see 'devices' (the hash is not
  // available on the server), so hydration never disagrees; the effect then
  // reads the real hash once mounted.
  const [tab, setTab] = useState<Tab>('devices');

  useEffect(() => {
    if (typeof window === 'undefined' || lifecycle === null) return;
    const read = () => setTab(window.location.hash === '#lifecycle' ? 'lifecycle' : 'devices');
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [lifecycle === null]);

  if (lifecycle === null) {
    return <DeviceList devices={devices} error={error} />;
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'devices', label: 'Devices' },
    { key: 'lifecycle', label: 'Hardware lifecycle' },
  ];

  return (
    <div>
      {/* One title for the page; the tabs are its sub-navigation and each
          panel renders embedded (no H1 of its own). */}
      <PageHeader title="Devices" lede="The machines your IT team looks after for you." />
      <div
        role="tablist"
        aria-label="Device views"
        data-testid="devices-tabs"
        className="-mt-2 mb-7 flex gap-6 border-b border-border"
      >
        {tabs.map((t) => {
          const selected = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={selected}
              data-testid={`devices-tab-${t.key}`}
              onClick={() => {
                // Setting the hash fires `hashchange`, which the effect above
                // turns into state — one code path for clicks and back/forward.
                window.location.hash = t.key;
                setTab(t.key);
              }}
              className={cn(
                '-mb-px border-b-2 pb-2.5 pt-1 text-sm font-semibold transition-colors',
                selected
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tab === 'devices' ? (
        // Keyed so a tab switch remounts the register and its hash-driven
        // scroll-and-highlight effect runs for a `#<deviceId>` arrival.
        <DeviceList key="devices" devices={devices} error={error} embedded />
      ) : (
        <LifecyclePage
          key="lifecycle"
          initialRun={lifecycle.run}
          initialSummary={lifecycle.summary}
          enableSelfService
          embedded
        />
      )}
    </div>
  );
}

export default DevicesPage;

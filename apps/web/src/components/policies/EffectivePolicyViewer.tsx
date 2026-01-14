import { useMemo, useState } from 'react';
import { Layers, Network } from 'lucide-react';
import { cn } from '@/lib/utils';

export type EffectiveSetting = {
  key: string;
  value: string;
  sourcePolicyId: string;
  sourcePolicyName: string;
  sourcePolicyType: string;
};

export type EffectivePolicyChainItem = {
  id: string;
  name: string;
  type: string;
  priority: number;
};

export type EffectivePolicyDevice = {
  id: string;
  name: string;
  settings: EffectiveSetting[];
  chain: EffectivePolicyChainItem[];
};

type EffectivePolicyViewerProps = {
  devices?: EffectivePolicyDevice[];
};

const mockDevices: EffectivePolicyDevice[] = [
  {
    id: 'dev-301',
    name: 'NYC-LT-112',
    settings: [
      {
        key: 'Firewall default',
        value: 'Block',
        sourcePolicyId: 'pol-101',
        sourcePolicyName: 'Endpoint Baseline',
        sourcePolicyType: 'Security'
      },
      {
        key: 'VPN enforcement',
        value: 'Always on',
        sourcePolicyId: 'pol-106',
        sourcePolicyName: 'SOC Alert Routing',
        sourcePolicyType: 'Security'
      },
      {
        key: 'Patch window',
        value: 'Sunday 2-4 AM',
        sourcePolicyId: 'pol-104',
        sourcePolicyName: 'Critical Patch Window',
        sourcePolicyType: 'Maintenance'
      }
    ],
    chain: [
      { id: 'pol-201', name: 'Global Defaults', type: 'Baseline', priority: 50 },
      { id: 'pol-104', name: 'Critical Patch Window', type: 'Maintenance', priority: 75 },
      { id: 'pol-101', name: 'Endpoint Baseline', type: 'Security', priority: 85 },
      { id: 'pol-106', name: 'SOC Alert Routing', type: 'Security', priority: 90 }
    ]
  },
  {
    id: 'dev-302',
    name: 'AUS-LT-044',
    settings: [
      {
        key: 'Firewall default',
        value: 'Block',
        sourcePolicyId: 'pol-101',
        sourcePolicyName: 'Endpoint Baseline',
        sourcePolicyType: 'Security'
      },
      {
        key: 'VPN enforcement',
        value: 'On demand',
        sourcePolicyId: 'pol-102',
        sourcePolicyName: 'CIS Level 1',
        sourcePolicyType: 'Compliance'
      },
      {
        key: 'Patch window',
        value: 'Saturday 1-3 AM',
        sourcePolicyId: 'pol-104',
        sourcePolicyName: 'Critical Patch Window',
        sourcePolicyType: 'Maintenance'
      }
    ],
    chain: [
      { id: 'pol-201', name: 'Global Defaults', type: 'Baseline', priority: 50 },
      { id: 'pol-102', name: 'CIS Level 1', type: 'Compliance', priority: 80 },
      { id: 'pol-101', name: 'Endpoint Baseline', type: 'Security', priority: 85 },
      { id: 'pol-104', name: 'Critical Patch Window', type: 'Maintenance', priority: 75 }
    ]
  }
];

const badgeColors = [
  'bg-emerald-100 text-emerald-700',
  'bg-blue-100 text-blue-700',
  'bg-amber-100 text-amber-700',
  'bg-slate-100 text-slate-700',
  'bg-rose-100 text-rose-700'
];

export default function EffectivePolicyViewer({ devices = mockDevices }: EffectivePolicyViewerProps) {
  const [selectedDeviceId, setSelectedDeviceId] = useState(devices[0]?.id ?? '');

  const selectedDevice = useMemo(
    () => devices.find(device => device.id === selectedDeviceId) ?? devices[0],
    [devices, selectedDeviceId]
  );

  const policyColorMap = useMemo(() => {
    const map = new Map<string, string>();
    selectedDevice?.chain.forEach((policy, index) => {
      map.set(policy.id, badgeColors[index % badgeColors.length]);
    });
    return map;
  }, [selectedDevice]);

  if (!selectedDevice) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">No devices available.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Effective Policy Viewer</h3>
          <p className="text-sm text-muted-foreground">
            Review merged settings and their policy sources.
          </p>
        </div>
        <select
          value={selectedDeviceId}
          onChange={event => setSelectedDeviceId(event.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {devices.map(device => (
            <option key={device.id} value={device.id}>
              {device.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Layers className="h-4 w-4 text-muted-foreground" />
            Merged policy settings
          </div>
          <div className="overflow-hidden rounded-lg border">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Setting</th>
                  <th className="px-4 py-3 font-medium">Value</th>
                  <th className="px-4 py-3 font-medium">Source policy</th>
                </tr>
              </thead>
              <tbody>
                {selectedDevice.settings.map(setting => (
                  <tr key={setting.key} className="border-t">
                    <td className="px-4 py-3 font-medium">{setting.key}</td>
                    <td className="px-4 py-3 text-muted-foreground">{setting.value}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                          policyColorMap.get(setting.sourcePolicyId) ?? 'bg-muted text-muted-foreground'
                        )}
                      >
                        {setting.sourcePolicyName}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {setting.sourcePolicyType}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Network className="h-4 w-4 text-muted-foreground" />
            Inheritance chain
          </div>
          <div className="space-y-3">
            {selectedDevice.chain.map((policy, index) => (
              <div key={policy.id} className="relative pl-6">
                <span className="absolute left-2 top-0 h-full w-px bg-muted" />
                <span
                  className={cn(
                    'absolute left-0 top-1.5 h-3.5 w-3.5 rounded-full border',
                    policyColorMap.get(policy.id) ?? 'border-muted-foreground'
                  )}
                />
                <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">{policy.name}</div>
                    <span className="text-xs text-muted-foreground">Priority {policy.priority}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">{policy.type}</div>
                </div>
                {index === selectedDevice.chain.length - 1 && (
                  <span className="absolute left-2 bottom-0 h-3 w-px bg-card" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

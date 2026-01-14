import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle, ChevronRight, Search, Server, CalendarClock, ClipboardList } from 'lucide-react';
import { cn } from '@/lib/utils';

type WizardStep = 'software' | 'targets' | 'configure' | 'review';

type SoftwareOption = {
  id: string;
  name: string;
  vendor: string;
  versions: string[];
  category: string;
};

type TargetNode = {
  id: string;
  name: string;
  type: 'org' | 'site' | 'group' | 'device';
  children?: TargetNode[];
};

const steps: { id: WizardStep; label: string; icon: typeof CheckCircle }[] = [
  { id: 'software', label: 'Select Software', icon: CheckCircle },
  { id: 'targets', label: 'Select Targets', icon: CheckCircle },
  { id: 'configure', label: 'Configure', icon: CheckCircle },
  { id: 'review', label: 'Review', icon: CheckCircle }
];

const softwareOptions: SoftwareOption[] = [
  {
    id: 'sw-chrome',
    name: 'Google Chrome',
    vendor: 'Google',
    versions: ['122.0.6261.112', '121.0.6167.85'],
    category: 'Browser'
  },
  {
    id: 'sw-firefox',
    name: 'Mozilla Firefox',
    vendor: 'Mozilla',
    versions: ['124.0', '123.0'],
    category: 'Browser'
  },
  {
    id: 'sw-vscode',
    name: 'Visual Studio Code',
    vendor: 'Microsoft',
    versions: ['1.87.2', '1.86.1'],
    category: 'Developer'
  },
  {
    id: 'sw-7zip',
    name: '7-Zip',
    vendor: 'Igor Pavlov',
    versions: ['23.01', '22.01'],
    category: 'Utilities'
  },
  {
    id: 'sw-zoom',
    name: 'Zoom',
    vendor: 'Zoom Video',
    versions: ['5.17.2', '5.16.6'],
    category: 'Collaboration'
  }
];

const targetTree: TargetNode[] = [
  {
    id: 'org-northwind',
    name: 'Northwind Health',
    type: 'org',
    children: [
      {
        id: 'site-seattle',
        name: 'Seattle HQ',
        type: 'site',
        children: [
          {
            id: 'group-finance',
            name: 'Finance',
            type: 'group',
            children: [
              { id: 'dev-fin-021', name: 'FIN-LT-021', type: 'device' },
              { id: 'dev-fin-024', name: 'FIN-DT-024', type: 'device' }
            ]
          },
          {
            id: 'group-hr',
            name: 'HR',
            type: 'group',
            children: [
              { id: 'dev-hr-011', name: 'HR-MB-011', type: 'device' },
              { id: 'dev-hr-012', name: 'HR-MB-012', type: 'device' }
            ]
          }
        ]
      },
      {
        id: 'site-remote',
        name: 'Remote Teams',
        type: 'site',
        children: [
          {
            id: 'group-sales',
            name: 'Sales',
            type: 'group',
            children: [
              { id: 'dev-sales-031', name: 'SAL-LT-031', type: 'device' },
              { id: 'dev-sales-032', name: 'SAL-LT-032', type: 'device' },
              { id: 'dev-sales-033', name: 'SAL-LT-033', type: 'device' }
            ]
          }
        ]
      }
    ]
  },
  {
    id: 'org-summit',
    name: 'Summit Retail',
    type: 'org',
    children: [
      {
        id: 'site-boston',
        name: 'Boston Office',
        type: 'site',
        children: [
          {
            id: 'group-it',
            name: 'IT',
            type: 'group',
            children: [
              { id: 'dev-it-001', name: 'IT-MAC-001', type: 'device' },
              { id: 'dev-it-002', name: 'IT-MAC-002', type: 'device' }
            ]
          }
        ]
      }
    ]
  }
];

const scheduleOptions = [
  { id: 'immediate', label: 'Deploy immediately', description: 'Start rollout as soon as approved.' },
  { id: 'scheduled', label: 'Schedule for later', description: 'Pick a specific date and time.' },
  { id: 'maintenance', label: 'Next maintenance window', description: 'Deploy during the next policy window.' }
];

function collectDeviceIds(node: TargetNode): string[] {
  if (node.type === 'device') return [node.id];
  if (!node.children) return [];
  return node.children.flatMap(child => collectDeviceIds(child));
}

export default function DeploymentWizard() {
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [selectedSoftwareId, setSelectedSoftwareId] = useState<string>('');
  const [selectedVersion, setSelectedVersion] = useState<string>('');
  const [selectedDevices, setSelectedDevices] = useState<Set<string>>(new Set());
  const [scheduleType, setScheduleType] = useState<'immediate' | 'scheduled' | 'maintenance'>('immediate');
  const [scheduledAt, setScheduledAt] = useState('');
  const [maintenanceWindow, setMaintenanceWindow] = useState('Saturday 02:00 - 04:00');

  const activeStep = steps[activeStepIndex]?.id ?? 'software';

  const filteredSoftware = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return softwareOptions.filter(item => {
      if (!normalized) return true;
      return item.name.toLowerCase().includes(normalized) || item.vendor.toLowerCase().includes(normalized);
    });
  }, [query]);

  const selectedSoftware = useMemo(
    () => softwareOptions.find(item => item.id === selectedSoftwareId),
    [selectedSoftwareId]
  );

  const selectedDeviceCount = useMemo(() => selectedDevices.size, [selectedDevices]);

  const canProceed = useMemo(() => {
    if (activeStep === 'software') return Boolean(selectedSoftwareId && selectedVersion);
    if (activeStep === 'targets') return selectedDevices.size > 0;
    if (activeStep === 'configure') return scheduleType !== 'scheduled' || Boolean(scheduledAt);
    return true;
  }, [activeStep, selectedSoftwareId, selectedVersion, selectedDevices, scheduleType, scheduledAt]);

  const toggleDevices = (deviceIds: string[], select: boolean) => {
    setSelectedDevices(prev => {
      const next = new Set(prev);
      deviceIds.forEach(id => {
        if (select) {
          next.add(id);
        } else {
          next.delete(id);
        }
      });
      return next;
    });
  };

  const renderStepContent = () => {
    if (activeStep === 'software') {
      return (
        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search software..."
                value={query}
                onChange={event => setQuery(event.target.value)}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-3">
              {filteredSoftware.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedSoftwareId(item.id);
                    setSelectedVersion(item.versions[0]);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left transition hover:border-primary/50',
                    selectedSoftwareId === item.id ? 'border-primary bg-primary/5' : 'bg-card'
                  )}
                >
                  <div>
                    <p className="text-sm font-semibold">{item.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.vendor} · {item.category}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">{item.versions[0]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Selected software</h3>
            </div>
            {selectedSoftware ? (
              <div className="mt-4 space-y-4">
                <div>
                  <p className="text-base font-semibold">{selectedSoftware.name}</p>
                  <p className="text-xs text-muted-foreground">{selectedSoftware.vendor}</p>
                </div>
                <div>
                  <label className="text-xs font-semibold uppercase text-muted-foreground">Version</label>
                  <select
                    value={selectedVersion}
                    onChange={event => setSelectedVersion(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {selectedSoftware.versions.map(version => (
                      <option key={version} value={version}>
                        {version}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                  Latest build is pre-selected. You can change to a previous release for rollback testing.
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">Select a software package to continue.</p>
            )}
          </div>
        </div>
      );
    }

    if (activeStep === 'targets') {
      const TreeItem = ({ node, level }: { node: TargetNode; level: number }) => {
        const checkboxRef = useRef<HTMLInputElement | null>(null);
        const deviceIds = collectDeviceIds(node);
        const allSelected = deviceIds.length > 0 && deviceIds.every(id => selectedDevices.has(id));
        const someSelected = deviceIds.some(id => selectedDevices.has(id));

        useEffect(() => {
          if (checkboxRef.current) {
            checkboxRef.current.indeterminate = !allSelected && someSelected;
          }
        }, [allSelected, someSelected]);

        return (
          <div className={cn('space-y-2', level > 0 && 'ml-6')}>
            <label className="flex items-center gap-2 text-sm">
              <input
                ref={checkboxRef}
                type="checkbox"
                checked={node.type === 'device' ? selectedDevices.has(node.id) : allSelected}
                onChange={() => {
                  if (node.type === 'device') {
                    toggleDevices([node.id], !selectedDevices.has(node.id));
                  } else {
                    toggleDevices(deviceIds, !allSelected);
                  }
                }}
                className="h-4 w-4 rounded border"
              />
              <span className="font-medium">{node.name}</span>
              <span className="text-xs text-muted-foreground">{node.type}</span>
            </label>
            {node.children?.map(child => (
              <TreeItem key={child.id} node={child} level={level + 1} />
            ))}
          </div>
        );
      };

      return (
        <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <div className="rounded-lg border bg-card p-5 shadow-sm">
            <h3 className="text-sm font-semibold">Organization targets</h3>
            <p className="text-xs text-muted-foreground">Select groups or devices for deployment.</p>
            <div className="mt-4 space-y-4">
              {targetTree.map(node => (
                <TreeItem key={node.id} node={node} level={0} />
              ))}
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-lg border bg-card p-5 shadow-sm">
              <h3 className="text-sm font-semibold">Selected targets</h3>
              <p className="mt-2 text-2xl font-semibold">{selectedDeviceCount}</p>
              <p className="text-xs text-muted-foreground">devices included in this deployment.</p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-4 text-xs text-muted-foreground">
              Tip: Selecting a group automatically includes all devices within it.
            </div>
          </div>
        </div>
      );
    }

    if (activeStep === 'configure') {
      return (
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Deployment schedule</h3>
          </div>
          <div className="mt-4 space-y-4">
            {scheduleOptions.map(option => (
              <label key={option.id} className="flex items-start gap-3 rounded-md border p-4 text-sm">
                <input
                  type="radio"
                  name="schedule"
                  value={option.id}
                  checked={scheduleType === option.id}
                  onChange={() => setScheduleType(option.id as typeof scheduleType)}
                  className="mt-1 h-4 w-4"
                />
                <div>
                  <p className="font-medium">{option.label}</p>
                  <p className="text-xs text-muted-foreground">{option.description}</p>
                </div>
              </label>
            ))}
          </div>
          {scheduleType === 'scheduled' && (
            <div className="mt-4">
              <label className="text-xs font-semibold uppercase text-muted-foreground">Scheduled date/time</label>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={event => setScheduledAt(event.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
          {scheduleType === 'maintenance' && (
            <div className="mt-4">
              <label className="text-xs font-semibold uppercase text-muted-foreground">Maintenance window</label>
              <select
                value={maintenanceWindow}
                onChange={event => setMaintenanceWindow(event.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="Saturday 02:00 - 04:00">Saturday 02:00 - 04:00</option>
                <option value="Sunday 01:00 - 03:00">Sunday 01:00 - 03:00</option>
                <option value="Weekdays 21:00 - 23:00">Weekdays 21:00 - 23:00</option>
              </select>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Review deployment</h3>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">Software</p>
              <p className="mt-2 text-sm font-semibold">{selectedSoftware?.name ?? '—'}</p>
              <p className="text-xs text-muted-foreground">Version {selectedVersion || '—'}</p>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">Targets</p>
              <p className="mt-2 text-sm font-semibold">{selectedDeviceCount} devices</p>
              <p className="text-xs text-muted-foreground">Across selected orgs and groups</p>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">Schedule</p>
              <p className="mt-2 text-sm font-semibold">
                {scheduleType === 'immediate' && 'Immediate'}
                {scheduleType === 'scheduled' && 'Scheduled'}
                {scheduleType === 'maintenance' && 'Maintenance window'}
              </p>
              <p className="text-xs text-muted-foreground">
                {scheduleType === 'scheduled' && scheduledAt ? scheduledAt : ''}
                {scheduleType === 'maintenance' ? maintenanceWindow : ''}
                {scheduleType === 'immediate' ? 'Starts after approval.' : ''}
              </p>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">Change window</p>
              <p className="mt-2 text-sm font-semibold">Standard</p>
              <p className="text-xs text-muted-foreground">Notifications enabled</p>
            </div>
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Create Deployment
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Deployment Wizard</h1>
        <p className="text-sm text-muted-foreground">Guide a deployment through selection, targeting, and review.</p>
      </div>

      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {steps.map((step, index) => {
            const isActive = index === activeStepIndex;
            const isCompleted = index < activeStepIndex;

            return (
              <div key={step.id} className="flex items-center gap-3">
                <div
                  className={cn(
                    'flex h-9 w-9 items-center justify-center rounded-full border text-sm font-semibold',
                    isCompleted && 'border-emerald-500 bg-emerald-500 text-white',
                    isActive && !isCompleted && 'border-primary text-primary',
                    !isActive && !isCompleted && 'text-muted-foreground'
                  )}
                >
                  {isCompleted ? <CheckCircle className="h-4 w-4" /> : index + 1}
                </div>
                <div>
                  <p className={cn('text-sm font-medium', isActive ? 'text-foreground' : 'text-muted-foreground')}>
                    {step.label}
                  </p>
                </div>
                {index < steps.length - 1 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
              </div>
            );
          })}
        </div>
      </div>

      <div>{renderStepContent()}</div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setActiveStepIndex(prev => Math.max(prev - 1, 0))}
          disabled={activeStepIndex === 0}
          className="inline-flex h-10 items-center justify-center rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          Back
        </button>
        {activeStepIndex < steps.length - 1 && (
          <button
            type="button"
            onClick={() => setActiveStepIndex(prev => Math.min(prev + 1, steps.length - 1))}
            disabled={!canProceed}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}

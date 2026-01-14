import { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  FolderOpen,
  MapPin,
  RotateCcw,
  Server
} from 'lucide-react';
import { cn } from '@/lib/utils';

type RestoreType = 'full' | 'selective';

type DestinationType = 'original' | 'alternate';

const snapshots = [
  {
    id: 'snap-0328',
    label: 'Mar 28, 2024 - 02:00 AM',
    size: '28.4 GB',
    status: 'Healthy'
  },
  {
    id: 'snap-0327',
    label: 'Mar 27, 2024 - 02:00 AM',
    size: '27.9 GB',
    status: 'Healthy'
  },
  {
    id: 'snap-0326',
    label: 'Mar 26, 2024 - 02:00 AM',
    size: '29.1 GB',
    status: 'Warnings'
  }
];

const selectableFiles = [
  { id: 'file-1', name: '/finance/Q1-report.xlsx', size: '4.2 MB' },
  { id: 'file-2', name: '/projects/apollo/specs/architecture.pdf', size: '1.4 MB' },
  { id: 'file-3', name: '/system/logs/backup.log', size: '2.1 MB' }
];

export default function RestoreWizard() {
  const [step, setStep] = useState(0);
  const [snapshotId, setSnapshotId] = useState('snap-0328');
  const [restoreType, setRestoreType] = useState<RestoreType>('full');
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set(['file-1']));
  const [destination, setDestination] = useState<DestinationType>('original');

  const nextStep = () => setStep((prev) => Math.min(prev + 1, 4));
  const prevStep = () => setStep((prev) => Math.max(prev - 1, 0));

  const toggleFile = (id: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedSnapshot = snapshots.find((snap) => snap.id === snapshotId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Restore Wizard</h2>
        <p className="text-sm text-muted-foreground">
          Guided restore flow for snapshots and targeted files.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {['Select snapshot', 'Restore type', 'Select files', 'Destination', 'Review'].map(
            (label, index) => (
              <div
                key={label}
                className={cn(
                  'rounded-full border px-4 py-1.5 text-xs font-semibold uppercase tracking-wide',
                  index === step
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted bg-muted/30 text-muted-foreground'
                )}
              >
                {index + 1}. {label}
              </div>
            )
          )}
        </div>

        <div className="mt-6 space-y-6">
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Select a snapshot</h3>
                <p className="text-sm text-muted-foreground">
                  Choose the recovery point you want to restore from.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                {snapshots.map((snapshot) => (
                  <button
                    key={snapshot.id}
                    onClick={() => setSnapshotId(snapshot.id)}
                    className={cn(
                      'rounded-lg border p-4 text-left',
                      snapshotId === snapshot.id
                        ? 'border-primary bg-primary/5'
                        : 'border-muted bg-muted/20'
                    )}
                  >
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{snapshot.size}</span>
                      <span>{snapshot.status}</span>
                    </div>
                    <div className="mt-2 text-sm font-semibold text-foreground">{snapshot.label}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Select restore type</h3>
                <p className="text-sm text-muted-foreground">
                  Full restores everything, selective restores specific files.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <button
                  onClick={() => setRestoreType('full')}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    restoreType === 'full'
                      ? 'border-primary bg-primary/5'
                      : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Server className="h-4 w-4 text-primary" />
                    Full restore
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Restores all data from the selected snapshot.
                  </p>
                </button>
                <button
                  onClick={() => setRestoreType('selective')}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    restoreType === 'selective'
                      ? 'border-primary bg-primary/5'
                      : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <ClipboardList className="h-4 w-4 text-primary" />
                    Selective restore
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Restore only the files and folders you choose.
                  </p>
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Select files</h3>
                <p className="text-sm text-muted-foreground">
                  Choose files to restore for selective recoveries.
                </p>
              </div>
              {restoreType === 'selective' ? (
                <div className="space-y-3">
                  {selectableFiles.map((file) => (
                    <label
                      key={file.id}
                      className="flex items-center justify-between rounded-md border bg-muted/20 px-4 py-3 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selectedFiles.has(file.id)}
                          onChange={() => toggleFile(file.id)}
                          className="h-4 w-4"
                        />
                        <span className="font-medium text-foreground">{file.name}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">{file.size}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
                  Full restore selected. Skip this step to continue.
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Destination</h3>
                <p className="text-sm text-muted-foreground">
                  Restore to the original location or provide an alternate path.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <button
                  onClick={() => setDestination('original')}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    destination === 'original'
                      ? 'border-primary bg-primary/5'
                      : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <RotateCcw className="h-4 w-4 text-primary" />
                    Original location
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">Restore files in place.</p>
                </button>
                <button
                  onClick={() => setDestination('alternate')}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    destination === 'alternate'
                      ? 'border-primary bg-primary/5'
                      : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FolderOpen className="h-4 w-4 text-primary" />
                    Alternate path
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">Restore to a new folder.</p>
                </button>
              </div>
              {destination === 'alternate' && (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Alternate path</label>
                  <input
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    defaultValue="/restore/nyc-db-14"
                  />
                </div>
              )}
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-foreground">Review & confirm</h3>
                <p className="text-sm text-muted-foreground">Confirm the restore summary before starting.</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    Snapshot
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{selectedSnapshot?.label}</p>
                </div>
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Server className="h-4 w-4 text-primary" />
                    Restore type
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {restoreType === 'full' ? 'Full restore' : 'Selective restore'}
                  </p>
                </div>
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <MapPin className="h-4 w-4 text-primary" />
                    Destination
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {destination === 'original' ? 'Original path' : 'Alternate path'}
                  </p>
                </div>
                <div className="rounded-md border border-dashed bg-muted/30 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <ClipboardList className="h-4 w-4 text-primary" />
                    Files
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {restoreType === 'full'
                      ? 'All files from snapshot'
                      : `${selectedFiles.size} files selected`}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <button
            onClick={prevStep}
            disabled={step === 0}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className="flex items-center gap-2">
            {step < 4 ? (
              <button
                onClick={nextStep}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
                Start restore
                <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

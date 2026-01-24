import { useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  HardDrive,
  Loader2,
  PauseCircle,
  Server,
  Timer
} from 'lucide-react';

const errorLog = [
  {
    time: '11:54:12 AM',
    message: 'Skipped 2 files due to access denied in /var/lib/postgres.'
  },
  {
    time: '11:52:44 AM',
    message: 'Retrying chunk 14 (network jitter detected).'
  }
];

export default function BackupJobProgress() {
  const [showErrors, setShowErrors] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Backup Job Progress</h2>
        <p className="text-sm text-muted-foreground">
          Live status for the current backup operation.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-5 shadow-sm space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Server className="h-6 w-6 text-primary" />
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">NYC-DB-14</p>
              <p className="text-xs text-muted-foreground">Config: Primary SQL S3</p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Timer className="h-4 w-4" />
            Started 11:42 AM - ETA 12:02 PM
          </div>
          <button className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent">
            <PauseCircle className="h-4 w-4" />
            Cancel job
          </button>
        </div>

        <div className="rounded-md border bg-muted/20 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Running - 62%
            </div>
            <div className="text-xs text-muted-foreground">Speed 182 MB/s</div>
          </div>
          <div className="mt-3 h-2 w-full rounded-full bg-muted">
            <div className="h-2 rounded-full bg-primary" style={{ width: '62%' }} />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>Files processed: 12,482 / 20,160</span>
            <span>Data copied: 9.3 GB / 15 GB</span>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-dashed bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <HardDrive className="h-4 w-4 text-emerald-600" />
              Current file
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              /var/lib/postgres/pgdata/base/11592/13819
            </p>
          </div>
          <div className="rounded-md border border-dashed bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <AlertTriangle className="h-4 w-4 text-warning" />
              Warning threshold
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              2 warnings logged - No critical errors detected.
            </p>
          </div>
        </div>

        <div className="rounded-md border border-dashed bg-muted/30">
          <button
            onClick={() => setShowErrors((prev) => !prev)}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-foreground"
          >
            Error log
            {showErrors ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          {showErrors && (
            <div className="space-y-3 border-t px-4 py-3 text-xs text-muted-foreground">
              {errorLog.map((entry) => (
                <div key={entry.time} className="flex items-start gap-3">
                  <span className="text-muted-foreground">{entry.time}</span>
                  <span className="text-foreground">{entry.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

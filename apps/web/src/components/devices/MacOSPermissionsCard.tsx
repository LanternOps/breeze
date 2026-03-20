import { ShieldCheck, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { TCCPermissions } from '@breeze/shared';

type MacOSPermissionsCardProps = {
  tccPermissions: TCCPermissions;
  formatDate: (dateString: string | null | undefined) => string;
};

export default function MacOSPermissionsCard({ tccPermissions, formatDate }: MacOSPermissionsCardProps) {
  const hasMissing = !tccPermissions.screenRecording || !tccPermissions.accessibility || !tccPermissions.fullDiskAccess;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-4">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-semibold">macOS Permissions</h3>
      </div>
      {hasMissing && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {!tccPermissions.fullDiskAccess
              ? 'Full Disk Access must be granted in System Settings > Privacy & Security. Screen Recording and Accessibility will be configured automatically.'
              : 'Screen Recording and Accessibility are being configured automatically. This should resolve shortly.'}
          </p>
        </div>
      )}
      <dl className="divide-y">
        <div className="flex justify-between py-2">
          <dt className="text-sm text-muted-foreground">Full Disk Access</dt>
          <dd className="text-sm font-medium">
            {tccPermissions.fullDiskAccess ? (
              <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" /> Granted
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                <XCircle className="h-4 w-4" /> Missing
              </span>
            )}
          </dd>
        </div>
        {([
          ['Screen Recording', tccPermissions.screenRecording],
          ['Accessibility', tccPermissions.accessibility],
        ] as const).map(([label, granted]) => (
          <div key={label} className="flex justify-between py-2">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-sm font-medium">
              {granted ? (
                <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
                  <CheckCircle2 className="h-4 w-4" /> Granted
                </span>
              ) : tccPermissions.fullDiskAccess ? (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" /> Configuring...
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  Auto-managed via FDA
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        Last checked: {formatDate(tccPermissions.checkedAt)}
      </p>
    </div>
  );
}

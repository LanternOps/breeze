import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import SnapshotIntegrityBadge, { isUnverifiedSnapshotStatus } from './SnapshotIntegrityBadge';
import '../../lib/i18n';

export type RestoreSnapshot = {
  id: string;
  label: string;
  deviceId?: string | null;
  deviceName?: string | null;
  size?: string;
  sizeBytes?: number | null;
  // /backup/snapshots carries no status (a snapshot row only exists once its
  // backup completed), so the card shows when it was captured instead (#6496).
  createdAt?: string | null;
  /** Integrity status from GET /backup/snapshots (absent on an older API). */
  integrityStatus?: string | null;
};

export type SnapshotDeviceGroup = {
  key: string;
  deviceName: string | null;
  snapshots: RestoreSnapshot[];
};

// A snapshot with no deviceId (an older API) still needs a group, and the
// <select> placeholder already owns the empty value.
const UNKNOWN_DEVICE_KEY = '__unknown_device__';

export function snapshotDeviceKey(snapshot: RestoreSnapshot): string {
  return snapshot.deviceId || UNKNOWN_DEVICE_KEY;
}

/**
 * Groups the org-wide snapshot list by source device, keeping the API's
 * newest-first order inside each group, so `group.snapshots[0]` is that
 * device's newest recovery point (#9627).
 */
export function groupSnapshotsByDevice(snapshots: RestoreSnapshot[]): SnapshotDeviceGroup[] {
  const groups = new Map<string, SnapshotDeviceGroup>();
  for (const snapshot of snapshots) {
    const key = snapshotDeviceKey(snapshot);
    let group = groups.get(key);
    if (!group) {
      group = { key, deviceName: snapshot.deviceName ?? null, snapshots: [] };
      groups.set(key, group);
    }
    group.deviceName ??= snapshot.deviceName ?? null;
    group.snapshots.push(snapshot);
  }
  return [...groups.values()].sort((a, b) =>
    (a.deviceName ?? '').localeCompare(b.deviceName ?? '') || a.key.localeCompare(b.key)
  );
}

type RestoreSnapshotStepProps = {
  groups: SnapshotDeviceGroup[];
  deviceKey: string | null;
  onDeviceChange: (key: string) => void;
  snapshotId: string;
  onSnapshotChange: (id: string) => void;
  formatBytes: (bytes?: number | null) => string;
  /** The snapshot the wizard was opened with is no longer in the list. */
  carriedSnapshotMissing?: boolean;
  /** The user has no second factor enrolled: flag unverified snapshots that will need one (#9629). */
  secondFactorMissing?: boolean;
};

/**
 * Step 1 of the restore wizard: pick the device first, then one of ITS
 * snapshots. The wizard never lists or preselects snapshots across devices —
 * a restore that silently lands on whichever server backed up last is the
 * failure this step exists to prevent (#9627).
 */
export default function RestoreSnapshotStep({
  groups,
  deviceKey,
  onDeviceChange,
  snapshotId,
  onSnapshotChange,
  formatBytes,
  carriedSnapshotMissing = false,
  secondFactorMissing = false,
}: RestoreSnapshotStepProps) {
  const { t } = useTranslation('backup');
  const deviceLabel = (group: SnapshotDeviceGroup) => group.deviceName || t('restoreWizard.unknownDevice');
  const activeGroup = deviceKey === null ? undefined : groups.find((group) => group.key === deviceKey);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-foreground">{t('restoreWizard.selectASnapshot')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('restoreWizard.chooseTheRecoveryPointYouWantToRestore')} </p>
      </div>
      {carriedSnapshotMissing ? (
        <div
          data-testid="restore-carried-snapshot-missing"
          role="status"
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
        >
          {t('restoreWizard.carriedSnapshotUnavailable')}
        </div>
      ) : null}
      {groups.length === 0 ? (
        <div className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
          {t('restoreWizard.noSnapshotsAvailable')} </div>
      ) : (
        <>
          <div className="space-y-2">
            <label htmlFor="restore-device-select" className="text-xs font-medium text-muted-foreground">
              {t('restoreWizard.device')}
            </label>
            <select
              id="restore-device-select"
              data-testid="restore-device-select"
              value={activeGroup?.key ?? ''}
              onChange={(event) => {
                if (event.target.value) onDeviceChange(event.target.value);
              }}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm md:max-w-md"
            >
              <option value="" disabled>
                {t('restoreWizard.selectADevice')}
              </option>
              {groups.map((group) => (
                <option key={group.key} value={group.key}>
                  {t('restoreWizard.deviceOption', { device: deviceLabel(group), count: group.snapshots.length })}
                </option>
              ))}
            </select>
          </div>
          {!activeGroup ? (
            <div
              data-testid="restore-device-required"
              className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
            >
              {t('restoreWizard.chooseTheDeviceToRestore')}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-3">
              {activeGroup.snapshots.map((snapshot) => (
                <button
                  type="button"
                  key={snapshot.id}
                  onClick={() => onSnapshotChange(snapshot.id)}
                  className={cn(
                    'rounded-lg border p-4 text-left',
                    snapshotId === snapshot.id
                      ? 'border-primary bg-primary/5'
                      : 'border-muted bg-muted/20'
                  )}
                >
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {typeof snapshot.sizeBytes === 'number'
                        ? formatBytes(snapshot.sizeBytes)
                        : snapshot.size ?? '--'}
                    </span>
                    {snapshot.createdAt ? <span>{formatDateTime(snapshot.createdAt)}</span> : null}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    {snapshot.label}
                    <SnapshotIntegrityBadge status={snapshot.integrityStatus} />
                    {secondFactorMissing && isUnverifiedSnapshotStatus(snapshot.integrityStatus) ? (
                      <span data-testid="snapshot-second-factor-hint" className="text-xs font-medium text-amber-700 dark:text-amber-400">
                        {t('restoreWizard.snapshotNeedsSecondFactor')}
                      </span>
                    ) : null}
                  </div>
                  {snapshot.deviceName ? (
                    <div className="mt-1 text-xs text-muted-foreground">{snapshot.deviceName}</div>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

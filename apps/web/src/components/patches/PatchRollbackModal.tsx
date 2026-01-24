import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  Clock,
  Loader2,
  Search,
  X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type RollbackReason =
  | 'system_instability'
  | 'app_compatibility'
  | 'performance'
  | 'security'
  | 'other';

type ScheduleType = 'now' | 'scheduled';

type PatchRollbackModalProps = {
  isOpen: boolean;
  onClose: () => void;
  patch: {
    id: string;
    name: string;
    version: string;
    installedAt: string;
    deviceCount: number;
  };
  onRollback: (data: {
    reason: string;
    scheduleType: 'now' | 'scheduled';
    scheduledTime?: string;
    deviceIds?: string[];
  }) => Promise<void>;
  devices?: { id: string; hostname: string; status: 'online' | 'offline' }[];
};

const reasonOptions: { value: RollbackReason; label: string }[] = [
  { value: 'system_instability', label: 'Caused system instability' },
  { value: 'app_compatibility', label: 'Application compatibility issue' },
  { value: 'performance', label: 'Performance degradation' },
  { value: 'security', label: 'Security concern' },
  { value: 'other', label: 'Other' }
];

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Fixed reference date for SSR hydration consistency
const REFERENCE_DATE = new Date('2024-01-15T12:00:00.000Z');

function getMinDateTime(): string {
  const date = new Date(REFERENCE_DATE);
  date.setMinutes(date.getMinutes() + 5);
  return date.toISOString().slice(0, 16);
}

export default function PatchRollbackModal({
  isOpen,
  onClose,
  patch,
  onRollback,
  devices = []
}: PatchRollbackModalProps) {
  const [reason, setReason] = useState<RollbackReason>('system_instability');
  const [additionalDetails, setAdditionalDetails] = useState('');
  const [scheduleType, setScheduleType] = useState<ScheduleType>('now');
  const [scheduledTime, setScheduledTime] = useState('');
  const [selectAllDevices, setSelectAllDevices] = useState(true);
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<Set<string>>(new Set());
  const [deviceSearchQuery, setDeviceSearchQuery] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setReason('system_instability');
      setAdditionalDetails('');
      setScheduleType('now');
      setScheduledTime('');
      setSelectAllDevices(true);
      setSelectedDeviceIds(new Set());
      setDeviceSearchQuery('');
      setConfirmed(false);
      setIsSubmitting(false);
    }
  }, [isOpen, patch?.id]);

  const filteredDevices = useMemo(() => {
    if (!deviceSearchQuery.trim()) return devices;
    const query = deviceSearchQuery.toLowerCase();
    return devices.filter(device =>
      device.hostname.toLowerCase().includes(query)
    );
  }, [devices, deviceSearchQuery]);

  const selectedCount = useMemo(() => {
    return selectAllDevices ? patch.deviceCount : selectedDeviceIds.size;
  }, [selectAllDevices, selectedDeviceIds.size, patch.deviceCount]);

  const canSubmit = useMemo(() => {
    const hasReason = reason !== 'other' || additionalDetails.trim().length > 0;
    const hasValidSchedule = scheduleType === 'now' || scheduledTime.length > 0;
    const hasDevices = selectAllDevices || selectedDeviceIds.size > 0;
    return hasReason && hasValidSchedule && hasDevices && confirmed;
  }, [reason, additionalDetails, scheduleType, scheduledTime, selectAllDevices, selectedDeviceIds.size, confirmed]);

  const handleDeviceToggle = (deviceId: string, checked: boolean) => {
    const newSet = new Set(selectedDeviceIds);
    if (checked) {
      newSet.add(deviceId);
    } else {
      newSet.delete(deviceId);
    }
    setSelectedDeviceIds(newSet);
  };

  const handleSelectAllFiltered = (checked: boolean) => {
    if (checked) {
      const newSet = new Set(selectedDeviceIds);
      filteredDevices.forEach(device => newSet.add(device.id));
      setSelectedDeviceIds(newSet);
    } else {
      const newSet = new Set(selectedDeviceIds);
      filteredDevices.forEach(device => newSet.delete(device.id));
      setSelectedDeviceIds(newSet);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) return;

    setIsSubmitting(true);

    const reasonLabel = reasonOptions.find(r => r.value === reason)?.label ?? reason;
    const fullReason = additionalDetails.trim()
      ? `${reasonLabel}: ${additionalDetails.trim()}`
      : reasonLabel;

    const rollbackData = {
      reason: fullReason,
      scheduleType,
      scheduledTime: scheduleType === 'scheduled' ? scheduledTime : undefined,
      deviceIds: selectAllDevices ? undefined : Array.from(selectedDeviceIds)
    };

    try {
      const response = await fetchWithAuth(`/patches/${patch.id}/rollback`, {
        method: 'POST',
        body: JSON.stringify(rollbackData)
      });

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to initiate rollback');
      }

      await onRollback(rollbackData);
      onClose();
    } catch {
      // Error handling is delegated to the parent
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  const allFilteredSelected = filteredDevices.length > 0 && filteredDevices.every(d => selectedDeviceIds.has(d.id));
  const someFilteredSelected = filteredDevices.some(d => selectedDeviceIds.has(d.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border bg-card shadow-lg">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/20">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Rollback Patch</h2>
              <div className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">{patch.name}</span>
                  <span className="mx-1.5">-</span>
                  <span>v{patch.version}</span>
                </p>
                <p>
                  Installed: {formatDate(patch.installedAt)}
                  <span className="mx-1.5">|</span>
                  {patch.deviceCount} device{patch.deviceCount !== 1 ? 's' : ''} affected
                </p>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <fieldset disabled={isSubmitting} className="space-y-6">
            {/* Rollback Reason */}
            <div>
              <label className="text-sm font-medium">
                Reason for rollback <span className="text-red-500">*</span>
              </label>
              <div className="mt-3 space-y-2">
                {reasonOptions.map(option => (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition',
                      reason === option.value
                        ? 'border-amber-500/40 bg-amber-500/10'
                        : 'border-muted hover:border-muted-foreground/40'
                    )}
                  >
                    <input
                      type="radio"
                      name="reason"
                      value={option.value}
                      checked={reason === option.value}
                      onChange={() => setReason(option.value)}
                      className="h-4 w-4 text-amber-600 focus:ring-amber-500"
                    />
                    <span className="text-sm">{option.label}</span>
                  </label>
                ))}
              </div>
              <div className="mt-3">
                <label className="text-sm font-medium text-muted-foreground">
                  Additional details {reason === 'other' && <span className="text-red-500">*</span>}
                </label>
                <textarea
                  value={additionalDetails}
                  onChange={e => setAdditionalDetails(e.target.value)}
                  placeholder="Provide more context about why this rollback is needed..."
                  className="mt-2 h-20 w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>

            {/* Schedule Options */}
            <div>
              <label className="text-sm font-medium">Schedule</label>
              <div className="mt-3 space-y-2">
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition',
                    scheduleType === 'now'
                      ? 'border-amber-500/40 bg-amber-500/10'
                      : 'border-muted hover:border-muted-foreground/40'
                  )}
                >
                  <input
                    type="radio"
                    name="schedule"
                    value="now"
                    checked={scheduleType === 'now'}
                    onChange={() => setScheduleType('now')}
                    className="h-4 w-4 text-amber-600 focus:ring-amber-500"
                  />
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">Roll back now</span>
                </label>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition',
                    scheduleType === 'scheduled'
                      ? 'border-amber-500/40 bg-amber-500/10'
                      : 'border-muted hover:border-muted-foreground/40'
                  )}
                >
                  <input
                    type="radio"
                    name="schedule"
                    value="scheduled"
                    checked={scheduleType === 'scheduled'}
                    onChange={() => setScheduleType('scheduled')}
                    className="h-4 w-4 text-amber-600 focus:ring-amber-500"
                  />
                  <Calendar className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">Schedule rollback</span>
                </label>
              </div>
              {scheduleType === 'scheduled' && (
                <div className="mt-3">
                  <input
                    type="datetime-local"
                    value={scheduledTime}
                    onChange={e => setScheduledTime(e.target.value)}
                    min={getMinDateTime()}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-64"
                  />
                </div>
              )}
              <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  Rolling back this patch may cause temporary downtime and could require devices to restart.
                  Ensure affected users are notified before proceeding.
                </p>
              </div>
            </div>

            {/* Device Selection */}
            <div>
              <label className="text-sm font-medium">Device Selection</label>
              <div className="mt-3 space-y-2">
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition',
                    selectAllDevices
                      ? 'border-amber-500/40 bg-amber-500/10'
                      : 'border-muted hover:border-muted-foreground/40'
                  )}
                >
                  <input
                    type="radio"
                    name="deviceSelection"
                    checked={selectAllDevices}
                    onChange={() => setSelectAllDevices(true)}
                    className="h-4 w-4 text-amber-600 focus:ring-amber-500"
                  />
                  <span className="text-sm">
                    Roll back on all devices ({patch.deviceCount})
                  </span>
                </label>
                <label
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 transition',
                    !selectAllDevices
                      ? 'border-amber-500/40 bg-amber-500/10'
                      : 'border-muted hover:border-muted-foreground/40'
                  )}
                >
                  <input
                    type="radio"
                    name="deviceSelection"
                    checked={!selectAllDevices}
                    onChange={() => setSelectAllDevices(false)}
                    className="h-4 w-4 text-amber-600 focus:ring-amber-500"
                  />
                  <span className="text-sm">Select specific devices</span>
                </label>
              </div>

              {!selectAllDevices && devices.length > 0 && (
                <div className="mt-3 rounded-md border">
                  <div className="border-b px-3 py-2">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type="search"
                        placeholder="Search devices..."
                        value={deviceSearchQuery}
                        onChange={e => setDeviceSearchQuery(e.target.value)}
                        className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {filteredDevices.length > 0 && (
                      <label className="flex cursor-pointer items-center gap-3 border-b bg-muted/40 px-4 py-2">
                        <input
                          type="checkbox"
                          checked={allFilteredSelected}
                          ref={el => {
                            if (el) el.indeterminate = someFilteredSelected && !allFilteredSelected;
                          }}
                          onChange={e => handleSelectAllFiltered(e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        <span className="text-xs font-medium text-muted-foreground">
                          Select all ({filteredDevices.length})
                        </span>
                      </label>
                    )}
                    {filteredDevices.length === 0 ? (
                      <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                        No devices found
                      </div>
                    ) : (
                      filteredDevices.map(device => (
                        <label
                          key={device.id}
                          className="flex cursor-pointer items-center gap-3 border-b px-4 py-2 last:border-b-0 hover:bg-muted/40"
                        >
                          <input
                            type="checkbox"
                            checked={selectedDeviceIds.has(device.id)}
                            onChange={e => handleDeviceToggle(device.id, e.target.checked)}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          <span className="flex-1 text-sm">{device.hostname}</span>
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                              device.status === 'online'
                                ? 'border-green-500/40 bg-green-500/20 text-green-700'
                                : 'border-red-500/40 bg-red-500/20 text-red-700'
                            )}
                          >
                            {device.status === 'online' ? 'Online' : 'Offline'}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                  <div className="border-t bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                    {selectedDeviceIds.size} device{selectedDeviceIds.size !== 1 ? 's' : ''} selected
                  </div>
                </div>
              )}

              {!selectAllDevices && devices.length === 0 && (
                <div className="mt-3 rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  No devices available for selection
                </div>
              )}
            </div>

            {/* Confirmation */}
            <div className="rounded-md border bg-muted/40 p-4">
              <h3 className="text-sm font-medium">Summary</h3>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                <li>
                  Patch: <span className="font-medium text-foreground">{patch.name} v{patch.version}</span>
                </li>
                <li>
                  Timing:{' '}
                  <span className="font-medium text-foreground">
                    {scheduleType === 'now' ? 'Immediately' : `Scheduled for ${scheduledTime || '(not set)'}`}
                  </span>
                </li>
                <li>
                  Devices:{' '}
                  <span className="font-medium text-foreground">
                    {selectAllDevices ? `All ${patch.deviceCount} devices` : `${selectedDeviceIds.size} selected`}
                  </span>
                </li>
              </ul>
              <label className="mt-4 flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={e => setConfirmed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300"
                />
                <span className="text-sm">
                  I understand this will uninstall the patch and may require a restart on affected devices
                </span>
              </label>
            </div>
          </fieldset>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || isSubmitting}
            className={cn(
              'inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium transition disabled:opacity-50',
              'bg-amber-600 text-white hover:bg-amber-700'
            )}
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {scheduleType === 'now' ? 'Start Rollback' : 'Schedule Rollback'}
          </button>
        </div>
      </div>
    </div>
  );
}

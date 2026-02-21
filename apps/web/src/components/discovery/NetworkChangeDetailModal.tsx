import { useEffect, useMemo, useState } from 'react';
import { eventTypeConfig, formatDateTime, type DeviceOption, type NetworkChangeEvent } from './networkTypes';

type NetworkChangeDetailModalProps = {
  open: boolean;
  event: NetworkChangeEvent | null;
  timezone?: string;
  devices: DeviceOption[];
  canAcknowledge: boolean;
  canLinkDevice: boolean;
  onClose: () => void;
  onAcknowledge: (eventId: string, notes?: string) => Promise<void>;
  onLinkDevice: (eventId: string, deviceId: string) => Promise<void>;
};

function prettyState(state: Record<string, unknown> | null): string {
  if (!state) return 'None';
  return JSON.stringify(state, null, 2);
}

export default function NetworkChangeDetailModal({
  open,
  event,
  timezone,
  devices,
  canAcknowledge,
  canLinkDevice,
  onClose,
  onAcknowledge,
  onLinkDevice
}: NetworkChangeDetailModalProps) {
  const [ackNotes, setAckNotes] = useState('');
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [working, setWorking] = useState<'ack' | 'link' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!event) return;
    setAckNotes('');
    setSelectedDeviceId(event.linkedDeviceId ?? '');
    setWorking(null);
    setError(null);
  }, [event]);

  const selectedDeviceLabel = useMemo(() => {
    if (!event?.linkedDeviceId) return null;
    return devices.find((device) => device.id === event.linkedDeviceId)?.label ?? event.linkedDeviceId;
  }, [devices, event?.linkedDeviceId]);

  if (!open || !event) return null;

  const typeInfo = eventTypeConfig[event.eventType];
  const canAcknowledgeThisEvent = canAcknowledge && !event.acknowledged;

  const handleAcknowledge = async () => {
    setWorking('ack');
    setError(null);
    try {
      const trimmedNotes = ackNotes.trim();
      await onAcknowledge(event.id, trimmedNotes.length > 0 ? trimmedNotes : undefined);
      setAckNotes('');
    } catch (ackError) {
      setError(ackError instanceof Error ? ackError.message : 'Failed to acknowledge event');
    } finally {
      setWorking(null);
    }
  };

  const handleLink = async () => {
    if (!selectedDeviceId) {
      setError('Select a device before linking.');
      return;
    }

    setWorking('link');
    setError(null);
    try {
      await onLinkDevice(event.id, selectedDeviceId);
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : 'Failed to link device');
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-4xl rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{event.hostname || event.ipAddress}</h2>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeInfo.color}`}>
                {typeInfo.label}
              </span>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                  event.acknowledged
                    ? 'bg-green-500/20 text-green-700 border-green-500/40'
                    : 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
                }`}
              >
                {event.acknowledged ? 'Acknowledged' : 'Unacknowledged'}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              IP {event.ipAddress} • MAC {event.macAddress ?? 'unknown'} • Detected {formatDateTime(event.detectedAt, timezone)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Close
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Event Details</h3>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Subnet</dt>
                  <dd className="font-medium">{event.baselineSubnet ?? 'Unknown'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Asset Type</dt>
                  <dd className="font-medium">{event.assetType ?? 'unknown'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Linked Device</dt>
                  <dd className="font-medium">{selectedDeviceLabel ?? 'Not linked'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Alert ID</dt>
                  <dd className="font-mono text-xs">{event.alertId ?? 'None'}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Acknowledged At</dt>
                  <dd className="font-medium">{formatDateTime(event.acknowledgedAt, timezone)}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Notes</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm">
                {event.notes?.trim().length ? event.notes : 'No notes recorded.'}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Previous State</h3>
              <pre className="mt-3 max-h-48 overflow-auto rounded bg-background p-3 text-xs">
                {prettyState(event.previousState)}
              </pre>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">Current State</h3>
              <pre className="mt-3 max-h-48 overflow-auto rounded bg-background p-3 text-xs">
                {prettyState(event.currentState)}
              </pre>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold">Acknowledge Event</h3>
            {!canAcknowledge && (
              <p className="mt-2 text-xs text-muted-foreground">
                Hidden after permission check failure. Requires `alerts:acknowledge`.
              </p>
            )}
            {canAcknowledge && event.acknowledged && (
              <p className="mt-2 text-xs text-muted-foreground">This event is already acknowledged.</p>
            )}
            {canAcknowledgeThisEvent && (
              <>
                <textarea
                  value={ackNotes}
                  onChange={(update) => setAckNotes(update.target.value)}
                  placeholder="Optional acknowledgement notes"
                  rows={3}
                  className="mt-3 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={handleAcknowledge}
                  disabled={working !== null}
                  className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {working === 'ack' ? 'Acknowledging...' : 'Acknowledge'}
                </button>
              </>
            )}
          </div>

          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold">Link Managed Device</h3>
            {!canLinkDevice && (
              <p className="mt-2 text-xs text-muted-foreground">
                Hidden after permission check failure. Requires `devices:write`.
              </p>
            )}
            {canLinkDevice && (
              <>
                <select
                  value={selectedDeviceId}
                  onChange={(update) => setSelectedDeviceId(update.target.value)}
                  className="mt-3 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">Select device</option>
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleLink}
                  disabled={working !== null || devices.length === 0}
                  className="mt-3 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {working === 'link' ? 'Linking...' : 'Link Device'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


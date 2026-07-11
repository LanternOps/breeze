import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { eventTypeConfig, formatDateTime, type DeviceOption, type NetworkChangeEvent } from './networkTypes';
import { Dialog } from '../shared/Dialog';

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

function prettyState(state: Record<string, unknown> | null, noneLabel: string): string {
  if (!state) return noneLabel;
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
  const { t } = useTranslation('discovery');
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

  if (!event) return null;

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
      setError(ackError instanceof Error ? ackError.message : t('networkChangeDetailModal.errors.acknowledge'));
    } finally {
      setWorking(null);
    }
  };

  const handleLink = async () => {
    if (!selectedDeviceId) {
      setError(t('networkChangeDetailModal.errors.selectDeviceBeforeLinking'));
      return;
    }

    setWorking('link');
    setError(null);
    try {
      await onLinkDevice(event.id, selectedDeviceId);
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : t('networkChangeDetailModal.errors.linkDevice'));
    } finally {
      setWorking(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={event.hostname || event.ipAddress} maxWidth="4xl" className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{event.hostname || event.ipAddress}</h2>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${typeInfo.color}`}>
                {t(`networkEvents.type.${event.eventType}`)}
              </span>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                  event.acknowledged
                    ? 'bg-success/15 text-success border-success/30'
                    : 'bg-warning/15 text-warning border-warning/30'
                }`}
              >
                {event.acknowledged ? t('networkChangeDetailModal.status.acknowledged') : t('networkChangeDetailModal.status.unacknowledged')}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('networkChangeDetailModal.summary', {
                ip: event.ipAddress,
                mac: event.macAddress ?? t('common:states.unknown'),
                detected: formatDateTime(event.detectedAt, timezone)
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {t('common:actions.close')}
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
              <h3 className="text-sm font-semibold">{t('networkChangeDetailModal.eventDetailsTitle')}</h3>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{t('networkChangeDetailModal.fields.subnet')}</dt>
                  <dd className="font-medium">{event.baselineSubnet ?? t('common:states.unknown')}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{t('networkChangeDetailModal.fields.assetType')}</dt>
                  <dd className="font-medium">{event.assetType ?? t('common:states.unknown')}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{t('networkChangeDetailModal.fields.linkedDevice')}</dt>
                  <dd className="font-medium">{selectedDeviceLabel ?? t('networkChangeDetailModal.notLinked')}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{t('networkChangeDetailModal.fields.alertId')}</dt>
                  <dd className="font-mono text-xs">{event.alertId ?? t('common:labels.none')}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">{t('networkChangeDetailModal.fields.acknowledgedAt')}</dt>
                  <dd className="font-medium">{formatDateTime(event.acknowledgedAt, timezone)}</dd>
                </div>
              </dl>
            </div>

            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('networkChangeDetailModal.notesTitle')}</h3>
              <p className="mt-2 whitespace-pre-wrap text-sm">
                {event.notes?.trim().length ? event.notes : t('networkChangeDetailModal.noNotes')}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('networkChangeDetailModal.previousState')}</h3>
              <pre className="mt-3 max-h-48 overflow-auto rounded bg-background p-3 text-xs">
                {prettyState(event.previousState, t('common:labels.none'))}
              </pre>
            </div>
            <div className="rounded-md border bg-muted/30 p-4">
              <h3 className="text-sm font-semibold">{t('networkChangeDetailModal.currentState')}</h3>
              <pre className="mt-3 max-h-48 overflow-auto rounded bg-background p-3 text-xs">
                {prettyState(event.currentState, t('common:labels.none'))}
              </pre>
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold">{t('networkChangeDetailModal.acknowledgeTitle')}</h3>
            {!canAcknowledge && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('networkChangeDetailModal.permissionAcknowledge')}
              </p>
            )}
            {canAcknowledge && event.acknowledged && (
              <p className="mt-2 text-xs text-muted-foreground">{t('networkChangeDetailModal.alreadyAcknowledged')}</p>
            )}
            {canAcknowledgeThisEvent && (
              <>
                <textarea
                  value={ackNotes}
                  onChange={(update) => setAckNotes(update.target.value)}
                  placeholder={t('networkChangeDetailModal.placeholders.ackNotes')}
                  rows={3}
                  className="mt-3 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={handleAcknowledge}
                  disabled={working !== null}
                  className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {working === 'ack' ? t('networkChangeDetailModal.actions.acknowledging') : t('networkChangeDetailModal.actions.acknowledge')}
                </button>
              </>
            )}
          </div>

          <div className="rounded-md border p-4">
            <h3 className="text-sm font-semibold">{t('networkChangeDetailModal.linkManagedDeviceTitle')}</h3>
            {!canLinkDevice && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('networkChangeDetailModal.permissionLinkDevice')}
              </p>
            )}
            {canLinkDevice && (
              <>
                <select
                  value={selectedDeviceId}
                  onChange={(update) => setSelectedDeviceId(update.target.value)}
                  className="mt-3 h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="">{t('networkChangeDetailModal.options.selectDevice')}</option>
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
                  {working === 'link' ? t('networkChangeDetailModal.actions.linking') : t('networkChangeDetailModal.actions.linkDevice')}
                </button>
              </>
            )}
          </div>
        </div>
    </Dialog>
  );
}

import { useEffect, useState } from 'react';
import { Loader2, Monitor, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

import { Dialog } from '../shared/Dialog';
import { fetchLiveSessions, type LiveSession } from '../../services/deviceActions';

type Props = {
  isOpen: boolean;
  deviceId: string;
  /**
   * 'desktop' → shadowing a live session; disconnected sessions have no active
   * desktop to capture, so they render disabled. 'script' → all sessions are
   * selectable (a script can run in a disconnected session's context).
   */
  purpose: 'desktop' | 'script';
  onSelect: (sessionId: number) => void;
  onClose: () => void;
};

export default function SessionPickerModal({ isOpen, deviceId, purpose, onSelect, onClose }: Props) {
  const { t } = useTranslation('devices');
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    fetchLiveSessions(deviceId)
      .then((result) => {
        if (!cancelled) setSessions(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('sessionPicker.fetchFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, deviceId, t]);

  const title = purpose === 'desktop' ? t('sessionPicker.titleDesktop') : t('sessionPicker.titleScript');

  const idleLabel = (s: LiveSession) =>
    s.idleMinutes == null ? '' : ` · ${t('sessionPicker.idleMinutes', { count: s.idleMinutes })}`;

  return (
    <Dialog open={isOpen} onClose={onClose} title={title} maxWidth="md" className="flex max-h-[80vh] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4" data-testid="session-picker-modal">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div
            data-testid="session-picker-error"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {error}
          </div>
        ) : sessions.length === 0 ? (
          <div data-testid="session-picker-empty" className="py-12 text-center text-sm text-muted-foreground">
            {t('sessionPicker.noSessions')}
          </div>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => {
              const disabled = purpose === 'desktop' && s.state === 'disconnected';
              return (
                <li key={s.sessionId}>
                  <button
                    type="button"
                    data-testid={`session-picker-row-${s.sessionId}`}
                    disabled={disabled}
                    title={disabled ? t('sessionPicker.disconnectedNotShadowable') : undefined}
                    onClick={() => {
                      if (disabled) return;
                      onSelect(s.sessionId);
                      onClose();
                    }}
                    className="flex w-full items-start gap-3 rounded-lg border p-4 text-left transition hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{s.username}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('sessionPicker.sessionLabel', { id: s.sessionId })} · {s.state}
                        {s.type === 'rdp' ? ' · RDP' : ''}
                        {idleLabel(s)}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end border-t px-6 py-4">
        <button
          type="button"
          onClick={onClose}
          className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          {t('sessionPicker.cancel')}
        </button>
      </div>
    </Dialog>
  );
}

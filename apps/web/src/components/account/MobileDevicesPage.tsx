import { useCallback, useEffect, useMemo, useState } from 'react';
import { Smartphone, Loader2, ShieldAlert, AlertTriangle, X, ArrowLeft } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import AccountSubNav from './AccountSubNav';
import { formatAbsolute, formatRelative } from './relativeTime';

interface MobileDevice {
  id: string;
  deviceId: string;
  platform: string | null;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  lastActiveAt: string | null;
  status: 'active' | 'blocked';
  blockedAt: string | null;
  blockedReason: string | null;
  createdAt: string;
  isCurrent: boolean;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; devices: MobileDevice[] };

interface ConfirmState {
  device: MobileDevice;
  reason: string;
  isOnly: boolean;
}

function platformLabel(p: string | null): string {
  if (!p) return 'Unknown device';
  if (p.toLowerCase() === 'ios') return 'iOS';
  if (p.toLowerCase() === 'android') return 'Android';
  return p;
}

function deviceTitle(d: MobileDevice): string {
  if (d.model && d.model.trim().length > 0) return d.model;
  return platformLabel(d.platform);
}

export default function MobileDevicesPage() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetchWithAuth('/me/mobile-devices');
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'error', message: body.error ?? `Request failed (${res.status})` });
        return;
      }
      const body = (await res.json()) as { devices: MobileDevice[] };
      setState({ kind: 'ready', devices: body.devices ?? [] });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeDevices = useMemo(
    () => (state.kind === 'ready' ? state.devices.filter((d) => d.status === 'active') : []),
    [state]
  );

  const handleRevokeClick = (device: MobileDevice) => {
    if (device.status !== 'active') return;
    setConfirm({
      device,
      reason: '',
      isOnly: activeDevices.length <= 1,
    });
  };

  const handleConfirm = async () => {
    if (!confirm) return;
    setRevoking(true);
    try {
      const res = await fetchWithAuth(`/me/mobile-devices/${encodeURIComponent(confirm.device.id)}/block`, {
        method: 'POST',
        body: JSON.stringify({ reason: confirm.reason.trim().length > 0 ? confirm.reason.trim() : undefined }),
      });
      if (res.status !== 204 && !res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        const msg = body.error ?? `Revoke failed (${res.status})`;
        showToast({ type: 'error', message: msg });
        return;
      }
      showToast({ type: 'success', message: 'Device revoked.' });
      setConfirm(null);
      await load();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Network error during revoke' });
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <a
          href="/"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </a>
        <h1 className="text-2xl font-semibold tracking-tight">Trusted devices</h1>
        <p className="text-sm text-muted-foreground">
          Phones and tablets you've paired with the Breeze mobile app. These devices can approve
          high-risk MCP requests on your behalf. Revoke any device you no longer use.
        </p>
      </header>

      <AccountSubNav current="devices" />

      {state.kind === 'loading' && (
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
        </div>
      )}

      {state.kind === 'error' && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
          <div className="flex-1 space-y-2">
            <p>{state.message}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium hover:bg-destructive/5"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {state.kind === 'ready' && state.devices.length === 0 && (
        <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center">
          <Smartphone className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
          <h2 className="mt-4 text-base font-semibold">No paired devices</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Install the Breeze mobile app and sign in to pair a device. Approvals will then surface
            on your phone.
          </p>
        </div>
      )}

      {state.kind === 'ready' && state.devices.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card">
          <ul className="divide-y">
            {state.devices.map((device) => {
              const isActive = device.status === 'active';
              return (
                <li key={device.id} className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Smartphone className="h-4 w-4 text-muted-foreground" aria-hidden />
                        <span className="font-medium">{deviceTitle(device)}</span>
                        {device.isCurrent && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                            This device
                          </span>
                        )}
                        {isActive ? (
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                            Active
                          </span>
                        ) : (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            Blocked
                          </span>
                        )}
                      </div>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <dt>Platform</dt>
                        <dd>
                          {platformLabel(device.platform)}
                          {device.osVersion ? ` ${device.osVersion}` : ''}
                          {device.appVersion ? ` · app ${device.appVersion}` : ''}
                        </dd>
                        <dt>Last active</dt>
                        <dd title={formatAbsolute(device.lastActiveAt)}>
                          {formatRelative(device.lastActiveAt)}
                        </dd>
                        {!isActive && (
                          <>
                            <dt>Blocked</dt>
                            <dd title={formatAbsolute(device.blockedAt)}>
                              {formatRelative(device.blockedAt)}
                              {device.blockedReason ? ` · ${device.blockedReason}` : ''}
                            </dd>
                          </>
                        )}
                      </dl>
                    </div>
                    {isActive && (
                      <button
                        type="button"
                        onClick={() => handleRevokeClick(device)}
                        disabled={device.isCurrent}
                        title={device.isCurrent ? 'Revoke from another device' : undefined}
                        className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {confirm && (
        <RevokeConfirmDialog
          state={confirm}
          revoking={revoking}
          onChange={(reason) => setConfirm({ ...confirm, reason })}
          onCancel={() => (revoking ? null : setConfirm(null))}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}

function RevokeConfirmDialog({
  state,
  revoking,
  onChange,
  onCancel,
  onConfirm,
}: {
  state: ConfirmState;
  revoking: boolean;
  onChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">Revoke {deviceTitle(state.device)}?</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={revoking}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          <p className="text-muted-foreground">
            The device's push tokens are wiped immediately and any in-flight approvals will fail. To
            use the app again you'll need to re-pair from a sign-in.
          </p>
          {state.isOnly && (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
              <p>
                <strong>This is your only trusted device.</strong> Until you re-pair from a new
                sign-in, you won't be able to approve anything from your phone.
              </p>
            </div>
          )}
          <label htmlFor="revoke-reason" className="block text-sm font-medium">
            Reason (optional)
          </label>
          <textarea
            id="revoke-reason"
            rows={2}
            value={state.reason}
            onChange={(e) => onChange(e.target.value)}
            maxLength={500}
            placeholder="Lost phone, replaced device, …"
            className="w-full rounded-md border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={revoking}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={revoking}
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {revoking ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Revoking…
              </>
            ) : (
              'Revoke device'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

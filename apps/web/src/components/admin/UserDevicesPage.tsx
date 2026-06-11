import { useCallback, useEffect, useState } from 'react';
import { Smartphone, Loader2, AlertTriangle, X, ArrowLeft } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { formatAbsolute, formatRelative } from '../account/relativeTime';

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
}

interface TargetUser {
  id: string;
  name: string;
  email: string;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; user: TargetUser; devices: MobileDevice[] };

interface ConfirmState {
  device: MobileDevice;
  reason: string;
}

interface UserDevicesPageProps {
  userId: string;
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

export default function UserDevicesPage({ userId }: UserDevicesPageProps) {
  const currentUser = useAuthStore((s) => s.user);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!userId) {
      setState({ kind: 'error', message: 'Missing user id' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const [devicesRes, userRes] = await Promise.all([
        fetchWithAuth(`/admin/users/${encodeURIComponent(userId)}/mobile-devices`),
        fetchWithAuth(`/users/${encodeURIComponent(userId)}`),
      ]);

      if (devicesRes.status === 403) {
        setState({ kind: 'unauthorized' });
        return;
      }

      if (!devicesRes.ok) {
        const body = (await devicesRes.json().catch(() => ({}))) as { error?: string };
        setState({ kind: 'error', message: body.error ?? `Request failed (${devicesRes.status})` });
        return;
      }

      const devicesBody = (await devicesRes.json()) as { devices: MobileDevice[] };

      let user: TargetUser = { id: userId, name: '', email: '' };
      if (userRes.ok) {
        const u = (await userRes.json()) as { id?: string; name?: string; email?: string };
        user = {
          id: u.id ?? userId,
          name: u.name ?? '',
          email: u.email ?? '',
        };
      }

      setState({ kind: 'ready', user, devices: devicesBody.devices ?? [] });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleBlockClick = (device: MobileDevice) => {
    if (device.status !== 'active') return;
    setConfirm({ device, reason: '' });
  };

  const handleConfirm = async () => {
    if (!confirm) return;
    if (confirm.reason.trim().length === 0) {
      showToast({ type: 'error', message: 'Reason is required.' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetchWithAuth(
        `/admin/users/${encodeURIComponent(userId)}/mobile-devices/${encodeURIComponent(confirm.device.id)}/block`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: confirm.reason.trim() }),
        }
      );
      if (res.status !== 204 && !res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        showToast({ type: 'error', message: body.error ?? `Block failed (${res.status})` });
        return;
      }
      const targetName =
        state.kind === 'ready' ? state.user.name || state.user.email || 'this user' : 'this user';
      showToast({
        type: 'success',
        message: `Device blocked. ${targetName} can no longer approve from this device until they re-pair.`,
      });
      setConfirm(null);
      await load();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setSubmitting(false);
    }
  };

  if (state.kind === 'loading') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
      </div>
    );
  }

  if (state.kind === 'unauthorized') {
    return (
      <div className="mx-auto max-w-2xl space-y-3 py-8">
        <h1 className="text-xl font-semibold">Not allowed</h1>
        <p className="text-sm text-muted-foreground">
          You don't have permission to manage this user. Make sure you're signed in as an org or
          partner admin and that this user is in your tenant.
        </p>
        <a
          href="/settings/users"
          className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> Back to users
        </a>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        role="alert"
        className="mx-auto max-w-2xl rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <p>{state.message}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium hover:bg-destructive/5"
        >
          Try again
        </button>
      </div>
    );
  }

  const { user, devices } = state;
  const isSelf = currentUser?.id === user.id;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 py-6">
      <header className="space-y-3">
        <a
          href="/settings/users"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" /> Back to users
        </a>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Trusted devices</h1>
          <p className="text-sm text-muted-foreground">
            Mobile devices paired by{' '}
            <span className="font-medium text-foreground">{user.name || user.email || user.id}</span>
            {user.email && user.name ? <> ({user.email})</> : null}. Blocking a device clears its
            push tokens and forces a re-pair.
          </p>
        </div>
      </header>

      {isSelf && (
        <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
          <p>
            This is <strong>your own</strong> account. Use{' '}
            <a className="underline" href="/account/devices">
              /account/devices
            </a>{' '}
            to manage your own devices — admin block can't target self.
          </p>
        </div>
      )}

      {devices.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center">
          <Smartphone className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
          <p className="mt-4 text-sm text-muted-foreground">This user has no paired devices.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <ul className="divide-y">
            {devices.map((device) => {
              const isActive = device.status === 'active';
              return (
                <li key={device.id} className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Smartphone className="h-4 w-4 text-muted-foreground" aria-hidden />
                        <span className="font-medium">{deviceTitle(device)}</span>
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
                        <dt>Paired</dt>
                        <dd title={formatAbsolute(device.createdAt)}>
                          {formatRelative(device.createdAt)}
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
                        <dt>Install ID</dt>
                        <dd className="font-mono">{device.deviceId}</dd>
                      </dl>
                    </div>
                    {isActive && !isSelf && (
                      <button
                        type="button"
                        onClick={() => handleBlockClick(device)}
                        className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10"
                      >
                        Block this device
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        <a className="underline" href="/audit">
          See related audit events
        </a>{' '}
        for a full history of approvals, sign-ins, and blocks.
      </p>

      {confirm && (
        <BlockDialog
          state={confirm}
          submitting={submitting}
          targetLabel={user.name || user.email || user.id}
          onChange={(reason) => setConfirm({ ...confirm, reason })}
          onCancel={() => (submitting ? null : setConfirm(null))}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}

function BlockDialog({
  state,
  submitting,
  targetLabel,
  onChange,
  onCancel,
  onConfirm,
}: {
  state: ConfirmState;
  submitting: boolean;
  targetLabel: string;
  onChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const reasonValid = state.reason.trim().length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">Block device</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          <p className="text-muted-foreground">
            This will block <span className="font-medium text-foreground">{deviceTitle(state.device)}</span> for{' '}
            <span className="font-medium text-foreground">{targetLabel}</span>. Push tokens are wiped
            immediately and the user will need to re-pair before approving anything from their phone.
          </p>
          <label htmlFor="admin-block-reason" className="block text-sm font-medium">
            Reason <span className="text-destructive">*</span>
          </label>
          <textarea
            id="admin-block-reason"
            rows={3}
            value={state.reason}
            onChange={(e) => onChange(e.target.value)}
            maxLength={500}
            placeholder="Lost phone, employee offboarded, suspected compromise…"
            className="w-full rounded-md border bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            required
          />
          {!reasonValid && (
            <p className="text-xs text-muted-foreground">A reason is required for the audit log.</p>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting || !reasonValid}
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Blocking…
              </>
            ) : (
              'Block device'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

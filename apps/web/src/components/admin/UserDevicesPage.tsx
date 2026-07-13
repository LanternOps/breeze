import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Smartphone, Loader2, AlertTriangle, X, ArrowLeft } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { formatAbsolute, formatRelative } from '../account/relativeTime';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

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

function platformLabel(p: string | null, unknownLabel: string): string {
  if (!p) return unknownLabel;
  if (p.toLowerCase() === 'ios') return 'iOS';
  if (p.toLowerCase() === 'android') return 'Android';
  return p;
}

function deviceTitle(d: MobileDevice, unknownLabel: string): string {
  if (d.model && d.model.trim().length > 0) return d.model;
  return platformLabel(d.platform, unknownLabel);
}

export default function UserDevicesPage({ userId }: UserDevicesPageProps) {
  const { t } = useTranslation('admin');
  const currentUser = useAuthStore((s) => s.user);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    if (!userId) {
      setState({ kind: 'error', message: t('admin.userDevicesPage.errors.missingUserId') });
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
        setState({ kind: 'error', message: body.error ?? t('admin.userDevicesPage.errors.requestFailed', { status: devicesRes.status }) });
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
      setState({ kind: 'error', message: err instanceof Error ? err.message : t('admin.userDevicesPage.errors.network') });
    }
  }, [userId, t]);

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
      showToast({ type: 'error', message: t('admin.userDevicesPage.toast.reasonRequired') });
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
        showToast({ type: 'error', message: body.error ?? t('admin.userDevicesPage.toast.blockFailed', { status: res.status }) });
        return;
      }
      const targetName =
        state.kind === 'ready' ? state.user.name || state.user.email || t('admin.userDevicesPage.thisUser') : t('admin.userDevicesPage.thisUser');
      showToast({
        type: 'success',
        message: t('admin.userDevicesPage.toast.blocked', { name: targetName }),
      });
      setConfirm(null);
      await load();
    } catch (err) {
      showToast({ type: 'error', message: err instanceof Error ? err.message : t('admin.userDevicesPage.errors.network') });
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
        <h1 className="text-xl font-semibold">{t('admin.userDevicesPage.unauthorized.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('admin.userDevicesPage.unauthorized.description')}
        </p>
        <a
          href="/settings/users"
          className="inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted"
        >
          <ArrowLeft className="mr-2 h-4 w-4" /> {t('admin.userDevicesPage.backToUsers')}
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
          {t('admin.userDevicesPage.retry')}
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
          <ArrowLeft className="h-4 w-4" /> {t('admin.userDevicesPage.backToUsers')}
        </a>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('admin.userDevicesPage.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('admin.userDevicesPage.description.prefix')}{' '}
            <span className="font-medium text-foreground">{user.name || user.email || user.id}</span>
            {user.email && user.name ? <> ({user.email})</> : null}. {t('admin.userDevicesPage.description.suffix')}
          </p>
        </div>
      </header>

      {isSelf && (
        <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
          <p>
            {t('admin.userDevicesPage.selfWarning.prefix')} <strong>{t('admin.userDevicesPage.selfWarning.own')}</strong>{' '}
            {t('admin.userDevicesPage.selfWarning.middle')}{' '}
            <a className="underline" href="/account/devices">
              /account/devices
            </a>{' '}
            {t('admin.userDevicesPage.selfWarning.suffix')}
          </p>
        </div>
      )}

      {devices.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-8 text-center">
          <Smartphone className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
          <p className="mt-4 text-sm text-muted-foreground">{t('admin.userDevicesPage.empty')}</p>
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
                        <span className="font-medium">{deviceTitle(device, t('admin.userDevicesPage.unknownDevice'))}</span>
                        {isActive ? (
                          <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                            {t('admin.userDevicesPage.status.active')}
                          </span>
                        ) : (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            {t('admin.userDevicesPage.status.blocked')}
                          </span>
                        )}
                      </div>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <dt>{t('admin.userDevicesPage.fields.platform')}</dt>
                        <dd>
                          {platformLabel(device.platform, t('admin.userDevicesPage.unknownDevice'))}
                          {device.osVersion ? ` ${device.osVersion}` : ''}
                          {device.appVersion ? ` · ${t('admin.userDevicesPage.fields.appVersion', { version: device.appVersion })}` : ''}
                        </dd>
                        <dt>{t('admin.userDevicesPage.fields.lastActive')}</dt>
                        <dd title={formatAbsolute(device.lastActiveAt)}>
                          {formatRelative(device.lastActiveAt)}
                        </dd>
                        <dt>{t('admin.userDevicesPage.fields.paired')}</dt>
                        <dd title={formatAbsolute(device.createdAt)}>
                          {formatRelative(device.createdAt)}
                        </dd>
                        {!isActive && (
                          <>
                            <dt>{t('admin.userDevicesPage.fields.blocked')}</dt>
                            <dd title={formatAbsolute(device.blockedAt)}>
                              {formatRelative(device.blockedAt)}
                              {device.blockedReason ? ` · ${device.blockedReason}` : ''}
                            </dd>
                          </>
                        )}
                        <dt>{t('admin.userDevicesPage.fields.installId')}</dt>
                        <dd className="font-mono">{device.deviceId}</dd>
                      </dl>
                    </div>
                    {isActive && !isSelf && (
                      <button
                        type="button"
                        onClick={() => handleBlockClick(device)}
                        className="inline-flex h-9 items-center justify-center rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10"
                      >
                        {t('admin.userDevicesPage.blockThisDevice')}
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
          {t('admin.userDevicesPage.auditLink')}
        </a>{' '}
        {t('admin.userDevicesPage.auditSuffix')}
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
  const { t } = useTranslation('admin');
  const reasonValid = state.reason.trim().length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold">{t('admin.userDevicesPage.blockDialog.title')}</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
            aria-label={t('admin.userDevicesPage.blockDialog.close')}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 space-y-3 text-sm">
          <p className="text-muted-foreground">
            {t('admin.userDevicesPage.blockDialog.descriptionPrefix')}{' '}
            <span className="font-medium text-foreground">{deviceTitle(state.device, t('admin.userDevicesPage.unknownDevice'))}</span>{' '}
            {t('admin.userDevicesPage.blockDialog.descriptionMiddle')}{' '}
            <span className="font-medium text-foreground">{targetLabel}</span>.{' '}
            {t('admin.userDevicesPage.blockDialog.descriptionSuffix')}
          </p>
          <label htmlFor="admin-block-reason" className="block text-sm font-medium">
            {t('admin.userDevicesPage.blockDialog.reason')} <span className="text-destructive">*</span>
          </label>
          <textarea
            id="admin-block-reason"
            rows={3}
            value={state.reason}
            onChange={(e) => onChange(e.target.value)}
            maxLength={500}
            placeholder={t('admin.userDevicesPage.blockDialog.reasonPlaceholder')}
            className="w-full rounded-md border bg-background p-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            required
          />
          {!reasonValid && (
            <p className="text-xs text-muted-foreground">{t('admin.userDevicesPage.blockDialog.reasonRequired')}</p>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('admin.userDevicesPage.blockDialog.cancel')}
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
                {t('admin.userDevicesPage.blockDialog.blocking')}
              </>
            ) : (
              t('admin.userDevicesPage.blockDialog.blockDevice')
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

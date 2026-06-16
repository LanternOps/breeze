import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, ShieldCheck, X } from 'lucide-react';
import {
  listApproverDevices,
  registerApproverDevice,
  revokeApproverDevice,
  renameApproverDevice,
  type ApproverDevice,
} from '../../stores/authenticator';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { formatAbsolute, formatRelative } from '../account/relativeTime';

/**
 * Profile "Approval security" section (Breeze Authenticator Phase 2).
 *
 * Mirrors the ProfilePage passkey list + MobileDevicesPage revoke/confirm
 * pattern, but swaps the data source to the typed `stores/authenticator`
 * helpers. Registering this browser/platform authenticator lets the signed-in
 * tech approve high-risk requests with Windows Hello / Touch ID (records a
 * `webauthn_platform` assurance factor — opt-in, never enforced in P2).
 *
 * Every mutation flows through `runAction` so success/failure always surfaces
 * to the user (CLAUDE.md `no-silent-mutations`).
 */

type ConfirmState = {
  device: ApproverDevice;
};

function deviceTitle(d: ApproverDevice): string {
  if (d.label && d.label.trim().length > 0) return d.label;
  return 'Unnamed device';
}

const OK_RESPONSE = { ok: true, status: 200, json: async () => ({ success: true }) } as Response;

export default function ApproverDevicesSection() {
  const [devices, setDevices] = useState<ApproverDevice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [label, setLabel] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(undefined);
    try {
      const result = await listApproverDevices();
      setDevices(result.filter((d) => !d.disabledAt));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load approver devices');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeDevices = useMemo(() => devices.filter((d) => !d.disabledAt), [devices]);

  const handleRegister = async () => {
    if (isRegistering) return;
    const trimmed = label.trim() || 'This device';
    setIsRegistering(true);
    try {
      await runAction({
        // registerApproverDevice runs the full WebAuthn registration ceremony
        // (options → Touch ID/Hello → verify) and resolves void on success; a
        // user cancellation or a non-2xx verify rejects, which runAction turns
        // into an error toast.
        request: async () => {
          await registerApproverDevice(trimmed);
          return OK_RESPONSE;
        },
        errorFallback: 'Failed to register this device',
        successMessage: 'This device can now approve requests',
      });
      setLabel('');
      await load();
    } catch (err) {
      if (err instanceof ActionError) return; // already toasted by runAction
      showToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to register this device' });
    } finally {
      setIsRegistering(false);
    }
  };

  const handleRevokeConfirm = async () => {
    if (!confirm) return;
    const id = confirm.device.id;
    setMutatingId(id);
    try {
      await runAction({
        request: () => revokeApproverDevice(id),
        errorFallback: 'Failed to revoke device',
        successMessage: 'Device revoked',
      });
      setConfirm(null);
      await load();
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to revoke device' });
      }
    } finally {
      setMutatingId(null);
    }
  };

  const handleRename = async (id: string) => {
    const next = editingLabel.trim();
    if (!next) return;
    setMutatingId(id);
    try {
      await runAction({
        request: () => renameApproverDevice(id, next),
        errorFallback: 'Failed to rename device',
        successMessage: 'Device renamed',
      });
      setDevices((prev) => prev.map((d) => (d.id === id ? { ...d, label: next } : d)));
      setEditingId(null);
      setEditingLabel('');
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed to rename device' });
      }
    } finally {
      setMutatingId(null);
    }
  };

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm" data-testid="approver-devices-section">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Approval security</h2>
        <p className="text-sm text-muted-foreground">
          Register this browser with Windows Hello or Touch ID so you can confirm high-risk approvals
          (privileged access, AI actions) with a biometric. This is optional — approvals still work
          without it.
        </p>
      </div>

      <div className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Loading approver devices…
          </div>
        ) : loadError ? (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <span>{loadError}</span>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium hover:bg-destructive/5"
            >
              Try again
            </button>
          </div>
        ) : activeDevices.length === 0 ? (
          <div
            data-testid="approver-devices-empty"
            className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground"
          >
            No approver devices registered. Register this device below to approve with a biometric.
          </div>
        ) : (
          activeDevices.map((device) => {
            const isEditing = editingId === device.id;
            const isMutating = mutatingId === device.id;
            return (
              <div
                key={device.id}
                data-testid={`approver-device-${device.id}`}
                className="rounded-md border bg-muted/30 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
                      {isEditing ? (
                        <input
                          type="text"
                          value={editingLabel}
                          onChange={(e) => setEditingLabel(e.target.value)}
                          className="h-9 rounded-md border bg-background px-3 text-sm"
                          disabled={isMutating}
                          autoFocus
                          data-testid={`approver-device-rename-input-${device.id}`}
                        />
                      ) : (
                        <span
                          data-testid={`approver-device-label-${device.id}`}
                          className="truncate text-sm font-medium"
                        >
                          {deviceTitle(device)}
                        </span>
                      )}
                      {device.isPlatformBound && (
                        <span
                          data-testid={`approver-device-platform-badge-${device.id}`}
                          className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                        >
                          Platform-bound
                        </span>
                      )}
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <dt>Registered</dt>
                      <dd title={formatAbsolute(device.createdAt)}>{formatRelative(device.createdAt)}</dd>
                      <dt>Last used</dt>
                      <dd title={formatAbsolute(device.lastUsedAt)}>{formatRelative(device.lastUsedAt)}</dd>
                    </dl>
                  </div>
                  <div className="flex items-center gap-2">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleRename(device.id)}
                          disabled={!editingLabel.trim() || isMutating}
                          data-testid={`approver-device-rename-save-${device.id}`}
                          className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {isMutating ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null);
                            setEditingLabel('');
                          }}
                          disabled={isMutating}
                          className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(device.id);
                            setEditingLabel(deviceTitle(device));
                          }}
                          disabled={!!mutatingId}
                          data-testid={`approver-device-rename-${device.id}`}
                          className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirm({ device })}
                          disabled={!!mutatingId}
                          data-testid={`approver-device-revoke-${device.id}`}
                          className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="space-y-4 rounded-md border p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Register this device</h3>
          <p className="text-xs text-muted-foreground">
            You'll be prompted for Windows Hello, Touch ID, or your device's biometric.
          </p>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="approver-device-label">
            Device name
          </label>
          <input
            id="approver-device-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Front-desk laptop"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            disabled={isRegistering}
            data-testid="approver-device-label-input"
          />
        </div>
        <button
          type="button"
          onClick={() => void handleRegister()}
          disabled={isRegistering}
          data-testid="approver-device-register"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRegistering ? 'Registering…' : 'Register this device'}
        </button>
      </div>

      {confirm && (
        <RevokeConfirmDialog
          device={confirm.device}
          revoking={mutatingId === confirm.device.id}
          onCancel={() => (mutatingId ? null : setConfirm(null))}
          onConfirm={() => void handleRevokeConfirm()}
        />
      )}
    </div>
  );
}

function RevokeConfirmDialog({
  device,
  revoking,
  onCancel,
  onConfirm,
}: {
  device: ApproverDevice;
  revoking: boolean;
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
            <h2 className="text-lg font-semibold">Revoke {deviceTitle(device)}?</h2>
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

        <p className="mt-4 text-sm text-muted-foreground">
          This device can no longer approve requests with a biometric. You can re-register it at any
          time.
        </p>

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
            data-testid="approver-device-revoke-confirm"
            className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {revoking ? 'Revoking…' : 'Revoke device'}
          </button>
        </div>
      </div>
    </div>
  );
}

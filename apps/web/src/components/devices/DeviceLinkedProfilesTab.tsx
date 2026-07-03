import { useCallback, useEffect, useState } from 'react';
import { Link2, Link2Off, AlertTriangle, Circle } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';

/** One boot profile (device record) in a linked multi-boot group. */
export interface LinkedProfile {
  deviceId: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  osVersion: string;
  agentVersion: string;
  status: string;
  lastSeenAt: string | null;
}

interface LinkGroupResponse {
  group: { id: string; name: string | null } | null;
  members: LinkedProfile[];
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Unknown';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function DeviceLinkedProfilesTab({ deviceId }: { deviceId: string }) {
  const [data, setData] = useState<LinkGroupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithAuth(`/devices/${deviceId}/link-group`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as LinkGroupResponse);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const group = data?.group ?? null;
  const members = data?.members ?? [];
  const onlineCount = members.filter((m) => m.status === 'online').length;
  const hasConflict = onlineCount > 1;

  const unlinkThisDevice = async () => {
    if (!group) return;
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/devices/link-groups/${group.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ removeDeviceIds: [deviceId] }),
          }),
        errorFallback: 'Could not unlink this device',
        successMessage: 'Device unlinked',
      });
      await load();
    } catch (err) {
      handleActionError(err, 'Could not unlink this device');
    } finally {
      setBusy(false);
    }
  };

  const dissolveGroup = async () => {
    if (!group) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/devices/link-groups/${group.id}`, { method: 'DELETE' }),
        errorFallback: 'Could not remove the link',
        successMessage: 'Link removed',
      });
      await load();
    } catch (err) {
      handleActionError(err, 'Could not remove the link');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">Loading linked profiles…</div>;
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6" data-testid="linked-profiles-error">
        <p className="text-sm text-destructive">Could not load linked profiles.</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!group) {
    return (
      <div className="rounded-lg border bg-card p-6" data-testid="linked-profiles-empty">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          Not part of a linked group
        </div>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          Multi-boot machines run a separate Breeze agent per OS, so the same hardware shows up as several
          devices. Select this device and its other boot profiles in the device list, then choose
          <span className="font-medium"> Link as multi-boot</span> to group them. The offline profiles stop
          adding noise to your online/offline counts while every device keeps its own history.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="linked-profiles-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{group.name || 'Linked boot profiles'}</h3>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {members.length} profiles
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void unlinkThisDevice()}
            data-testid="linked-profiles-unlink-self"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Link2Off className="h-3.5 w-3.5" />
            Unlink this device
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void dissolveGroup()}
            data-testid="linked-profiles-dissolve"
            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Remove link
          </button>
        </div>
      </div>

      {hasConflict && (
        <div
          data-testid="linked-profiles-conflict"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            More than one linked profile is reporting online at the same time. A multi-boot machine can only
            run one OS at once — this usually means the devices were linked incorrectly or the hardware
            identity changed.
          </span>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Profile</th>
              <th className="px-3 py-2 font-medium">OS</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Agent</th>
              <th className="px-3 py-2 font-medium">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isOnline = m.status === 'online';
              const isCurrent = m.deviceId === deviceId;
              return (
                <tr
                  key={m.deviceId}
                  data-testid={`linked-profile-${m.deviceId}`}
                  className={`border-t ${isOnline ? '' : 'text-muted-foreground'} ${isCurrent ? 'bg-muted/30' : ''}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">
                      {m.displayName || m.hostname}
                      {isCurrent && <span className="ml-2 text-xs text-muted-foreground">(this device)</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">{m.hostname}</div>
                  </td>
                  <td className="px-3 py-2 capitalize">
                    {m.osType} <span className="text-xs text-muted-foreground">{m.osVersion}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center gap-1.5 ${isOnline ? 'text-success' : 'text-muted-foreground'}`}
                      data-testid={`linked-profile-${m.deviceId}-status`}
                    >
                      <Circle className={`h-2 w-2 ${isOnline ? 'fill-success' : 'fill-muted-foreground'}`} />
                      {isOnline ? 'Online (active)' : m.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">v{m.agentVersion}</td>
                  <td className="px-3 py-2">{formatLastSeen(m.lastSeenAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Server } from 'lucide-react';
import { Dialog } from '../shared/Dialog';
import { OSIcon } from './osIcons';
import type { Device } from './DeviceList';

/**
 * Host picker for creating a vm_host link group (#2308).
 *
 * The bulk "Link as VM host + guests" action needs one decision the multiboot
 * flow doesn't: WHICH selected device is the host server. This modal lists the
 * selection, the operator picks the host, and every other device becomes a
 * guest VM nested under it in the device list. The actual POST (and its
 * success/failure toasts) stays in DevicesPage, mirroring the multiboot path.
 */
interface LinkVmHostModalProps {
  isOpen: boolean;
  devices: Device[];
  busy?: boolean;
  onConfirm: (hostDeviceId: string) => void;
  onClose: () => void;
}

export default function LinkVmHostModal({ isOpen, devices, busy, onConfirm, onClose }: LinkVmHostModalProps) {
  const [hostId, setHostId] = useState<string | null>(null);

  const handleClose = () => {
    setHostId(null);
    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={handleClose} title="Link as VM host + guests" maxWidth="lg">
      <div className="p-6" data-testid="vm-host-modal">
        <div className="mb-1 flex items-center gap-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Link as VM host + guests</h2>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Pick the host server. The other {devices.length - 1} device{devices.length - 1 === 1 ? '' : 's'} become
          guest VMs nested under it in the device list — each stays a fully managed endpoint with its own
          inventory and history.
        </p>

        <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
          {devices.map((d) => (
            <label
              key={d.id}
              data-testid={`vm-host-option-${d.id}`}
              className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm transition hover:bg-muted ${hostId === d.id ? 'bg-muted' : ''}`}
            >
              <input
                type="radio"
                name="vm-host"
                checked={hostId === d.id}
                onChange={() => setHostId(d.id)}
                className="h-4 w-4 border-border"
              />
              <OSIcon os={d.os} className="h-4 w-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{d.displayName || d.hostname}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {d.hostname} · {d.status}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="vm-host-cancel"
            onClick={handleClose}
            disabled={busy}
            className="rounded-md border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="vm-host-confirm"
            disabled={!hostId || busy}
            onClick={() => hostId && onConfirm(hostId)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? 'Linking…' : 'Link devices'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

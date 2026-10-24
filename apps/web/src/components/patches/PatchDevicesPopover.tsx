import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';

export type PatchDevice = {
  deviceId: string;
  hostname: string;
  status: string;
  lastCheckedAt: string | null;
};

/** One page (1-based) of GET /patches/:id/devices. */
export type LoadPatchDevices = (patchId: string, page: number) => Promise<{ devices: PatchDevice[]; total: number }>;

// Labelled with the device list's own wording (devices.json deviceList.statuses.full).
const DEVICE_STATUSES = ['online', 'offline', 'maintenance', 'decommissioned', 'quarantined', 'updating', 'pending'];
const POPOVER_GAP_PX = 4;

type Props = {
  patchId: string;
  patchTitle: string;
  count: number;
  loadDevices: LoadPatchDevices;
};

/**
 * The approval list's device count (#8728) and, on click, the hostnames
 * behind it. Hostnames are fetched on demand — never in the list payload — one
 * page at a time.
 *
 * Portalled into `document.body` with `position: fixed` for the same reason as
 * `ActionMenu`: the row lives inside `ResponsiveTable`'s `overflow-x-auto`
 * wrapper, which clips an `absolute` popup.
 */
export function PatchDevicesPopover({ patchId, patchTitle, count, loadDevices }: Props) {
  const { t } = useTranslation(['patches', 'devices']);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<PatchDevice[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', top: 0, left: 0 });

  // Only the newest load may write state: a response for a request started
  // before a close/reopen (or superseded by a retry) is dropped.
  const requestRef = useRef(0);

  const loadPage = useCallback(async (next: number) => {
    const request = ++requestRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = await loadDevices(patchId, next);
      if (request !== requestRef.current) return;
      setDevices((prev) => (next === 1 ? result.devices : [...prev, ...result.devices]));
      setTotal(result.total);
      setPage(next);
    } catch {
      if (request !== requestRef.current) return;
      setFailed(true);
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [loadDevices, patchId]);

  const close = useCallback(() => {
    requestRef.current++;
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) {
      requestRef.current++;
      setOpen(false);
      return;
    }
    setOpen(true);
    // Reload from page 1 on every open: the list may have been refreshed since.
    setDevices([]);
    setTotal(null);
    setPage(0);
    setFailed(false);
    void loadPage(1);
  };

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      requestRef.current++;
      setOpen(false);
    };
    // On the document, not the popover: focus stays on the trigger after a
    // click, and Escape should close it from there too.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const height = popoverRef.current?.offsetHeight ?? 0;
      const below = rect.bottom + POPOVER_GAP_PX;
      const flip = below + height > window.innerHeight && rect.top > window.innerHeight - rect.bottom;
      setStyle({
        position: 'fixed',
        top: flip ? Math.max(POPOVER_GAP_PX, rect.top - POPOVER_GAP_PX - height) : below,
        left: Math.max(POPOVER_GAP_PX, Math.min(rect.left, window.innerWidth - 288 - POPOVER_GAP_PX)),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, devices.length, loading]);

  const statusLabel = (status: string) =>
    DEVICE_STATUSES.includes(status)
      ? t(/* i18n-dynamic */ `devices:deviceList.statuses.full.${status}`)
      : t('devices:deviceList.statuses.full.unknown');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('patchList.outstandingDevices.open', { title: patchTitle })}
        data-testid={`patch-row-${patchId}-devices`}
        className="inline-flex w-fit items-center rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium hover:bg-muted"
      >
        {t('patchList.outstandingDevices.badge', { count })}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={t('patchList.outstandingDevices.heading', { title: patchTitle })}
          data-testid="patch-devices-popover"
          style={style}
          className="z-50 w-72 rounded-md border bg-popover p-3 text-sm text-popover-foreground shadow-md"
        >
          <p className="mb-2 text-xs font-semibold text-muted-foreground">
            {t('patchList.outstandingDevices.heading', { title: patchTitle })}
          </p>
          {failed && devices.length === 0 ? (
            <div className="flex items-center justify-between gap-2 text-destructive">
              <span>{t('patchList.outstandingDevices.error')}</span>
              <button
                type="button"
                onClick={() => void loadPage(devices.length === 0 ? 1 : page + 1)}
                data-testid="patch-devices-retry"
                className="rounded-md border border-destructive/40 px-2 py-1 text-xs font-medium hover:bg-destructive/10"
              >
                {t('patchList.actions.tryAgain')}
              </button>
            </div>
          ) : (
            <>
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {devices.map((device) => (
                  <li key={device.deviceId} className="flex items-baseline justify-between gap-2">
                    <a
                      href={`/devices/${device.deviceId}#patches`}
                      className="truncate font-medium text-primary hover:underline"
                      title={device.lastCheckedAt
                        ? t('patchList.outstandingDevices.lastChecked', { when: formatDateTime(device.lastCheckedAt) })
                        : undefined}
                    >
                      {device.hostname}
                    </a>
                    <span className={cn('shrink-0 text-xs', device.status === 'online' ? 'text-success' : 'text-muted-foreground')}>
                      {statusLabel(device.status)}
                    </span>
                  </li>
                ))}
              </ul>
              {loading && (
                <div className="flex items-center gap-2 py-1 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('patchList.outstandingDevices.loading')}
                </div>
              )}
              {failed && devices.length > 0 && (
                <p className="pt-1 text-xs text-destructive">{t('patchList.outstandingDevices.error')}</p>
              )}
              {total !== null && (
                <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
                  <span>{t('patchList.outstandingDevices.showing', { shown: devices.length, total })}</span>
                  {!loading && devices.length < total && (
                    <button
                      type="button"
                      onClick={() => void loadPage(page + 1)}
                      data-testid="patch-devices-load-more"
                      className="font-medium text-primary hover:underline"
                    >
                      {t('patchList.outstandingDevices.loadMore')}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>,
        document.body
      )}
    </>
  );
}

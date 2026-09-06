import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { getDeviceRoleLabel } from '../../lib/deviceRoles';
import { useHashState } from '../../lib/useHashState';
import type { InvoiceLine, InvoiceLineDevice } from './invoiceTypes';

export interface InvoiceLineDevicesResult {
  recorded: boolean;
  total: number;
  devices: InvoiceLineDevice[];
  nextCursor: string | null;
}

/** Read-only invoice-evidence client. `fetchWithAuth` supplies the active org. */
export async function fetchInvoiceLineDevices(
  invoiceId: string,
  lineId: string,
  opts: { limit: number; cursor?: string },
): Promise<InvoiceLineDevicesResult> {
  const params = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.cursor) params.set('cursor', opts.cursor);
  const res = await fetchWithAuth(`/invoices/${invoiceId}/lines/${lineId}/devices?${params.toString()}`);
  if (!res.ok) throw new Error(`Invoice device evidence request failed (${res.status})`);
  const body = (await res.json()) as { data: InvoiceLineDevicesResult };
  return body.data;
}

type LoadState = {
  status: 'idle' | 'loading' | 'error' | 'ready';
  total: number;
  devices: InvoiceLineDevice[];
  nextCursor: string | null;
};

// Every mounted instance's open/closed state is membership in a SET of ids
// carried in one `devices=` hash segment (`#devices=l1,l2`), not a single
// global "which one is open" value — the earlier one-value-per-hash design
// force-closed line A whenever line B was expanded, because A's own
// `hashchange` listener saw `hash !== hashA` and closed itself (#3205 W07
// review). The segment is composed with — never replaces — whatever else is
// already in the hash (e.g. InvoiceDetail's own `#editor`): split on `&`,
// only the `devices=` token is ours to touch. Read via `useHashState`, not a
// raw `useState(() => …location.hash…)` initializer, so the first client
// render still matches the SSR-rendered default (#2421 hydration guard,
// `src/lib/__tests__/no-hash-in-usestate.test.ts`).
const HASH_SEGMENT_KEY = 'devices';

function parseOpenIds(rawHash: string): Set<string> {
  const ids = new Set<string>();
  for (const segment of rawHash.split('&')) {
    if (!segment.startsWith(`${HASH_SEGMENT_KEY}=`)) continue;
    for (const id of segment.slice(HASH_SEGMENT_KEY.length + 1).split(',')) {
      if (id) ids.add(id);
    }
  }
  return ids;
}

function writeOpenIds(ids: Set<string>): void {
  const raw = window.location.hash.replace(/^#/, '');
  const otherSegments = raw.split('&').filter((s) => s && !s.startsWith(`${HASH_SEGMENT_KEY}=`));
  const ownSegment = ids.size > 0 ? [`${HASH_SEGMENT_KEY}=${[...ids].sort().join(',')}`] : [];
  window.location.hash = [...otherSegments, ...ownSegment].join('&');
}

/**
 * #3205 W07: the devices this invoice line billed, disclosed on demand.
 *
 * READ-ONLY — no runAction (that guard is for mutations). The first page is
 * fetched once on first expand and cached across collapse/re-expand. Additional
 * pages follow the API's opaque nextCursor.
 */
export default function InvoiceLineDevices({ invoiceId, line }: { invoiceId: string; line: InvoiceLine }) {
  const { t } = useTranslation('billing');
  const [openIds, setOpenIds] = useHashState<Set<string>>(new Set(), parseOpenIds);
  const open = openIds.has(line.id);
  const [state, setState] = useState<LoadState>({
    status: 'idle', total: 0, devices: [], nextCursor: null,
  });

  const load = useCallback(async (cursor?: string) => {
    if (!cursor && state.status !== 'idle') return;
    if (!cursor) setState((s) => ({ ...s, status: 'loading' }));
    try {
      const data = await fetchInvoiceLineDevices(invoiceId, line.id, { limit: 100, cursor });
      setState((s) => ({
        status: 'ready',
        total: data.total,
        devices: cursor ? [...s.devices, ...data.devices] : data.devices,
        nextCursor: data.nextCursor,
      }));
    } catch {
      setState((s) => ({ ...s, status: 'error' }));
    }
  }, [invoiceId, line.id, state.status]);

  useEffect(() => {
    if (open && state.status === 'idle') void load();
  }, [load, open, state.status]);

  if (line.deviceCount === 0) return null;

  const toggle = () => {
    const next = new Set(openIds);
    if (next.has(line.id)) next.delete(line.id);
    else next.add(line.id);
    writeOpenIds(next);
    setOpenIds(next);
  };
  const billed = state.devices.filter((d) => d.countedAs !== 'flagged');
  const flagged = state.devices.filter((d) => d.countedAs === 'flagged');

  const rows = (devices: InvoiceLineDevice[]) => devices.map((d) => (
    <tr key={d.id} data-testid={`invoice-line-device-${d.id}`} className="border-t">
      <td className="px-2 py-1.5">
        {d.hostname}
        {d.deviceId === null && (
          <span className="ml-2 text-muted-foreground" data-testid={`invoice-line-device-removed-${d.id}`}>
            {t('invoiceDetail.devices.removed')}
          </span>
        )}
      </td>
      <td className="px-2 py-1.5">{getDeviceRoleLabel(d.deviceRole)}</td>
      <td className="px-2 py-1.5">
        {d.countedAs === 'flagged'
          ? t('invoiceDetail.devices.flaggedHeading')
          : t(/* i18n-dynamic */ `invoiceDetail.devices.${d.countedAs}`)}
      </td>
    </tr>
  ));

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        data-testid={`invoice-line-devices-toggle-${line.id}`}
        className="text-xs text-primary hover:underline"
      >
        {t('invoiceDetail.devices.toggle', { count: line.deviceCount })}
      </button>
      {open && (
        <div className="mt-2 min-w-[28rem] rounded-md border bg-background p-2">
          <p className="px-2 pb-1 text-xs font-semibold">{t('invoiceDetail.devices.title')}</p>
          {state.status === 'loading' && <p className="px-2 py-2 text-xs text-muted-foreground">…</p>}
          {state.status === 'error' && (
            <p className="px-2 py-2 text-xs text-destructive" data-testid={`invoice-line-devices-error-${line.id}`}>
              {t('invoiceDetail.devices.loadError')}
            </p>
          )}
          {state.status === 'ready' && state.devices.length === 0 && (
            <p className="px-2 py-2 text-xs text-muted-foreground" data-testid={`invoice-line-devices-empty-${line.id}`}>
              {t('invoiceDetail.devices.empty')}
            </p>
          )}
          {state.status === 'ready' && state.devices.length > 0 && (
            <>
              <table className="w-full text-xs" data-testid={`invoice-line-devices-${line.id}`}>
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-2 py-1 font-medium">{t('invoiceDetail.devices.hostname')}</th>
                    <th className="px-2 py-1 font-medium">{t('invoiceDetail.devices.role')}</th>
                    <th className="px-2 py-1 font-medium">{t('invoiceDetail.devices.countedAs')}</th>
                  </tr>
                </thead>
                <tbody>{rows(billed)}</tbody>
              </table>
              {flagged.length > 0 && (
                <div className="mt-3" data-testid={`invoice-line-devices-flagged-${line.id}`}>
                  <p className="px-2 pb-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
                    {t('invoiceDetail.devices.flaggedHeading')}
                  </p>
                  <table className="w-full text-xs">
                    <tbody>{rows(flagged)}</tbody>
                  </table>
                </div>
              )}
              {state.devices.length < state.total && (
                <button
                  type="button"
                  onClick={() => state.nextCursor && void load(state.nextCursor)}
                  disabled={!state.nextCursor}
                  data-testid={`invoice-line-devices-showing-${line.id}`}
                  className="mt-2 px-2 text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                >
                  {t('invoiceDetail.devices.showing', { shown: state.devices.length, total: state.total })}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

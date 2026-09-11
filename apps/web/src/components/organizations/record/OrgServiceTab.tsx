import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import DeliverableForm from '@/components/deliverables/DeliverableForm';
import DeliverableTable from '@/components/deliverables/DeliverableTable';
import OccurrenceDrawer from '@/components/deliverables/OccurrenceDrawer';
import { listDeliverables, unwrapData, type Deliverable } from '@/lib/api/serviceDeliverables';
import { formatDate } from '@/components/billing/shared/format';
import { ActionError } from '@/lib/runAction';
import { useLatest, type OrgFetch } from './orgRecordFetch';

const UPCOMING_WINDOW_DAYS = 90;

interface ContractOption {
  id: string;
  name: string;
}

/** A failed load keeps the server's message so the tab can say WHY. */
interface LoadFailure {
  failed: true;
  message: string;
}

/** The contract list a new deliverable can be filed under: still loading, the
 *  options, or a failure the form must refuse to save through. */
type ContractsState = 'loading' | 'failed' | ContractOption[];

/** `listContractsQuerySchema` caps `limit` at 100; the org is appended by the
 *  record's `orgFetch` (`orgIdOverride`, orgRecordFetch.ts). */
const CONTRACTS_PATH = '/contracts?limit=100';

function failureFrom(err: unknown, fallback: string): LoadFailure {
  const message = err instanceof ActionError && err.message ? err.message : fallback;
  return { failed: true, message };
}

/** Today as ISO `YYYY-MM-DD` in local time — `nextDue` is a date, not an instant. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/**
 * Deliverables due inside the next `UPCOMING_WINDOW_DAYS`, soonest first.
 * ISO dates compare lexicographically, so no Date parsing is needed — and
 * none of the timezone drift that comes with it.
 */
export function upcomingWithin(rows: Deliverable[], today: string, days: number): Deliverable[] {
  const until = addDaysIso(today, days);
  return rows
    .filter((r): r is Deliverable & { nextDue: string } => !!r.nextDue && r.nextDue >= today && r.nextDue <= until)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.name.localeCompare(b.name));
}

/**
 * The organization record's Service tab (#5573 W01): every deliverable the
 * org is owed, grouped by contract, with what falls due in the next 90 days
 * pulled out on top.
 *
 * Every request goes through the record's `orgFetch` — the tab is pinned to
 * the org in the URL, never to the OrgSwitcher (see orgRecordFetch.ts).
 */
export default function OrgServiceTab({ orgId, orgFetch }: { orgId: string; orgFetch: OrgFetch }) {
  const { t } = useTranslation('deliverables');
  const [rows, setRows] = useState<Deliverable[] | LoadFailure | null>(null);
  const [contracts, setContracts] = useState<ContractsState>('loading');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Deliverable | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const latest = useLatest<Deliverable[] | LoadFailure>();

  const load = useCallback(async () => {
    const result = await latest.run(
      listDeliverables(orgFetch, orgId).catch((err: unknown): LoadFailure => {
        console.error('[OrgServiceTab] failed to load deliverables', err);
        return failureFrom(err, t('errors.loadFailed'));
      }),
    );
    if (result === undefined) return;
    setRows(result);
  }, [latest, orgFetch, orgId, t]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Contract options for the add form's picker, loaded once per org. A failed
  // load is NOT an empty list: the form keeps the picker, shows the failure and
  // refuses to save, so a deliverable owed under a contract is never filed
  // standalone by accident.
  useEffect(() => {
    let cancelled = false;
    setContracts('loading');
    (async () => {
      try {
        const list = await unwrapData<Array<{ id: string; name: string }>>(await orgFetch(CONTRACTS_PATH));
        if (!cancelled) setContracts((Array.isArray(list) ? list : []).map((c) => ({ id: c.id, name: c.name })));
      } catch (err) {
        console.error('[OrgServiceTab] failed to load contracts', err);
        if (!cancelled) setContracts('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgFetch, orgId]);

  const upcoming = useMemo(
    () => (Array.isArray(rows) ? upcomingWithin(rows, todayIso(), UPCOMING_WINDOW_DAYS) : []),
    [rows],
  );

  const bump = () => setRefreshKey((k) => k + 1);

  return (
    <div data-testid="org-service-tab" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t('section.title')}</h2>
        <button
          type="button"
          data-testid="org-service-add"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('actions.add')}
        </button>
      </div>

      {adding && (
        <div className="rounded-lg border bg-card p-4">
          <DeliverableForm
            fetcher={orgFetch}
            orgId={orgId}
            contractOptions={Array.isArray(contracts) ? contracts : []}
            contractsState={Array.isArray(contracts) ? undefined : contracts}
            onSaved={() => {
              setAdding(false);
              bump();
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      <section data-testid="org-service-upcoming" className="rounded-lg border bg-card">
        <header className="border-b px-4 py-2.5">
          <h3 className="text-sm font-semibold">{t('upcoming.title')}</h3>
        </header>
        {rows === null ? (
          <div className="space-y-2 px-4 py-3">
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        ) : !Array.isArray(rows) ? (
          <p className="px-4 py-4 text-sm text-destructive" data-testid="org-service-error">{rows.message}</p>
        ) : upcoming.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">{t('upcoming.empty')}</p>
        ) : (
          <ul className="divide-y">
            {upcoming.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <button
                  type="button"
                  className="truncate text-left font-medium hover:underline"
                  onClick={() => setSelected(d)}
                >
                  {d.name}
                </button>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {[d.contractName ?? t('group.noContract'), formatDate(d.nextDue)].join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <DeliverableTable
        fetcher={orgFetch}
        orgId={orgId}
        groupByContract
        onSelect={setSelected}
        refreshKey={refreshKey}
      />

      {selected && (
        <OccurrenceDrawer
          fetcher={orgFetch}
          orgId={orgId}
          deliverable={selected}
          onClose={() => setSelected(null)}
          onChanged={bump}
        />
      )}
    </div>
  );
}

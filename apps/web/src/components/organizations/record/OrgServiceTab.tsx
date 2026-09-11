import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import DeliverableForm from '@/components/deliverables/DeliverableForm';
import DeliverableTable from '@/components/deliverables/DeliverableTable';
import OccurrenceDrawer from '@/components/deliverables/OccurrenceDrawer';
import { listDeliverables, unwrapData, type Deliverable } from '@/lib/api/serviceDeliverables';
import { formatDate } from '@/lib/dateTimeFormat';
import { useLatest, type OrgFetch } from './orgRecordFetch';

const UPCOMING_WINDOW_DAYS = 90;

interface ContractOption {
  id: string;
  name: string;
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
  const [rows, setRows] = useState<Deliverable[] | 'failed' | null>(null);
  const [contracts, setContracts] = useState<ContractOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Deliverable | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const latest = useLatest<Deliverable[] | 'failed'>();

  const load = useCallback(async () => {
    const result = await latest.run(listDeliverables(orgFetch, orgId).catch((): 'failed' => 'failed'));
    if (result === undefined) return;
    setRows(result);
  }, [latest, orgFetch, orgId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Contract options for the add form's picker. Loaded once per org; a failed
  // load leaves the picker empty (the deliverable can still be standalone).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await unwrapData<Array<{ id: string; name: string }>>(await orgFetch('/contracts'));
        if (!cancelled) setContracts((Array.isArray(list) ? list : []).map((c) => ({ id: c.id, name: c.name })));
      } catch {
        if (!cancelled) setContracts([]);
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
            contractOptions={contracts}
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
        ) : rows === 'failed' ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">{t('errors.loadFailed')}</p>
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

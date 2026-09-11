import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  deactivateDeliverable,
  listDeliverables,
  updateDeliverable,
  type Deliverable,
  type DeliverableStatus,
  type Fetcher,
} from '../../lib/api/serviceDeliverables';
import { handleActionError } from '../../lib/runAction';
import { formatDate } from '../billing/shared/format';
import { Dialog } from '../shared/Dialog';
import DeliverableForm, { runClientAction } from './DeliverableForm';

export interface DeliverableTableProps {
  fetcher: Fetcher;
  orgId: string;
  /** Restrict the list to one contract (the contract detail page). */
  contractId?: string;
  /** Name click — parents open the occurrence drawer. */
  onSelect?: (d: Deliverable) => void;
  /** Group rows under their contract name; standalone rows under "No contract". */
  groupByContract?: boolean;
  /** Bump to force a reload (e.g. after the parent's Add form saved). */
  refreshKey?: number;
}

const STATUS_PILL: Record<DeliverableStatus, string> = {
  on_track: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  due_soon: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  late: 'bg-destructive/10 text-destructive',
  missed: 'bg-destructive/10 text-destructive',
  inactive: 'bg-muted text-muted-foreground',
};

const LATE_PILL = 'inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive';

interface Group {
  key: string;
  label: string | null;
  rows: Deliverable[];
}

function groupRows(rows: Deliverable[], byContract: boolean): Group[] {
  if (!byContract) return [{ key: 'all', label: null, rows }];
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const key = row.contractId ?? 'none';
    const g = groups.get(key);
    if (g) g.rows.push(row);
    else groups.set(key, { key, label: row.contractName, rows: [row] });
  }
  // Contract groups first (alphabetical by name), standalone rows last.
  return [...groups.values()].sort((a, b) => {
    if (a.key === 'none') return 1;
    if (b.key === 'none') return -1;
    return (a.label ?? '').localeCompare(b.label ?? '');
  });
}

export default function DeliverableTable({
  fetcher,
  orgId,
  contractId,
  onSelect,
  groupByContract = false,
  refreshKey = 0,
}: DeliverableTableProps) {
  const { t } = useTranslation('deliverables');
  const [rows, setRows] = useState<Deliverable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [editing, setEditing] = useState<Deliverable | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await listDeliverables(fetcher, orgId, contractId ? { contractId } : {});
        if (!cancelled) setRows(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error && err.message ? err.message : t('errors.loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetcher, orgId, contractId, refreshKey, reloadTick, t]);

  const replaceRow = (next: Deliverable) => setRows((prev) => prev.map((r) => (r.id === next.id ? next : r)));

  const togglePortal = async (row: Deliverable) => {
    if (busyId) return;
    setBusyId(row.id);
    try {
      const saved = await runClientAction(
        () => updateDeliverable(fetcher, orgId, row.id, { portalVisible: !row.portalVisible }),
        { errorFallback: t('errors.saveFailed'), successMessage: t('toast.saved') },
      );
      replaceRow(saved);
    } catch (err) {
      handleActionError(err, t('errors.saveFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const deactivate = async (row: Deliverable) => {
    if (busyId) return;
    setBusyId(row.id);
    try {
      await runClientAction(() => deactivateDeliverable(fetcher, orgId, row.id), {
        errorFallback: t('errors.saveFailed'),
        successMessage: t('toast.deactivated'),
      });
      setConfirmingId(null);
      reload();
    } catch (err) {
      handleActionError(err, t('errors.saveFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const groups = groupRows(rows, groupByContract);

  return (
    <div data-testid="deliverables-table">
      {loading ? (
        <div className="flex items-center justify-center py-8" data-testid="deliverables-loading">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : error ? (
        <div className="px-3 py-6 text-center text-sm text-destructive" data-testid="deliverables-error">
          {error}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-8 text-center text-sm text-muted-foreground" data-testid="deliverables-empty">
          {t('section.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('table.name')}</th>
                <th className="px-3 py-2 font-medium">{t('table.cadence')}</th>
                <th className="px-3 py-2 font-medium">{t('table.nextDue')}</th>
                <th className="px-3 py-2 font-medium">{t('table.lastDelivered')}</th>
                <th className="px-3 py-2 font-medium">{t('table.status')}</th>
                <th className="px-3 py-2 font-medium">{t('table.portal')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <GroupRows
                  key={group.key}
                  group={group}
                  showHeading={groupByContract}
                  busyId={busyId}
                  confirmingId={confirmingId}
                  onSelect={onSelect}
                  onEdit={setEditing}
                  onTogglePortal={(row) => void togglePortal(row)}
                  onArmDeactivate={setConfirmingId}
                  onDeactivate={(row) => void deactivate(row)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t('actions.edit')}
        maxWidth="xl"
        className="p-5"
      >
        {editing && (
          <>
            <h3 className="mb-3 text-base font-semibold">{editing.name}</h3>
            <DeliverableForm
              fetcher={fetcher}
              orgId={orgId}
              contractId={contractId ?? editing.contractId}
              initial={editing}
              onSaved={(saved) => {
                replaceRow(saved);
                setEditing(null);
                reload();
              }}
              onCancel={() => setEditing(null)}
            />
          </>
        )}
      </Dialog>
    </div>
  );
}

interface GroupRowsProps {
  group: Group;
  showHeading: boolean;
  busyId: string | null;
  confirmingId: string | null;
  onSelect?: (d: Deliverable) => void;
  onEdit: (d: Deliverable) => void;
  onTogglePortal: (d: Deliverable) => void;
  onArmDeactivate: (id: string | null) => void;
  onDeactivate: (d: Deliverable) => void;
}

function GroupRows({
  group,
  showHeading,
  busyId,
  confirmingId,
  onSelect,
  onEdit,
  onTogglePortal,
  onArmDeactivate,
  onDeactivate,
}: GroupRowsProps) {
  const { t } = useTranslation('deliverables');
  return (
    <>
      {showHeading && (
        <tr className="border-t bg-muted/40" data-testid={`deliverable-group-${group.key}`}>
          <th colSpan={7} scope="rowgroup" className="px-3 py-1.5 text-left text-xs font-semibold text-muted-foreground">
            {group.label ?? t('group.noContract')}
          </th>
        </tr>
      )}
      {group.rows.map((row) => {
        const busy = busyId === row.id;
        const confirming = confirmingId === row.id;
        return (
          <tr key={row.id} className="border-t align-top" data-testid={`deliverable-row-${row.id}`}>
            <td className="px-3 py-2">
              <button
                type="button"
                onClick={() => onSelect?.(row)}
                className="text-left font-medium text-primary hover:underline"
                data-testid={`deliverable-name-${row.id}`}
              >
                {row.name}
              </button>
              {row.description && (
                <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{row.description}</div>
              )}
            </td>
            <td className="px-3 py-2 whitespace-nowrap">{t(/* i18n-dynamic */ `cadence.${row.cadence}`)}</td>
            <td className="px-3 py-2 whitespace-nowrap">{formatDate(row.nextDue)}</td>
            <td className="px-3 py-2 whitespace-nowrap">
              {row.lastDelivered ? (
                <span className="inline-flex items-center gap-1.5">
                  {formatDate(row.lastDelivered.at)}
                  {row.lastDelivered.late && <span className={LATE_PILL}>{t('drawer.late')}</span>}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
            <td className="px-3 py-2 whitespace-nowrap">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[row.status]}`}
                data-testid={`deliverable-status-${row.id}`}
              >
                {t(/* i18n-dynamic */ `status.${row.status}`)}
              </span>
            </td>
            <td className="px-3 py-2">
              <input
                type="checkbox"
                checked={row.portalVisible}
                disabled={busy}
                onChange={() => onTogglePortal(row)}
                aria-label={t('form.portalVisible')}
                data-testid={`deliverable-portal-toggle-${row.id}`}
              />
            </td>
            <td className="px-3 py-2 text-right whitespace-nowrap">
              {confirming ? (
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  <span className="text-xs text-muted-foreground">{t('confirm.deactivate', { name: row.name })}</span>
                  <button
                    type="button"
                    onClick={() => onDeactivate(row)}
                    disabled={busy}
                    className="rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                    data-testid={`deliverable-deactivate-${row.id}`}
                  >
                    {t('actions.deactivate')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onArmDeactivate(null)}
                    disabled={busy}
                    className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    data-testid={`deliverable-deactivate-cancel-${row.id}`}
                  >
                    {t('actions.cancel')}
                  </button>
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onEdit(row)}
                    disabled={busy}
                    className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    data-testid={`deliverable-edit-${row.id}`}
                  >
                    {t('actions.edit')}
                  </button>
                  {row.active && (
                    <button
                      type="button"
                      onClick={() => onArmDeactivate(row.id)}
                      disabled={busy}
                      className="rounded-md border px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      data-testid={`deliverable-deactivate-${row.id}`}
                    >
                      {t('actions.deactivate')}
                    </button>
                  )}
                </span>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}

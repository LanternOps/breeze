import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  listDeliverables,
  moveDeliverables,
  type Deliverable,
  type Fetcher,
} from '../../lib/api/serviceDeliverables';
import { ActionError, handleActionError } from '../../lib/runAction';
import { runClientAction } from '../../lib/runClientAction';
import { Dialog } from '../shared/Dialog';
import { useContractOptions } from './useContractOptions';

interface BaseProps {
  fetcher: Fetcher;
  orgId: string;
  onClose: () => void;
  onMoved: () => void;
}

/** 409 DUPLICATE_NAME carries `details.names`; surface them so the user knows what to rename. */
function collisionNames(err: unknown): string[] | null {
  if (!(err instanceof ActionError) || err.code !== 'DUPLICATE_NAME') return null;
  const names = (err.body as { details?: { names?: unknown } } | undefined)?.details?.names;
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : null;
}

function useMove({ fetcher, orgId, onMoved }: Pick<BaseProps, 'fetcher' | 'orgId' | 'onMoved'>) {
  const { t } = useTranslation('deliverables');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (deliverableIds: string[], contractId: string | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await runClientAction(() => moveDeliverables(fetcher, orgId, { deliverableIds, contractId }), {
        errorFallback: t('errors.saveFailed'),
        successMessage: t('move.moved'),
      });
      onMoved();
    } catch (err) {
      const names = collisionNames(err);
      if (names) setError(t('move.collision', { names: names.join(', ') }));
      else if (err instanceof ActionError && err.status > 0) setError(err.message);
      handleActionError(err, t('errors.saveFailed'));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** Move the already-selected deliverables to a contract chosen here (or to "no contract"). */
export function MoveToContractDialog({
  deliverableIds,
  ...props
}: BaseProps & { deliverableIds: string[] }) {
  const { t } = useTranslation('deliverables');
  const { options, state } = useContractOptions(props.fetcher, props.orgId);
  const [target, setTarget] = useState('');
  const { busy, error, run } = useMove(props);

  return (
    <Dialog open onClose={props.onClose} title={t('move.toTitle')} maxWidth="md" className="p-5">
      <h3 className="mb-1 text-base font-semibold">{t('move.toTitle')}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{t('move.selected', { count: deliverableIds.length })}</p>
      <label htmlFor="move-target" className="block text-xs font-medium text-muted-foreground">{t('move.target')}</label>
      <select
        id="move-target"
        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        disabled={state !== 'ready' || busy}
        data-testid="move-to-target"
      >
        <option value="">{t('form.noContract')}</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      {state === 'failed' && (
        <p className="mt-1 text-xs text-destructive" role="alert">{t('form.contractsUnavailable')}</p>
      )}
      {error && <p className="mt-2 text-sm text-destructive" role="alert" data-testid="move-error">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={props.onClose} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          {t('actions.cancel')}
        </button>
        <button
          type="button"
          disabled={busy || state !== 'ready'}
          onClick={() => void run(deliverableIds, target || null)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="move-to-confirm"
        >
          {t('move.confirm')}
        </button>
      </div>
    </Dialog>
  );
}

/** Contract page: pick deliverables from the org's OTHER contracts (and standalone ones) to move here. */
export function MoveHereDialog({
  targetContractId,
  ...props
}: BaseProps & { targetContractId: string }) {
  const { t } = useTranslation('deliverables');
  const [rows, setRows] = useState<Deliverable[] | 'failed' | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { busy, error, run } = useMove(props);

  useEffect(() => {
    let cancelled = false;
    listDeliverables(props.fetcher, props.orgId)
      .then((all) => { if (!cancelled) setRows(all.filter((d) => d.contractId !== targetContractId)); })
      .catch((err: unknown) => {
        console.error('[MoveHereDialog] failed to load deliverables', err);
        if (!cancelled) setRows('failed');
      });
    return () => { cancelled = true; };
  }, [props.fetcher, props.orgId, targetContractId]);

  const groups = useMemo(() => {
    const m = new Map<string, { label: string; rows: Deliverable[] }>();
    for (const d of Array.isArray(rows) ? rows : []) {
      const key = d.contractId ?? 'none';
      const g = m.get(key) ?? { label: d.contractName ?? t('group.noContract'), rows: [] };
      g.rows.push(d);
      m.set(key, g);
    }
    return [...m.entries()];
  }, [rows, t]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog open onClose={props.onClose} title={t('move.hereTitle')} maxWidth="lg" className="p-5">
      <h3 className="mb-1 text-base font-semibold">{t('move.hereTitle')}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{t('move.hereHelp')}</p>
      <div className="max-h-80 overflow-y-auto rounded-md border" data-testid="move-here-list">
        {rows === null ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">…</p>
        ) : rows === 'failed' ? (
          <p className="px-3 py-4 text-sm text-destructive" role="alert">{t('errors.loadFailed')}</p>
        ) : groups.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground" data-testid="move-here-empty">{t('move.hereEmpty')}</p>
        ) : (
          groups.map(([key, g]) => (
            <div key={key}>
              <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-semibold text-muted-foreground">{g.label}</div>
              {g.rows.map((d) => (
                <label key={d.id} className="flex items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0">
                  <input
                    type="checkbox"
                    checked={picked.has(d.id)}
                    onChange={() => toggle(d.id)}
                    data-testid={`move-here-pick-${d.id}`}
                  />
                  {d.name}
                </label>
              ))}
            </div>
          ))
        )}
      </div>
      {error && <p className="mt-2 text-sm text-destructive" role="alert" data-testid="move-error">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={props.onClose} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          {t('actions.cancel')}
        </button>
        <button
          type="button"
          disabled={busy || picked.size === 0}
          onClick={() => void run([...picked], targetContractId)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="move-here-confirm"
        >
          {t('move.confirm')}
        </button>
      </div>
    </Dialog>
  );
}

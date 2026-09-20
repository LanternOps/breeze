import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { conversionPaths, type ConversionLedgerEntry, type LedgerPage } from './conversionApi';
export default function ConversionLedger({ orgId, policyId, revision = 0, onChanged }: {
  orgId?: string; policyId?: string; revision?: number; onChanged?: () => void;
}) {
  const { t } = useTranslation(['monitoring', 'common']);
  const [rows, setRows] = useState<ConversionLedgerEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async (next?: string) => {
    const current = ++generation.current;
    setLoading(true); setError(false);
    try {
      const response = await fetchWithAuth(conversionPaths.ledger({ orgId, policyId, cursor: next, limit: 25 }));
      if (!response.ok) throw new Error('ledger_read_failed');
      const page: LedgerPage = await response.json();
      if (current !== generation.current) return;
      setRows((old) => next ? [...old, ...page.items] : page.items); setCursor(page.nextCursor);
    } catch { if (current === generation.current) setError(true); }
    finally { if (current === generation.current) setLoading(false); }
  }, [orgId, policyId]);
  useEffect(() => { setRows([]); void load(); return () => { generation.current++; }; }, [load, revision]);
  const undo = async (row: ConversionLedgerEntry) => {
    if (!row.revertable || row.revertedAt || busy) return;
    setBusy(true);
    try {
      await runAction({ request: () => fetchWithAuth(conversionPaths.revert(row.id), { method: 'POST' }),
        errorFallback: t('monitoring:conversion.errors.revert'), successMessage: t('monitoring:conversion.undone', { count: 1 }) });
      onChanged?.();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('monitoring:conversion.errors.revert') });
    } finally { setBusy(false); await load(); }
  };
  return <section data-testid="conversion-ledger" className="space-y-3 rounded border p-4">
    <h3>{t('monitoring:conversion.ledger.title')}</h3>
    <p>{t('monitoring:conversion.ledger.deadline')}</p>
    {loading && <p>{t('common:states.loading')}</p>}
    {error && <button onClick={() => void load()}>{t('common:actions.retry')}</button>}
    {!loading && !error && rows.length === 0 && <p>{t('monitoring:conversion.ledger.empty')}</p>}
    <ul>{rows.map((row) => <li key={row.id}>
      <p>{row.sourceName} · {row.convertedAt} · {row.convertedBy ?? t('monitoring:conversion.ledger.system')}</p>
      <ul>{row.outputs.map((output) => <li key={`${output.monitorId}:${output.role}`}>
        <a href={`/alerts/monitors/${output.monitorId}`}>{output.monitorId}</a> · {output.role}
      </li>)}</ul>
      <button data-testid={`ledger-undo-${row.id}`} disabled={loading || error || busy || !row.revertable || !!row.revertedAt}
        onClick={() => void undo(row)}>{t('monitoring:conversion.ledger.undo')}</button>
    </li>)}</ul>
    {cursor && <button data-testid="ledger-more" disabled={loading} onClick={() => void load(cursor)}>{t('monitoring:conversion.ledger.more')}</button>}
  </section>;
}

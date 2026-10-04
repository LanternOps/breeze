import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { BookCheck } from 'lucide-react';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { ActionError, runAction } from '@/lib/runAction';
import { useHashTab } from '@/lib/useHashState';
import { useStableT } from '@/lib/i18n/useStableT';
import { formatPercent } from '@/lib/i18n/format';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { EmptyState } from '../shared/EmptyState';
import { PageHeader } from '../shared/PageHeader';

const TABS = ['fixes', 'steps'] as const;
const PAGE_SIZE = 50;
const CONDITION_DEBOUNCE_MS = 300;
const FILTER_ALL = '';

type FixStatus = 'active' | 'demoted' | 'retired';
type FixScope = 'all_clients' | 'this_client';

interface FixMemoryRow {
  id: string;
  scope: FixScope;
  orgId: string | null;
  fixKind: string;
  label: string;
  osType: string | null;
  attempts: number;
  verified: number;
  failed: number;
  recurred: number;
  successRate: number;
  status: FixStatus;
  stale: boolean;
  lastVerifiedAt: string | null;
  condition: string | null;
  signatureKeyPrefix: string;
}

interface ReviewedSteps {
  id: string;
  title: string;
  steps: string[];
  osType: string | null;
  reviewedAt: string;
}

type RetireTarget = { kind: 'fix' | 'steps'; id: string };

const selectClass = 'h-9 rounded-md border bg-background px-2 text-sm';
const thClass = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground';

type StatusKey = 'active' | 'demoted' | 'retired' | 'stale';

function statusTone(status: FixStatus, stale: boolean): { key: StatusKey; className: string } {
  if (status === 'retired') return { key: 'retired', className: 'bg-muted text-muted-foreground' };
  if (status === 'demoted') return { key: 'demoted', className: 'bg-warning/15 text-warning' };
  if (stale) return { key: 'stale', className: 'bg-warning/15 text-warning' };
  return { key: 'active', className: 'bg-success/15 text-success' };
}

export default function FixMemoryPage() {
  const { t } = useTranslation('common');
  const stableT = useStableT(t);
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const [tab, setTab] = useHashTab(TABS, 'fixes');

  // Filters are transient component state (not URL state).
  const [osType, setOsType] = useState(FILTER_ALL);
  const [status, setStatus] = useState(FILTER_ALL);
  const [scope, setScope] = useState(FILTER_ALL);
  const [conditionInput, setConditionInput] = useState('');
  const [condition, setCondition] = useState('');

  const [rows, setRows] = useState<FixMemoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const loadSeq = useRef(0);

  const [steps, setSteps] = useState<ReviewedSteps[]>([]);
  const [stepsLoading, setStepsLoading] = useState(false);
  const [stepsError, setStepsError] = useState(false);

  const [retireTarget, setRetireTarget] = useState<RetireTarget | null>(null);
  const [retiring, setRetiring] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => setCondition(conditionInput.trim()), CONDITION_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [conditionInput]);

  const buildQuery = useCallback((offset: number) => {
    const params = new URLSearchParams();
    if (osType) params.set('osType', osType);
    if (status) params.set('status', status);
    if (scope) params.set('scope', scope);
    if (condition) params.set('condition', condition);
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    return `/fix-memory?${params.toString()}`;
  }, [osType, status, scope, condition]);

  const fetchPage = useCallback(async (offset: number) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth(buildQuery(offset));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: FixMemoryRow[]; total?: number };
      if (seq !== loadSeq.current) return; // a newer filter/page superseded this response
      const data = body.data ?? [];
      setRows((prev) => (offset === 0 ? data : [...prev, ...data]));
      setTotal(body.total ?? data.length);
    } catch {
      if (seq !== loadSeq.current) return;
      setLoadError(true);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [buildQuery]);

  useEffect(() => {
    if (tab !== 'fixes') return;
    void fetchPage(0);
  }, [tab, fetchPage, reloadKey]);

  useEffect(() => {
    if (tab !== 'steps') return;
    let cancelled = false;
    setStepsLoading(true);
    setStepsError(false);
    (async () => {
      try {
        const res = await fetchWithAuth('/fix-memory/instructions');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: ReviewedSteps[] };
        if (!cancelled) setSteps(body.data ?? []);
      } catch {
        if (!cancelled) setStepsError(true);
      } finally {
        if (!cancelled) setStepsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, reloadKey]);

  const confirmRetire = async () => {
    if (!retireTarget) return;
    const target = retireTarget;
    const isFix = target.kind === 'fix';
    setRetiring(true);
    try {
      await runAction({
        request: () => fetchWithAuth(
          isFix ? `/fix-memory/${target.id}/retire` : `/fix-memory/instructions/${target.id}/retire`,
          { method: 'POST' },
        ),
        errorFallback: stableT(isFix ? 'fixMemoryPage.retire.failed' : 'fixMemoryPage.steps.failed'),
        successMessage: stableT(isFix ? 'fixMemoryPage.retire.success' : 'fixMemoryPage.steps.success'),
      });
      if (isFix) {
        setRows((prev) => prev.map((r) => (r.id === target.id ? { ...r, status: 'retired' } : r)));
      } else {
        setSteps((prev) => prev.filter((s) => s.id !== target.id));
      }
      setRetireTarget(null);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // let auth redirect handle it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: stableT(isFix ? 'fixMemoryPage.retire.failed' : 'fixMemoryPage.steps.failed') });
      }
      setRetireTarget(null);
    } finally {
      setRetiring(false);
    }
  };

  const scopeLabel = (s: FixScope) => (s === 'all_clients' ? t('fixMemoryPage.scope.everyClient') : t('fixMemoryPage.scope.oneClient'));
  const statusLabel = (key: StatusKey) => {
    switch (key) {
      case 'retired': return t('fixMemoryPage.status.retired');
      case 'demoted': return t('fixMemoryPage.status.demoted');
      case 'stale': return t('fixMemoryPage.status.stale');
      default: return t('fixMemoryPage.status.active');
    }
  };
  const canRetire = (r: FixMemoryRow) => r.status !== 'retired' && (r.scope === 'this_client' || canManagePartnerWide);
  const fmtDate = (v: string | null) => (v ? formatDateTime(v) : t('fixMemoryPage.never'));

  const tabButton = (id: (typeof TABS)[number], label: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={tab === id}
      data-testid={`fix-memory-tab-${id}`}
      onClick={() => setTab(id)}
      className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      {label}
    </button>
  );

  const retryButton = (testId: string) => (
    <button type="button" data-testid={testId} onClick={() => setReloadKey((k) => k + 1)} className="h-9 rounded-md border px-3 text-sm hover:bg-muted">
      {t('fixMemoryPage.retry')}
    </button>
  );

  return (
    <div className="space-y-4" data-testid="fix-memory-page">
      <PageHeader icon={<BookCheck className="h-5 w-5" />} title={t('fixMemoryPage.title')} description={t('fixMemoryPage.subtitle')} />

      <div role="tablist" className="flex gap-1 border-b">
        {tabButton('fixes', t('fixMemoryPage.tabs.fixes'))}
        {tabButton('steps', t('fixMemoryPage.tabs.steps'))}
      </div>

      {tab === 'fixes' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label={t('fixMemoryPage.filters.os')} data-testid="fix-memory-filter-os" className={selectClass} value={osType} onChange={(e) => setOsType(e.target.value)}>
              <option value="">{t('fixMemoryPage.filters.anyOs')}</option>
              <option value="windows">Windows</option>
              <option value="macos">macOS</option>
              <option value="linux">Linux</option>
            </select>
            <select aria-label={t('fixMemoryPage.filters.status')} data-testid="fix-memory-filter-status" className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t('fixMemoryPage.filters.anyStatus')}</option>
              <option value="active">{t('fixMemoryPage.status.active')}</option>
              <option value="demoted">{t('fixMemoryPage.status.demoted')}</option>
              <option value="retired">{t('fixMemoryPage.status.retired')}</option>
            </select>
            <select aria-label={t('fixMemoryPage.filters.scope')} data-testid="fix-memory-filter-scope" className={selectClass} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">{t('fixMemoryPage.filters.anyScope')}</option>
              <option value="all_clients">{t('fixMemoryPage.scope.everyClient')}</option>
              <option value="this_client">{t('fixMemoryPage.scope.oneClient')}</option>
            </select>
            <input
              type="search"
              data-testid="fix-memory-filter-condition"
              aria-label={t('fixMemoryPage.filters.condition')}
              placeholder={t('fixMemoryPage.filters.condition')}
              className="h-9 min-w-[14rem] rounded-md border bg-background px-3 text-sm"
              value={conditionInput}
              onChange={(e) => setConditionInput(e.target.value)}
            />
          </div>

          {loadError ? (
            <div className="flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" data-testid="fix-memory-error" role="alert">
              <span>{t('fixMemoryPage.errors.loadFailed')}</span>
              {retryButton('fix-memory-retry')}
            </div>
          ) : rows.length === 0 && !loading ? (
            <EmptyState size="sm" headingLevel={2} testId="fix-memory-empty" icon={<BookCheck className="h-5 w-5" />} title={t('fixMemoryPage.empty')} />
          ) : (
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/30">
                  <tr>
                    <th className={thClass}>{t('fixMemoryPage.columns.fix')}</th>
                    <th className={thClass}>{t('fixMemoryPage.columns.record')}</th>
                    <th className={thClass}>{t('fixMemoryPage.columns.rate')}</th>
                    <th className={thClass}>{t('fixMemoryPage.columns.scope')}</th>
                    <th className={thClass}>{t('fixMemoryPage.columns.os')}</th>
                    <th className={thClass}>{t('fixMemoryPage.columns.condition')}</th>
                    <th className={thClass}>{t('fixMemoryPage.columns.lastVerified')}</th>
                    <th className={thClass}>{t('fixMemoryPage.columns.status')}</th>
                    <th className={thClass}><span className="sr-only">{t('fixMemoryPage.columns.actions')}</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => {
                    const tone = statusTone(r.status, r.stale);
                    return (
                      <tr key={r.id} data-testid={`fix-memory-row-${r.id}`}>
                        <td className="px-3 py-2 font-medium">{r.label}</td>
                        <td className="px-3 py-2 tabular-nums">{`${r.verified}/${r.attempts}`}</td>
                        <td className="px-3 py-2 tabular-nums">{formatPercent(r.successRate, { maximumFractionDigits: 0 })}</td>
                        <td className="px-3 py-2">{scopeLabel(r.scope)}</td>
                        <td className="px-3 py-2 capitalize">{r.osType ?? '—'}</td>
                        <td className="px-3 py-2 font-mono text-xs">{r.condition ?? t('fixMemoryPage.signature', { prefix: r.signatureKeyPrefix })}</td>
                        <td className="px-3 py-2">{fmtDate(r.lastVerifiedAt)}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone.className}`}>{statusLabel(tone.key)}</span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {canRetire(r) && (
                            <button type="button" data-testid={`fix-memory-retire-${r.id}`} onClick={() => setRetireTarget({ kind: 'fix', id: r.id })} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">
                              {t('fixMemoryPage.retire.action')}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!loadError && rows.length < total && (
            <button type="button" data-testid="fix-memory-load-more" disabled={loading} onClick={() => void fetchPage(rows.length)} className="h-9 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50">
              {t('fixMemoryPage.loadMore')}
            </button>
          )}
        </div>
      )}

      {tab === 'steps' && (
        <div className="space-y-3">
          {stepsError ? (
            <div className="flex items-center gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" data-testid="fix-steps-error" role="alert">
              <span>{t('fixMemoryPage.errors.loadFailed')}</span>
              {retryButton('fix-steps-retry')}
            </div>
          ) : steps.length === 0 && !stepsLoading ? (
            <EmptyState size="sm" headingLevel={2} testId="fix-steps-empty" icon={<BookCheck className="h-5 w-5" />} title={t('fixMemoryPage.steps.empty')} />
          ) : (
            <ul className="space-y-2">
              {steps.map((s) => (
                <li key={s.id} data-testid={`fix-steps-row-${s.id}`} className="rounded-lg border bg-card p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{s.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {[s.osType, fmtDate(s.reviewedAt)].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    {canManagePartnerWide && (
                      <button type="button" data-testid={`fix-steps-retire-${s.id}`} onClick={() => setRetireTarget({ kind: 'steps', id: s.id })} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">
                        {t('fixMemoryPage.retire.action')}
                      </button>
                    )}
                  </div>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
                    {s.steps.map((step, i) => <li key={i}>{step}</li>)}
                  </ol>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={retireTarget !== null}
        onClose={() => setRetireTarget(null)}
        onConfirm={() => void confirmRetire()}
        title={t('fixMemoryPage.retire.confirmTitle')}
        message={t('fixMemoryPage.retire.confirmBody')}
        confirmLabel={retireTarget?.kind === 'steps' ? t('fixMemoryPage.steps.retire') : t('fixMemoryPage.retire.confirm')}
        confirmTestId="fix-memory-retire-confirm"
        isLoading={retiring}
      />
    </div>
  );
}

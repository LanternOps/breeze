import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { useHashState } from '@/lib/useHashState';
import { useJwtClaims } from '../../lib/authScope';
import SetupStepper from '../setup/SetupStepper';
import { useTicketImportAccess } from './importAccess';
import {
  DEFAULT_IMPORT_HASH,
  IMPORT_STEPS,
  formatImportHash,
  parseImportHash,
  type ImportHash,
  type ImportStep,
} from './ticketImportHash';
import {
  ImportReadError,
  isRunActive,
  readImport,
  windowsOfSource,
  type ImportModule,
  type ImportRun,
  type ImportSource,
  type ImportSourceDetail,
  type MigrationWindow,
  type Preflight,
  type ConnectReport,
} from './ticketImportApi';
import ConnectStep from './ConnectStep';
import PreflightStep, { connectWarningText } from './PreflightStep';
import MappingsStep from './MappingsStep';
import RunStep from './RunStep';
import WindowStep from './WindowStep';
import CloseStep from './CloseStep';
import MigrationWindowList from './MigrationWindows';
import { Notice, Panel, buttonPrimary, buttonSecondary } from './importUi';
import { usePartnerOrgs } from './usePartnerOrgs';

/**
 * /tickets/import (#8313 W6; spec 2026-10-19 §5.11): the wizard that drives
 * the ticket import API end to end, and the cutover runbook (§7) step by
 * step — connect, preflight, mappings, dry run, window, bulk run, delta run,
 * close. Not a setting (settings rule 2: an import is an action), so it lives
 * beside the ticket list, not under /settings. Partner-scope, partner-wide
 * admins only; the server enforces every route.
 *
 * URL state is the hash: `#source=<id>&step=<step>` (CLAUDE.md URL state rule).
 */
const STEP_LABEL: Record<ImportStep, string> = {
  connect: 'steps.connect',
  preflight: 'steps.preflight',
  mappings: 'steps.mappings',
  'dry-run': 'steps.dryRun',
  window: 'steps.window',
  bulk: 'steps.bulk',
  delta: 'steps.delta',
  close: 'steps.close',
};

export default function TicketImportPage() {
  const { t } = useTranslation('ticketImport');
  const access = useTicketImportAccess();
  const claims = useJwtClaims();
  const partnerId = claims.status === 'resolved' ? claims.claims.partnerId : null;
  const [hash, setHash] = useHashState<ImportHash>(DEFAULT_IMPORT_HASH, parseImportHash);
  const { nameOf } = usePartnerOrgs();

  const [modules, setModules] = useState<ImportModule[]>([]);
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [sourcesFailed, setSourcesFailed] = useState(false);
  const [detail, setDetail] = useState<ImportSourceDetail | null>(null);
  const [detailMissing, setDetailMissing] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [windows, setWindows] = useState<MigrationWindow[]>([]);
  const [windowsFailed, setWindowsFailed] = useState(false);
  const [preflights, setPreflights] = useState<Record<string, Preflight>>({});
  // The live test's report from connecting a source here (token_not_read_only, ...), shown until dismissed.
  const [connectReport, setConnectReport] = useState<{ sourceId: string; report: ConnectReport } | null>(null);

  const go = useCallback((next: ImportHash) => {
    setHash(next);
    const formatted = formatImportHash(next);
    if (formatted) window.location.hash = formatted;
    else window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, [setHash]);

  const allowed = access === 'allowed';

  const loadSources = useCallback(async () => {
    try {
      const { data } = await readImport<ImportSource[]>('/ticket-imports/sources');
      setSources(data);
      setSourcesFailed(false);
    } catch {
      setSourcesFailed(true);
    }
  }, []);

  const loadWindows = useCallback(async () => {
    try {
      const { data } = await readImport<MigrationWindow[]>('/migration-windows');
      setWindows(data);
      setWindowsFailed(false);
    } catch {
      setWindowsFailed(true);
    }
  }, []);

  const sourceId = hash.sourceId;
  // Each read is numbered: only the newest answer for the current source lands,
  // so a slow answer for a source left behind (or an older refresh) never
  // overwrites a newer one.
  const detailSeq = useRef(0);
  const runsSeq = useRef(0);
  const loadDetail = useCallback(async () => {
    const seq = ++detailSeq.current;
    if (!sourceId) { setDetail(null); return; }
    try {
      const { data } = await readImport<ImportSourceDetail>(`/ticket-imports/sources/${sourceId}`);
      if (seq !== detailSeq.current) return;
      setDetail(data);
      setDetailMissing(false);
      setDetailFailed(false);
    } catch (error) {
      if (seq !== detailSeq.current) return;
      if (error instanceof ImportReadError && error.status === 404) setDetailMissing(true);
      else setDetailFailed(true);
    }
  }, [sourceId]);

  const loadRuns = useCallback(async () => {
    const seq = ++runsSeq.current;
    if (!sourceId) { setRuns([]); return; }
    try {
      const { data } = await readImport<ImportRun[]>(`/ticket-imports/sources/${sourceId}/runs`);
      if (seq !== runsSeq.current) return;
      setRuns(data);
    } catch {
      // The steps keep the runs they have; the next refresh tries again.
    }
  }, [sourceId]);

  useEffect(() => {
    if (!allowed) return;
    void loadSources();
    void loadWindows();
    readImport<ImportModule[]>('/ticket-imports/modules').then(({ data }) => setModules(data)).catch(() => setModules([]));
  }, [allowed, loadSources, loadWindows]);

  useEffect(() => {
    setDetail(null);
    setDetailMissing(false);
    setDetailFailed(false);
    setRuns([]);
    if (!allowed || !sourceId) return;
    void loadDetail();
    void loadRuns();
  }, [allowed, sourceId, loadDetail, loadRuns]);

  const refreshSource = useCallback(() => {
    void loadDetail();
    void loadRuns();
    void loadSources();
  }, [loadDetail, loadRuns, loadSources]);

  const refreshAll = useCallback(() => {
    refreshSource();
    void loadWindows();
  }, [refreshSource, loadWindows]);

  const { open: openWindow, latest: latestWindow } = useMemo(() => windowsOfSource(windows, detail), [windows, detail]);
  const otherOpenWindow = windows.find((w) => w.status === 'open' && w.principalId !== detail?.principalId) ?? null;
  const step: ImportStep | null = hash.step ?? (sourceId ? 'preflight' : null);
  const runActive = runs.some((r) => isRunActive(r.state)) || (detail?.activeRunId ?? null) !== null;

  if (access === 'unknown') {
    return <p className="p-6 text-sm text-muted-foreground" data-testid="ticket-import-loading">{t('page.loading')}</p>;
  }
  if (access === 'denied') {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <h1 className="text-xl font-semibold" data-testid="ticket-import-heading">{t('page.title')}</h1>
        <Notice tone="warning" testId="ticket-import-denied">{t('page.denied')}</Notice>
        <a href="/tickets" className={buttonSecondary} data-testid="ticket-import-back">{t('page.back')}</a>
      </div>
    );
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold" data-testid="ticket-import-heading">{t('page.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('page.subtitle')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {(sourceId || step === 'connect') && (
          <button type="button" className={buttonSecondary} onClick={() => go(DEFAULT_IMPORT_HASH)} data-testid="ticket-import-all-sources">
            {t('page.allSources')}
          </button>
        )}
        <a href="/tickets" className={buttonSecondary} data-testid="ticket-import-back">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('page.back')}
        </a>
      </div>
    </div>
  );

  const windowList = (
    <MigrationWindowList windows={windows} loadFailed={windowsFailed} nameOfOrg={nameOf} onChanged={refreshAll} />
  );

  // The source list: no source chosen and not connecting a new one.
  if (!sourceId && step !== 'connect') {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        {header}
        <Panel
          title={t('sources.title')}
          testId="ticket-import-sources"
          actions={(
            <button type="button" className={buttonPrimary} onClick={() => go({ sourceId: null, step: 'connect' })}
              data-testid="ticket-import-connect-new">{t('sources.connectNew')}</button>
          )}
        >
          {sourcesFailed && <Notice tone="error" testId="ticket-import-sources-failed">{t('sources.loadFailed')}</Notice>}
          {sources === null && !sourcesFailed && <p className="text-sm text-muted-foreground">{t('page.loading')}</p>}
          {sources?.length === 0 && <p className="text-sm text-muted-foreground" data-testid="ticket-import-sources-empty">{t('sources.empty')}</p>}
          {sources && sources.length > 0 && (
            <ul className="divide-y" data-testid="ticket-import-sources-list">
              {sources.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`ticket-import-source-row-${s.id}`}>
                  <div className="min-w-0 text-sm">
                    <span className="font-medium">{s.label}</span>
                    <span className="block break-all text-xs text-muted-foreground">{s.baseUrl}</span>
                    <span className="block text-xs text-muted-foreground">
                      {!s.hasCredentials ? t('sources.revoked') : s.activeRunId ? t('sources.activeRun') : t('sources.ready')}
                    </span>
                  </div>
                  <button type="button" className={buttonSecondary} onClick={() => go({ sourceId: s.id, step: 'preflight' })}
                    data-testid={`ticket-import-source-open-${s.id}`}>{t('sources.open')}</button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {windowList}
      </div>
    );
  }

  const currentIndex = Math.max(0, IMPORT_STEPS.indexOf(step ?? 'connect'));
  const toStep = (next: ImportStep) => go({ sourceId, step: next });

  let body: ReactNode;
  if (sourceId && detailMissing) {
    body = <Notice tone="error" testId="ticket-import-source-missing">{t('page.sourceMissing')}</Notice>;
  } else if (!sourceId) {
    body = (
      <ConnectStep
        modules={modules}
        sources={sources ?? []}
        source={null}
        onCreated={(id, report) => {
          if (report) setConnectReport({ sourceId: id, report });
          void loadSources();
          go({ sourceId: id, step: 'preflight' });
        }}
        onChanged={refreshSource}
        onDeleted={() => go(DEFAULT_IMPORT_HASH)}
      />
    );
  } else if (!detail && detailFailed) {
    body = (
      <Notice tone="error" testId="ticket-import-source-failed">
        {t('page.sourceLoadFailed')}{' '}
        <button type="button" className="font-medium underline underline-offset-2"
          onClick={() => { setDetailFailed(false); void loadDetail(); void loadRuns(); }}
          data-testid="ticket-import-source-retry">{t('page.retry')}</button>
      </Notice>
    );
  } else if (!detail) {
    body = <p className="text-sm text-muted-foreground" data-testid="ticket-import-source-loading">{t('page.loading')}</p>;
  } else {
    const nameOfOrg = nameOf;
    switch (step) {
      case 'connect':
        body = <ConnectStep modules={modules} sources={sources ?? []} source={detail} onCreated={() => undefined}
          onChanged={refreshSource} onDeleted={() => { void loadSources(); go(DEFAULT_IMPORT_HASH); }} />;
        break;
      case 'mappings':
        body = <MappingsStep source={detail} preflight={preflights[detail.id] ?? null}
          onPreflight={(p) => setPreflights((prev) => ({ ...prev, [detail.id]: p }))}
          onSaved={refreshSource} onContinue={() => toStep('dry-run')} />;
        break;
      case 'dry-run':
      case 'bulk':
      case 'delta':
        body = <RunStep key={step} kind={step === 'dry-run' ? 'dry_run' : step} source={detail} runs={runs} openWindow={openWindow} latestWindow={latestWindow}
          nameOfOrg={nameOfOrg} onRunsChanged={refreshAll} onOpenWindowStep={() => toStep('window')}
          onOpenMappings={() => toStep('mappings')}
          onContinue={() => toStep(step === 'dry-run' ? 'window' : step === 'bulk' ? 'delta' : 'close')} />;
        break;
      case 'window':
        body = partnerId
          ? <WindowStep source={detail} openWindow={openWindow} otherOpenWindow={otherOpenWindow} partnerId={partnerId}
            nameOfOrg={nameOfOrg} onOpened={refreshAll} onContinue={() => toStep('bulk')} />
          : <Notice tone="error">{t('page.denied')}</Notice>;
        break;
      case 'close':
        body = <CloseStep source={detail} latestWindow={latestWindow} runActive={runActive} nameOfOrg={nameOfOrg}
          onClosed={refreshAll} onManageSource={() => toStep('connect')} />;
        break;
      case 'preflight':
      default:
        body = <PreflightStep source={detail} preflight={preflights[detail.id] ?? null}
          onPreflight={(p) => setPreflights((prev) => ({ ...prev, [detail.id]: p }))} onContinue={() => toStep('mappings')} />;
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      {header}
      {detail && <p className="text-sm" data-testid="ticket-import-current-source">{t('page.currentSource', { label: detail.label })}</p>}
      <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <div data-testid="ticket-import-stepper">
          <SetupStepper
            orientation="vertical"
            ariaLabel={t('steps.aria')}
            steps={IMPORT_STEPS.map((s) => ({ label: t(/* i18n-dynamic */ STEP_LABEL[s]) }))}
            currentStep={currentIndex}
            reachableStep={sourceId ? IMPORT_STEPS.length - 1 : 0}
            onStepClick={sourceId ? (i) => toStep(IMPORT_STEPS[i]!) : undefined}
          />
        </div>
        <div className="min-w-0 space-y-4" data-testid={`ticket-import-step-${step ?? 'connect'}`}>
          {connectReport && connectReport.sourceId === sourceId && connectReport.report.warnings.length > 0 && (
            <Notice tone="warning" testId="ticket-import-connect-report">
              <span className="font-medium">{t('connect.reportTitle')}</span>
              <ul className="mt-1 list-disc pl-5">
                {connectReport.report.warnings.map((w, i) => (
                  <li key={`${w.code}-${i}`} data-testid={`ticket-import-connect-report-${w.code}`}>{connectWarningText(t, w.code, w.detail)}</li>
                ))}
              </ul>
              <button type="button" className="mt-1 text-xs underline" onClick={() => setConnectReport(null)}
                data-testid="ticket-import-connect-report-dismiss">{t('connect.reportDismiss')}</button>
            </Notice>
          )}
          {body}
        </div>
      </div>
      {windowList}
    </div>
  );
}

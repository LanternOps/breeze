import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import '../../lib/i18n';
import {
  ALERT_TICKETING_SEVERITIES as SEVERITIES_ASCENDING,
  type AlertTicketingInactiveReason,
  type AlertTicketingSeverity as AlertSeverity,
} from '@breeze/shared';

// Alert -> PSA ticket settings for one partner-wide PSA connection. Partner
// level only: there is deliberately no per-organization override. Server
// contract: apps/api/src/routes/psaAlertTicketing.ts.

/** Most severe first, for display. */
const ALERT_TICKETING_SEVERITIES = [...SEVERITIES_ASCENDING].reverse() as AlertSeverity[];

export type AlertTicketingConfig = {
  enabled: boolean;
  boardId?: number;
  openStatusId?: number;
  closedStatusId?: number;
  typeId?: number;
  priorityBySeverity: Partial<Record<AlertSeverity, number>>;
  minSeverity: AlertSeverity;
  ruleIds?: string[];
  monitorIds?: string[];
  closeOnResolve: boolean;
  noteOnAcknowledge: boolean;
  hourlyCreateCap: number;
  lookbackHours: number;
};

export type AlertTicketingView = {
  connectionId: string;
  provider: string;
  capable: boolean;
  rev: number;
  config: AlertTicketingConfig | null;
  configInvalid: boolean;
  enabledAt: string | null;
  paused: null | { reason: 'auth'; at: string };
  status: { active: true } | { active: false; reason: AlertTicketingInactiveReason };
  bound: boolean;
  serviceManagementMode: 'native' | 'external' | 'off';
  companyLinksConfirmed: boolean;
  canManage: boolean;
};

type OptionList<T> = { options: T[]; truncated: boolean };
export type AlertTicketingOptions = {
  boards: OptionList<{ id: number; name: string }>;
  priorities: OptionList<{ id: number; name: string }>;
  statuses: null | OptionList<{ id: number; name: string; closed: boolean | null }>;
};

type OptionsFailure = { error: string; detail?: string };

const REV_CONFLICT = 'alert_ticketing_rev_conflict';

const selectClass =
  'h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60';

function toId(value: string): number | undefined {
  const n = Number(value);
  return value !== '' && Number.isInteger(n) && n > 0 ? n : undefined;
}

export interface PsaAlertTicketingCardProps {
  connectionId: string;
  connectionName: string;
}

export default function PsaAlertTicketingCard({ connectionId, connectionName }: PsaAlertTicketingCardProps) {
  const { t } = useTranslation('common');
  const tRef = useRef(t);
  tRef.current = t;
  const base = `/psa/connections/${connectionId}/alert-ticketing`;

  const [view, setView] = useState<AlertTicketingView | null>(null);
  const [options, setOptions] = useState<AlertTicketingOptions | null>(null);
  const [optionsFailure, setOptionsFailure] = useState<OptionsFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  // Form state (strings so empty = unset).
  const [enabled, setEnabled] = useState(false);
  const [boardId, setBoardId] = useState('');
  const [openStatusId, setOpenStatusId] = useState('');
  const [closedStatusId, setClosedStatusId] = useState('');
  const [priorities, setPriorities] = useState<Record<AlertSeverity, string>>({
    critical: '', high: '', medium: '', low: '', info: '',
  });
  const [minSeverity, setMinSeverity] = useState<AlertSeverity>('low');
  const [closeOnResolve, setCloseOnResolve] = useState(false);
  const [noteOnAcknowledge, setNoteOnAcknowledge] = useState(false);
  const [confirmLinks, setConfirmLinks] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const hydrate = useCallback((v: AlertTicketingView) => {
    const c = v.config;
    setEnabled(c?.enabled ?? false);
    setBoardId(c?.boardId ? String(c.boardId) : '');
    setOpenStatusId(c?.openStatusId ? String(c.openStatusId) : '');
    setClosedStatusId(c?.closedStatusId ? String(c.closedStatusId) : '');
    setPriorities({
      critical: String(c?.priorityBySeverity?.critical ?? ''),
      high: String(c?.priorityBySeverity?.high ?? ''),
      medium: String(c?.priorityBySeverity?.medium ?? ''),
      low: String(c?.priorityBySeverity?.low ?? ''),
      info: String(c?.priorityBySeverity?.info ?? ''),
    });
    setMinSeverity(c?.minSeverity ?? 'low');
    setCloseOnResolve(c?.closeOnResolve ?? false);
    setNoteOnAcknowledge(c?.noteOnAcknowledge ?? false);
    setConfirmLinks(false);
    setConfirmReplace(false);
  }, []);

  const loadView = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchWithAuth(base);
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        // Not ours to show: auth redirect handles 401; 403/404 mean no access
        // or no such connection.
        setLoadFailed(false);
        setView(null);
        return;
      }
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const body = await res.json();
      const next = body?.data as AlertTicketingView | undefined;
      if (!next) {
        setLoadFailed(true);
        return;
      }
      setLoadFailed(false);
      setView(next);
      hydrate(next);
    } catch {
      // Keep any previously loaded view so a failed reload never drops the form.
      setLoadFailed(true);
    }
  }, [base, hydrate]);

  useEffect(() => {
    void loadView();
  }, [loadView]);

  const canManage = view?.capable === true && view.canManage === true;

  // Live PSA lookups. Re-run when the chosen board changes so the status
  // lists belong to that board.
  const [optionsNonce, setOptionsNonce] = useState(0);
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    const qs = boardId ? `?boardId=${encodeURIComponent(boardId)}` : '';
    (async () => {
      try {
        const res = await fetchWithAuth(`${base}/options${qs}`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setOptions(o => (o ? { ...o, statuses: null } : o));
          setOptionsFailure({
            error: typeof body?.error === 'string' ? body.error : tRef.current('longTail.psa.PsaAlertTicketingCard.options.error'),
            detail: typeof body?.detail === 'string' ? body.detail : undefined,
          });
          return;
        }
        setOptionsFailure(null);
        setOptions(body?.data as AlertTicketingOptions);
      } catch {
        if (!cancelled) {
          setOptions(o => (o ? { ...o, statuses: null } : o));
          setOptionsFailure({ error: tRef.current('longTail.psa.PsaAlertTicketingCard.options.error') });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, canManage, boardId, optionsNonce]);

  const loadErrorAlert = loadFailed ? (
    <div
      role="alert"
      className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      data-testid="psa-alert-ticketing-load-error"
    >
      <p>{t('longTail.psa.PsaAlertTicketingCard.loadError.message')}</p>
      <button
        type="button"
        className="mt-2 rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
        data-testid="psa-alert-ticketing-load-retry"
        onClick={() => void loadView()}
      >
        {t('longTail.psa.PsaAlertTicketingCard.loadError.retry')}
      </button>
    </div>
  ) : null;

  if (!view && loadFailed) {
    return (
      <section
        className="rounded-lg border bg-card p-6 shadow-xs"
        data-testid="psa-alert-ticketing-card"
        aria-label={t('longTail.psa.PsaAlertTicketingCard.title')}
      >
        <h2 className="text-base font-semibold" data-testid="psa-alert-ticketing-title">
          {t('longTail.psa.PsaAlertTicketingCard.title')}
          <span className="ml-2 text-sm font-normal text-muted-foreground">{connectionName}</span>
        </h2>
        {loadErrorAlert}
      </section>
    );
  }
  if (!view || !view.capable) return null;

  const needsLinkConfirm = enabled && !view.companyLinksConfirmed;
  const missingIds = enabled && (!toId(boardId) || !toId(openStatusId) || !toId(closedStatusId));
  const needsReplaceConfirm = view.configInvalid === true;
  const saveDisabled = saving || missingIds || (needsLinkConfirm && !confirmLinks) || (needsReplaceConfirm && !confirmReplace);

  const handleBoardChange = (value: string) => {
    setBoardId(value);
    // The old board's statuses must never be offered for the new board.
    setOptions(o => (o ? { ...o, statuses: null } : o));
    setOpenStatusId('');
    setClosedStatusId('');
  };

  const handleSave = async () => {
    const priorityBySeverity: Partial<Record<AlertSeverity, number>> = {};
    for (const sev of ALERT_TICKETING_SEVERITIES) {
      const id = toId(priorities[sev]);
      if (id) priorityBySeverity[sev] = id;
    }
    // Spread the loaded config first so fields this form does not edit
    // (ruleIds, monitorIds, typeId, hourlyCreateCap, lookbackHours) survive.
    const config: Record<string, unknown> = {
      ...(view.config ?? {}),
      enabled,
      priorityBySeverity,
      minSeverity,
      closeOnResolve,
      noteOnAcknowledge,
    };
    for (const [key, value] of [['boardId', boardId], ['openStatusId', openStatusId], ['closedStatusId', closedStatusId]] as const) {
      const id = toId(value);
      if (id) config[key] = id;
      else delete config[key];
    }
    const payload: Record<string, unknown> = { config, expectedRev: view.rev };
    if (needsLinkConfirm && confirmLinks) payload.confirmCompanyLinks = true;

    setSaving(true);
    try {
      const result = await runAction<{ data: AlertTicketingView }>({
        request: () => fetchWithAuth(base, { method: 'PUT', body: JSON.stringify(payload) }),
        errorFallback: t('longTail.psa.PsaAlertTicketingCard.errors.save'),
        successMessage: t('longTail.psa.PsaAlertTicketingCard.saved'),
        suppressErrorToast: (_status, code) => code === REV_CONFLICT,
      });
      if (result?.data) {
        setView(result.data);
        hydrate(result.data);
      }
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError && err.code === REV_CONFLICT) {
        showToast({ type: 'warning', message: t('longTail.psa.PsaAlertTicketingCard.conflict') });
        await loadView();
        return;
      }
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('longTail.psa.PsaAlertTicketingCard.errors.save') });
      }
    } finally {
      setSaving(false);
    }
  };

  const statusText = (() => {
    if (view.status.active) return t('longTail.psa.PsaAlertTicketingCard.status.active');
    switch (view.status.reason) {
      case 'not_external':
      case 'not_bound':
        return t('longTail.psa.PsaAlertTicketingCard.status.notExternal');
      case 'disabled':
        return t('longTail.psa.PsaAlertTicketingCard.status.disabled');
      case 'paused':
        return t('longTail.psa.PsaAlertTicketingCard.status.paused');
      case 'company_links_unverified':
        return t('longTail.psa.PsaAlertTicketingCard.status.companyLinksUnverified');
      case 'invalid_config':
        return t('longTail.psa.PsaAlertTicketingCard.status.invalidConfig');
      case 'credentials_unusable':
        return t('longTail.psa.PsaAlertTicketingCard.status.credentialsUnusable');
      default:
        return t('longTail.psa.PsaAlertTicketingCard.status.unsupportedProvider');
    }
  })();

  const boards = options?.boards.options ?? [];
  const statuses = options?.statuses?.options ?? [];
  const priorityOptions = options?.priorities.options ?? [];
  const truncated = !!(options?.boards.truncated || options?.priorities.truncated || options?.statuses?.truncated);
  const statusLabel = (s: { name: string; closed: boolean | null }) =>
    s.closed === true ? t('longTail.psa.PsaAlertTicketingCard.closedSuffix', { name: s.name }) : s.name;
  const sevLabels: Record<AlertSeverity, string> = {
    critical: t('longTail.psa.PsaAlertTicketingCard.severity.critical'),
    high: t('longTail.psa.PsaAlertTicketingCard.severity.high'),
    medium: t('longTail.psa.PsaAlertTicketingCard.severity.medium'),
    low: t('longTail.psa.PsaAlertTicketingCard.severity.low'),
    info: t('longTail.psa.PsaAlertTicketingCard.severity.info'),
  };
  const boardName = boards.find(b => String(b.id) === boardId)?.name;

  return (
    <section
      className="rounded-lg border bg-card p-6 shadow-xs"
      data-testid="psa-alert-ticketing-card"
      aria-label={t('longTail.psa.PsaAlertTicketingCard.title')}
    >
      <div>
        <h2 className="text-base font-semibold" data-testid="psa-alert-ticketing-title">
          {t('longTail.psa.PsaAlertTicketingCard.title')}
          <span className="ml-2 text-sm font-normal text-muted-foreground">{connectionName}</span>
        </h2>
        <p className="text-sm text-muted-foreground" data-testid="psa-alert-ticketing-scope-note">
          {t('longTail.psa.PsaAlertTicketingCard.scopeNote')}
        </p>
      </div>

      {loadErrorAlert}

      {view.paused && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
          data-testid="psa-alert-ticketing-paused"
        >
          {t('longTail.psa.PsaAlertTicketingCard.pausedBanner')}
        </div>
      )}

      <p className="mt-4 text-sm" data-testid="psa-alert-ticketing-status">{statusText}</p>

      {!canManage ? (
        <dl className="mt-4 space-y-1 text-sm" data-testid="psa-alert-ticketing-readonly">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">{t('longTail.psa.PsaAlertTicketingCard.readOnly.enabled')}</dt>
            <dd data-testid="psa-alert-ticketing-readonly-enabled">
              {view.config?.enabled ? t('longTail.psa.PsaAlertTicketingCard.yes') : t('longTail.psa.PsaAlertTicketingCard.no')}
            </dd>
          </div>
          {view.config?.boardId !== undefined && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('longTail.psa.PsaAlertTicketingCard.fields.board')}</dt>
              <dd data-testid="psa-alert-ticketing-readonly-board">
                {boardName ?? `#${view.config.boardId}`}
              </dd>
            </div>
          )}
        </dl>
      ) : (
        <form
          className="mt-4 space-y-4"
          data-testid="psa-alert-ticketing-form"
          onSubmit={e => {
            e.preventDefault();
            if (!saveDisabled) void handleSave();
          }}
        >
          {needsReplaceConfirm && (
            <div
              role="alert"
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
              data-testid="psa-alert-ticketing-config-invalid"
            >
              <p>{t('longTail.psa.PsaAlertTicketingCard.configInvalid.warning')}</p>
              <label className="mt-2 flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={confirmReplace}
                  onChange={e => setConfirmReplace(e.target.checked)}
                  data-testid="psa-alert-ticketing-confirm-replace"
                />
                {t('longTail.psa.PsaAlertTicketingCard.configInvalid.confirm')}
              </label>
            </div>
          )}

          {optionsFailure && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              data-testid="psa-alert-ticketing-options-error"
            >
              <p>{optionsFailure.error}</p>
              {optionsFailure.detail && <p className="mt-1 text-xs">{optionsFailure.detail}</p>}
              <button
                type="button"
                className="mt-2 rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted"
                data-testid="psa-alert-ticketing-options-retry"
                onClick={() => setOptionsNonce(n => n + 1)}
              >
                {t('longTail.psa.PsaAlertTicketingCard.options.retry')}
              </button>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setEnabled(e.target.checked)}
              data-testid="psa-alert-ticketing-enabled"
            />
            {t('longTail.psa.PsaAlertTicketingCard.fields.enabled')}
          </label>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <label htmlFor={`alert-ticketing-board-${connectionId}`} className="text-xs font-medium text-muted-foreground">
                {t('longTail.psa.PsaAlertTicketingCard.fields.board')}
              </label>
              <select
                id={`alert-ticketing-board-${connectionId}`}
                className={selectClass}
                value={boardId}
                onChange={e => handleBoardChange(e.target.value)}
                data-testid="psa-alert-ticketing-board"
              >
                <option value="">{t('longTail.psa.PsaAlertTicketingCard.selectPlaceholder')}</option>
                {boardId && !boards.some(b => String(b.id) === boardId) && <option value={boardId}>{`#${boardId}`}</option>}
                {boards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor={`alert-ticketing-open-${connectionId}`} className="text-xs font-medium text-muted-foreground">
                {t('longTail.psa.PsaAlertTicketingCard.fields.openStatus')}
              </label>
              <select
                id={`alert-ticketing-open-${connectionId}`}
                className={selectClass}
                value={openStatusId}
                disabled={!boardId}
                onChange={e => setOpenStatusId(e.target.value)}
                data-testid="psa-alert-ticketing-open-status"
              >
                <option value="">{t('longTail.psa.PsaAlertTicketingCard.selectPlaceholder')}</option>
                {openStatusId && !statuses.some(s => String(s.id) === openStatusId) && <option value={openStatusId}>{`#${openStatusId}`}</option>}
                {statuses.map(s => <option key={s.id} value={s.id}>{statusLabel(s)}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor={`alert-ticketing-closed-${connectionId}`} className="text-xs font-medium text-muted-foreground">
                {t('longTail.psa.PsaAlertTicketingCard.fields.closedStatus')}
              </label>
              <select
                id={`alert-ticketing-closed-${connectionId}`}
                className={selectClass}
                value={closedStatusId}
                disabled={!boardId}
                onChange={e => setClosedStatusId(e.target.value)}
                data-testid="psa-alert-ticketing-closed-status"
              >
                <option value="">{t('longTail.psa.PsaAlertTicketingCard.selectPlaceholder')}</option>
                {closedStatusId && !statuses.some(s => String(s.id) === closedStatusId) && <option value={closedStatusId}>{`#${closedStatusId}`}</option>}
                {statuses.map(s => <option key={s.id} value={s.id}>{statusLabel(s)}</option>)}
              </select>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-muted-foreground">
              {t('longTail.psa.PsaAlertTicketingCard.fields.priorityHeading')}
            </legend>
            <div className="grid gap-3 sm:grid-cols-5">
              {ALERT_TICKETING_SEVERITIES.map(sev => (
                <div key={sev} className="space-y-1">
                  <label htmlFor={`alert-ticketing-priority-${sev}-${connectionId}`} className="text-xs">
                    {sevLabels[sev]}
                  </label>
                  <select
                    id={`alert-ticketing-priority-${sev}-${connectionId}`}
                    className={selectClass}
                    value={priorities[sev]}
                    onChange={e => setPriorities(p => ({ ...p, [sev]: e.target.value }))}
                    data-testid={`psa-alert-ticketing-priority-${sev}`}
                  >
                    <option value="">{t('longTail.psa.PsaAlertTicketingCard.priorityDefault')}</option>
                    {priorities[sev] && !priorityOptions.some(p => String(p.id) === priorities[sev]) && (
                      <option value={priorities[sev]}>{`#${priorities[sev]}`}</option>
                    )}
                    {priorityOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1 sm:max-w-xs">
            <label htmlFor={`alert-ticketing-min-severity-${connectionId}`} className="text-xs font-medium text-muted-foreground">
              {t('longTail.psa.PsaAlertTicketingCard.fields.minSeverity')}
            </label>
            <select
              id={`alert-ticketing-min-severity-${connectionId}`}
              className={selectClass}
              value={minSeverity}
              onChange={e => setMinSeverity(e.target.value as AlertSeverity)}
              data-testid="psa-alert-ticketing-min-severity"
            >
              {ALERT_TICKETING_SEVERITIES.map(sev => (
                <option key={sev} value={sev}>{sevLabels[sev]}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t('longTail.psa.PsaAlertTicketingCard.fields.minSeverityHelp')}</p>
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={closeOnResolve}
                onChange={e => setCloseOnResolve(e.target.checked)}
                data-testid="psa-alert-ticketing-close-on-resolve"
              />
              {t('longTail.psa.PsaAlertTicketingCard.fields.closeOnResolve')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={noteOnAcknowledge}
                onChange={e => setNoteOnAcknowledge(e.target.checked)}
                data-testid="psa-alert-ticketing-note-on-acknowledge"
              />
              {t('longTail.psa.PsaAlertTicketingCard.fields.noteOnAcknowledge')}
            </label>
            {needsLinkConfirm && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmLinks}
                  onChange={e => setConfirmLinks(e.target.checked)}
                  data-testid="psa-alert-ticketing-confirm-links"
                />
                {t('longTail.psa.PsaAlertTicketingCard.fields.confirmCompanyLinks')}
              </label>
            )}
          </div>

          {truncated && (
            <p className="text-xs text-muted-foreground" data-testid="psa-alert-ticketing-truncated">
              {t('longTail.psa.PsaAlertTicketingCard.options.truncated')}
            </p>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saveDisabled}
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              data-testid="psa-alert-ticketing-save"
            >
              {saving ? t('longTail.psa.PsaAlertTicketingCard.saving') : t('longTail.psa.PsaAlertTicketingCard.save')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

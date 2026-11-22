import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import {
  isPortalDirectoryStatusView,
  type PortalDirectoryActionEffect,
  type PortalDirectoryActionReason,
  type PortalDirectoryActionRow,
  type PortalDirectoryHoldReason,
  type PortalDirectoryRunReason,
  type PortalDirectoryRunSummary,
  type PortalDirectorySource,
  type PortalDirectorySourceStatus,
  type PortalDirectoryStatusView,
  type SsoProviders,
} from './types';

export interface DirectoryDeprovisioningPanelProps {
  orgId: string;
  /** The policy view's `canEdit`: Apply and Dismiss need org write access (the API also checks MFA). */
  canEdit: boolean;
  /**
   * What this deployment can run (`view.capabilities`). A directory whose
   * sign-in method is not available is not shown or named (W7 ships dark);
   * with neither, the panel renders nothing.
   */
  providers: SsoProviders;
}

const PROVIDER_OF: Record<PortalDirectorySource, keyof SsoProviders> = { entra: 'microsoft', google: 'google' };

const DESCRIPTION_KEYS = {
  microsoft: 'portalDirectory.descriptionMicrosoft',
  google: 'portalDirectory.descriptionGoogle',
  both: 'portalDirectory.descriptionBoth',
} as const;

const statusUrl = (orgId: string) => `/orgs/organizations/${orgId}/portal-directory`;
const toLogin = () => void navigateTo('/login', { replace: true });

const SOURCE_KEYS: Record<PortalDirectorySource, string> = {
  entra: 'portalDirectory.sources.entra',
  google: 'portalDirectory.sources.google',
};

const RUN_REASON_KEYS: Record<PortalDirectoryRunReason, string> = {
  tenant_not_proven: 'portalDirectory.runReasons.tenant_not_proven',
  tenant_mismatch: 'portalDirectory.runReasons.tenant_mismatch',
  connection_inactive: 'portalDirectory.runReasons.connection_inactive',
  org_inactive: 'portalDirectory.runReasons.org_inactive',
  sync_incomplete: 'portalDirectory.runReasons.sync_incomplete',
  directory_too_large: 'portalDirectory.runReasons.directory_too_large',
  scope_missing: 'portalDirectory.runReasons.scope_missing',
  access_denied: 'portalDirectory.runReasons.access_denied',
  unavailable: 'portalDirectory.runReasons.unavailable',
  connection_invalid: 'portalDirectory.runReasons.connection_invalid',
  admin_not_admin: 'portalDirectory.runReasons.admin_not_admin',
  mixed_customer: 'portalDirectory.runReasons.mixed_customer',
  malformed: 'portalDirectory.runReasons.malformed',
};

const HOLD_REASON_KEYS: Record<PortalDirectoryHoldReason, string> = {
  first_enforcement: 'portalDirectory.holdReasons.first_enforcement',
  threshold: 'portalDirectory.holdReasons.threshold',
};

const ACTION_REASON_KEYS: Record<PortalDirectoryActionReason, string> = {
  account_disabled: 'portalDirectory.actionReasons.account_disabled',
  absent: 'portalDirectory.actionReasons.absent',
  suspended: 'portalDirectory.actionReasons.suspended',
  archived: 'portalDirectory.actionReasons.archived',
};

const EFFECT_KEYS: Record<PortalDirectoryActionEffect, Record<PortalDirectorySource, string>> = {
  identity_and_account: {
    entra: 'portalDirectory.effects.identity_and_account',
    google: 'portalDirectory.effects.identity_and_account',
  },
  identity: {
    entra: 'portalDirectory.effects.identityEntra',
    google: 'portalDirectory.effects.identityGoogle',
  },
};

/** Apply / Dismiss refusals (runDecisions.ts). Anything else toasts the server's message. */
const DECISION_ERROR_KEYS: Record<string, string> = {
  PORTAL_DIRECTORY_RUN_STALE: 'portalDirectory.errors.stale',
  PORTAL_DIRECTORY_RUN_NOT_HELD: 'portalDirectory.errors.notHeld',
  PORTAL_DIRECTORY_RUN_NOT_FOUND: 'portalDirectory.errors.notHeld',
  PORTAL_DIRECTORY_ENFORCEMENT_OFF: 'portalDirectory.errors.enforcementOff',
};

function decisionErrorMessage(code: string, t: TFunction): string | undefined {
  const key = DECISION_ERROR_KEYS[code];
  return key ? t(/* i18n-dynamic */ key) : undefined;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; view: PortalDirectoryStatusView };

type Decision = { kind: 'apply' | 'dismiss'; source: PortalDirectorySource; run: PortalDirectoryRunSummary };

const scrollToTenant = () => {
  // The settings page selects its tab from the hash: scroll, never re-hash.
  document.getElementById('entra-tenant')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function SourceLine({ status, t }: { status: PortalDirectorySourceStatus; t: TFunction }) {
  const { source, lastRun } = status;
  const label = t(/* i18n-dynamic */ SOURCE_KEYS[source]);
  let detail: ReactNode;
  if (!lastRun) {
    detail = t('portalDirectory.source.never');
  } else if (lastRun.outcome === 'evaluated') {
    detail = t('portalDirectory.source.evaluated', { count: lastRun.directoryUserCount ?? 0 });
  } else if (lastRun.outcome === 'suspect_shrink') {
    detail = t('portalDirectory.source.suspectShrink');
  } else {
    const reason = lastRun.reason ? t(/* i18n-dynamic */ RUN_REASON_KEYS[lastRun.reason]) : t('portalDirectory.runReasons.unknown');
    detail = (
      <>
        {t('portalDirectory.source.nothingChanged')} {reason}
        {lastRun.reason === 'tenant_not_proven' && (
          <>
            {' '}
            <button
              type="button"
              data-testid="portal-directory-tenant-link"
              onClick={scrollToTenant}
              className="underline hover:text-foreground"
            >
              {t('portalDirectory.source.tenantLink')}
            </button>
          </>
        )}
      </>
    );
  }
  return (
    <li data-testid={`portal-directory-source-${source}`} className="text-sm">
      <span className="font-medium">{label}</span>
      {lastRun && (
        <span className="ml-2 text-xs text-muted-foreground">
          {t('portalDirectory.source.lastRead', { when: new Date(lastRun.createdAt).toLocaleString() })}
        </span>
      )}
      <p className="text-xs text-muted-foreground">{detail}</p>
    </li>
  );
}

function ActionLine({ row, t }: { row: PortalDirectoryActionRow; t: TFunction }) {
  return (
    <tr data-testid={`portal-directory-action-${row.identityId}`} className="border-b last:border-0 align-top">
      <td className="py-2 pr-2">
        <div>{row.name ?? row.email}</div>
        {row.name && <div className="text-xs text-muted-foreground">{row.email}</div>}
      </td>
      <td className="py-2 pr-2">{t(/* i18n-dynamic */ SOURCE_KEYS[row.provider])}</td>
      <td className="py-2 pr-2">{row.reason ? t(/* i18n-dynamic */ ACTION_REASON_KEYS[row.reason]) : '—'}</td>
      <td className="py-2">
        {row.effect ? t(/* i18n-dynamic */ EFFECT_KEYS[row.effect][row.provider]) : '—'}
        <div className="mt-1 flex flex-wrap gap-1">
          {row.keepsPassword && (
            <span
              data-testid={`portal-directory-tag-keeps-password-${row.identityId}`}
              className="inline-flex rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700"
            >
              {t('portalDirectory.tags.keepsPassword')}
            </span>
          )}
          {row.rearmed && (
            <span
              data-testid={`portal-directory-tag-rearmed-${row.identityId}`}
              className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            >
              {t('portalDirectory.tags.rearmed')}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

/**
 * Directory deprovisioning (portal registration W8, #11385; plan Task 10):
 * whether it is in report mode, what each directory's last read found, the
 * people it would turn off (or has queued for a decision), and Apply / Dismiss
 * for a run held for the MSP. A status panel, not a setting: there is nothing
 * to save (rule 9). Rendered by the Sign-in & registration card.
 */
export function DirectoryDeprovisioningPanel({ orgId, canEdit, providers }: DirectoryDeprovisioningPanelProps) {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [decision, setDecision] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = (seq.current += 1);
    try {
      const res = await fetchWithAuth(statusUrl(orgId));
      if (mine !== seq.current) return;
      if (res.status === 401) { toLogin(); return; }
      if (!res.ok) throw new Error(`portal directory status load failed: ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      if (mine !== seq.current) return;
      if (!isPortalDirectoryStatusView(body.data)) throw new Error('portal directory status returned an unexpected body');
      setState({ status: 'ready', view: body.data });
    } catch (err) {
      if (mine !== seq.current) return;
      console.warn('[DirectoryDeprovisioningPanel] load failed', err);
      setState({ status: 'error' });
    }
  }, [orgId]);

  useEffect(() => {
    setState({ status: 'loading' });
    void load();
    return () => { seq.current += 1; };
  }, [load]);

  const decide = async (d: Decision) => {
    if (!d.run.impactDigest) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`${statusUrl(orgId)}/runs/${d.run.id}/${d.kind}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ impactDigest: d.run.impactDigest }),
        }),
        errorFallback: t('portalDirectory.errors.decide'),
        successMessage: d.kind === 'apply' ? t('portalDirectory.toasts.applying') : t('portalDirectory.toasts.dismissed'),
        friendly: (code) => decisionErrorMessage(code, t),
        onUnauthorized: toLogin,
      });
      setDecision(null);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        console.error('[DirectoryDeprovisioningPanel] decision failed', err);
        showToast({ type: 'error', message: t('portalDirectory.errors.decide') });
      }
      setDecision(null);
    } finally {
      setBusy(false);
      // A refusal (stale, superseded) means the panel is out of date as well.
      void load();
    }
  };

  if (!providers.microsoft && !providers.google) return null;
  const shown = (source: PortalDirectorySource) => providers[PROVIDER_OF[source]];
  const descriptionKey = providers.microsoft && providers.google
    ? DESCRIPTION_KEYS.both
    : providers.google ? DESCRIPTION_KEYS.google : DESCRIPTION_KEYS.microsoft;

  const shell = (children: ReactNode) => (
    <div data-testid="portal-directory-panel" className="space-y-3 rounded-md border bg-muted/20 p-4 text-sm">
      <div>
        <h3 className="text-sm font-semibold">{t('portalDirectory.title')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t(/* i18n-dynamic */ descriptionKey)}</p>
      </div>
      {children}
    </div>
  );

  if (state.status === 'loading') {
    return shell(<p className="text-xs text-muted-foreground">{t('portalDirectory.loading')}</p>);
  }
  if (state.status === 'error') {
    return shell(
      <p data-testid="portal-directory-load-error" className="text-xs text-muted-foreground">
        {t('portalDirectory.errors.load')}{' '}
        <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
          {t('common:actions.retry')}
        </button>
      </p>,
    );
  }

  const { view } = state;
  const sources = view.sources.filter((s) => shown(s.source));
  const openActions = view.openActions.filter((a) => shown(a.provider));
  const held = sources.filter((s) => s.lastEvaluatedRun?.disposition === 'held');
  const decisionCount = decision?.run.affectedCount ?? 0;
  const decisionHold = decision?.run.holdReason ? t(/* i18n-dynamic */ HOLD_REASON_KEYS[decision.run.holdReason]) : '';

  return shell(
    <>
      <p data-testid="portal-directory-mode" className={view.mode === 'enforce' ? 'font-medium' : 'text-muted-foreground'}>
        {view.mode === 'enforce' ? t('portalDirectory.mode.enforce') : t('portalDirectory.mode.report')}
      </p>

      <ul className="space-y-2">
        {sources.map((s) => <SourceLine key={s.source} status={s} t={t} />)}
      </ul>

      {held.map((s) => {
        const run = s.lastEvaluatedRun!;
        return (
          <div
            key={s.source}
            data-testid={`portal-directory-held-${s.source}`}
            className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3"
          >
            <p className="font-medium">
              {t('portalDirectory.held.summary', { count: run.affectedCount, source: t(/* i18n-dynamic */ SOURCE_KEYS[s.source]) })}
            </p>
            {run.holdReason && (
              <p className="text-xs text-muted-foreground">
                {t('portalDirectory.held.because', { reason: t(/* i18n-dynamic */ HOLD_REASON_KEYS[run.holdReason]) })}
              </p>
            )}
            {canEdit && view.mode === 'enforce' && run.impactDigest && (
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid={`portal-directory-apply-${s.source}`}
                  disabled={busy}
                  onClick={() => setDecision({ kind: 'apply', source: s.source, run })}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {t('portalDirectory.held.apply')}
                </button>
                <button
                  type="button"
                  data-testid={`portal-directory-dismiss-${s.source}`}
                  disabled={busy}
                  onClick={() => setDecision({ kind: 'dismiss', source: s.source, run })}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
                >
                  {t('portalDirectory.held.dismiss')}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {openActions.length === 0 ? (
        <p data-testid="portal-directory-empty" className="text-xs text-muted-foreground">{t('portalDirectory.empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table data-testid="portal-directory-actions" className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 font-medium">{t('portalDirectory.columns.person')}</th>
                <th className="py-2 pr-2 font-medium">{t('portalDirectory.columns.provider')}</th>
                <th className="py-2 pr-2 font-medium">{t('portalDirectory.columns.reason')}</th>
                <th className="py-2 font-medium">{t('portalDirectory.columns.effect')}</th>
              </tr>
            </thead>
            <tbody>
              {openActions.map((row) => <ActionLine key={`${row.identityId}-${row.id ?? 'rearmed'}`} row={row} t={t} />)}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={decision !== null}
        onClose={() => { if (!busy) setDecision(null); }}
        onConfirm={() => { if (decision) void decide(decision); }}
        title={decision?.kind === 'dismiss' ? t('portalDirectory.confirm.dismissTitle') : t('portalDirectory.confirm.applyTitle')}
        message={decision?.kind === 'dismiss'
          ? t('portalDirectory.confirm.dismissMessage', { count: decisionCount, reason: decisionHold })
          : t('portalDirectory.confirm.applyMessage', { count: decisionCount, reason: decisionHold })}
        confirmLabel={decision?.kind === 'dismiss' ? t('portalDirectory.held.dismiss') : t('portalDirectory.held.apply')}
        variant={decision?.kind === 'apply' ? 'destructive' : 'warning'}
        isLoading={busy}
        confirmTestId="portal-directory-confirm"
        dialogTestId="portal-directory-confirm-dialog"
      />
    </>,
  );
}

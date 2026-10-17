// Owner: W02b (declared controls: declare, re-declare, withdraw, 365-day expiry).
// Practices Breeze cannot measure, attested by a named MSP user (spec §18.2). A declaration reaches the public
// page only through a publish (Ruling 20); a withdrawal or an expiry takes effect at the next hourly refresh.
// Mutations go through runAction (listed in no-silent-mutations TARGET_GLOBS) and carry the page revision.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRUST_DECLARATION_REMINDER_DAYS, type DeclaredControlId } from '@breeze/shared';
import { Dialog } from '@/components/shared/Dialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { formatDate } from '@/lib/dateTimeFormat';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { listOrgDocuments, type OrgDocument } from '@/lib/api/orgDocuments';
import type { TrustSectionProps } from '@/lib/api/trustPage';
import {
  declareTrustControl, getTrustDeclarations, withdrawTrustDeclaration,
  type TrustDeclaration, type TrustDeclarationsState,
} from '@/lib/api/trustPageDeclarations';
import { useTrustControlCopy } from './trustControlCopy';

const DAY_MS = 86_400_000;
const STATEMENT_MIN = 10;
const STATEMENT_MAX = 1000;

/** Whole days until `expiresAt`, rounded up (a declaration expiring later today is "1 day"). */
export function daysUntil(expiresAt: string, now = Date.now()): number {
  return Math.ceil((new Date(expiresAt).getTime() - now) / DAY_MS);
}

export default function TrustDeclarationsSection({ orgId, orgFetch, state, canWrite, onReload }: TrustSectionProps) {
  const { t } = useTranslation('organizations');
  const copy = useTrustControlCopy();
  const [data, setData] = useState<TrustDeclarationsState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState<DeclaredControlId | null>(null);
  const [withdrawing, setWithdrawing] = useState<TrustDeclaration | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getTrustDeclarations(orgFetch, orgId));
      setLoadFailed(false);
    } catch (err) {
      console.error('[TrustDeclarationsSection] failed to load declarations', err);
      setLoadFailed(true);
    }
  }, [orgFetch, orgId]);
  // Re-read whenever the page revision moves (a declare/withdraw here, or a publish elsewhere in the tab).
  const revision = state.page.publicationRevision;
  useEffect(() => { void load(); }, [load, revision]);

  const activeByControl = useMemo(() => new Map((data?.active ?? []).map((d) => [d.controlId, d])), [data]);
  const published = useMemo(() => new Set(data?.publishedDeclarationIds ?? []), [data]);
  // A withdrawn id stays in the frozen config until a republish, but the refresh already drops it from the public
  // page — so it never makes a republish "needed".
  const publishedLive = useMemo(() => {
    const withdrawn = new Set((data?.history ?? []).filter((h) => h.withdrawnAt !== null).map((h) => h.id));
    return new Set([...published].filter((id) => !withdrawn.has(id)));
  }, [data, published]);
  // What a publish would freeze now (active, unexpired) vs what the live page froze.
  const republishNeeded = useMemo(() => {
    if (!data || !state.page.publishedAt) return false;
    const draft = new Set(data.active.filter((d) => new Date(d.expiresAt).getTime() > Date.now()).map((d) => d.id));
    if (draft.size !== publishedLive.size) return true;
    for (const id of draft) if (!publishedLive.has(id)) return true;
    return false;
  }, [data, publishedLive, state.page.publishedAt]);

  const afterMutation = async () => {
    await onReload();
    await load();
  };
  const onStale = async (err: unknown) => {
    if (err instanceof ActionError && err.code === 'REVISION_MISMATCH') {
      try { await afterMutation(); } catch (reloadErr) { console.error('[TrustDeclarationsSection] reload after stale revision failed', reloadErr); }
    }
  };
  const friendly = (code: string) => ({
    REVISION_MISMATCH: t('orgRecord.trust.errors.revisionMismatch'),
    EVIDENCE_UNAVAILABLE: t('orgRecord.trust.declarations.evidenceUnavailable'),
    MFA_REQUIRED: t('orgRecord.trust.declarations.mfaRequired'),
  } as Record<string, string>)[code];

  const submitDeclaration = async (input: { controlId: DeclaredControlId; statement: string; evidenceDocumentId: string | null }) => {
    if (!canWrite) return;
    setBusy(true);
    try {
      await runAction({
        request: () => declareTrustControl(orgFetch, orgId, { ...input, expectedRevision: state.page.publicationRevision }),
        successMessage: t('orgRecord.trust.declarations.saved'),
        errorFallback: t('orgRecord.trust.declarations.saveFailed'),
        friendly,
      });
      setEditing(null);
      await afterMutation();
    } catch (err) {
      handleActionError(err, t('orgRecord.trust.declarations.saveFailed'));
      if (err instanceof ActionError && err.code === 'REVISION_MISMATCH') {
        // Retrying with the same stale revision would 409 forever: refresh, then close.
        await onStale(err);
        setEditing(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmWithdraw = async () => {
    if (!canWrite || !withdrawing) return;
    const target = withdrawing;
    setBusy(true);
    try {
      await runAction({
        request: () => withdrawTrustDeclaration(orgFetch, orgId, target.id, state.page.publicationRevision),
        successMessage: t('orgRecord.trust.declarations.withdrawn'),
        errorFallback: t('orgRecord.trust.declarations.withdrawFailed'),
        friendly,
      });
      await afterMutation();
    } catch (err) {
      handleActionError(err, t('orgRecord.trust.declarations.withdrawFailed'));
      await onStale(err);
    } finally {
      setBusy(false);
      setWithdrawing(null);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-testid="trust-declarations-section">
      <div>
        <h3 className="text-base font-semibold">{t('orgRecord.trust.declarations.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('orgRecord.trust.declarations.description')}</p>
      </div>

      {republishNeeded && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="trust-declarations-republish">
          {t('orgRecord.trust.declarations.republishNeeded')}
        </p>
      )}

      {loadFailed ? (
        <p className="text-sm text-destructive" role="alert" data-testid="trust-declarations-load-failed">{t('orgRecord.trust.declarations.loadFailed')}</p>
      ) : data === null ? (
        <p className="text-sm text-muted-foreground">{t('orgRecord.trust.loading')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {data.catalog.map((control) => {
            const d = activeByControl.get(control.id);
            const days = d ? daysUntil(d.expiresAt) : null;
            const expired = d !== undefined && new Date(d.expiresAt).getTime() <= Date.now();
            const expiringSoon = d !== undefined && !expired && days !== null && days <= TRUST_DECLARATION_REMINDER_DAYS;
            return (
              <li key={control.id} className="space-y-2 p-3 text-sm" data-testid={`trust-declaration-${control.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium">{copy.controlTitle(control.id)}</div>
                    <div className="text-xs text-muted-foreground">{copy.controlDescription(control.id)}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${!d ? 'text-muted-foreground' : expired ? 'border-destructive/40 text-destructive' : 'border-primary/40 text-primary'}`}
                      data-testid={`trust-declaration-${control.id}-status`}
                    >
                      {!d ? t('orgRecord.trust.declarations.notDeclared') : expired ? t('orgRecord.trust.declarations.expired') : t('orgRecord.trust.declarations.current')}
                    </span>
                    {expiringSoon && (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300" data-testid={`trust-declaration-${control.id}-expiring`}>
                        {t('orgRecord.trust.declarations.expiresIn', { count: days ?? 0 })}
                      </span>
                    )}
                    {d && published.has(d.id) && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs" data-testid={`trust-declaration-${control.id}-published`}>
                        {t('orgRecord.trust.declarations.onPublicPage')}
                      </span>
                    )}
                  </div>
                </div>
                {d && (
                  <div className="space-y-1">
                    <p className="whitespace-pre-wrap">{d.statement}</p>
                    <p className="text-xs text-muted-foreground">
                      {expired
                        ? t('orgRecord.trust.declarations.expiredOn', { date: formatDate(d.expiresAt) })
                        : t('orgRecord.trust.declarations.declaredBy', { partner: d.declaredByPartnerName, date: formatDate(d.declaredAt), expires: formatDate(d.expiresAt) })}
                    </p>
                  </div>
                )}
                {canWrite && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setEditing(control.id)}
                      className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid={`trust-declare-${control.id}`}
                    >
                      {d ? t('orgRecord.trust.declarations.redeclare') : t('orgRecord.trust.declarations.declare')}
                    </button>
                    {d && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setWithdrawing(d)}
                        className="rounded-md border px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`trust-withdraw-${control.id}`}
                      >
                        {t('orgRecord.trust.declarations.withdraw')}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {data && data.history.length > 0 && (
        <details className="text-sm" data-testid="trust-declarations-history">
          <summary className="cursor-pointer text-muted-foreground">{t('orgRecord.trust.declarations.historyTitle')}</summary>
          <ul className="mt-2 space-y-1">
            {data.history.map((h) => (
              <li key={h.id} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{copy.controlTitle(h.controlId)}</span>
                {' · '}
                {[
                  h.supersededAt ? t('orgRecord.trust.declarations.historySuperseded', { date: formatDate(h.supersededAt) }) : null,
                  h.withdrawnAt ? t('orgRecord.trust.declarations.historyWithdrawn', { date: formatDate(h.withdrawnAt) }) : null,
                ].filter(Boolean).join(' · ')}
              </li>
            ))}
          </ul>
        </details>
      )}

      {editing && data && (
        <DeclareDialog
          controlId={editing}
          controlTitle={copy.controlTitle(editing)}
          partnerName={data.partnerName}
          initial={activeByControl.get(editing) ?? null}
          orgId={orgId}
          orgFetch={orgFetch}
          busy={busy}
          onClose={() => setEditing(null)}
          onSubmit={submitDeclaration}
        />
      )}

      <ConfirmDialog
        open={withdrawing !== null}
        onClose={() => { if (!busy) setWithdrawing(null); }}
        onConfirm={() => { void confirmWithdraw(); }}
        title={t('orgRecord.trust.declarations.withdrawTitle')}
        message={t('orgRecord.trust.declarations.withdrawMessage', { control: withdrawing ? copy.controlTitle(withdrawing.controlId) : '' })}
        confirmLabel={t('orgRecord.trust.declarations.withdrawConfirm')}
        variant="destructive"
        isLoading={busy}
        confirmTestId="trust-withdraw-confirm"
      />
    </section>
  );
}

interface DeclareDialogProps {
  controlId: DeclaredControlId;
  controlTitle: string;
  partnerName: string;
  initial: TrustDeclaration | null;
  orgId: string;
  orgFetch: TrustSectionProps['orgFetch'];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { controlId: DeclaredControlId; statement: string; evidenceDocumentId: string | null }) => Promise<void>;
}

function DeclareDialog({ controlId, controlTitle, partnerName, initial, orgId, orgFetch, busy, onClose, onSubmit }: DeclareDialogProps) {
  const { t } = useTranslation('organizations');
  const [statement, setStatement] = useState(initial?.statement ?? '');
  const [evidenceId, setEvidenceId] = useState<string>('');
  const [confirmed, setConfirmed] = useState(false);
  const [library, setLibrary] = useState<OrgDocument[]>([]);
  const initialEvidenceId = initial?.evidenceDocumentId ?? null;

  useEffect(() => {
    let cancelled = false;
    listOrgDocuments(orgFetch, orgId, { includeSuperseded: false })
      .then((docs) => {
        if (cancelled) return;
        const live = docs.filter((d) => d.supersededByDocumentId === null);
        setLibrary(live);
        // Re-declaring keeps the previous evidence when it is still a current document — seeded once, so a
        // reload of the section while the dialog is open never overwrites the user's pick.
        if (initialEvidenceId && live.some((d) => d.id === initialEvidenceId)) setEvidenceId((cur) => cur || initialEvidenceId);
      })
      .catch((err: unknown) => console.error('[TrustDeclarationsSection] failed to load the document library', err));
    return () => { cancelled = true; };
  }, [orgFetch, orgId, initialEvidenceId]);

  const trimmed = statement.trim();
  const valid = trimmed.length >= STATEMENT_MIN && trimmed.length <= STATEMENT_MAX;
  const canSubmit = !busy && valid && confirmed;

  return (
    <Dialog open onClose={busy ? () => undefined : onClose} title={t('orgRecord.trust.declarations.dialogTitle', { control: controlTitle })} maxWidth="lg">
      <form
        className="space-y-4 p-6"
        data-testid="trust-declare-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void onSubmit({ controlId, statement: trimmed, evidenceDocumentId: evidenceId || null });
        }}
      >
        <h3 className="text-base font-semibold">{t('orgRecord.trust.declarations.dialogTitle', { control: controlTitle })}</h3>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('orgRecord.trust.declarations.statementLabel')}</span>
          <textarea
            value={statement}
            maxLength={STATEMENT_MAX}
            rows={5}
            onChange={(e) => setStatement(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="trust-declare-statement"
          />
          <span className="mt-1 block text-xs text-muted-foreground">{t('orgRecord.trust.declarations.statementHelp')}</span>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('orgRecord.trust.declarations.evidenceLabel')}</span>
          <select
            value={evidenceId}
            onChange={(e) => setEvidenceId(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            data-testid="trust-declare-evidence"
          >
            <option value="">{t('orgRecord.trust.declarations.evidenceNone')}</option>
            {library.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">{t('orgRecord.trust.declarations.evidenceHelp')}</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            data-testid="trust-declare-confirm"
          />
          <span>{t('orgRecord.trust.declarations.confirm', { partner: partnerName })}</span>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50" data-testid="trust-declare-cancel">
            {t('orgRecord.trust.declarations.cancel')}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="trust-declare-submit"
          >
            {t('orgRecord.trust.declarations.submit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

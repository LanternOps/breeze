import '@/lib/i18n';
import { useState } from 'react';
import { AlertTriangle, Check, Layers, Loader2, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { groupMembersByOrg, type CrossOrgGroup, type PendingApproval } from './approvalGrouping';
import { RegisterApproverDeviceLink } from './RegisterApproverDeviceLink';
import { riskClass } from './riskClass';

/** The exact set the approver reviewed — what the one passkey signs. */
export interface FrozenCrossOrgBatch {
  identity: string;
  members: PendingApproval[];
}

export interface CrossOrgBatchPanelProps {
  group: CrossOrgGroup;
  /** Any decision in flight anywhere in the inbox. */
  busy: boolean;
  /** THIS panel's batch is the one in flight. */
  deciding: boolean;
  /** A group error kind, rendered from the `approvals:errors.*` copy. */
  error?: string;
  onDecide: (
    frozen: FrozenCrossOrgBatch,
    decision: 'approve' | 'deny',
    reason?: string,
  ) => void | Promise<void>;
}

const DENY_REASON_MAX = 500;

/** Set equality over ids — never a count comparison: a live refresh that
 *  swaps one card for another keeps the count and changes what gets signed. */
function sameIdSet(a: readonly PendingApproval[], b: readonly PendingApproval[]): boolean {
  const left = new Set(a.map((member) => member.id));
  const right = new Set(b.map((member) => member.id));
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/**
 * ONE ceremony across several organizations for an allowlisted action
 * (`CROSS_ORG_BATCH_ACTIONS`), shown above the org-first list.
 *
 * Collapsed it is a single summary line; Approve and Deny only exist once the
 * approver opens the review, which lists every org and every card in full.
 * Opening the review FREEZES the member set: the buttons act on that snapshot
 * only, and if the live group stops matching it (a refresh added, removed or
 * replaced a card, a card drifted, a partial result removed some) they disable
 * until the approver reviews the new list. One passkey must never sign a set
 * the approver did not see.
 */
export default function CrossOrgBatchPanel({
  group,
  busy,
  deciding,
  error,
  onDecide,
}: CrossOrgBatchPanelProps) {
  const { t } = useTranslation('approvals');
  const [snapshot, setSnapshot] = useState<PendingApproval[] | null>(null);
  const [denyOpen, setDenyOpen] = useState(false);
  const [denyReason, setDenyReason] = useState('');

  const key = group.testKey;
  const reviewing = snapshot !== null;
  const changed = snapshot !== null && !sameIdSet(snapshot, group.members);
  const actionsDisabled = busy || changed;

  const freeze = () => setSnapshot([...group.members]);

  const toggleReview = () => {
    if (reviewing) {
      setSnapshot(null);
      setDenyOpen(false);
      return;
    }
    freeze();
  };

  const submit = (decision: 'approve' | 'deny', reason?: string) => {
    // Re-checked here, not only through `disabled`: the snapshot is the
    // authority, and a stale one must never reach the server.
    if (!snapshot || busy || !sameIdSet(snapshot, group.members)) return;
    const frozen = { identity: group.identity, members: snapshot };
    void (decision === 'approve' ? onDecide(frozen, 'approve') : onDecide(frozen, 'deny', reason));
  };

  const openDeny = () => {
    if (actionsDisabled) return;
    setDenyReason('');
    setDenyOpen((current) => !current);
  };

  const reviewedOrgs = snapshot ? groupMembersByOrg(snapshot) : [];

  return (
    <section
      className="overflow-hidden rounded-xl border bg-card"
      data-testid={`cross-org-batch-${key}`}
    >
      <div className="flex flex-col gap-3 bg-muted/40 px-5 py-3 md:flex-row md:items-center md:justify-between">
        <p
          className="flex min-w-0 items-center gap-2 text-sm font-semibold"
          data-testid={`cross-org-batch-summary-${key}`}
        >
          <Layers className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0">
            {t('batch.crossOrg.summary', {
              count: group.members.length,
              tool: group.tool,
              orgCount: group.orgs.length,
            })}
          </span>
        </p>
        <button
          type="button"
          onClick={toggleReview}
          disabled={deciding}
          aria-expanded={reviewing}
          aria-controls={`cross-org-batch-list-${key}`}
          className="inline-flex h-9 shrink-0 items-center rounded-lg border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={`cross-org-batch-review-${key}`}
        >
          {reviewing ? t('batch.crossOrg.hideReview') : t('batch.crossOrg.review')}
        </button>
      </div>

      {error && (
        <div
          className="border-t bg-destructive/10 px-5 py-2 text-sm text-destructive"
          data-testid={`cross-org-batch-error-${key}`}
          role="alert"
        >
          {t(/* i18n-dynamic */ `errors.${error}`)}
          {error === 'noApproverDevice' && (
            <>
              {' '}
              <RegisterApproverDeviceLink />
            </>
          )}
        </div>
      )}

      {snapshot && (
        <div className="border-t px-5 py-4">
          <p className="text-sm text-muted-foreground">{t('batch.crossOrg.reviewHint')}</p>

          {changed && (
            <div
              className="mt-3 flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`cross-org-batch-changed-${key}`}
              role="status"
            >
              <span className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t('batch.crossOrg.changed')}
              </span>
              <button
                type="button"
                onClick={freeze}
                disabled={busy}
                className="inline-flex h-8 shrink-0 items-center gap-2 self-start rounded-lg border border-current bg-background/60 px-3 text-sm font-medium transition-colors hover:bg-background disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
                data-testid={`cross-org-batch-rereview-${key}`}
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {t('batch.crossOrg.reReview')}
              </button>
            </div>
          )}

          <div
            id={`cross-org-batch-list-${key}`}
            className="mt-3 space-y-4"
            data-testid={`cross-org-batch-list-${key}`}
          >
            {reviewedOrgs.map((org) => (
              <div key={org.orgId} data-testid={`cross-org-batch-org-${key}-${org.orgId}`}>
                <p className="flex items-baseline justify-between gap-3 text-xs font-medium text-muted-foreground">
                  <span className="min-w-0 break-words">
                    {org.orgName ?? t('unknownOrganization')}
                  </span>
                  <span className="shrink-0">
                    {t('batch.crossOrg.orgRequestCount', { count: org.members.length })}
                  </span>
                </p>
                <ul className="mt-1 divide-y rounded-lg border">
                  {org.members.map((member) => (
                    <li
                      key={member.id}
                      className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                      data-testid={`cross-org-batch-member-${member.id}`}
                    >
                      <span className="min-w-0">
                        <span className="block font-medium break-words">
                          {member.targetDevice?.hostname ?? t('batch.crossOrg.unknownDevice')}
                        </span>
                        <span className="block text-muted-foreground break-words">
                          {member.actionLabel}
                        </span>
                      </span>
                      <span
                        className={`self-start rounded-full px-2 py-0.5 text-xs font-semibold sm:self-auto ${riskClass[member.riskTier]}`}
                      >
                        {t(/* i18n-dynamic */ `risk.${member.riskTier}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={openDeny}
              disabled={actionsDisabled}
              aria-expanded={denyOpen}
              className="inline-flex h-9 items-center gap-2 rounded-lg border bg-background px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`cross-org-batch-deny-${key}`}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              {t('batch.declineAll', { count: snapshot.length })}
            </button>
            <button
              type="button"
              onClick={() => submit('approve')}
              disabled={actionsDisabled}
              // Same contrast note as the inbox's own Approve: emerald-700
              // clears 4.5:1 against white, emerald-600 does not.
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-emerald-700 px-3 text-sm font-medium text-white transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid={`cross-org-batch-approve-${key}`}
            >
              {deciding ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="h-4 w-4" aria-hidden="true" />
              )}
              {deciding ? t('deciding') : t('batch.approveAll', { count: snapshot.length })}
            </button>
          </div>

          {denyOpen && (
            <div
              className="mt-3 rounded-lg border bg-muted/20 px-4 py-3"
              data-testid={`cross-org-batch-deny-form-${key}`}
            >
              <p
                className="text-sm text-muted-foreground"
                data-testid={`cross-org-batch-deny-summary-${key}`}
              >
                {t('batch.crossOrg.denyConfirmSummary', {
                  count: snapshot.length,
                  orgCount: reviewedOrgs.length,
                })}
              </p>
              <label
                className="mt-2 block text-sm font-medium"
                htmlFor={`cross-org-batch-deny-reason-${key}`}
              >
                {t('denyPrompt')}
              </label>
              <textarea
                id={`cross-org-batch-deny-reason-${key}`}
                className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                rows={2}
                maxLength={DENY_REASON_MAX}
                value={denyReason}
                placeholder={t('denyReasonPlaceholder')}
                onChange={(event) => setDenyReason(event.target.value)}
                data-testid={`cross-org-batch-deny-reason-${key}`}
              />
              <p
                className="mt-1 text-right text-xs text-muted-foreground"
                data-testid={`cross-org-batch-deny-reason-count-${key}`}
              >
                {t('charCount', { count: denyReason.length, max: DENY_REASON_MAX })}
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDenyOpen(false)}
                  disabled={busy}
                  className="inline-flex h-9 items-center rounded-lg border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid={`cross-org-batch-deny-cancel-${key}`}
                >
                  {t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => submit('deny', denyReason)}
                  disabled={actionsDisabled}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-destructive px-3 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid={`cross-org-batch-deny-confirm-${key}`}
                >
                  {deciding && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                  {deciding ? t('deciding') : t('confirmDeny')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

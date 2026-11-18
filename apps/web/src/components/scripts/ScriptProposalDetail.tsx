import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { usePageItemName } from '../layout/usePageItemName';

// The as-built detail DTO (packages/shared/src/types/scriptProposals.ts,
// ScriptProposalDetailDto) — this read-only page renders only the fields
// spec §4.9 asks for: goal, status, risk tier, and the reviewer's summary.
type RiskTier = 'low' | 'medium' | 'high' | 'critical';

interface ScriptProposalDetailDto {
  proposal: {
    status: string;
    goal: string;
    riskTier: RiskTier | string | null;
  };
  review: { summary: string | null } | null;
}

const RISK_KEYS: Record<RiskTier, string> = {
  low: 'scriptProposalDetail.riskLow',
  medium: 'scriptProposalDetail.riskMedium',
  high: 'scriptProposalDetail.riskHigh',
  critical: 'scriptProposalDetail.riskCritical',
};

const STATUS_KEYS: Record<string, string> = {
  proposed: 'scriptProposalDetail.status.proposed',
  scan_rejected: 'scriptProposalDetail.status.scan_rejected',
  review_failed: 'scriptProposalDetail.status.review_failed',
  reviewed: 'scriptProposalDetail.status.reviewed',
  approved: 'scriptProposalDetail.status.approved',
  rejected: 'scriptProposalDetail.status.rejected',
  changes_requested: 'scriptProposalDetail.status.changes_requested',
  expired: 'scriptProposalDetail.status.expired',
  superseded: 'scriptProposalDetail.status.superseded',
  executed: 'scriptProposalDetail.status.executed',
  verified: 'scriptProposalDetail.status.verified',
  verification_failed: 'scriptProposalDetail.status.verification_failed',
  promoted: 'scriptProposalDetail.status.promoted',
};

// States the approvals page can act on: approve/request changes (proposed,
// reviewed, approved), the failed-review override (review_failed) and save to
// library (verified). See ScriptProposalApprovalCard.
const ACTIONABLE_STATUSES = new Set(['proposed', 'reviewed', 'approved', 'review_failed', 'verified']);

function isRiskTier(value: string | null): value is RiskTier {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

export default function ScriptProposalDetail({ proposalId }: { proposalId: string }) {
  const { t } = useTranslation('scripts');
  const [state, setState] = useState<'loading' | 'erased' | 'error' | 'ready'>('loading');
  const [proposal, setProposal] = useState<ScriptProposalDetailDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetchWithAuth(`/ai/script-proposals/${proposalId}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // Only a genuine "row is gone" 404 reads as "evidence erased" (org
          // merge / retention) — a 404 the route returns because the whole
          // feature is flag-off (`error: 'feature_disabled'`), or a 403 for
          // a proposal the caller can't read, must not tell the operator
          // audit evidence was destroyed when it wasn't.
          if (res.status === 404) {
            const body = await res.json().catch(() => null);
            if ((body as { error?: string } | null)?.error === 'not_found') {
              setState('erased');
              return;
            }
          }
          setState('error');
          return;
        }
        setProposal(await res.json());
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  usePageItemName(proposal?.proposal.goal);

  if (state === 'loading') {
    return <p className="text-sm text-muted-foreground">{t('scriptProposalDetail.loading')}</p>;
  }

  if (state === 'erased') {
    return (
      <div data-testid="script-proposal-evidence-erased" className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {t('scriptProposalDetail.evidenceErased')}
      </div>
    );
  }

  if (state === 'error' || !proposal) {
    return <p className="text-sm text-destructive">{t('scriptProposalDetail.loadError')}</p>;
  }

  const riskTier = proposal.proposal.riskTier;
  const rawStatus = proposal.proposal.status;
  // An unknown future status falls back to the raw value rather than a blank.
  const statusLabel = (status: string) => (STATUS_KEYS[status] ? t(/* i18n-dynamic */ STATUS_KEYS[status]) : status);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <h1 className="text-lg font-semibold">{proposal.proposal.goal}</h1>
      <dl className="mt-4 space-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground">{t('scriptProposalDetail.statusLabel')}</dt>
          <dd>{statusLabel(proposal.proposal.status)}</dd>
        </div>
        {riskTier && isRiskTier(riskTier) && (
          <div>
            <dt className="text-muted-foreground">{t('scriptProposalDetail.riskTierLabel')}</dt>
            <dd>{t(/* i18n-dynamic */ RISK_KEYS[riskTier])}</dd>
          </div>
        )}
        {proposal.review?.summary && (
          <div>
            <dt className="text-muted-foreground">{t('scriptProposalDetail.reviewSummaryLabel')}</dt>
            <dd>{proposal.review.summary}</dd>
          </div>
        )}
      </dl>
      {ACTIONABLE_STATUSES.has(rawStatus) && (
        <a
          href={`/approvals#proposal-${proposalId}`}
          className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
          data-testid="script-proposal-review-link"
        >
          {t('scriptProposalDetail.reviewInApprovals')}
        </a>
      )}
    </div>
  );
}

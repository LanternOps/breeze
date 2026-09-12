import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';

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
        // 404 covers both "never existed" and "evidence erased" (org merge /
        // retention) — the API cannot distinguish them once the row is gone,
        // and neither case should read as a broken link.
        if (res.status === 404) {
          setState('erased');
          return;
        }
        if (!res.ok) {
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

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <h1 className="text-lg font-semibold">{proposal.proposal.goal}</h1>
      <dl className="mt-4 space-y-2 text-sm">
        <div>
          <dt className="text-muted-foreground">{t('scriptProposalDetail.statusLabel')}</dt>
          <dd>{proposal.proposal.status}</dd>
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
    </div>
  );
}

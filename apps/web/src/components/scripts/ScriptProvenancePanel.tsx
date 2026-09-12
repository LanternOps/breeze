import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, PencilLine } from 'lucide-react';
import type { ScriptOrigin, ScriptVersionDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

type ScriptProvenancePanelProps = {
  scriptId: string;
};

// Mirrors scripts.json's provenance.origin* keys — see CLAUDE.md's i18n note:
// these keys already exist and must not be duplicated.
const ORIGIN_KEY_SUFFIX: Record<ScriptOrigin, string> = {
  human: 'Human',
  ai_proposal: 'AiProposal',
  imported: 'Imported',
  system: 'System',
};

export default function ScriptProvenancePanel({ scriptId }: ScriptProvenancePanelProps) {
  const { t } = useTranslation(['scripts', 'common']);
  const [versions, setVersions] = useState<ScriptVersionDto[] | null>(null);
  const [error, setError] = useState<string>();

  const fetchVersions = useCallback(async () => {
    try {
      setError(undefined);
      const response = await fetchWithAuth(`/scripts/${scriptId}/versions`);
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        // Reuses ScriptVersionHistory's existing error copy — this panel reads
        // the same underlying version history, just shaped for provenance.
        throw new Error(t('scriptVersionHistory.errors.fetch'));
      }
      const data = await response.json();
      setVersions(Array.isArray(data.versions) ? data.versions : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('scriptVersionHistory.errors.generic'));
    }
  }, [scriptId, t]);

  useEffect(() => {
    void fetchVersions();
  }, [fetchVersions]);

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      </div>
    );
  }

  if (versions === null) {
    // Still loading — render nothing rather than a flashing skeleton for what
    // is usually a near-instant read.
    return null;
  }

  if (versions.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs" data-testid="script-provenance-empty">
        <h2 className="text-lg font-semibold">{t('provenance.provenanceTitle')}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('provenance.originHuman')}</p>
      </div>
    );
  }

  const head = versions[0];
  const earlierVersionWasReviewed = versions.slice(1).some((v) => !!v.reviewId);
  const headIsReviewed = !!head.reviewId && !head.reviewEvidenceErased;
  const editedSinceReview = !headIsReviewed && head.origin === 'human' && earlierVersionWasReviewed;
  const hasReviewCitation = !!head.reviewId;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('provenance.provenanceTitle')}</h2>
        <div className="flex items-center gap-2 text-sm">
          <span data-testid="script-provenance-origin" className="font-medium">
            {t(/* i18n-dynamic */ `provenance.origin${ORIGIN_KEY_SUFFIX[head.origin]}`)}
          </span>
          {headIsReviewed && (
            <span
              data-testid="script-provenance-badge-reviewed"
              className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success"
            >
              <ShieldCheck className="h-3 w-3" />
              {t('provenance.reviewed')}
            </span>
          )}
          {editedSinceReview && (
            <span
              data-testid="script-provenance-edited-since-review"
              className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning"
            >
              <PencilLine className="h-3 w-3" />
              {t('provenance.editedSinceReview')}
            </span>
          )}
        </div>
      </div>

      {hasReviewCitation && (
        head.reviewEvidenceErased ? (
          <p data-testid="script-provenance-erased" className="mt-4 text-sm text-muted-foreground">
            {t('provenance.evidenceErased')}
          </p>
        ) : (
          <div className="mt-4 space-y-2 text-sm">
            {head.reviewSummary && (
              <p data-testid="script-provenance-review-summary">
                <span className="font-medium text-muted-foreground">{t('provenance.reviewSummary')}: </span>
                {head.reviewSummary}
              </p>
            )}
            <p data-testid="script-provenance-approver" className="text-muted-foreground">
              <span className="font-medium">{t('provenance.approvedBy')}: </span>
              {head.approverName ?? head.approvedBy ?? t('common:states.unknown')}
              {head.approvalMethod ? ` (${head.approvalMethod})` : ''}
            </p>
            {head.proposalId && (
              <a
                data-testid="script-provenance-proposal-link"
                href={`/approvals#proposal-${head.proposalId}`}
                className="inline-block text-primary underline underline-offset-2 hover:no-underline"
              >
                {t('provenance.provenanceTitle')}
              </a>
            )}
          </div>
        )
      )}
    </div>
  );
}

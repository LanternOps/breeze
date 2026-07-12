import { i18n } from '@/lib/i18n';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { cn, widthPercentClass } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';
import AccessReviewList, { type AccessReview } from './AccessReviewList';
import AccessReviewForm from './AccessReviewForm';
import { formatDate as formatLocaleDate } from '@/lib/dateTimeFormat';

type AccessReviewDecision = 'pending' | 'approved' | 'revoked';

type AccessReviewItem = {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  roleId: string;
  roleName: string;
  decision: AccessReviewDecision;
  notes?: string;
  reviewedAt?: string;
  permissions?: string[];
  lastActiveAt?: string | null;
};

type AccessReviewDetail = AccessReview & {
  items: AccessReviewItem[];
};

type ModalMode = 'closed' | 'create' | 'review';

type ReviewerOption = {
  id: string;
  name: string;
  email: string;
};

type AccessReviewFormValues = {
  name: string;
  description?: string;
  scope: 'current' | 'organization' | 'partner';
  reviewerIds?: string[];
  dueDate?: string;
  notifyReviewers?: boolean;
};

type DeadlineStatus = {
  label: string;
  isOverdue: boolean;
};

const decisionStyles: Record<AccessReviewDecision, string> = {
  pending: 'bg-amber-500/10 text-amber-700',
  approved: 'bg-emerald-500/10 text-emerald-700',
  revoked: 'bg-destructive/10 text-destructive'
};

const decisionLabelKeys: Record<AccessReviewDecision, string> = {
  pending: 'accessReviewPage.pending',
  approved: 'accessReviewPage.approved',
  revoked: 'accessReviewPage.revoked'
};

const dayMs = 1000 * 60 * 60 * 24;

function formatDate(dateString?: string | null): string {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '-';
  return formatLocaleDate(date, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRelativeDate(dateString?: string | null): string {
  if (!dateString) return i18n.t('settings:accessReviewPage.never');
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '-';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < dayMs) return i18n.t('settings:accessReviewPage.today');
  const days = Math.floor(diffMs / dayMs);
  if (days < 7) return i18n.t('settings:accessReviewPage.daysAgo', { count: days });
  return formatDate(dateString);
}

function getDeadlineStatus(dueDate?: string | null): DeadlineStatus {
  if (!dueDate) {
    return { label: i18n.t('settings:accessReviewPage.noDeadline'), isOverdue: false };
  }
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) {
    return { label: i18n.t('settings:accessReviewPage.noDeadline'), isOverdue: false };
  }
  const now = new Date();
  const diffMs = due.getTime() - now.getTime();
  if (diffMs < 0) {
    const overdueDays = Math.ceil(Math.abs(diffMs) / dayMs);
    return {
      label: i18n.t('settings:accessReviewPage.daysOverdue', { count: overdueDays }),
      isOverdue: true
    };
  }
  const remainingDays = Math.ceil(diffMs / dayMs);
  if (remainingDays === 0) {
    return { label: i18n.t('settings:accessReviewPage.dueToday'), isOverdue: false };
  }
  return {
    label: i18n.t('settings:accessReviewPage.daysRemaining', { count: remainingDays }),
    isOverdue: false
  };
}

function escapeCsvValue(value: string): string {
  const safe = value ?? '';
  return `"${safe.replace(/"/g, '""')}"`;
}

function buildReviewCsv(review: AccessReviewDetail, t: TFunction): string {
  const rows: string[][] = [
    ['Review Name', review.name],
    ['Status', review.status],
    ['Due Date', review.dueDate ? formatDate(review.dueDate) : ''],
    ['']
  ];

  rows.push(['User', 'Email', 'Role', 'Permissions', 'Last Active', 'Decision', 'Notes', 'Reviewed At']);

  review.items.forEach((item) => {
    rows.push([
      item.userName,
      item.userEmail,
      item.roleName,
      (item.permissions ?? []).join(' | '),
      item.lastActiveAt ? formatDate(item.lastActiveAt) : i18n.t('settings:accessReviewPage.never'),
      t(/* i18n-dynamic */ decisionLabelKeys[item.decision]),
      item.notes ?? '',
      item.reviewedAt ? formatDate(item.reviewedAt) : ''
    ]);
  });

  return rows.map((row) => row.map(escapeCsvValue).join(',')).join('\n');
}

export default function AccessReviewPage() {
  const { t } = useTranslation('settings');
  const [reviews, setReviews] = useState<AccessReview[]>([]);
  const [selectedReview, setSelectedReview] = useState<AccessReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [submitting, setSubmitting] = useState(false);
  const [reviewers, setReviewers] = useState<ReviewerOption[]>([]);
  const [reviewersError, setReviewersError] = useState<string>();
  const [decisionFilter, setDecisionFilter] = useState<AccessReviewDecision | 'all'>('all');
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({});
  const [bulkReason, setBulkReason] = useState('');
  const [notifying, setNotifying] = useState(false);
  const [reporting, setReporting] = useState(false);

  const fetchReviews = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/access-reviews');
      if (!response.ok) {
        throw new Error(t('accessReviewPage.failedToFetchAccessReviews'));
      }
      const result = await response.json();
      setReviews(result.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accessReviewPage.anErrorOccurred'));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchReviewers = useCallback(async () => {
    try {
      setReviewersError(undefined);
      const response = await fetchWithAuth('/users');
      if (!response.ok) {
        throw new Error(t('accessReviewPage.failedToFetchReviewers'));
      }
      const data = await response.json();
      const users = data.data ?? data.users ?? data ?? [];
      setReviewers(
        users.map((user: ReviewerOption) => ({
          id: user.id,
          name: user.name,
          email: user.email
        }))
      );
    } catch (err) {
      setReviewersError(err instanceof Error ? err.message : t('accessReviewPage.anErrorOccurred'));
    }
  }, []);

  const fetchReviewDetail = useCallback(async (reviewId: string) => {
    try {
      setError(undefined);
      const response = await fetchWithAuth(`/access-reviews/${reviewId}`);
      if (!response.ok) {
        throw new Error(t('accessReviewPage.failedToFetchReviewDetails'));
      }
      const result = await response.json();
      setSelectedReview(result);
      setModalMode('review');
      setItemNotes(
        Object.fromEntries(
          (result.items ?? []).map((item: AccessReviewItem) => [item.id, item.notes ?? ''])
        )
      );
      setSelectedItemIds([]);
      setBulkReason('');
      setDecisionFilter('all');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accessReviewPage.anErrorOccurred'));
    }
  }, []);

  useEffect(() => {
    fetchReviews();
    fetchReviewers();
  }, [fetchReviews, fetchReviewers]);

  const handleCreateNew = () => {
    setModalMode('create');
  };

  const handleViewReview = (review: AccessReview) => {
    fetchReviewDetail(review.id);
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedReview(null);
    setSelectedItemIds([]);
    setItemNotes({});
    setBulkReason('');
    setDecisionFilter('all');
  };

  const handleNotifyReviewers = useCallback(
    async (context: { id: string; name: string; dueDate?: string; reviewerIds?: string[] }) => {
      if (!context.id) return false;
      setNotifying(true);
      setError(undefined);
      try {
        const response = await fetchWithAuth(`/access-reviews/${context.id}/notify`, {
          method: 'POST',
          body: JSON.stringify({ reviewerIds: context.reviewerIds, name: context.name })
        });

        if (response.ok) {
          return true;
        }

        const reviewerEmails = (context.reviewerIds ?? [])
          .map((id) => reviewers.find((reviewer) => reviewer.id === id)?.email)
          .filter((email): email is string => Boolean(email));

        if (reviewerEmails.length === 0) {
          throw new Error(t('accessReviewPage.noReviewerEmailsAvailableForNotifications'));
        }

        if (typeof window !== 'undefined') {
          const subject = encodeURIComponent(t('accessReviewPage.emailSubject', { name: context.name }));
          const dueLabel = context.dueDate
            ? t('accessReviewPage.emailDeadline', { date: formatDate(context.dueDate) })
            : t('accessReviewPage.noDeadlineSet');
          const body = encodeURIComponent(
            t('accessReviewPage.emailBody', { name: context.name, dueLabel })
          );
          window.location.href = `mailto:${reviewerEmails.join(',')}?subject=${subject}&body=${body}`;
          return true;
        }

        throw new Error(t('accessReviewPage.unableToLaunchEmailNotification'));
      } catch (err) {
        setError(err instanceof Error ? err.message : t('accessReviewPage.anErrorOccurred'));
        return false;
      } finally {
        setNotifying(false);
      }
    },
    [reviewers]
  );

  const handleCreateSubmit = async (values: AccessReviewFormValues) => {
    setSubmitting(true);
    try {
      const response = await fetchWithAuth('/access-reviews', {
        method: 'POST',
        body: JSON.stringify({
          name: values.name,
          description: values.description,
          dueDate: values.dueDate ? new Date(values.dueDate).toISOString() : undefined,
          reviewerId: values.reviewerIds?.[0],
          reviewerIds: values.reviewerIds,
          scope: values.scope
        })
      });

      if (!response.ok) {
        throw new Error(t('accessReviewPage.failedToCreateAccessReview'));
      }

      const result = await response.json();

      if (values.notifyReviewers && values.reviewerIds && values.reviewerIds.length > 0) {
        await handleNotifyReviewers({
          id: result.id,
          name: values.name,
          dueDate: values.dueDate,
          reviewerIds: values.reviewerIds
        });
      }

      await fetchReviews();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accessReviewPage.anErrorOccurred'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateDecision = async (
    itemId: string,
    decision: AccessReviewDecision,
    notes?: string
  ) => {
    if (!selectedReview) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(
        `/access-reviews/${selectedReview.id}/items/${itemId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ decision, notes })
        }
      );

      if (!response.ok) {
        throw new Error(t('accessReviewPage.failedToUpdateDecision'));
      }

      await fetchReviewDetail(selectedReview.id);
      await fetchReviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accessReviewPage.anErrorOccurred'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkDecision = async (decision: AccessReviewDecision) => {
    if (!selectedReview || selectedItemIds.length === 0) return;

    setSubmitting(true);
    try {
      await Promise.all(
        selectedItemIds.map(async (itemId) => {
          const notes = bulkReason || itemNotes[itemId];
          const response = await fetchWithAuth(
            `/access-reviews/${selectedReview.id}/items/${itemId}`,
            {
              method: 'PATCH',
              body: JSON.stringify({ decision, notes })
            }
          );

          if (!response.ok) {
            throw new Error(t('accessReviewPage.failedToUpdateDecision'));
          }
        })
      );

      setSelectedItemIds([]);
      setBulkReason('');
      await fetchReviewDetail(selectedReview.id);
      await fetchReviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accessReviewPage.anErrorOccurred'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGenerateReport = useCallback(
    async (review?: AccessReviewDetail | AccessReview) => {
      const reviewId = review?.id ?? selectedReview?.id;
      if (!reviewId) return;

      setReporting(true);
      try {
        let detail = review as AccessReviewDetail | null;
        if (!detail?.items) {
          const response = await fetchWithAuth(`/access-reviews/${reviewId}`);
          if (!response.ok) {
            throw new Error(t('accessReviewPage.failedToFetchReviewForReport'));
          }
          detail = await response.json();
        }

        if (!detail) {
          throw new Error(t('accessReviewPage.failedToFetchReviewDetailsForReport'));
        }
        const csv = buildReviewCsv(detail, t);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `access-review-${detail.name.toLowerCase().replace(/\s+/g, '-')}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('accessReviewPage.anErrorOccurred'));
      } finally {
        setReporting(false);
      }
    },
    [selectedReview, t]
  );

  const handleCompleteReview = async () => {
    if (!selectedReview) return;

    const pendingItems = selectedReview.items.filter((item) => item.decision === 'pending');
    if (pendingItems.length > 0) {
      setError(t('accessReviewPage.pleaseReviewAllItemsBeforeCompleting'));
      return;
    }

    const revokedCount = selectedReview.items.filter((item) => item.decision === 'revoked').length;
    const confirmMessage = revokedCount > 0
      ? t('accessReviewPage.completeWithRevocations', { count: revokedCount })
      : t('accessReviewPage.completeConfirm');

    if (!confirm(confirmMessage)) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/access-reviews/${selectedReview.id}/complete`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error(t('accessReviewPage.failedToCompleteReview'));
      }

      await fetchReviews();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accessReviewPage.anErrorOccurred'));
    } finally {
      setSubmitting(false);
    }
  };

  const filteredItems = useMemo(() => {
    if (!selectedReview) return [];
    if (decisionFilter === 'all') return selectedReview.items;
    return selectedReview.items.filter((item) => item.decision === decisionFilter);
  }, [decisionFilter, selectedReview]);

  const selectedItemSet = useMemo(() => new Set(selectedItemIds), [selectedItemIds]);
  const allSelected =
    filteredItems.length > 0 && filteredItems.every((item) => selectedItemSet.has(item.id));

  const decisionCounts = useMemo(() => {
    if (!selectedReview) {
      return { approved: 0, revoked: 0, pending: 0, reviewed: 0, total: 0 };
    }
    const approved = selectedReview.items.filter((item) => item.decision === 'approved').length;
    const revoked = selectedReview.items.filter((item) => item.decision === 'revoked').length;
    const pending = selectedReview.items.filter((item) => item.decision === 'pending').length;
    const reviewed = approved + revoked;
    return { approved, revoked, pending, reviewed, total: selectedReview.items.length };
  }, [selectedReview]);

  const deadlineStatus = selectedReview ? getDeadlineStatus(selectedReview.dueDate) : null;
  const progressPercent =
    decisionCounts.total > 0 ? Math.round((decisionCounts.reviewed / decisionCounts.total) * 100) : 0;

  const assignedReviewer = useMemo(() => {
    if (!selectedReview?.reviewerId) return null;
    return reviewers.find((reviewer) => reviewer.id === selectedReview.reviewerId) ?? null;
  }, [reviewers, selectedReview]);

  const historyReviews = useMemo(() => {
    return reviews
      .filter((review) => review.status === 'completed')
      .slice()
      .sort((a, b) => {
        const aDate = new Date(a.completedAt ?? a.createdAt).getTime();
        const bDate = new Date(b.completedAt ?? b.createdAt).getTime();
        return bDate - aDate;
      });
  }, [reviews]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('accessReviewPage.loadingAccessReviews')}</p>
        </div>
      </div>
    );
  }

  if (error && reviews.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchReviews}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('accessReviewPage.tryAgain')}</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('accessReviewPage.accessReviews')}</h1>
        <p className="text-muted-foreground">
          {t('accessReviewPage.conductPeriodicReviewsOfUserAccessAndPermissionsToEnsure')}</p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {reviewersError && (
        <div className="rounded-md border border-amber-400/40 bg-amber-100/60 px-3 py-2 text-sm text-amber-800">
          {reviewersError}
        </div>
      )}

      <AccessReviewList
        reviews={reviews}
        onCreateNew={handleCreateNew}
        onViewReview={handleViewReview}
      />

      <div className="space-y-4 rounded-lg border bg-card p-6 shadow-xs">
        <div>
          <h2 className="text-lg font-semibold">{t('accessReviewPage.reviewHistory')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('accessReviewPage.completedCampaignsAndCertificationEvidenceForAudits')}</p>
        </div>

        <div className="overflow-hidden rounded-lg border">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">{t('accessReviewPage.campaign')}</th>
                <th className="px-4 py-3">{t('accessReviewPage.completed')}</th>
                <th className="px-4 py-3">{t('accessReviewPage.reviewer')}</th>
                <th className="px-4 py-3">{t('accessReviewPage.dueDate')}</th>
                <th className="px-4 py-3 text-right">{t('accessReviewPage.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {historyReviews.map((review) => (
                <tr key={review.id} className="border-t">
                  <td className="px-4 py-3">
                    <div>
                      <span className="font-medium">{review.name}</span>
                      {review.description && (
                        <p className="text-xs text-muted-foreground truncate max-w-xs">
                          {review.description}
                        </p>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {review.completedAt ? formatDate(review.completedAt) : '-'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {review.reviewerName || t('accessReviewPage.unassigned')}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {review.dueDate ? formatDate(review.dueDate) : '-'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => handleViewReview(review)}
                        className="text-sm font-medium text-primary hover:underline"
                      >
                        {t('accessReviewPage.view')}</button>
                      <button
                        type="button"
                        onClick={() => handleGenerateReport(review)}
                        disabled={reporting}
                        className="text-sm font-medium text-muted-foreground hover:text-foreground"
                      >
                        {reporting ? t('accessReviewPage.generating') : t('accessReviewPage.report')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {historyReviews.length === 0 && (
                <tr className="border-t">
                  <td className="px-4 py-8 text-center text-sm text-muted-foreground" colSpan={5}>
                    {t('accessReviewPage.noCompletedAccessReviewCampaignsYet')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Review Modal */}
      <AccessReviewForm
        isOpen={modalMode === 'create'}
        onSubmit={handleCreateSubmit}
        onCancel={handleCloseModal}
        loading={submitting}
        reviewers={reviewers}
      />

      {/* Review Detail Modal */}
      {modalMode === 'review' && selectedReview && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 px-4 py-8 overflow-y-auto">
          <div className="w-full max-w-5xl rounded-lg border bg-card p-6 shadow-xs my-8">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{selectedReview.name}</h2>
                {selectedReview.description && (
                  <p className="text-sm text-muted-foreground">{selectedReview.description}</p>
                )}
                <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                      selectedReview.status === 'pending' && 'bg-amber-500/10 text-amber-700',
                      selectedReview.status === 'in_progress' && 'bg-blue-500/10 text-blue-700',
                      selectedReview.status === 'completed' && 'bg-emerald-500/10 text-emerald-700'
                    )}
                  >
                    {selectedReview.status === 'in_progress'
                      ? t('accessReviewPage.inProgress')
                      : selectedReview.status.charAt(0).toUpperCase() + selectedReview.status.slice(1)}
                  </span>
                  <span>{selectedReview.items.length} {t('accessReviewPage.usersToReview')}</span>
                  {selectedReview.dueDate && (
                    <span
                      className={cn(
                        deadlineStatus?.isOverdue ? 'text-destructive font-medium' : ''
                      )}
                    >
                      {t('accessReviewPage.due')}{formatDate(selectedReview.dueDate)}
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={handleCloseModal}
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('accessReviewPage.close')}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-6 rounded-lg border bg-muted/30 p-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-2">
                  <p className="text-xs uppercase text-muted-foreground">{t('accessReviewPage.progress')}</p>
                  <p className="text-sm font-medium">
                    {decisionCounts.reviewed} {t('accessReviewPage.of')}{decisionCounts.total} {t('accessReviewPage.reviewed')}</p>
                  <div className="h-2 w-48 rounded-full bg-muted">
                    <div
                      className={cn('h-2 rounded-full bg-emerald-500', widthPercentClass(progressPercent))}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="text-xs uppercase text-muted-foreground">{t('accessReviewPage.deadline')}</p>
                  <p
                    className={cn(
                      'text-sm font-medium',
                      deadlineStatus?.isOverdue ? 'text-destructive' : 'text-foreground'
                    )}
                  >
                    {selectedReview.dueDate ? formatDate(selectedReview.dueDate) : t('accessReviewPage.noDeadline')}
                  </p>
                  <p
                    className={cn(
                      'text-xs',
                      deadlineStatus?.isOverdue ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {deadlineStatus?.label ?? t('accessReviewPage.noDeadline')}
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-xs uppercase text-muted-foreground">{t('accessReviewPage.reviewer')}</p>
                  <p className="text-sm font-medium">
                    {assignedReviewer?.name || selectedReview.reviewerName || t('accessReviewPage.unassigned')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {assignedReviewer?.email || ''}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="decision-filter" className="text-sm font-medium">
                  {t('accessReviewPage.filter')}</label>
                <select
                  id="decision-filter"
                  value={decisionFilter}
                  onChange={(event) => setDecisionFilter(event.target.value as AccessReviewDecision | 'all')}
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="all">{t('accessReviewPage.allDecisions')}</option>
                  <option value="pending">{t('accessReviewPage.pending')}</option>
                  <option value="approved">{t('accessReviewPage.approved')}</option>
                  <option value="revoked">{t('accessReviewPage.revoked')}</option>
                </select>
              </div>
              <div className="text-sm text-muted-foreground">
                {t('accessReviewPage.showing')}{filteredItems.length} {t('accessReviewPage.of')}{selectedReview.items.length} {t('accessReviewPage.users')}</div>
            </div>

            {selectedReview.status !== 'completed' && (
              <div className="mt-4 rounded-lg border bg-muted/30 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="text"
                    value={bulkReason}
                    onChange={(event) => setBulkReason(event.target.value)}
                    placeholder={t('accessReviewPage.reasonForBulkActionOptional')}
                    className="h-10 flex-1 min-w-[220px] rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                  <button
                    type="button"
                    onClick={() => handleBulkDecision('approved')}
                    disabled={submitting || selectedItemIds.length === 0}
                    className="inline-flex h-10 items-center justify-center rounded-md bg-emerald-600 px-4 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('accessReviewPage.approveSelected')}</button>
                  <button
                    type="button"
                    onClick={() => handleBulkDecision('revoked')}
                    disabled={submitting || selectedItemIds.length === 0}
                    className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('accessReviewPage.revokeSelected')}</button>
                  <button
                    type="button"
                    onClick={() => setSelectedItemIds([])}
                    disabled={selectedItemIds.length === 0}
                    className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('accessReviewPage.clear')}</button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {selectedItemIds.length} {t('accessReviewPage.selected')}</p>
              </div>
            )}

            <div className="mt-6 overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() => {
                          if (allSelected) {
                            setSelectedItemIds([]);
                            return;
                          }
                          setSelectedItemIds(filteredItems.map((item) => item.id));
                        }}
                        disabled={
                          selectedReview.status === 'completed' || filteredItems.length === 0
                        }
                        className="h-4 w-4 rounded border-muted-foreground"
                        aria-label={t('accessReviewPage.selectAll')}
                      />
                    </th>
                    <th className="px-4 py-3">{t('accessReviewPage.user')}</th>
                    <th className="px-4 py-3">{t('accessReviewPage.role')}</th>
                    <th className="px-4 py-3">{t('accessReviewPage.permissions')}</th>
                    <th className="px-4 py-3">{t('accessReviewPage.lastActive')}</th>
                    <th className="px-4 py-3">{t('accessReviewPage.decision')}</th>
                    <th className="px-4 py-3">{t('accessReviewPage.reason')}</th>
                    <th className="px-4 py-3 text-right">{t('accessReviewPage.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => {
                    const permissions = item.permissions ?? [];
                    return (
                      <tr key={item.id} className="border-t">
                        <td className="px-4 py-3">
                          <input
                            type="checkbox"
                            checked={selectedItemSet.has(item.id)}
                            onChange={() => {
                              setSelectedItemIds((prev) =>
                                prev.includes(item.id)
                                  ? prev.filter((id) => id !== item.id)
                                  : [...prev, item.id]
                              );
                            }}
                            disabled={selectedReview.status === 'completed'}
                            className="h-4 w-4 rounded border-muted-foreground"
                            aria-label={t('accessReviewPage.selectUser', { name: item.userName })}
                          />
                        </td>
                        <td className="px-4 py-3">
                          <div>
                            <span className="font-medium">{item.userName}</span>
                            <p className="text-xs text-muted-foreground">{item.userEmail}</p>
                          </div>
                        </td>
                        <td className="px-4 py-3">{item.roleName}</td>
                        <td className="px-4 py-3">
                          {permissions.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {permissions.slice(0, 3).map((permission) => (
                                <span
                                  key={`${item.id}-${permission}`}
                                  className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                                >
                                  {permission}
                                </span>
                              ))}
                              {permissions.length > 3 && (
                                <span className="text-xs text-muted-foreground">
                                  +{permissions.length - 3} {t('accessReviewPage.more')}</span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatRelativeDate(item.lastActiveAt)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                              decisionStyles[item.decision]
                            )}
                          >
                            {t(/* i18n-dynamic */ decisionLabelKeys[item.decision])}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {selectedReview.status === 'completed' ? (
                            <span className="text-xs text-muted-foreground">{item.notes || '-'}</span>
                          ) : (
                            <input
                              type="text"
                              value={itemNotes[item.id] ?? ''}
                              onChange={(event) =>
                                setItemNotes((prev) => ({ ...prev, [item.id]: event.target.value }))
                              }
                              placeholder={t('accessReviewPage.reasonOptional')}
                              className="h-9 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                            />
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {selectedReview.status !== 'completed' && (
                            <div className="flex items-center justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => handleUpdateDecision(item.id, 'approved', itemNotes[item.id])}
                                disabled={submitting || item.decision === 'approved'}
                                className={cn(
                                  'text-sm font-medium transition',
                                  item.decision === 'approved'
                                    ? 'text-emerald-700 cursor-default'
                                    : 'text-emerald-600 hover:text-emerald-700 hover:underline'
                                )}
                              >
                                {t('accessReviewPage.approve')}</button>
                              <span className="text-muted-foreground">|</span>
                              <button
                                type="button"
                                onClick={() => handleUpdateDecision(item.id, 'revoked', itemNotes[item.id])}
                                disabled={submitting || item.decision === 'revoked'}
                                className={cn(
                                  'text-sm font-medium transition',
                                  item.decision === 'revoked'
                                    ? 'text-destructive cursor-default'
                                    : 'text-destructive/80 hover:text-destructive hover:underline'
                                )}
                              >
                                {t('accessReviewPage.revoke')}</button>
                            </div>
                          )}
                          {selectedReview.status === 'completed' && (
                            <span className="text-sm text-muted-foreground">-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredItems.length === 0 && (
                    <tr className="border-t">
                      <td className="px-4 py-8 text-center text-sm text-muted-foreground" colSpan={8}>
                        {t('accessReviewPage.noUsersMatchThisFilter')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t pt-6">
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-emerald-700">
                  {decisionCounts.approved} {t('accessReviewPage.approved2')}</span>
                {' | '}
                <span className="font-medium text-destructive">
                  {decisionCounts.revoked} {t('accessReviewPage.revoked2')}</span>
                {' | '}
                <span className="font-medium text-amber-700">
                  {decisionCounts.pending} {t('accessReviewPage.pending2')}</span>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() =>
                    handleGenerateReport({
                      ...selectedReview,
                      items: selectedReview.items
                    })
                  }
                  disabled={reporting}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {reporting ? t('accessReviewPage.generating') : t('accessReviewPage.generateReport')}
                </button>
                {selectedReview.status !== 'completed' && (
                  <button
                    type="button"
                    onClick={() =>
                      handleNotifyReviewers({
                        id: selectedReview.id,
                        name: selectedReview.name,
                        dueDate: selectedReview.dueDate,
                        reviewerIds: selectedReview.reviewerId ? [selectedReview.reviewerId] : []
                      })
                    }
                    disabled={notifying || !selectedReview.reviewerId}
                    className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {notifying ? t('accessReviewPage.sending') : t('accessReviewPage.notifyReviewers')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                >
                  {t('accessReviewPage.close')}</button>
                {selectedReview.status !== 'completed' && (
                  <button
                    type="button"
                    onClick={handleCompleteReview}
                    disabled={submitting || selectedReview.items.some((i) => i.decision === 'pending')}
                    className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? t('accessReviewPage.completing') : t('accessReviewPage.completeReview')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

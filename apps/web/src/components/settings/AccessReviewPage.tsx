import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import AccessReviewList, { type AccessReview, type AccessReviewStatus } from './AccessReviewList';
import AccessReviewForm from './AccessReviewForm';

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
};

type AccessReviewDetail = AccessReview & {
  items: AccessReviewItem[];
};

type ModalMode = 'closed' | 'create' | 'review';

const decisionStyles: Record<AccessReviewDecision, string> = {
  pending: 'bg-amber-500/10 text-amber-700',
  approved: 'bg-emerald-500/10 text-emerald-700',
  revoked: 'bg-destructive/10 text-destructive'
};

const decisionLabels: Record<AccessReviewDecision, string> = {
  pending: 'Pending',
  approved: 'Approved',
  revoked: 'Revoked'
};

export default function AccessReviewPage() {
  const [reviews, setReviews] = useState<AccessReview[]>([]);
  const [selectedReview, setSelectedReview] = useState<AccessReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [submitting, setSubmitting] = useState(false);

  const fetchReviews = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/v1/access-reviews');
      if (!response.ok) {
        throw new Error('Failed to fetch access reviews');
      }
      const result = await response.json();
      setReviews(result.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchReviewDetail = useCallback(async (reviewId: string) => {
    try {
      setError(undefined);
      const response = await fetch(`/api/v1/access-reviews/${reviewId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch review details');
      }
      const result = await response.json();
      setSelectedReview(result);
      setModalMode('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  }, []);

  useEffect(() => {
    fetchReviews();
  }, [fetchReviews]);

  const handleCreateNew = () => {
    setModalMode('create');
  };

  const handleViewReview = (review: AccessReview) => {
    fetchReviewDetail(review.id);
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedReview(null);
  };

  const handleCreateSubmit = async (values: { name: string; description?: string; dueDate?: string }) => {
    setSubmitting(true);
    try {
      const response = await fetch('/api/v1/access-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: values.name,
          description: values.description,
          dueDate: values.dueDate ? new Date(values.dueDate).toISOString() : undefined
        })
      });

      if (!response.ok) {
        throw new Error('Failed to create access review');
      }

      await fetchReviews();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateDecision = async (itemId: string, decision: AccessReviewDecision, notes?: string) => {
    if (!selectedReview) return;

    setSubmitting(true);
    try {
      const response = await fetch(
        `/api/v1/access-reviews/${selectedReview.id}/items/${itemId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, notes })
        }
      );

      if (!response.ok) {
        throw new Error('Failed to update decision');
      }

      // Refresh the review detail
      await fetchReviewDetail(selectedReview.id);
      await fetchReviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCompleteReview = async () => {
    if (!selectedReview) return;

    const pendingItems = selectedReview.items.filter((item) => item.decision === 'pending');
    if (pendingItems.length > 0) {
      setError('Please review all items before completing');
      return;
    }

    const revokedCount = selectedReview.items.filter((item) => item.decision === 'revoked').length;
    const confirmMessage = revokedCount > 0
      ? `This will complete the review and revoke access for ${revokedCount} user(s). Continue?`
      : 'This will complete the review. Continue?';

    if (!confirm(confirmMessage)) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/v1/access-reviews/${selectedReview.id}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        throw new Error('Failed to complete review');
      }

      await fetchReviews();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading access reviews...</p>
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
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Access Reviews</h1>
        <p className="text-muted-foreground">
          Conduct periodic reviews of user access and permissions to ensure compliance.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <AccessReviewList
        reviews={reviews}
        onCreateNew={handleCreateNew}
        onViewReview={handleViewReview}
      />

      {/* Create Review Modal */}
      <AccessReviewForm
        isOpen={modalMode === 'create'}
        onSubmit={handleCreateSubmit}
        onCancel={handleCloseModal}
        loading={submitting}
      />

      {/* Review Detail Modal */}
      {modalMode === 'review' && selectedReview && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 px-4 py-8 overflow-y-auto">
          <div className="w-full max-w-4xl rounded-lg border bg-card p-6 shadow-sm my-8">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{selectedReview.name}</h2>
                {selectedReview.description && (
                  <p className="text-sm text-muted-foreground">{selectedReview.description}</p>
                )}
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                      selectedReview.status === 'pending' && 'bg-amber-500/10 text-amber-700',
                      selectedReview.status === 'in_progress' && 'bg-blue-500/10 text-blue-700',
                      selectedReview.status === 'completed' && 'bg-emerald-500/10 text-emerald-700'
                    )}
                  >
                    {selectedReview.status === 'in_progress' ? 'In Progress' :
                      selectedReview.status.charAt(0).toUpperCase() + selectedReview.status.slice(1)}
                  </span>
                  <span>{selectedReview.items.length} users to review</span>
                </div>
              </div>
              <button
                type="button"
                onClick={handleCloseModal}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Close"
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

            <div className="mt-6 overflow-hidden rounded-lg border">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">User</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Decision</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedReview.items.map((item) => (
                    <tr key={item.id} className="border-t">
                      <td className="px-4 py-3">
                        <div>
                          <span className="font-medium">{item.userName}</span>
                          <p className="text-xs text-muted-foreground">{item.userEmail}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3">{item.roleName}</td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
                            decisionStyles[item.decision]
                          )}
                        >
                          {decisionLabels[item.decision]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {selectedReview.status !== 'completed' && (
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => handleUpdateDecision(item.id, 'approved')}
                              disabled={submitting || item.decision === 'approved'}
                              className={cn(
                                'text-sm font-medium transition',
                                item.decision === 'approved'
                                  ? 'text-emerald-700 cursor-default'
                                  : 'text-emerald-600 hover:text-emerald-700 hover:underline'
                              )}
                            >
                              Approve
                            </button>
                            <span className="text-muted-foreground">|</span>
                            <button
                              type="button"
                              onClick={() => handleUpdateDecision(item.id, 'revoked')}
                              disabled={submitting || item.decision === 'revoked'}
                              className={cn(
                                'text-sm font-medium transition',
                                item.decision === 'revoked'
                                  ? 'text-destructive cursor-default'
                                  : 'text-destructive/80 hover:text-destructive hover:underline'
                              )}
                            >
                              Revoke
                            </button>
                          </div>
                        )}
                        {selectedReview.status === 'completed' && (
                          <span className="text-sm text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {selectedReview.items.length === 0 && (
                    <tr className="border-t">
                      <td className="px-4 py-8 text-center text-sm text-muted-foreground" colSpan={4}>
                        No users to review.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Summary and Actions */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t pt-6">
              <div className="text-sm text-muted-foreground">
                <span className="font-medium text-emerald-700">
                  {selectedReview.items.filter((i) => i.decision === 'approved').length} approved
                </span>
                {' | '}
                <span className="font-medium text-destructive">
                  {selectedReview.items.filter((i) => i.decision === 'revoked').length} revoked
                </span>
                {' | '}
                <span className="font-medium text-amber-700">
                  {selectedReview.items.filter((i) => i.decision === 'pending').length} pending
                </span>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                >
                  Close
                </button>
                {selectedReview.status !== 'completed' && (
                  <button
                    type="button"
                    onClick={handleCompleteReview}
                    disabled={submitting || selectedReview.items.some((i) => i.decision === 'pending')}
                    className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? 'Completing...' : 'Complete Review'}
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

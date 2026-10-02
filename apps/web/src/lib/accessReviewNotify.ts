export type NotifyFallbackReason =
  | 'email_not_configured'
  | 'no_reviewer_email'
  | 'send_failed'
  | 'request_failed';

export type NotifyOutcome =
  | { emailed: true }
  | { emailed: false; reason: NotifyFallbackReason }
  // The request was rejected (400/403/404): mailto: would hide a permission or
  // scope problem, so the caller surfaces `message` instead of falling back.
  | { emailed: false; reason: 'rejected'; status: number; message: string };

const SERVER_REASONS: readonly string[] = ['email_not_configured', 'no_reviewer_email', 'send_failed'];

/**
 * Ask the API to email the review's assigned reviewer. Never throws: any
 * failure becomes `{ emailed: false, reason }` so the caller can fall back to
 * mailto: and tell the user why.
 */
export async function requestReviewerNotification(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  reviewId: string
): Promise<NotifyOutcome> {
  try {
    const response = await fetcher(`/access-reviews/${reviewId}/notify`, { method: 'POST' });
    if (!response.ok) {
      if ([400, 403, 404].includes(response.status)) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        return { emailed: false, reason: 'rejected', status: response.status, message: err.error ?? `HTTP ${response.status}` };
      }
      return { emailed: false, reason: 'request_failed' };
    }
    const body = (await response.json()) as { emailed?: boolean; reason?: string };
    if (body.emailed === true) return { emailed: true };
    const reason = body.reason && SERVER_REASONS.includes(body.reason) ? body.reason : 'request_failed';
    return { emailed: false, reason: reason as NotifyFallbackReason };
  } catch (err) {
    console.warn('[accessReviewNotify] notify request failed', err);
    return { emailed: false, reason: 'request_failed' };
  }
}

export type NotifyFallbackReason =
  | 'email_not_configured'
  | 'no_reviewer_email'
  | 'send_failed'
  | 'request_failed';

export type NotifyOutcome = { emailed: true } | { emailed: false; reason: NotifyFallbackReason };

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
    if (!response.ok) return { emailed: false, reason: 'request_failed' };
    const body = (await response.json()) as { emailed?: boolean; reason?: string };
    if (body.emailed === true) return { emailed: true };
    const reason = body.reason && SERVER_REASONS.includes(body.reason) ? body.reason : 'request_failed';
    return { emailed: false, reason: reason as NotifyFallbackReason };
  } catch {
    return { emailed: false, reason: 'request_failed' };
  }
}

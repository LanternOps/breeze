import { describe, it, expect, vi } from 'vitest';
import { requestReviewerNotification } from './accessReviewNotify';

const res = (ok: boolean, body: unknown, status = ok ? 200 : 500) =>
  ({ ok, status, json: async () => body }) as Response;

describe('requestReviewerNotification', () => {
  it('posts to the notify route and reports a server send', async () => {
    const fetcher = vi.fn().mockResolvedValue(res(true, { emailed: true, recipients: 1 }));
    const out = await requestReviewerNotification(fetcher, 'r-1');
    expect(fetcher).toHaveBeenCalledWith('/access-reviews/r-1/notify', { method: 'POST' });
    expect(out).toEqual({ emailed: true });
  });

  it.each(['email_not_configured', 'no_reviewer_email', 'send_failed'] as const)(
    'surfaces server reason %s so the UI can explain the mailto fallback',
    async (reason) => {
      const fetcher = vi.fn().mockResolvedValue(res(true, { emailed: false, reason }));
      expect(await requestReviewerNotification(fetcher, 'r-1')).toEqual({ emailed: false, reason });
    }
  );

  it('maps a 5xx response to request_failed', async () => {
    const fetcher = vi.fn().mockResolvedValue(res(false, { error: 'x' }, 502));
    expect(await requestReviewerNotification(fetcher, 'r-1')).toEqual({ emailed: false, reason: 'request_failed' });
  });

  it.each([400, 403, 404])('surfaces a %i rejection instead of a fallback', async (status) => {
    const fetcher = vi.fn().mockResolvedValue(res(false, { error: 'nope' }, status));
    expect(await requestReviewerNotification(fetcher, 'r-1')).toEqual({
      emailed: false, reason: 'rejected', status, message: 'nope'
    });
  });

  it('maps an unknown server reason to request_failed', async () => {
    const fetcher = vi.fn().mockResolvedValue(res(true, { emailed: false, reason: 'weird' }));
    expect(await requestReviewerNotification(fetcher, 'r-1')).toEqual({ emailed: false, reason: 'request_failed' });
  });

  it('maps a network error to request_failed', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await requestReviewerNotification(fetcher, 'r-1')).toEqual({ emailed: false, reason: 'request_failed' });
  });
});

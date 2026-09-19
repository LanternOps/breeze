import { captureMessage } from './sentry';
import { throttledReporter } from './sentryThrottle';

/**
 * Shared handling for a device-filter preview cancelled by
 * `withFilterStatementTimeout`'s 500ms bound (#5181 / BREEZE-2C).
 *
 * Lives here rather than in `routes/filters.ts` because there are FOUR preview
 * endpoints across two route files — the ad-hoc preview (enriched and
 * `idsOnly`), the saved-filter preview, and the dynamic-group preview in
 * `routes/groups.ts`. Keeping the body and the reporter in one place is what
 * stops the fourth one from being the endpoint that still answers an anonymous
 * 500, which is exactly how this class of bug survives a partial fix.
 *
 * 57014 means the filter is well-formed — `validateFilter` already passed — and
 * simply too expensive to run, so the honest answer is a 4xx that says "narrow
 * it", not the 500 a raw `PostgresError` produced.
 *
 * 422 rather than 408: 408 promises that an identical retry can succeed, and
 * this one cannot — the same filter over the same fleet hits the same bound
 * every time. The client's move is to change the request, which is what
 * "well-formed but unprocessable" means. `code` is the stable discriminator the
 * web maps to a translated string (the established `ActionError.code` /
 * `failureCopy` convention); `error` is the English fallback for non-UI callers.
 */
export const FILTER_PREVIEW_TIMEOUT_BODY = {
  error: 'Filter preview took too long to run. Narrow the filter and try again.',
  code: 'filter_query_timeout',
} as const;

export const FILTER_PREVIEW_TIMEOUT_STATUS = 422;

/**
 * THROTTLED. Filter preview is a UI-facing endpoint the device list polls, so
 * one org with a missing index on a newly filterable column can trip this on
 * every refresh of an affected view — an unthrottled `captureMessage` would
 * turn that into a per-request event stream and burn the quota that makes the
 * next incident visible. One event per minute per process is enough to see the
 * condition and alert on it; `captureMessage` itself has no sampling or dedup.
 */
const reportThrottled = throttledReporter(60_000, (suppressed) => {
  captureMessage('Device filter preview hit its statement_timeout', {
    eventCode: 'filter_preview_statement_timeout',
    level: 'warning',
    // No org/user/filter id: those are exactly the unbounded tag cardinality
    // the event-code registry exists to keep out. Per-tenant attribution lives
    // in the console line below and in the route audit rows.
    tags: { pg_code: '57014' },
  });
  if (suppressed > 0) {
    console.warn(`[filterPreview] ${suppressed} further statement_timeouts suppressed since the last Sentry report`);
  }
});

/**
 * `orgId` is logged, never tagged. The console line is neither scrubbed nor
 * throttled, so a partner previewing across many orgs can still be told WHICH
 * org timed out — the 422 body cannot say, because the multi-org loop abandons
 * the whole preview on the first timeout (unchanged from the 500 it replaces;
 * partial results were discarded before this change too).
 */
export function reportFilterPreviewTimeout(orgId: string | null): void {
  console.warn(`[filterPreview] cancelled by statement_timeout (57014)${orgId ? ` for org ${orgId}` : ''}`);
  reportThrottled();
}

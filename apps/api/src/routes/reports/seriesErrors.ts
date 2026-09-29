import type { Context } from 'hono';
import { SeriesAuthorityUnverifiableError } from '../../services/reportSeries/authority';
import { ReportSeriesError } from '../../services/reportSeries/errors';

/**
 * The ONE mapper from ReportSeriesError to an HTTP answer (INDEX):
 * `{ error: code, ...body }` with the error's status. Anything else is
 * rethrown to the app's error handler (a 500 with the usual capture).
 */
export function seriesErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof ReportSeriesError) {
    return c.json({ error: err.code, ...(err.body ?? {}) }, err.status);
  }
  // Transient live-authority lookup failure: not a denial, retryable.
  if (err instanceof SeriesAuthorityUnverifiableError) {
    return c.json({ error: 'series_authority_unverifiable' }, 503);
  }
  throw err;
}

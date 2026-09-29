/**
 * Multi-org report series (spec 2026-09-28). The one error type every
 * services/reportSeries module throws (INDEX contract). Routes map it through
 * `seriesErrorResponse` (routes/reports/seriesErrors.ts) into
 * `{ error: code, ...body }` with `status`. W04 may subclass it.
 */
export class ReportSeriesError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly body?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'ReportSeriesError';
  }
}

export function seriesNotFound(): ReportSeriesError {
  return new ReportSeriesError('series_not_found', 404);
}

export function isReportSeriesError(err: unknown, code?: string): err is ReportSeriesError {
  return err instanceof ReportSeriesError && (code === undefined || err.code === code);
}

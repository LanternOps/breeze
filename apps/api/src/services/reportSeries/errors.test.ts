import { describe, expect, it } from 'vitest';
import { isReportSeriesError, ReportSeriesError, seriesNotFound } from './errors';

describe('ReportSeriesError', () => {
  it('carries code, status and an optional body', () => {
    const err = new ReportSeriesError('series_owner_ineligible', 400, { reason: 'user_inactive' });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('series_owner_ineligible');
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ reason: 'user_inactive' });
  });

  it('seriesNotFound is the 404 series_not_found error', () => {
    const err = seriesNotFound();
    expect([err.code, err.status]).toEqual(['series_not_found', 404]);
  });

  it('isReportSeriesError narrows by class and optionally by code', () => {
    const err = new ReportSeriesError('series_managed', 409);
    expect(isReportSeriesError(err)).toBe(true);
    expect(isReportSeriesError(err, 'series_managed')).toBe(true);
    expect(isReportSeriesError(err, 'series_not_found')).toBe(false);
    expect(isReportSeriesError(new Error('series_managed'))).toBe(false);
  });
});

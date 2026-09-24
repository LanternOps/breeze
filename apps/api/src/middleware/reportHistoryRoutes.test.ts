import { describe, expect, it } from 'vitest';
import { isReportHistoryReadRoute } from './reportHistoryRoutes';

const ID = '44444444-4444-4444-8444-444444444444';

/**
 * #6771 — the report-history capability is computed ONLY for the routes that
 * show definitions and run metadata. Everything else — recipients (live
 * contact PII), downloads and /data (exports), every mutation — must not opt
 * in, so neither the app-layer capability nor the RLS GUC exists there.
 */
describe('isReportHistoryReadRoute (#6771 route allowance)', () => {
  it.each([
    '/api/v1/reports',
    '/api/v1/reports/',
    '/api/v1/reports/templates',
    `/api/v1/reports/${ID}`,
    '/api/v1/reports/runs',
    `/api/v1/reports/runs/${ID}`,
    // Integration suites mount the router at /reports with no /api/v1 prefix.
    '/reports',
    `/reports/${ID}`,
    `/reports/runs/${ID}`,
  ])('GET %s opts in', (path) => {
    expect(isReportHistoryReadRoute('GET', path)).toBe(true);
  });

  it.each([
    `/api/v1/reports/${ID}/recipients`,
    `/api/v1/reports/runs/${ID}/download`,
    '/api/v1/reports/data/device-inventory',
    '/api/v1/reports/data/software-inventory',
    `/api/v1/reports/${ID}/generate`,
    '/api/v1/reports/generate',
    '/api/v1/reports/not-a-uuid',
    `/api/v1/reports/runs/${ID}/attachments/from-artifact`,
    '/api/v1/devices',
    '/api/v1/reportsx',
    `/api/v1/other/reports/${ID}`,
  ])('GET %s does not opt in', (path) => {
    expect(isReportHistoryReadRoute('GET', path)).toBe(false);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])(
    '%s never opts in, even on an allowed path',
    (method) => {
      expect(isReportHistoryReadRoute(method, '/api/v1/reports')).toBe(false);
      expect(isReportHistoryReadRoute(method, `/api/v1/reports/${ID}`)).toBe(false);
    },
  );
});

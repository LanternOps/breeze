import type { ReportBranding } from '@breeze/shared/reportPdf';

/** The `branding` the run download carries for org-scoped staff (#12048):
 *  the API's own ReportBranding, accepted only in its exact shape. */
export function serverBrandingFrom(value: unknown): ReportBranding | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const b = value as Partial<ReportBranding>;
  if (typeof b.name !== 'string' || !b.name) return undefined;
  return value as ReportBranding;
}

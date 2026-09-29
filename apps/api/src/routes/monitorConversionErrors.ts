import { ConversionError } from '../services/monitors/conversion/errors';

export type ConversionErrorResponse = { status: 400 | 403 | 404 | 409; body: Record<string, unknown> };

/**
 * Status and body for a refusal from the monitor converters. Shared by the
 * conversion resource (monitorDefinitions.conversion.ts) and the per-rule
 * "Convert to monitor" route (monitorDefinitions.ts), so a refusal decided
 * inside a conversion transaction (a stale preview, an already-converted
 * group, a governance check under the group's row locks) answers with the
 * same status on both instead of reaching the global handler as a 500.
 */
export function conversionRefusalResponse(error: Pick<ConversionError, 'code' | 'message' | 'details'>): ConversionErrorResponse {
  if (error.code === 'prerequisite_missing') {
    return { status: 409, body: { error: 'CONVERSION_PREREQUISITE_MISSING', missing: Array.isArray(error.details) ? error.details : [] } };
  }
  const status = error.code === 'partner_wide_denied' ? 403
    : ['policy_not_found', 'source_not_found', 'conversion_not_found'].includes(error.code) ? 404
    : error.code === 'invalid_reason' ? 400 : 409;
  return { status, body: { error: error.code, message: error.message, details: error.details } };
}

/**
 * `conversionRefusalResponse` for a `ConversionError`, null for anything else.
 * Imports only the error class, so a route can use it without loading the
 * converter graph.
 */
export function conversionErrorResponse(error: unknown): ConversionErrorResponse | null {
  return error instanceof ConversionError ? conversionRefusalResponse(error) : null;
}

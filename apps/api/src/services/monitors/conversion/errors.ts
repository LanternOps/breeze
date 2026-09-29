/** A refusal from the monitor converters; routes map `code` to a status (routes/monitorConversionErrors.ts). */
export class ConversionError extends Error {
  constructor(readonly code: 'policy_not_found' | 'partner_wide_denied' | 'prerequisite_missing' | 'blocked' | 'preview_stale' | 'equivalence_delta' | 'source_not_found' | 'already_converted' | 'invalid_reason' | 'conversion_not_found' | 'conversion_revert_unavailable', message: string, readonly details?: unknown) {
    super(message);
    this.name = 'ConversionError';
  }
}

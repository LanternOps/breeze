/**
 * Leaf module (type-only imports) so request-path code — the /ai/sessions
 * route and its tests — can map this error without loading the resolver's
 * DB adapters. sessionModel.ts re-exports it; there is one class.
 */
import type { ResolveFailureReason } from './eligibility';

/** A session was requested on a model it may not use (W03 #7601; replaces W00's #7587 class). */
export class InvalidSessionModelError extends Error {
  readonly status = 400 as const;
  readonly code: 'invalid_model' | ResolveFailureReason;

  constructor(message: string, code: 'invalid_model' | ResolveFailureReason) {
    super(message);
    this.name = 'InvalidSessionModelError';
    this.code = code;
  }
}

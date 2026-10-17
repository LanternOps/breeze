/**
 * The single safe serializer for a caller-verification refusal (#6354 W05).
 *
 * Every adapter that surfaces a refusal — the AI SDK pre-tool result, the
 * durable release worker's stored result, the external MCP `isError` envelope
 * and the helper's stream/history passthrough — emits exactly this object, so
 * the web/helper UI can render "verify the caller" from
 * `requiresCallerVerification` instead of parsing prose. It carries the gate's
 * typed payload only: never an error message, stack, SQL text or credential.
 */
import { CallerVerificationRequiredError } from './errors';

export type CallerRefusalPayload = CallerVerificationRequiredError['payload'];

export const CALLER_VERIFICATION_REQUIRED_ERROR = 'Caller verification required';
/** The release `error_code` for a typed refusal (worker, inline SDK, revalidation). */
export const CALLER_VERIFICATION_REQUIRED_CODE = 'caller_verification_required';

export interface CallerRefusal {
  error: typeof CALLER_VERIFICATION_REQUIRED_ERROR;
  requiresCallerVerification: CallerRefusalPayload;
}

export function callerRefusal(error: unknown): CallerRefusal | null {
  return error instanceof CallerVerificationRequiredError
    ? { error: CALLER_VERIFICATION_REQUIRED_ERROR, requiresCallerVerification: error.payload }
    : null;
}

/** Build the refusal object from an already-extracted payload (worker/SDK revalidation details). */
export function callerRefusalFromPayload(payload: CallerRefusalPayload): CallerRefusal {
  return { error: CALLER_VERIFICATION_REQUIRED_ERROR, requiresCallerVerification: payload };
}

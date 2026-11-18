import { captureException, captureMessage } from './sentry';

/** Stable errorId tags survive the Sentry scrubber; full IDs/outcomes stay in structured server logs. */
export const errorIds = {
  PAX8_EXECUTION_RESULT: 'PAX8_EXECUTION_RESULT',
  PAX8_PERSIST_FAILED: 'PAX8_PERSIST_FAILED',
  PAX8_BILLING_CONFLICT: 'PAX8_BILLING_CONFLICT',
  PAX8_BILLING_INTEGRITY_DRIFT: 'PAX8_BILLING_INTEGRITY_DRIFT',
  PAX8_REOPEN_FAILED: 'PAX8_REOPEN_FAILED',
} as const;
export function logError(errorId: typeof errorIds[keyof typeof errorIds], message: string, context: Record<string, unknown>): void {
  console.error(`[pax8OrderSubmit] ${errorId} ${message}`, context);
}
export function recordExecution(context: Record<string, unknown>, error?: unknown): void {
  if (error !== undefined) {
    logError(errorIds.PAX8_PERSIST_FAILED, 'Vendor execution result could not be persisted', { ...context, error });
    captureException(error, undefined, { errorId: errorIds.PAX8_PERSIST_FAILED });
  } else {
    console.info(`[pax8OrderSubmit] ${errorIds.PAX8_EXECUTION_RESULT}`, context);
    captureMessage('Pax8 execution result received', { eventCode: 'pax8_order_execution_result', level: 'info', tags: { errorId: errorIds.PAX8_EXECUTION_RESULT } });
  }
}

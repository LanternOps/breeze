/**
 * Benign unhandled-rejection predicate (#1379 B3). Centralizes the SDK
 * session-cleanup races previously inlined in index.ts so the
 * unhandledRejection AND uncaughtException (B4) handlers share one list.
 */
export function isBenignRejection(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason);
  return (
    message.includes('ProcessTransport is not ready for writing') ||
    (reason instanceof Error && reason.name === 'AbortError') ||
    (message.includes('Operation aborted') && message.includes('Transport'))
  );
}

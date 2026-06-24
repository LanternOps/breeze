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

// Both V8 phrasings of "tried to read .write off a null value": Node >=16 says
// "Cannot read properties of null (reading 'write')"; older engines said
// "Cannot read property 'write' of null". Anchored to `null` + `write` so it
// can't match arbitrary other null-property reads.
const NULL_WRITE_MESSAGE_RE =
  /Cannot read propert(?:y 'write' of null|ies of null \(reading 'write'\))/;

/**
 * True for the specific, recoverable crash postgres@3 throws when the backend
 * connection is torn down (DB idle-in-transaction timeout firing during slow
 * non-DB work inside an open context, #1105 — or any mid-flight socket close)
 * while a write is still buffered. The orphaned `nextWrite` Immediate then does
 * `socket.write(...)` on a nulled socket and throws a TypeError that escapes
 * every async frame, so it surfaces as an uncaughtException and (absent a
 * handler) kills the whole API — logging out every active session on the
 * restart.
 *
 * The driver has already discarded the dead connection and the pool reconnects
 * on the next query, so suppressing this lets the process survive a transient
 * connection loss instead of crash-looping. Scoped tightly to the postgres
 * driver's own stack frame so an identically-worded bug in application code
 * still fails loudly.
 */
export function isRecoverablePostgresConnectionTeardown(reason: unknown): boolean {
  if (!(reason instanceof TypeError)) return false;
  if (!NULL_WRITE_MESSAGE_RE.test(reason.message)) return false;
  const stack = reason.stack ?? '';
  // Must originate inside the postgres driver's connection module — not any
  // app-level null-write with the same message.
  return stack.includes('postgres') && stack.includes('connection.js');
}

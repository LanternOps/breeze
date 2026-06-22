import '@testing-library/jest-dom';

// jsdom gives the document a base URL (http://localhost/) but Node's global
// fetch (undici) ignores it and *throws synchronously* on a relative URL
// ("Failed to parse URL from /…"). Components that do best-effort relative
// fetches in effects (e.g. AddDeviceModal's SHA256SUMS load) then emit an
// unhandled error that escapes their .catch(), which vitest attributes to
// whichever test file is co-scheduled in the parallel run — a floating,
// non-deterministic suite failure (surfaced by the undici 6.27 bump, #1753).
// Normalise relative request URLs against a base so undici rejects gracefully
// (the test never reaches a real server) instead of throwing. No test mocks
// fetch through this wrapper rely on the original throw behaviour.
const __realFetch = globalThis.fetch?.bind(globalThis);
if (__realFetch) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      if (typeof input === 'string' && input.startsWith('/')) {
        input = `http://localhost${input}`;
      } else if (input instanceof URL === false && input && typeof (input as Request).url === 'string' && (input as Request).url.startsWith('/')) {
        input = new Request(`http://localhost${(input as Request).url}`, input as Request);
      }
      return __realFetch(input as RequestInfo | URL, init);
    } catch (err) {
      return Promise.reject(err);
    }
  }) as typeof fetch;
}

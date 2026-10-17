import * as dbModule from './index';

/**
 * Runs `fn` with the request's held DB context exited (#1105 / #8334).
 *
 * Use for short non-DB work (a Redis limiter round-trip) that has to execute
 * after `authMiddleware` has already opened `withDbAccessContext`. The call
 * resolves against the ambient store at invocation time, so `fn` must START
 * its async work inside the callback (return the promise).
 *
 * Tolerates a PARTIAL test double of `../db` that does not export
 * `runOutsideDbContext` (same reason as `assertOutsideHeldDbContextSafe` in
 * services/rate-limit.ts); in production the export always exists.
 */
export function runOutsideHeldDbContext<T>(fn: () => Promise<T>): Promise<T> {
  let run: (<R>(f: () => R) => R) | undefined;
  try {
    run = (dbModule as { runOutsideDbContext?: <R>(f: () => R) => R }).runOutsideDbContext;
  } catch {
    run = undefined;
  }
  return typeof run === 'function' ? run(fn) : fn();
}

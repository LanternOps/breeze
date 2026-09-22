/**
 * Test-only chain-aware Drizzle mock. Imported by *.test.ts files only.
 *
 * Every chain method records `{name, args}` and returns the chain; awaiting
 * the chain resolves the next queued result (or `[]`). `execute` is a spy so
 * advisory-lock statements can be asserted without being queued.
 */
import { vi } from 'vitest';

export function makeDbMock() {
  const results: unknown[][] = [];
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const chain: any = {};
  for (const name of ['select', 'from', 'where', 'limit', 'orderBy', 'for', 'insert', 'values', 'update', 'set', 'returning', 'onConflictDoNothing', 'delete']) {
    chain[name] = (...args: unknown[]) => { calls.push({ name, args }); return chain; };
  }
  chain.then = (yes: (v: unknown) => unknown, no: (e: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(yes, no);
  chain.execute = vi.fn(async () => []);
  return { db: chain, results, calls };
}

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import postgresEsm from 'postgres';
import { describe, expect, it } from 'vitest';

// The patch lands in THREE independent hunks (src/, cjs/src/, cf/src/), and the
// two that matter here resolve to different files: this test file's ESM import
// follows the package's `import` condition to `src/index.js`, while production
// (`dist/index.cjs`, tsup externalizes postgres) `require()`s the `default`
// condition — `cjs/src/index.js`. Exercising only one build would stay green
// while the other's hunk silently stopped applying (empirically confirmed:
// reverting only the cjs hunk left the ESM-only suite passing). So every test
// below runs against BOTH entries.
const postgresCjs = createRequire(import.meta.url)('postgres') as typeof postgresEsm;

const DRIVER_BUILDS = [
  ['esm (src/ — what this test file imports)', postgresEsm],
  ['cjs (cjs/src/ — what production dist/index.cjs loads)', postgresCjs],
] as const;

/**
 * Regression guard for the postgres.js pool-poisoning bug behind #3214,
 * repaired by the vendored patch tracked in #3225.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT (postgres.js 3.4.9, `src/connection.js`)
 * ---------------------------------------------------------------------------
 * The driver batches small writes behind a `setImmediate`, guarded by a
 * "already scheduled?" check:
 *
 *     function write(x, fn) {                                        // :246
 *       chunk = chunk ? Buffer.concat([chunk, x]) : Buffer.from(x)
 *       if (fn || chunk.length >= 1024)
 *         return nextWrite(fn)
 *       nextWriteTimer === null && (nextWriteTimer = setImmediate(nextWrite))
 *       return true
 *     }
 *
 *     function nextWrite(fn) {                                       // :254
 *       const x = socket.write(chunk, fn)
 *       nextWriteTimer !== null && clearImmediate(nextWriteTimer)
 *       chunk = nextWriteTimer = null                                // <- only reset
 *       return x
 *     }
 *
 * `nextWrite` actually running is the ONLY thing that ever resets
 * `nextWriteTimer` to null. But the two teardown paths cancel the immediate
 * WITHOUT clearing the variable (and without dropping the buffered `chunk`):
 *
 *     function terminate() { ... clearImmediate(nextWriteTimer) ... }      // :427
 *     async function closed(hadError) { ... clearImmediate(nextWriteTimer) // :440
 *                                        ... socket = null ... }
 *
 * So a pooled connection whose socket dies while a deferred write is still
 * queued is left with `nextWriteTimer` permanently non-null. From then on the
 * guard at :250 is false forever, no flush is ever scheduled again, and the
 * StartupMessage written by `connected()` on every subsequent reconnect is
 * appended to `chunk` and never reaches the socket. The handshake therefore
 * cannot complete, `connect_timeout` expires, `connectTimedOut()` reports
 * `CONNECT_TIMEOUT` and destroys the socket, `closed()` reconnects — and the
 * cycle repeats for the life of the process.
 *
 * That accounts for every symptom reported in #3214: `TLSSocket.closed` errors
 * appearing days before the outage (each one poisoning a slot), the pool
 * decaying 35 -> 9 over hours, ~144 CONNECT_TIMEOUT/min sustained against a
 * database that was demonstrably healthy, and full recovery within seconds of a
 * process restart (fresh closures).
 *
 * ---------------------------------------------------------------------------
 * THE REPAIR THIS TEST NOW GUARDS (#3225)
 * ---------------------------------------------------------------------------
 * `patches/postgres@3.4.9.patch` (pnpm patchedDependencies) adds
 * `chunk = nextWriteTimer = null` after the `clearImmediate` in BOTH teardown
 * paths — `terminate()` and `closed()` — in all three shipped builds
 * (src/, cjs/src/, cf/src/). With the patch applied, a reconnect after a
 * mid-write socket death schedules its flush normally and the handshake bytes
 * reach the wire.
 *
 * This file originally pinned the DEFECT (so the mechanism was documented
 * executably and reproducible for an upstream report). Now that the patch is
 * vendored, the poisoning test asserts the FIX instead: if it goes red, the
 * patch has stopped applying — most likely a `postgres` version bump that
 * dropped `patchedDependencies` without the new release containing the
 * upstream repair. Re-verify src/connection.js teardown before removing the
 * patch or weakening this test.
 *
 * The `db/dbPoolHealthMonitor.ts` watchdog predates the patch and stays as
 * defense-in-depth: it detects pool degradation from ANY cause, not just this
 * one.
 */

interface FakeSocket extends EventEmitter {
  readyState: string;
  bytesWritten: number;
  setKeepAlive(): void;
  write(buf: Buffer | string): boolean;
  destroy(): void;
  end(): void;
}

function createFakeSocket(): FakeSocket {
  const s = new EventEmitter() as FakeSocket;
  s.readyState = 'open';
  s.bytesWritten = 0;
  s.setKeepAlive = () => {};
  s.write = (buf: Buffer | string) => {
    s.bytesWritten += Buffer.byteLength(buf as Buffer);
    return true;
  };
  s.destroy = () => {
    s.readyState = 'closed';
  };
  s.end = () => {
    s.readyState = 'closed';
  };
  return s;
}

/**
 * Drives postgres.js against fake sockets supplied through its `socket` option.
 * With that option set, `connect()` short-circuits straight to `connected()`
 * (no TCP, no TLS, no real host), which writes the StartupMessage — the small,
 * callback-less write that takes the deferred path we are probing.
 *
 * `killAttempts` names the attempts whose socket is destroyed while that
 * deferred flush is still queued. The kill is scheduled with `setImmediate`
 * from inside the socket factory, which runs BEFORE `connected()` does, so it
 * is queued ahead of the driver's own `setImmediate(nextWrite)` and always wins
 * the race — no timing luck involved.
 */
async function runHandshakeAttempts(options: {
  postgres: typeof postgresEsm;
  killAttempts: ReadonlySet<number>;
  settleMs: number;
  /**
   * When set, the kill is deferred by this many ms instead of being queued as an
   * immediate — long enough for the driver's own flush to have already run. That
   * is the negative control: the socket still dies, but with NO buffered write,
   * so `nextWriteTimer` was legitimately reset and the connection recovers.
   */
  killDelayMs?: number;
}): Promise<number[]> {
  const postgres = options.postgres;
  const sockets: FakeSocket[] = [];

  // `socket` is a genuine postgres.js option — `parseOptions` copies it
  // (`src/index.js`: `socket: o.socket`) and `createSocket` calls it
  // (`src/connection.js:132`) — but it is absent from the shipped `.d.ts`, so
  // the cast is unavoidable. It is what makes this test hermetic: no TCP, no
  // TLS, no database, no network timeouts.
  const driverOptions = {
    host: 'pool-poisoning.invalid',
    port: 5432,
    database: 'breeze',
    user: 'breeze',
    pass: '',
    max: 1,
    ssl: false,
    connect_timeout: 1,
    socket: () => {
      const socket = createFakeSocket();
      sockets.push(socket);
      const attempt = sockets.length;
      if (options.killAttempts.has(attempt)) {
        if (options.killDelayMs === undefined) {
          setImmediate(() => socket.emit('close', false));
        } else {
          setTimeout(() => socket.emit('close', false), options.killDelayMs);
        }
      }
      return socket;
    },
  };

  const sql = postgres(driverOptions as unknown as Parameters<typeof postgres>[0]);

  // Never resolves against a fake socket; we only care about the bytes the
  // driver puts (or fails to put) on the wire.
  void sql`select 1`.catch(() => undefined);

  await new Promise((resolve) => setTimeout(resolve, options.settleMs));
  await sql.end({ timeout: 0 }).catch(() => undefined);

  return sockets.map((s) => s.bytesWritten);
}

describe.each(DRIVER_BUILDS)('postgres.js deferred-write pool poisoning (#3214) — %s', (_buildName, postgres) => {
  it('control: an undisturbed connection flushes its StartupMessage', async () => {
    // Proves the harness itself works — without this, the poisoning assertion
    // below could pass simply because the fake socket never receives anything.
    const written = await runHandshakeAttempts({
      postgres,
      killAttempts: new Set(),
      settleMs: 250,
    });

    expect(written.length).toBeGreaterThanOrEqual(1);
    expect(written[0]).toBeGreaterThan(0);
  }, 10_000);

  it('negative control: a socket that dies AFTER its flush leaves the connection able to write again', async () => {
    // Without this, `written[1] === 0` in the test below would also be satisfied
    // by "the driver stopped writing on reconnect for some unrelated reason".
    // Here the socket dies just as hard, but with nothing buffered — so
    // `nextWrite` had already run and reset `nextWriteTimer`, and attempt 2
    // completes its handshake write normally. That isolates the buffered write
    // as the actual cause, which is the claim an upstream report has to make.
    const written = await runHandshakeAttempts({
      postgres,
      killAttempts: new Set([1]),
      killDelayMs: 60,
      settleMs: 1_500,
    });

    expect(written.length).toBeGreaterThanOrEqual(2);
    expect(written[0]).toBeGreaterThan(0);
    expect(
      written[1],
      'the reconnect after a FLUSHED socket death should still write — if this is 0, '
        + 'the poisoning assertion below is no longer isolating the buffered write.',
    ).toBeGreaterThan(0);
  }, 15_000);

  it('a socket that dies with a buffered write can still flush after reconnect (patched)', async () => {
    // Attempt 1's socket is closed while the StartupMessage flush is still
    // queued. Unpatched 3.4.9 leaves `nextWriteTimer` non-null in `closed()`,
    // so attempt 2 — a full reconnect with a brand-new socket — schedules no
    // flush and writes zero bytes (the #3214 pool poisoning). With
    // patches/postgres@3.4.9.patch applied, both teardown paths null the timer
    // and drop the stale chunk, so the reconnect handshake reaches the wire.
    const written = await runHandshakeAttempts({
      postgres,
      killAttempts: new Set([1]),
      settleMs: 1_500,
    });

    expect(
      written.length,
      'expected the driver to reconnect after the socket closed. If it no longer '
        + 'reconnects at all, that is an upstream behaviour change — re-read this '
        + 'test against src/connection.js rather than adjusting the harness.',
    ).toBeGreaterThanOrEqual(2);

    expect(
      written[1],
      'the reconnect after a mid-write socket death wrote ZERO bytes — the #3214 '
        + 'pool poisoning is back, meaning patches/postgres@3.4.9.patch is no longer '
        + 'applying (a postgres version bump that dropped pnpm patchedDependencies?). '
        + 'Re-apply the patch against the new version, or verify upstream now nulls '
        + 'nextWriteTimer and chunk in terminate()/closed() before removing it.',
    ).toBeGreaterThan(0);
  }, 15_000);
});

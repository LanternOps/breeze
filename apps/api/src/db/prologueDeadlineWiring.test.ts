/**
 * #6048 — the deadline must be armed at the REAL context openers, not only in
 * the standalone helper.
 *
 * `prologueDeadline.test.ts` proves the mechanism against synthetic work. That
 * is not the same as proving `db/index.ts` uses it correctly: the bug this PR
 * fixes lives at the seam — is the deadline actually armed around
 * `applyAccessContextGucs`, is it DISARMED before the caller's `fn` runs, and
 * do the abort checks on either side of the (single, #8052) prologue statement
 * really stop a late-resolving statement from handing the opener an abandoned
 * connection? None of that is observable from the helper's own tests, and every
 * consumer test in this repo stubs `withDbAccessContext` out with a
 * passthrough, so without this file the wiring has no coverage at all.
 *
 * `drizzle` is faked (rather than the postgres.js driver) so the transaction
 * handle is fully controllable: a statement can be made to hang forever, which
 * is exactly what the wedged backend does and what no real local database can
 * be persuaded to do on demand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { drizzleFactory, transactionImpl, requestWedgedBackendReclaim } = vi.hoisted(() => {
  const transactionImpl = vi.fn();
  const requestWedgedBackendReclaim = vi.fn(() => null);
  const drizzleFactory = vi.fn(() => ({
    transaction: (fn: (tx: unknown) => Promise<unknown>) => transactionImpl(fn),
  }));
  return { drizzleFactory, transactionImpl, requestWedgedBackendReclaim };
});

vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: drizzleFactory }));
vi.mock('postgres', () => ({
  default: vi.fn(() => Object.assign(vi.fn(), { options: { parsers: {}, serializers: {} } })),
}));
// The reclaimer would otherwise open a real side connection from the expiry
// handler. We assert it is ASKED; whether it terminates anything is
// wedgedBackends.test.ts's job.
vi.mock('./wedgedBackends', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./wedgedBackends')>()),
  requestWedgedBackendReclaim,
}));

const originalEnv = { ...process.env };

/**
 * A transaction handle whose Nth `execute` never settles — the wedge. Records
 * every statement it was asked to run, so "no statement after the wedge was issued"
 * is an assertion about behaviour rather than about a mock's internals.
 */
function makeTx(hangOnStatement: number | null) {
  const issued: string[] = [];
  const tx = {
    execute: vi.fn((query: unknown) => {
      issued.push(JSON.stringify(query ?? null).slice(0, 80));
      if (hangOnStatement !== null && issued.length === hangOnStatement) {
        return new Promise(() => {});
      }
      return Promise.resolve([]);
    }),
  };
  return { tx, issued };
}

async function loadDb() {
  return import('./index');
}

describe('#6048 prologue deadline wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DATABASE_URL_APP = 'postgresql://breeze_app:pw@database.example.test:5432/breeze';
    process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = '15000';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('rejects withDbAccessContext with the typed error when the prologue statement wedges', async () => {
    // The production incident: backend_start == xact_start, stuck on the
    // prologue (then `select set_config('breeze.scope', $1, true)`; since #8052
    // one statement carrying all seven set_config calls).
    const { tx, issued } = makeTx(1);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const fn = vi.fn(async () => 'rows');
    const result = withSystemDbAccessContext(fn, 'wiringTest');
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    // The caller's work must never have started: that is what makes abandoning
    // the transaction safe.
    expect(fn).not.toHaveBeenCalled();
    expect(issued).toHaveLength(1);
    expect(requestWedgedBackendReclaim).toHaveBeenCalledTimes(1);
  });

  it('never runs the caller work when the prologue statement resolves AFTER the deadline', async () => {
    // `Promise.race` does not cancel its loser. Without the post-statement abort
    // check, a prologue that resolved late would hand the caller's work a
    // connection being torn down — or already recycled to another tenant.
    const issued: string[] = [];
    const tx = {
      execute: vi.fn((query: unknown) => {
        issued.push(JSON.stringify(query ?? null).slice(0, 80));
        return new Promise((resolve) => setTimeout(() => resolve([]), 20_000));
      }),
    };
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const fn = vi.fn(async () => 'rows');
    const result = withSystemDbAccessContext(fn, 'wiringTest');
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    // The late statement now settles on the abandoned transaction.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fn).not.toHaveBeenCalled();
    expect(issued).toHaveLength(1);
  });

  it('runs the single-statement prologue and the caller work when nothing wedges', async () => {
    // #8052: all seven GUCs ride in ONE set_config statement.
    const { tx, issued } = makeTx(null);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext } = await loadDb();
    await expect(withSystemDbAccessContext(async () => 'rows', 'wiringTest')).resolves.toBe('rows');

    expect(issued).toHaveLength(1);
    expect(requestWedgedBackendReclaim).not.toHaveBeenCalled();
  });

  it('does NOT bound the caller work that follows a completed prologue', async () => {
    // A slow report query is not a wedged connection. If the deadline were left
    // armed around `fn`, every query over the budget would become a 500.
    const { tx } = makeTx(null);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext } = await loadDb();
    let release: ((value: string) => void) | null = null;
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });

    const result = withSystemDbAccessContext(() => slow, 'wiringTest');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(requestWedgedBackendReclaim).not.toHaveBeenCalled();

    release!('late but fine');
    await expect(result).resolves.toBe('late but fine');
  });

  it('never issues the prologue when SET TRANSACTION READ ONLY resolves AFTER the deadline', async () => {
    // The pre-statement abort check in applyAccessContextGucs. Only this opener
    // runs a statement between arming the deadline and the prologue, so it is
    // the one place a late resolution can reach that check.
    const issued: string[] = [];
    const tx = {
      execute: vi.fn((query: unknown) => {
        issued.push(JSON.stringify(query ?? null).slice(0, 80));
        return new Promise((resolve) => setTimeout(() => resolve([]), 20_000));
      }),
    };
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withArchivedOrgReadContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const fn = vi.fn(async () => 'rows');
    const result = withArchivedOrgReadContext(['7f1b0a4e-0c2d-4c8a-9a0e-2f9c1b3d4e5f'], fn);
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    await vi.advanceTimersByTimeAsync(10_000);

    // Only SET TRANSACTION was issued; the set_config prologue never went out.
    expect(issued).toHaveLength(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('bounds the archived-org opener, whose first statement is SET TRANSACTION READ ONLY', async () => {
    // This opener issues an extra statement before the prologue, so its
    // arming/abort sequence is structurally different from the other two.
    const { tx, issued } = makeTx(1);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withArchivedOrgReadContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const result = withArchivedOrgReadContext(
      ['7f1b0a4e-0c2d-4c8a-9a0e-2f9c1b3d4e5f'],
      async () => 'rows',
    );
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(issued).toHaveLength(1);
  });

  it('bounds the second, narrowing prologue in withResolvedDbAccessContext', async () => {
    // This one runs a prologue INSIDE an already-open system-scope transaction,
    // so it needs its own bound — the outer one has long since disarmed.
    let call = 0;
    const issued: number[] = [];
    const tx = {
      execute: vi.fn(() => {
        call += 1;
        issued.push(call);
        // Statement 1 is the outer system prologue; 2 is the narrowing
        // prologue (#8052: one statement each), and that is where we wedge.
        return call === 2 ? new Promise(() => {}) : Promise.resolve([]);
      }),
    };
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withResolvedDbAccessContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const fn = vi.fn(async () => 'rows');
    const result = withResolvedDbAccessContext(
      async () => ({
        context: {
          scope: 'organization' as const,
          orgId: '7f1b0a4e-0c2d-4c8a-9a0e-2f9c1b3d4e5f',
          accessibleOrgIds: ['7f1b0a4e-0c2d-4c8a-9a0e-2f9c1b3d4e5f'],
        },
        value: 1,
      }),
      fn,
    );
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(issued).toHaveLength(2);
    expect(fn).not.toHaveBeenCalled();
  });

  // ---- #8229: the pool wait is its own clock --------------------------------

  /**
   * A `transaction` that queues for `waitMs` before the pool "hands over" the
   * connection and runs the callback. Records the callback's own settlement so
   * a refused late connection is observable (a throwing callback is what makes
   * postgres.js roll back and release the connection).
   */
  function queuedTransaction(waitMs: number, tx: unknown) {
    const callback = { entered: false, rejectedWith: undefined as unknown };
    transactionImpl.mockImplementation(
      (fn: (t: unknown) => Promise<unknown>) =>
        new Promise((resolve, reject) => {
          setTimeout(() => {
            callback.entered = true;
            Promise.resolve()
              .then(() => fn(tx))
              .then(resolve, (err: unknown) => {
                callback.rejectedWith = err;
                reject(err);
              });
          }, waitMs);
        }),
    );
    return callback;
  }

  it('does not charge the pool wait to the prologue budget (#8229)', async () => {
    // 10s queued for a slot + a prologue that then takes 10s: 20s total. The
    // old single clock (armed before the pool handed over a connection)
    // reported this as a wedged prologue and requested a reclaim pass.
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '15000';
    const issued: string[] = [];
    const tx = {
      execute: vi.fn((query: unknown) => {
        issued.push(JSON.stringify(query ?? null).slice(0, 80));
        return new Promise((resolve) => setTimeout(() => resolve([]), 10_000));
      }),
    };
    queuedTransaction(10_000, tx);

    const { withSystemDbAccessContext } = await loadDb();
    const result = withSystemDbAccessContext(async () => 'rows', 'wiringTest');
    const assertion = expect(result).resolves.toBe('rows');

    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(requestWedgedBackendReclaim).not.toHaveBeenCalled();
  });

  it('rejects with DbPoolAcquireTimeoutError, and requests NO reclaim, when the pool never frees a slot (#8229)', async () => {
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '15000';
    transactionImpl.mockImplementation(() => new Promise(() => {}));

    const { withSystemDbAccessContext, DbPoolAcquireTimeoutError, DbAccessContextPrologueTimeoutError } =
      await loadDb();
    const fn = vi.fn(async () => 'rows');
    let captured: unknown = null;
    const result = withSystemDbAccessContext(fn, 'wiringTest').catch((err: unknown) => {
      captured = err;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await result;

    expect(captured).toBeInstanceOf(DbPoolAcquireTimeoutError);
    expect(captured).not.toBeInstanceOf(DbAccessContextPrologueTimeoutError);
    expect(fn).not.toHaveBeenCalled();
    expect(requestWedgedBackendReclaim).not.toHaveBeenCalled();
  });

  it('refuses a connection that arrives after the acquire budget expired, issuing nothing on it (#8229)', async () => {
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '15000';
    const { tx, issued } = makeTx(null);
    const callback = queuedTransaction(20_000, tx);

    const { withSystemDbAccessContext, DbPoolAcquireTimeoutError, DbPoolAcquireAbortedError } =
      await loadDb();
    const fn = vi.fn(async () => 'rows');
    const result = withSystemDbAccessContext(fn, 'wiringTest');
    const assertion = expect(result).rejects.toBeInstanceOf(DbPoolAcquireTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    await vi.advanceTimersByTimeAsync(10_000);

    // The callback ran (the pool did hand the connection over) and threw, which
    // is what makes the driver roll back and return it to the pool.
    expect(callback.entered).toBe(true);
    expect(callback.rejectedWith).toBeInstanceOf(DbPoolAcquireAbortedError);
    expect(issued).toHaveLength(0);
    expect(fn).not.toHaveBeenCalled();
    expect(requestWedgedBackendReclaim).not.toHaveBeenCalled();
  });

  it('applies the same acquire budget to the archived-org opener (#8229)', async () => {
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '15000';
    const { tx, issued } = makeTx(null);
    const callback = queuedTransaction(20_000, tx);

    const { withArchivedOrgReadContext, DbPoolAcquireTimeoutError, DbPoolAcquireAbortedError } =
      await loadDb();
    const result = withArchivedOrgReadContext(
      ['7f1b0a4e-0c2d-4c8a-9a0e-2f9c1b3d4e5f'],
      async () => 'rows',
    );
    const assertion = expect(result).rejects.toBeInstanceOf(DbPoolAcquireTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(callback.rejectedWith).toBeInstanceOf(DbPoolAcquireAbortedError);
    // Not even SET TRANSACTION READ ONLY went out on the refused connection.
    expect(issued).toHaveLength(0);
  });

  it('times a wedged prologue from acquisition, after a slow pool wait (#8229)', async () => {
    process.env.DB_POOL_ACQUIRE_TIMEOUT_MS = '15000';
    const { tx } = makeTx(1);
    queuedTransaction(10_000, tx);

    const { withSystemDbAccessContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    let captured: unknown = null;
    const result = withSystemDbAccessContext(async () => 'rows', 'wiringTest').catch((err: unknown) => {
      captured = err;
    });

    // 15s after the call is only 5s into the prologue: not yet expired.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(captured).toBeNull();

    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(captured).toBeInstanceOf(DbAccessContextPrologueTimeoutError);
    // A genuine prologue wedge still asks for recovery, exactly as before.
    expect(requestWedgedBackendReclaim).toHaveBeenCalledTimes(1);
  });

  it('is a pass-through when the deadline is disabled', async () => {
    process.env.DB_ACCESS_CONTEXT_PROLOGUE_TIMEOUT_MS = '0';
    const { tx } = makeTx(null);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext } = await loadDb();
    await expect(withSystemDbAccessContext(async () => 'rows', 'wiringTest')).resolves.toBe('rows');
    expect(vi.getTimerCount()).toBe(0);
  });
});

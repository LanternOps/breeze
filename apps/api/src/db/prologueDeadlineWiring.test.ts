/**
 * #6048 — the deadline must be armed at the REAL context openers, not only in
 * the standalone helper.
 *
 * `prologueDeadline.test.ts` proves the mechanism against synthetic work. That
 * is not the same as proving `db/index.ts` uses it correctly: the bug this PR
 * fixes lives at the seam — is the deadline actually armed around
 * `applyAccessContextGucs`, is it DISARMED before the caller's `fn` runs, and
 * does the per-statement abort check really stop the remaining `set_config`
 * statements? None of that is observable from the helper's own tests, and every
 * consumer test in this repo stubs `withDbAccessContext` out with a passthrough,
 * so without this file the wiring has no coverage at all.
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
 * every statement it was asked to run, so "statements 4-6 were never issued"
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

  it('rejects withDbAccessContext with the typed error when the first set_config wedges', async () => {
    // The production incident exactly: backend_start == xact_start, stuck on
    // `select set_config('breeze.scope', $1, true)`.
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

  it('stops issuing the remaining set_config statements when the wedge is mid-prologue', async () => {
    // `Promise.race` does not cancel its loser. Without the per-statement abort
    // check, a statement that resolved late would queue the rest onto a
    // connection being torn down — or already recycled to another tenant.
    const { tx, issued } = makeTx(3);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext, DbAccessContextPrologueTimeoutError } = await loadDb();
    const result = withSystemDbAccessContext(async () => 'rows', 'wiringTest');
    const assertion = expect(result).rejects.toBeInstanceOf(DbAccessContextPrologueTimeoutError);

    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;

    expect(issued).toHaveLength(3);
  });

  it('runs the full six-statement prologue and the caller work when nothing wedges', async () => {
    const { tx, issued } = makeTx(null);
    transactionImpl.mockImplementation((fn: (t: unknown) => Promise<unknown>) => fn(tx));

    const { withSystemDbAccessContext } = await loadDb();
    await expect(withSystemDbAccessContext(async () => 'rows', 'wiringTest')).resolves.toBe('rows');

    expect(issued).toHaveLength(6);
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
        // Statements 1-6 are the outer system prologue; 7 is the first
        // statement of the narrowing prologue, and that is where we wedge.
        return call === 7 ? new Promise(() => {}) : Promise.resolve([]);
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

    expect(issued).toHaveLength(7);
    expect(fn).not.toHaveBeenCalled();
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

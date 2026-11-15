import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPoolObservedReadOnly, notePoolReadOnly, notePoolWritable } from './readOnlyDatabase';
import {
  createReadOnlyLogThrottle,
  installReadOnlyLogThrottle,
  readOnlyLogSource,
  type ConsoleLike,
} from './readOnlyLogThrottle';

function readOnlyError(command = 'UPDATE'): Error {
  return Object.assign(new Error(`cannot execute ${command} in a read-only transaction`), {
    code: '25006',
  });
}

function fakeConsole() {
  const lines: Array<{ level: string; args: unknown[] }> = [];
  const sink: ConsoleLike = {
    error: (...args: unknown[]) => lines.push({ level: 'error', args }),
    warn: (...args: unknown[]) => lines.push({ level: 'warn', args }),
    log: (...args: unknown[]) => lines.push({ level: 'log', args }),
    info: (...args: unknown[]) => lines.push({ level: 'info', args }),
  };
  return { sink, lines };
}

describe('readOnlyLogSource', () => {
  it('keys on the leading [tag] so per-job ids do not split one source', () => {
    expect(readOnlyLogSource(['[MonitorWorker] Job 123 failed:', readOnlyError()])).toBe('[MonitorWorker]');
    expect(readOnlyLogSource(['[MonitorWorker] Job 456 failed:', readOnlyError()])).toBe('[MonitorWorker]');
  });

  it('normalizes digits and ids out of an untagged message', () => {
    const a = readOnlyLogSource(['Job 1 for device 3f2a9c1e-0b5d-4e0f-9a43-1d2c3b4a5f6e failed', readOnlyError()]);
    const b = readOnlyLogSource(['Job 22 for device 00000000-0000-4000-8000-000000000000 failed', readOnlyError()]);
    expect(a).toBe(b);
  });

  it('falls back to a fixed key when there is neither a message nor a stack', () => {
    const bare = Object.assign(new Error(''), { code: '25006' });
    bare.stack = undefined;
    expect(readOnlyLogSource([bare])).toBe('(no message)');
  });

  // #11741 review: `console.error(err)` with no string argument.
  it('keys a bare error on its top application stack frame, so two callers stay distinct', () => {
    // The same driver text from both: only the call site tells them apart.
    function heartbeatWriter(): Error {
      return Object.assign(new Error('cannot execute UPDATE in a read-only transaction'), { code: '25006' });
    }
    function monitorWriter(): Error {
      return Object.assign(new Error('cannot execute UPDATE in a read-only transaction'), { code: '25006' });
    }
    const a = readOnlyLogSource([heartbeatWriter()]);
    const b = readOnlyLogSource([monitorWriter()]);
    expect(a).not.toBe(b);
    expect(a).not.toBe('(no message)');
    // file:function, relative to src/, never an absolute path.
    expect(a).toBe('db/readOnlyLogThrottle.test.ts:heartbeatWriter');
    expect(b).toBe('db/readOnlyLogThrottle.test.ts:monitorWriter');
  });

  it('skips library frames and strips absolute paths from a bundled build', () => {
    const err = readOnlyError();
    err.stack = [
      'Error: cannot execute UPDATE in a read-only transaction',
      '    at ErrorResponse (/app/node_modules/.pnpm/postgres@3.4.7/node_modules/postgres/cjs/src/connection.js:790:26)',
      '    at handle (node:internal/process/task_queues:95:5)',
      '    at async recordHeartbeat (/app/apps/api/dist/index.cjs:123456:7)',
    ].join('\n');
    expect(readOnlyLogSource([err])).toBe('index.cjs:recordHeartbeat');
  });

  it('falls back to the wrapper error\'s own message, normalized, when no application frame is known', () => {
    const wrapper = new Error('Failed query: update "devices" set "last_seen_at" = $1 where "id" = $2', {
      cause: readOnlyError(),
    });
    wrapper.stack = `Error: ${wrapper.message}\n    at query (/app/node_modules/drizzle-orm/session.js:1:1)`;
    const other = new Error('Failed query: insert into "alerts" values ($1)', { cause: readOnlyError() });
    other.stack = `Error: ${other.message}\n    at query (/app/node_modules/drizzle-orm/session.js:1:1)`;
    expect(readOnlyLogSource([wrapper])).toContain('Failed query: update "devices"');
    expect(readOnlyLogSource([wrapper])).not.toBe(readOnlyLogSource([other]));
  });
});

// #11741 review: SQLSTATE 25006 also comes from an intentional READ ONLY
// transaction (withArchivedOrgReadContext). Until the pool itself has been
// observed read-only, such an error is a code bug and must reach the log whole.
describe('createReadOnlyLogThrottle while the pool has not been observed read-only', () => {
  beforeEach(() => notePoolWritable());

  it('logs every read-only error in full, with its stack, every time', () => {
    expect(isPoolObservedReadOnly()).toBe(false);
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => 0 });
    const leaked = new Error('Failed query: insert into "audit_logs" ...', { cause: readOnlyError('INSERT') });
    for (let i = 0; i < 3; i++) throttle.console.error('[archivedOrgRead] export failed:', leaked);
    throttle.console.warn('[Reaper] pass failed: cannot execute DELETE in a read-only transaction');
    throttle.console.error(leaked);
    expect(lines).toEqual([
      { level: 'error', args: ['[archivedOrgRead] export failed:', leaked] },
      { level: 'error', args: ['[archivedOrgRead] export failed:', leaked] },
      { level: 'error', args: ['[archivedOrgRead] export failed:', leaked] },
      { level: 'warn', args: ['[Reaper] pass failed: cannot execute DELETE in a read-only transaction'] },
      { level: 'error', args: [leaked] },
    ]);
    expect((lines[0]!.args[1] as Error).stack).toContain('readOnlyLogThrottle.test.ts');
  });

  it('throttles only while the flag is set, and passes through again once it clears', () => {
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => 0 });
    const err = readOnlyError();
    throttle.console.error('[W] failed:', err); // full
    notePoolReadOnly();
    throttle.console.error('[W] failed:', err); // compact
    throttle.console.error('[W] failed:', err); // counted
    notePoolWritable();
    throttle.console.error('[W] failed:', err); // full again
    expect(lines).toHaveLength(3);
    expect(lines[0]!.args).toEqual(['[W] failed:', err]);
    expect(lines[1]!.args).toEqual([expect.stringContaining('SQLSTATE 25006')]);
    expect(lines[2]!.args).toEqual(['[W] failed:', err]);
  });
});

describe('createReadOnlyLogThrottle while the pool is observed read-only', () => {
  beforeEach(() => notePoolReadOnly());
  afterEach(() => notePoolWritable());

  it('passes every line through untouched when nothing is a read-only error', () => {
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => 0 });
    const other = Object.assign(new Error('duplicate key'), { code: '23505' });
    throttle.console.error('[X] failed:', other);
    throttle.console.error('[X] failed:', other);
    throttle.console.log('[X] started');
    expect(lines).toEqual([
      { level: 'error', args: ['[X] failed:', other] },
      { level: 'error', args: ['[X] failed:', other] },
      { level: 'log', args: ['[X] started'] },
    ]);
  });

  it('writes one compact line per source per window instead of a stack per failure', () => {
    let now = 0;
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => now, windowMs: 60_000 });

    for (let i = 0; i < 50; i++) throttle.console.error(`[MonitorWorker] Job ${i} failed:`, readOnlyError());
    throttle.console.error('[AlertWorker] Job 1 failed:', readOnlyError('INSERT'));

    expect(lines).toHaveLength(2);
    // No Error object (so no stack), the source, the SQLSTATE and the driver message.
    expect(lines[0]!.level).toBe('error');
    expect(lines[0]!.args).toHaveLength(1);
    expect(lines[0]!.args[0]).toEqual(expect.stringContaining('[MonitorWorker]'));
    expect(lines[0]!.args[0]).toEqual(expect.stringContaining('SQLSTATE 25006'));
    expect(lines[0]!.args[0]).toEqual(expect.stringContaining('cannot execute UPDATE in a read-only transaction'));
    expect(lines[1]!.args[0]).toEqual(expect.stringContaining('[AlertWorker]'));

    // Next window: one line again, carrying the suppressed count.
    now = 60_000;
    throttle.console.error('[MonitorWorker] Job 99 failed:', readOnlyError());
    expect(lines).toHaveLength(3);
    expect(lines[2]!.args[0]).toEqual(expect.stringContaining('49 more suppressed'));
  });

  it('keeps the call\'s own message in the compact line', () => {
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => 0 });
    throttle.console.error('[MonitorWorker] Job 42 for monitor abc failed:', readOnlyError());
    expect(lines[0]!.args[0]).toEqual(expect.stringContaining('Latest: [MonitorWorker] Job 42 for monitor abc failed:'));
  });

  it('never throttles a call that also carries a different error', () => {
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => 0 });
    const other = new Error('lock timeout');
    const coded = { code: '23505', detail: 'duplicate key' };
    throttle.console.error('[X] failed:', readOnlyError(), other);
    throttle.console.error('[X] failed:', readOnlyError(), other);
    throttle.console.error('[X] cannot execute UPDATE in a read-only transaction', coded);
    expect(lines).toEqual([
      { level: 'error', args: ['[X] failed:', expect.any(Error), other] },
      { level: 'error', args: ['[X] failed:', expect.any(Error), other] },
      { level: 'error', args: ['[X] cannot execute UPDATE in a read-only transaction', coded] },
    ]);
  });

  it('recognizes the error when drizzle wraps the driver error on cause', () => {
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => 0 });
    const wrapped = new Error('Failed query: update "devices" ...', { cause: readOnlyError() });
    throttle.console.error('[agentHeartbeat] write failed:', wrapped);
    throttle.console.error('[agentHeartbeat] write failed:', wrapped);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.args[0]).toEqual(expect.stringContaining('[agentHeartbeat]'));
  });

  it('recognizes a message-only log of the read-only error', () => {
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => 0 });
    throttle.console.warn('[Reaper] pass failed: cannot execute DELETE in a read-only transaction');
    throttle.console.warn('[Reaper] pass failed: cannot execute DELETE in a read-only transaction');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
  });

  it('flush() reports what was suppressed when no further error arrives', () => {
    let now = 0;
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => now, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) throttle.console.error('[MonitorWorker] failed:', readOnlyError());
    expect(lines).toHaveLength(1);

    now = 30_000;
    throttle.flush();
    expect(lines).toHaveLength(1); // window still open

    now = 60_000;
    throttle.flush();
    expect(lines).toHaveLength(2);
    expect(lines[1]!.args[0]).toEqual(expect.stringContaining('4 more suppressed'));

    // Nothing left to report: a later flush is silent.
    now = 200_000;
    throttle.flush();
    expect(lines).toHaveLength(2);
  });

  it('bounds the number of tracked sources', () => {
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => 0, maxSources: 2 });
    throttle.console.error('[A] failed:', readOnlyError());
    throttle.console.error('[B] failed:', readOnlyError());
    throttle.console.error('[C] failed:', readOnlyError());
    throttle.console.error('[D] failed:', readOnlyError());
    // A and B get their own line; C and D share the overflow source.
    expect(lines).toHaveLength(3);
    expect(lines[2]!.args[0]).toEqual(expect.stringContaining('(other sources)'));
  });

  it('never throws out of a console call, even for a hostile argument', () => {
    const { sink, lines } = fakeConsole();
    const throttle = createReadOnlyLogThrottle(sink, { now: () => 0 });
    const hostile = new Proxy({}, {
      get() {
        throw new Error('boom');
      },
    });
    expect(() => throttle.console.error('[X] failed:', hostile)).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.args[1]).toBe(hostile);
  });
});

describe('installReadOnlyLogThrottle', () => {
  const realError = console.error;
  beforeEach(() => notePoolReadOnly());
  afterEach(() => {
    console.error = realError;
    notePoolWritable();
  });

  it('routes the process console through the throttle and restores it', () => {
    const stub = vi.fn();
    console.error = stub;
    const restore = installReadOnlyLogThrottle();
    try {
      expect(installReadOnlyLogThrottle()).toBe(restore); // idempotent
      console.error('[W] Job 1 failed:', readOnlyError());
      console.error('[W] Job 2 failed:', readOnlyError());
      console.error('[W] unrelated');
      expect(stub).toHaveBeenCalledTimes(2);
      expect(stub.mock.calls[1]).toEqual(['[W] unrelated']);
    } finally {
      restore();
    }
    expect(console.error).toBe(stub);
  });
});

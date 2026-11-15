import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('falls back to a fixed key when there is no message', () => {
    expect(readOnlyLogSource([readOnlyError()])).toBe('(no message)');
  });
});

describe('createReadOnlyLogThrottle', () => {
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
  afterEach(() => {
    console.error = realError;
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

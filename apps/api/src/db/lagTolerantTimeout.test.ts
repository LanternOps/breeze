// apps/api/src/db/lagTolerantTimeout.test.ts
import net from 'node:net';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armLagTolerantTimeout,
  DB_TIMER_LATE_THRESHOLD_MS,
  getDbTimerLagGraceMs,
} from './lagTolerantTimeout';

/** Blocks the event loop, the way a CPU-bound request handler does. */
function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // deliberately spinning
  }
}

/**
 * An echo server on its OWN event loop (a worker thread), so it keeps
 * answering while the test's loop is stalled — exactly like Postgres does.
 */
const ECHO_WORKER_SOURCE = `
const net = require('node:net');
const { parentPort } = require('node:worker_threads');
const server = net.createServer((socket) => socket.on('data', (data) => socket.write(data)));
server.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
`;

async function startEchoWorker(): Promise<{ port: number; close: () => Promise<number> }> {
  const worker = new Worker(ECHO_WORKER_SOURCE, { eval: true });
  const [port] = (await once(worker, 'message')) as [number];
  return { port, close: () => worker.terminate() };
}

describe('getDbTimerLagGraceMs', () => {
  const original = process.env.DB_TIMER_LAG_GRACE_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.DB_TIMER_LAG_GRACE_MS;
    else process.env.DB_TIMER_LAG_GRACE_MS = original;
  });

  it('defaults to 2s', () => {
    delete process.env.DB_TIMER_LAG_GRACE_MS;
    expect(getDbTimerLagGraceMs()).toBe(2_000);
  });

  it('honours an explicit 0 as "no grace"', () => {
    process.env.DB_TIMER_LAG_GRACE_MS = '0';
    expect(getDbTimerLagGraceMs()).toBe(0);
  });

  it('clamps to 10s so a typo cannot unbound a budget', () => {
    process.env.DB_TIMER_LAG_GRACE_MS = '600000';
    expect(getDbTimerLagGraceMs()).toBe(10_000);
  });

  it('falls back to the default on garbage', () => {
    process.env.DB_TIMER_LAG_GRACE_MS = 'soon';
    expect(getDbTimerLagGraceMs()).toBe(2_000);
  });
});

describe('armLagTolerantTimeout (fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once, on time, with late=false when the loop is healthy', async () => {
    const onFire = vi.fn();
    armLagTolerantTimeout({ timeoutMs: 1_000, graceMs: 2_000, onFire });
    await vi.advanceTimersByTimeAsync(999);
    expect(onFire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith({ elapsedMs: 1_000, late: false });
  });

  it('never fires after cancel()', async () => {
    const onFire = vi.fn();
    const handle = armLagTolerantTimeout({ timeoutMs: 1_000, graceMs: 2_000, onFire });
    handle.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onFire).not.toHaveBeenCalled();
    expect(handle.fired).toBe(false);
  });

  it('grants exactly one grace period when the timer fires at least the threshold late', async () => {
    let skew = 0;
    const now = () => Date.now() + skew;
    const onFire = vi.fn();
    const handle = armLagTolerantTimeout({ timeoutMs: 1_000, graceMs: 2_000, onFire, now });
    // The loop was stalled: by the time the timer callback runs, the wall clock
    // is DB_TIMER_LATE_THRESHOLD_MS past the due time.
    skew = DB_TIMER_LATE_THRESHOLD_MS;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0]?.[0]).toMatchObject({ late: true });
    expect(handle.fired).toBe(true);
  });

  it('reports late=true but does not extend when grace is 0', async () => {
    let skew = 0;
    const onFire = vi.fn();
    armLagTolerantTimeout({ timeoutMs: 1_000, graceMs: 0, onFire, now: () => Date.now() + skew });
    skew = 5_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire.mock.calls[0]?.[0]).toMatchObject({ late: true, elapsedMs: 6_000 });
  });

  it('a cancel during the grace period prevents the fire', async () => {
    let skew = 0;
    const onFire = vi.fn();
    const handle = armLagTolerantTimeout({ timeoutMs: 1_000, graceMs: 2_000, onFire, now: () => Date.now() + skew });
    skew = 1_500;
    await vi.advanceTimersByTimeAsync(1_000);
    handle.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe('armLagTolerantTimeout (real event loop, #8143)', () => {
  it('characterization: after a stall, an expired timer runs BEFORE socket data that arrived during the stall', async () => {
    // This is the whole justification for the grace period. If this test ever
    // fails on a new Node/libuv, the runtime no longer has the problem: set the
    // DB_TIMER_LAG_GRACE_MS default to 0 in lagTolerantTimeout.ts and say so in
    // the PR.
    const echo = await startEchoWorker();
    const socket = net.connect(echo.port, '127.0.0.1');
    try {
      await once(socket, 'connect');
      const order: string[] = [];
      const gotData = once(socket, 'data').then(() => order.push('io'));
      setTimeout(() => order.push('timer'), 20);
      socket.write('ping');
      busyWait(300);
      await gotData;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual(['timer', 'io']);
    } finally {
      socket.destroy();
      await echo.close();
    }
  });

  it('with grace, a reply that arrived during the stall wins against a late timer', async () => {
    const echo = await startEchoWorker();
    const socket = net.connect(echo.port, '127.0.0.1');
    try {
      await once(socket, 'connect');
      const onFire = vi.fn();
      const handle = armLagTolerantTimeout({ timeoutMs: 20, graceMs: 500, lateThresholdMs: 100, onFire });
      const gotData = once(socket, 'data').then(() => handle.cancel());
      socket.write('ping');
      busyWait(300);
      await gotData;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(onFire).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
      await echo.close();
    }
  });

  it('without grace, the same stall fails the operation even though the reply is buffered', async () => {
    const echo = await startEchoWorker();
    const socket = net.connect(echo.port, '127.0.0.1');
    try {
      await once(socket, 'connect');
      const onFire = vi.fn();
      const handle = armLagTolerantTimeout({ timeoutMs: 20, graceMs: 0, lateThresholdMs: 100, onFire });
      const gotData = once(socket, 'data').then(() => handle.cancel());
      socket.write('ping');
      busyWait(300);
      await gotData;
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire.mock.calls[0]?.[0]).toMatchObject({ late: true });
    } finally {
      socket.destroy();
      await echo.close();
    }
  });
});

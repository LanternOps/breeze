/**
 * The receiver of a webhook channel is chosen by the tenant, so its reply is
 * untrusted. The sender reads at most `WEBHOOK_RESPONSE_BODY_MAX_BYTES` of it,
 * then drops the socket. The status code still decides the result: an
 * over-size reply is the same success or failure the sender reports for that
 * status with a small body.
 *
 * These run the real `safeFetch` against a local HTTP server. The SSRF policy
 * sees a private test record (self-hosted, cleartext to an on-LAN receiver);
 * only the final dial is redirected to 127.0.0.1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo, LookupFunction } from 'net';

const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));
vi.mock('dns/promises', () => ({
  lookup: dnsLookupMock,
  default: { lookup: dnsLookupMock },
}));

import * as webhookSender from './webhookSender';
import { sendWebhookNotification } from './webhookSender';
import { __setLookupForTests } from '../urlSafety';

const CAP = 64 * 1024;
const RECEIVER_IP = '10.20.30.40';
const realHttpRequest = http.request;

const payload = {
  alertId: 'alert-1',
  alertName: 'Disk full',
  severity: 'high',
  summary: 'C: is at 99%',
  orgId: 'org-1',
  triggeredAt: '2026-11-27T00:00:00.000Z'
};

const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  process.env.IS_HOSTED = 'false';
  dnsLookupMock.mockResolvedValue([{ address: RECEIVER_IP, family: 4 }]);
  __setLookupForTests(async () => [{ address: RECEIVER_IP, family: 4 }]);
  const toLoopback: LookupFunction = (_host, opts, done) => {
    const callback = (typeof opts === 'function' ? opts : done) as (...a: unknown[]) => void;
    if (typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all) {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
      return;
    }
    callback(null, '127.0.0.1', 4);
  };
  vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions, cb?: (res: http.IncomingMessage) => void) =>
    realHttpRequest({ ...options, lookup: toLoopback }, cb)) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  delete process.env.IS_HOSTED;
  __setLookupForTests(null);
  dnsLookupMock.mockReset();
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

interface Receiver {
  url: string;
  /** Body bytes the receiver managed to write before the connection closed. */
  written: () => number;
  /** Resolves when the sender's side of the connection is gone. */
  closed: Promise<void>;
}

/**
 * A receiver that answers `status` with `prefix` and then `padding` until
 * `total` bytes (or forever, when `total` is undefined), paced so that a client
 * that buffers everything cannot finish quickly or exhaust the test runner.
 */
async function receiver(opts: {
  status: number;
  prefix: string;
  padding?: string;
  total?: number;
}): Promise<Receiver> {
  let written = 0;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const headers: Record<string, string | number> = { 'content-type': 'text/plain; charset=utf-8' };
      if (opts.total !== undefined) headers['content-length'] = opts.total;
      res.writeHead(opts.status, headers);
      res.on('close', markClosed);
      const first = Buffer.from(opts.prefix);
      res.write(first);
      written += first.length;
      const chunk = Buffer.from((opts.padding ?? 'x').repeat(16 * 1024)).subarray(0, 16 * 1024);
      const timer = setInterval(() => {
        if (res.destroyed || res.writableEnded) { clearInterval(timer); return; }
        const remaining = opts.total === undefined ? chunk.length : opts.total - written;
        if (remaining <= 0) { clearInterval(timer); res.end(); return; }
        const piece = chunk.subarray(0, Math.min(chunk.length, remaining));
        res.write(piece);
        written += piece.length;
      }, 5);
      res.on('close', () => clearInterval(timer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const { port } = server.address() as AddressInfo;
  return { url: `http://hook.example.test:${port}/alerts`, written: () => written, closed };
}

describe('webhook sender reply size (#12788)', () => {
  it('exports the cap the sender reads to', () => {
    expect((webhookSender as Record<string, unknown>).WEBHOOK_RESPONSE_BODY_MAX_BYTES).toBe(CAP);
  });

  it('a 2xx with an endless body is a delivered notification, read only to the cap', async () => {
    const r = await receiver({ status: 200, prefix: 'accepted ' });
    const started = Date.now();

    const result = await sendWebhookNotification({ url: r.url, method: 'POST', timeout: 3_000 }, payload);

    expect(result).toMatchObject({ success: true, statusCode: 200 });
    expect(result.responseBody?.startsWith('accepted ')).toBe(true);
    expect(Buffer.byteLength(result.responseBody ?? '')).toBeLessThanOrEqual(CAP);
    // Ended at the cap, not at the configured timeout.
    expect(Date.now() - started).toBeLessThan(2_500);
    await r.closed;
  });

  it('a 5xx with an endless body keeps its status, its summary and its retry', async () => {
    const r = await receiver({ status: 503, prefix: 'Upstream is overloaded, try again later. ', padding: ' ' });

    const result = await sendWebhookNotification({ url: r.url, method: 'POST', timeout: 3_000 }, payload);

    expect(result).toEqual({
      success: false,
      error: 'HTTP 503: Upstream is overloaded, try again later.',
      retryable: true
    });
    await r.closed;
  });

  it('a 4xx with a large declared body is the same permanent failure, and the socket drops at the cap', async () => {
    const total = 4 * 1024 * 1024;
    const r = await receiver({ status: 400, prefix: 'Bad payload. ', total });

    const result = await sendWebhookNotification({ url: r.url, method: 'POST', timeout: 10_000 }, payload);

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toMatch(/^HTTP 400: Bad payload\./);
    await r.closed;
    // The receiver could not finish: the sender hung up shortly after the cap.
    expect(r.written()).toBeLessThan(total / 4);
  });

  it('a small reply is returned whole', async () => {
    const r = await receiver({ status: 202, prefix: '{"queued":true}', total: 15 });

    const result = await sendWebhookNotification({ url: r.url, method: 'POST' }, payload);

    expect(result).toEqual({ success: true, statusCode: 202, responseBody: '{"queued":true}' });
  });
});

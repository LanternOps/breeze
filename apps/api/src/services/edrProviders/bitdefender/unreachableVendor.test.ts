/**
 * A response action against a GravityZone host that never answers the TCP
 * connect (packets dropped) ends at the client's timeout as outcome_unknown
 * (#12788). Before, the socket sat in SYN_SENT for the kernel's retry schedule
 * (about two minutes), because the request timeout only starts once the
 * connection is established.
 *
 * Real transport end to end: adapter → GravityZone client → guarded fetch →
 * safeFetch → a real `https.request` whose socket never finishes connecting.
 * Only DNS (a public test record) and the socket itself are substituted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import https from 'https';
import net from 'net';
import type { EdrActionRequest, EdrAdapterContext } from '../types';
import { createGuardedFetch } from '../guardedFetch';
import { __setLookupForTests } from '../../urlSafety';
import { bitdefenderAdapter as adapter } from './adapter';

const realHttpsRequest = https.request;
const sockets: net.Socket[] = [];

class NeverConnectingAgent extends https.Agent {
  override createConnection(): net.Socket {
    const sock = new net.Socket();
    (sock as unknown as { connecting: boolean }).connecting = true;
    sockets.push(sock);
    return sock;
  }
}

const ACT = '7f0c0000-0000-4000-8000-00000000a001';
const T = { rootId: '5f0a1b2c3d4e5f60718293a0' } as never;
const isolate: EdrActionRequest = { action: 'isolate', target: { kind: 'endpoint', vendorEndpointId: 'ep1' } };

function ctx(): EdrAdapterContext {
  return {
    creds: { apiKey: 'SECRETKEY0123456789abcdef' },
    baseUrl: 'https://cloud.gravityzone.bitdefender.com/api',
    region: null,
    fetch: createGuardedFetch(adapter.hostAllowlist),
    limiter: { acquire: vi.fn(async () => {}) },
    runCache: new Map(),
  };
}

describe('GravityZone response action — vendor unreachable at TCP connect', () => {
  let dials = 0;

  beforeEach(() => {
    dials = 0;
    sockets.length = 0;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    __setLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, cb?: never) => {
      dials++;
      return realHttpsRequest({ ...options, agent: new NeverConnectingAgent() }, cb);
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __setLookupForTests(null);
  });

  it('ends at the 30 s client timeout as outcome_unknown, sent once, socket destroyed', async () => {
    let settled: { ok: boolean; error?: unknown } | undefined;
    adapter.performAction!(ctx(), T, isolate, ACT).then(
      () => { settled = { ok: true }; },
      (error: unknown) => { settled = { ok: false, error }; },
    );

    await vi.advanceTimersByTimeAsync(29_900);
    expect(settled).toBeUndefined();
    expect(dials).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBeDefined();
    expect(settled!.ok).toBe(false);
    expect(settled!.error).toMatchObject({ code: 'outcome_unknown', scope: 'operation', reauth: false });
    // A write is never retried: still exactly one dial.
    expect(dials).toBe(1);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.destroyed).toBe(true);
  });
});

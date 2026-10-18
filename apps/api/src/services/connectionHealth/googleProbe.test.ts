import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

const directoryThrow = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../secretCrypto', () => ({
  decryptForColumn: vi.fn(() => '{"client_email":"SENTINEL-KEY-xyz","private_key":"SENTINEL-PEM"}'),
}));
vi.mock('../googleClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../googleClient')>()),
  getDirectoryClient: vi.fn(() => ({
    users: { get: vi.fn(async () => { throw directoryThrow.current; }) },
  })),
}));

import { GoogleApiError } from '../googleClient';
import {
  classifyProbeError,
  PROBE_BATCH,
  PROBE_CONCURRENCY,
  PROBE_TIMEOUT_MS,
  ProbeCredentialsError,
  ProbeTimeoutError,
  runGoogleProbes,
  probeConnection,
  type ProbeDeps,
  type ProbeTarget,
} from './googleProbe';

const NOW = new Date('2026-10-17T12:00:00Z');
const target = (i: number): ProbeTarget => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  orgId: '33333333-3333-4333-8333-333333333333',
  adminEmail: 'admin@example.com',
  serviceAccountKey: 'ciphertext',
  updatedAtText: '2026-10-01 00:00:00',
});

function deps(over: Partial<ProbeDeps> = {}): ProbeDeps & { recorded: Array<[string, string]> } {
  const recorded: Array<[string, string]> = [];
  return {
    recorded,
    claim: vi.fn(async () => [target(1), target(2)]),
    probe: vi.fn(async () => undefined),
    record: vi.fn(async (t, r) => { recorded.push([t.id, r.status]); return true; }),
    timeoutMs: PROBE_TIMEOUT_MS,
    ...over,
  };
}

describe('classifyProbeError', () => {
  it.each([
    ['401 from Google', Object.assign(new Error('Login Required'), { status: 401 }), 'failed'],
    ['403 delegation revoked', Object.assign(new Error('Not Authorized to access this resource/api'), { code: 403 }), 'failed'],
    ['404 admin deleted', Object.assign(new Error('Resource Not Found: userKey'), { response: { status: 404 } }), 'failed'],
    ['400 unauthorized_client at token exchange', Object.assign(new Error('unauthorized_client: Client is unauthorized'), { status: 400 }), 'failed'],
    ['malformed key', new GoogleApiError('invalid_service_account', 'Service-account key is not valid JSON.'), 'failed'],
    // Breeze-side (wrong encryption key on this worker would hit every org): no verdict.
    ['unreadable ciphertext', new ProbeCredentialsError(), 'unavailable'],
    ['429', Object.assign(new Error('Rate Limit Exceeded'), { status: 429 }), 'unavailable'],
    ['403 rateLimitExceeded (Directory quota)', Object.assign(new Error('Rate Limit Exceeded'), { status: 403, errors: [{ reason: 'rateLimitExceeded' }] }), 'unavailable'],
    ['403 userRateLimitExceeded via response body', Object.assign(new Error('User Rate Limit'), { response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } }), 'unavailable'],
    ['403 quotaExceeded', Object.assign(new Error('Quota'), { code: 403, errors: [{ reason: 'quotaExceeded' }] }), 'unavailable'],
    ['403 forbidden stays failed', Object.assign(new Error('Not Authorized'), { status: 403, errors: [{ reason: 'forbidden' }] }), 'failed'],
    ['408', Object.assign(new Error('Request Timeout'), { status: 408 }), 'unavailable'],
    ['503', Object.assign(new Error('Backend Error'), { code: '503' }), 'unavailable'],
    ['network', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'unavailable'],
    ['our timeout', new ProbeTimeoutError(PROBE_TIMEOUT_MS), 'unavailable'],
    ['an unexpected bug', new TypeError('x is not a function'), 'unavailable'],
  ] as const)('%s → %s', (_n, err, status) => {
    const r = classifyProbeError(err);
    expect(r.status).toBe(status);
    expect(r.error === null || r.error.length <= 300).toBe(true);
  });

  it('logs an error it cannot classify (without its message text), so a probe bug is visible', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    classifyProbeError(new TypeError('x is not a function SENTINEL'));
    classifyProbeError(new ProbeCredentialsError());
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('connection_health_google_probe_unclassified') && l.includes('TypeError'))).toBe(true);
    expect(lines.some((l) => l.includes('connection_health_google_probe_credentials_unreadable'))).toBe(true);
    expect(lines.join('\n')).not.toContain('SENTINEL');
    warn.mockRestore();
  });

  it('never records key material, even if an error echoes it', () => {
    const leak = Object.assign(
      new Error('bad key -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY----- for sa@example.iam.gserviceaccount.com token=ya29.secret'),
      { status: 401 },
    );
    const r = classifyProbeError(leak);
    expect(r.status).toBe('failed');
    expect(r.error).not.toMatch(/PRIVATE KEY|MIIEvQ|ya29/);
  });
});

describe('runGoogleProbes', () => {
  it('records ok for a successful probe and the classified status for a failure', async () => {
    const d = deps({
      probe: vi.fn(async (t: ProbeTarget) => {
        if (t.id === target(2).id) throw Object.assign(new Error('Not Authorized'), { status: 403 });
      }),
    });
    const res = await runGoogleProbes(NOW, d);
    expect(d.recorded).toEqual([[target(1).id, 'ok'], [target(2).id, 'failed']]);
    expect(res).toMatchObject({ claimed: 2, ok: 1, failed: 1, unavailable: 0, discarded: 0, recordErrors: 0 });
    expect(d.claim).toHaveBeenCalledWith(NOW, PROBE_BATCH);
  });

  it('runs at most PROBE_CONCURRENCY probes at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const d = deps({
      claim: vi.fn(async () => Array.from({ length: 10 }, (_, i) => target(i))),
      probe: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      }),
    });
    await runGoogleProbes(NOW, d);
    expect(peak).toBe(PROBE_CONCURRENCY);
    expect(d.recorded).toHaveLength(10);
  });

  it('a hung probe times out as unavailable and does not hold up the others', async () => {
    const d = deps({
      timeoutMs: 20,
      probe: vi.fn((t: ProbeTarget) => (t.id === target(1).id ? new Promise<void>(() => {}) : Promise.resolve())),
    });
    const res = await runGoogleProbes(NOW, d);
    expect(d.recorded).toEqual(expect.arrayContaining([[target(1).id, 'unavailable'], [target(2).id, 'ok']]));
    expect(res.unavailable).toBe(1);
  });

  it('a lost CAS is counted as discarded; one record error does not stop the batch', async () => {
    const d = deps({
      record: vi.fn(async (t: ProbeTarget) => {
        if (t.id === target(1).id) return false;
        throw new Error('db down');
      }),
    });
    const res = await runGoogleProbes(NOW, d);
    expect(res).toMatchObject({ claimed: 2, discarded: 1, recordErrors: 1 });
  });

  it('throws when every claimed result failed to record, so the kind fails and the streak alert can fire', async () => {
    const d = deps({ record: vi.fn(async () => { throw new Error('column missing'); }) });
    await expect(runGoogleProbes(NOW, d)).rejects.toThrow(/could not record any probe result/);
  });

  it('a failed claim throws, so the kind fails instead of reading stale results as fresh', async () => {
    await expect(runGoogleProbes(NOW, deps({ claim: vi.fn(async () => { throw new Error('claim failed'); }) }))).rejects.toThrow('claim failed');
  });

  it('pins the rate limits from the plan', () => {
    expect({ PROBE_BATCH, PROBE_CONCURRENCY, PROBE_TIMEOUT_MS }).toEqual({ PROBE_BATCH: 16, PROBE_CONCURRENCY: 4, PROBE_TIMEOUT_MS: 8000 });
  });
});

describe('probeConnection keeps key material out of results and logs', () => {
  it.each([
    ['a parse-style error echoing the key', () => new SyntaxError('Unexpected token in {"client_email":"SENTINEL-KEY-xyz"')],
    ['a Google error echoing the key', () => new GoogleApiError('invalid_service_account', 'bad key SENTINEL-KEY-xyz')],
    ['a 400 echoing the key', () => Object.assign(new Error('invalid_grant for SENTINEL-KEY-xyz'), { status: 400 })],
  ])('%s', async (_name, makeErr) => {
    directoryThrow.current = makeErr();
    const logs: string[] = [];
    for (const level of ['info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    }
    const recorded: Array<{ status: string; error: string | null }> = [];
    await runGoogleProbes(NOW, {
      claim: async () => [target(1)],
      probe: probeConnection,
      record: async (_t, r) => { recorded.push(r); return true; },
      timeoutMs: 1000,
    });
    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded)).not.toContain('SENTINEL');
    expect(logs.join('\n')).not.toContain('SENTINEL');
    vi.restoreAllMocks();
  });
});


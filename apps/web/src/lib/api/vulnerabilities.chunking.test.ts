// #3694: the API caps deviceVulnerabilityIds at 200 and the web layer used to
// POST the whole selection, so any selection over 200 failed with
// `Too big: expected array to have <=200 items` — reported against a real
// 576-finding remediation.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

const showToast = vi.fn();
vi.mock('../../components/shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import { remediateVuln, bulkAcceptVulnRisk, bulkMitigateVulns, createVulnTicket } from './vulnerabilities';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
const sentBatches = () =>
  fetchWithAuth.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body).deviceVulnerabilityIds as string[]);

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
  // A Response body is single-use: mockResolvedValue would hand the SAME object
  // to every batch and the second .json() would throw. Build a fresh one per call.
  // Respond with the ACTUAL batch size: a fixed 200 let the 176-id final batch
  // report 200 and the suite blessed an impossible total of 600.
  fetchWithAuth.mockImplementation((_url: string, opts: { body: string }) => {
    const n = (JSON.parse(opts.body).deviceVulnerabilityIds as string[]).length;
    return Promise.resolve(new Response(JSON.stringify({ scheduled: n, skipped: [], success: true, succeeded: n })));
  });
});

describe('#3694 bulk id chunking', () => {
  it('sends 576 findings as three batches of 200/200/176, none over the cap', async () => {
    await remediateVuln(ids(576));
    const batches = sentBatches();
    expect(batches.map((b) => b.length)).toEqual([200, 200, 176]);
    expect(batches.flat()).toEqual(ids(576));            // every id sent exactly once, in order
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(200);
  });

  it('at or under the cap it stays a SINGLE request — the unchanged path', async () => {
    await remediateVuln(ids(200));
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(sentBatches()[0]).toHaveLength(200);
  });

  it('emits ONE aggregate success toast for a multi-batch run, not one per batch', async () => {
    await remediateVuln(ids(576));
    const successes = showToast.mock.calls.filter((c) => (c[0] as { type: string }).type === 'success');
    expect(successes).toHaveLength(1);
    expect((successes[0][0] as { message: string }).message).toContain('576'); // 200+200+176, the real total
  });

  it('reports partial progress when a later batch fails, instead of failing silently', async () => {
    fetchWithAuth
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ scheduled: 200, skipped: [] }))))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 })));

    await expect(remediateVuln(ids(576))).rejects.toThrow();

    const errs = showToast.mock.calls
      .filter((c) => (c[0] as { type: string }).type === 'error')
      .map((c) => (c[0] as { message: string }).message);
    // The operator must learn that 200 DID schedule and 376 did not.
    expect(errs.some((m) => m.includes('200') && m.includes('576'))).toBe(true);
  });

  it('bulk accept-risk and mitigate chunk the same way and keep their payload', async () => {
    await bulkAcceptVulnRisk(ids(450), { reason: 'r', acceptedUntil: '2026-12-01' });
    expect(sentBatches().map((b) => b.length)).toEqual([200, 200, 50]);
    expect(JSON.parse((fetchWithAuth.mock.calls[0][1] as { body: string }).body).reason).toBe('r');

    fetchWithAuth.mockClear();
    await bulkMitigateVulns(ids(201), { note: 'n' });
    expect(sentBatches().map((b) => b.length)).toEqual([200, 1]);
    expect(JSON.parse((fetchWithAuth.mock.calls[0][1] as { body: string }).body).note).toBe('n');
  });


  // Codex caught these three as unproven: each mutation below passed the
  // original suite.

  it('the single-batch path STILL emits its success toast (not silently muted)', async () => {
    await remediateVuln(ids(10));
    const successes = showToast.mock.calls.filter((c) => (c[0] as { type: string }).type === 'success');
    expect(successes).toHaveLength(1);
    // Flipping the at-cap branch to send(ids, false) would drop this toast and
    // was previously invisible to the suite.
    expect((successes[0][0] as { message: string }).message).toContain('10');
  });

  it('batches run SEQUENTIALLY — request 2 does not start until request 1 settles', async () => {
    const started: number[] = [];
    let releaseFirst: (() => void) | undefined;
    fetchWithAuth.mockImplementation((_u: string, opts: { body: string }) => {
      const n = (JSON.parse(opts.body).deviceVulnerabilityIds as string[]).length;
      started.push(n);
      const res = new Response(JSON.stringify({ scheduled: n, skipped: [] }));
      if (started.length === 1) return new Promise((r) => { releaseFirst = () => r(res); });
      return Promise.resolve(res);
    });

    const p = remediateVuln(ids(576));
    await Promise.resolve();
    // A concurrent implementation that merely awaits in order would have fired
    // all three by now.
    expect(started).toHaveLength(1);
    releaseFirst!();
    await p;
    expect(started).toEqual([200, 200, 176]);
  });

  it('stops dead on a failed batch — no further requests are sent', async () => {
    fetchWithAuth
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ scheduled: 200, skipped: [] }))))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 })));
    await expect(remediateVuln(ids(576))).rejects.toThrow();
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);   // the third batch must never fire
  });

  it('the partial message warns about duplicate installs rather than inviting a blind retry', async () => {
    fetchWithAuth
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ scheduled: 200, skipped: [] }))))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 })));
    await expect(remediateVuln(ids(576))).rejects.toThrow();
    const errs = showToast.mock.calls
      .filter((c) => (c[0] as { type: string }).type === 'error')
      .map((c) => (c[0] as { message: string }).message);
    // "At least N" not "exactly N": the failed batch may also have applied work.
    expect(errs.some((m) => m.includes('At least 200') && /duplicate/i.test(m))).toBe(true);
  });

  // Tickets are the exception: the server creates ONE ticket per org, so three
  // batches would create three tickets per org rather than one.
  it('does NOT chunk ticket creation — it refuses with actionable copy', async () => {
    await expect(
      createVulnTicket(ids(576), { title: 't', priority: 'high' }),
    ).rejects.toThrow(/at most 200/);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    const msg = (showToast.mock.calls[0][0] as { message: string }).message;
    expect(msg).toContain('duplicates');
  });

  it('still creates a ticket normally at or under the cap', async () => {
    fetchWithAuth.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true, tickets: [{ ticketId: 't1', orgId: 'o1', findingCount: 5 }], skipped: [] }))));
    await createVulnTicket(ids(200), { title: 't', priority: 'high' });
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});

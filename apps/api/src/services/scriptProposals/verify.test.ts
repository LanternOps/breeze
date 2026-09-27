import { describe, expect, it, vi, beforeEach } from 'vitest';

const verifyServiceRunningForTask = vi.fn();
const verifyProcessAbsentByNameForTask = vi.fn();
vi.mock('../aiAgents/actVerify', () => ({
  verifyServiceRunningForTask: (...a: unknown[]) => verifyServiceRunningForTask(...a),
  verifyProcessAbsentByNameForTask: (...a: unknown[]) => verifyProcessAbsentByNameForTask(...a),
}));
const executeCommandWithSystemPrecheck = vi.fn();
vi.mock('../commandQueue', () => ({
  executeCommandWithSystemPrecheck: (...a: unknown[]) => executeCommandWithSystemPrecheck(...a),
}));
vi.mock('bullmq', () => ({ Queue: function Queue() { return { add: vi.fn() }; } }));
vi.mock('../redis', () => ({ getBullMQConnection: () => ({}) }));

// Defaults to the REAL implementation (matched/not_matched/error) for every
// test below except the one that forces a timeout via mockResolvedValueOnce.
const { testRegexWithTimeout } = vi.hoisted(() => ({ testRegexWithTimeout: vi.fn() }));
vi.mock('./regexMatchTimeout', async () => {
  const actual = await vi.importActual<typeof import('./regexMatchTimeout')>('./regexMatchTimeout');
  testRegexWithTimeout.mockImplementation(actual.testRegexWithTimeout);
  return { testRegexWithTimeout };
});

import { evaluateVerificationClaim, onUnattendedVerificationOutcome, registerUnattendedVerificationOutcomeHandler } from './verify';

const device = { deviceId: 'd1', orgId: 'o1' };
const ok = { status: 'completed', exitCode: 0, stdout: 'Spooler started', stderr: null };
beforeEach(() => vi.clearAllMocks());

describe('exit_code', () => {
  it('verifies on an equal exit code', async () => {
    expect((await evaluateVerificationClaim({ kind: 'exit_code', equals: 0 }, ok, device, 'u1')).outcome)
      .toBe('verified');
  });
  it('fails on a different exit code', async () => {
    const r = await evaluateVerificationClaim({ kind: 'exit_code', equals: 0 }, { ...ok, exitCode: 3 }, device, 'u1');
    expect(r.outcome).toBe('verification_failed');
    expect(r.evidence).toMatchObject({ exitCode: 3, expected: 0 });
  });
  it('is unknown when the execution never reached a completed state with an exit code', async () => {
    expect((await evaluateVerificationClaim({ kind: 'exit_code', equals: 0 }, { ...ok, status: 'timeout', exitCode: null }, device, 'u1')).outcome)
      .toBe('unknown');
  });
});

describe('output_matches', () => {
  it('verifies when the regex matches stdout', async () => {
    expect((await evaluateVerificationClaim({ kind: 'output_matches', regex: 'Spooler started' }, ok, device, 'u1')).outcome)
      .toBe('verified');
  });
  it('fails when it does not match', async () => {
    expect((await evaluateVerificationClaim({ kind: 'output_matches', regex: '^never$' }, ok, device, 'u1')).outcome)
      .toBe('verification_failed');
  });
  it('is unknown — never a crash — on an invalid regex', async () => {
    const r = await evaluateVerificationClaim({ kind: 'output_matches', regex: '([' }, ok, device, 'u1');
    expect(r.outcome).toBe('unknown');
    expect(r.evidence).toMatchObject({ reason: expect.stringMatching(/regex|claim/) });
  });
  it('is unknown when the execution produced no output to match against', async () => {
    const r = await evaluateVerificationClaim({ kind: 'output_matches', regex: 'x' }, { ...ok, status: 'failed', stdout: null, stderr: null }, device, 'u1');
    expect(r.outcome).toBe('unknown');
  });

  it('bounds the matched haystack instead of scanning unbounded execution output', async () => {
    // A marker at the very START of a payload far larger than any reasonable
    // cap. Only the TAIL of stdout+stderr should be considered — matching the
    // marker here proves the whole (multi-MB) string was fed to the regex
    // engine with no bound.
    const huge = 'MARKER' + 'x'.repeat(2_000_000);
    const r = await evaluateVerificationClaim(
      { kind: 'output_matches', regex: '^MARKER' },
      { ...ok, stdout: huge, stderr: null },
      device,
      'u1',
    );
    expect(r.outcome).toBe('verification_failed');
  });

  it('is unknown for a stored pattern that fails the safety re-check (defence in depth for pre-existing rows)', async () => {
    // Simulates a proposal authored before pattern-complexity validation
    // existed at the schema layer — verify.ts must not trust the stored
    // regex is safe just because it once passed authoring-time checks.
    const r = await evaluateVerificationClaim(
      { kind: 'output_matches', regex: '(a+)+$' },
      ok,
      device,
      'u1',
    );
    expect(r.outcome).toBe('unknown');
  });

  it('is unknown, not a crash or a false failure, when the match-time execution bound trips', async () => {
    // Exercises the genuine execution-time backstop (regexMatchTimeout.ts)
    // rather than only the heuristic pre-check above: a pattern that
    // somehow reaches match time and then runs too long must resolve to
    // `unknown` with a distinct evidence reason, the same non-punitive
    // posture as every other "couldn't evaluate this" branch here — never
    // treated as a failed verification, and never left hanging the worker.
    testRegexWithTimeout.mockResolvedValueOnce({ status: 'timeout' });
    const r = await evaluateVerificationClaim(
      { kind: 'output_matches', regex: 'Spooler started' },
      ok,
      device,
      'u1',
    );
    expect(r).toEqual({ outcome: 'unknown', evidence: { reason: 'regex_match_timeout', regex: 'Spooler started' } });
  });
});

describe('service_running', () => {
  it('uses an INDEPENDENT list_services read, not the execution result', async () => {
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'passed' });
    const r = await evaluateVerificationClaim({ kind: 'service_running', name: 'spooler' }, ok, device, 'u1');
    expect(verifyServiceRunningForTask).toHaveBeenCalledWith({ serviceName: 'spooler' }, device, 'u1');
    expect(r.outcome).toBe('verified');
    expect(r.evidence).toMatchObject({ independentRead: 'list_services' });
  });
  it('maps inconclusive to unknown, not to failed', async () => {
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'inconclusive', detail: 'device offline' });
    expect((await evaluateVerificationClaim({ kind: 'service_running', name: 'spooler' }, ok, device, 'u1')).outcome)
      .toBe('unknown');
  });
  it('fails on a genuine read-back of a stopped service', async () => {
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'failed', detail: 'service status is "Stopped"' });
    expect((await evaluateVerificationClaim({ kind: 'service_running', name: 'spooler' }, ok, device, 'u1')).outcome)
      .toBe('verification_failed');
  });
  it('does not consult the execution exit code at all', async () => {
    verifyServiceRunningForTask.mockResolvedValue({ verification: 'passed' });
    const r = await evaluateVerificationClaim({ kind: 'service_running', name: 'spooler' }, { ...ok, exitCode: 1, status: 'failed' }, device, 'u1');
    expect(r.outcome).toBe('verified');
  });
});

describe('process_absent', () => {
  it('verifies when the independent process list has no match', async () => {
    verifyProcessAbsentByNameForTask.mockResolvedValue({ verification: 'passed' });
    const r = await evaluateVerificationClaim({ kind: 'process_absent', name: 'evil.exe' }, ok, device, 'u1');
    expect(r.outcome).toBe('verified');
  });

  it('threads a kind-only aiOrigin — this worker has no agent run to point at, but the read is still AI-decided (#5789)', async () => {
    verifyProcessAbsentByNameForTask.mockResolvedValue({ verification: 'passed' });
    await evaluateVerificationClaim({ kind: 'process_absent', name: 'evil.exe' }, ok, device, 'u1');
    expect(verifyProcessAbsentByNameForTask).toHaveBeenCalledWith(
      { processName: 'evil.exe' },
      device,
      'u1',
      { kind: 'ai_agent' },
    );
  });
  it('fails when the process is still there', async () => {
    verifyProcessAbsentByNameForTask.mockResolvedValue({ verification: 'failed', detail: 'still present' });
    expect((await evaluateVerificationClaim({ kind: 'process_absent', name: 'evil.exe' }, ok, device, 'u1')).outcome)
      .toBe('verification_failed');
  });
});

describe('file_exists', () => {
  const listing = (entries: Array<{ name: string; path: string }>, truncated = false) =>
    JSON.stringify({ path: 'C:/temp', entries, limit: 5000, truncated });

  it('verifies from an independent file_list read of the parent directory', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: listing([{ name: 'marker', path: 'C:/temp/marker' }]) });
    const r = await evaluateVerificationClaim({ kind: 'file_exists', path: 'C:/temp/marker' }, ok, device, 'u1');
    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledWith(
      'd1', 'file_list', expect.objectContaining({ path: 'C:/temp' }), expect.objectContaining({ expectedOrgId: 'o1', userId: 'u1' }),
    );
    expect(r.outcome).toBe('verified');
  });
  it('matches Windows backslash paths', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: listing([{ name: 'marker.txt', path: 'C:\\temp\\marker.txt' }]) });
    const r = await evaluateVerificationClaim({ kind: 'file_exists', path: 'C:\\temp\\marker.txt' }, ok, device, 'u1');
    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledWith('d1', 'file_list', expect.objectContaining({ path: 'C:\\temp' }), expect.anything());
    expect(r.outcome).toBe('verified');
  });
  it('is unknown when the read did not complete', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'timeout' });
    expect((await evaluateVerificationClaim({ kind: 'file_exists', path: 'C:/temp/marker' }, ok, device, 'u1')).outcome)
      .toBe('unknown');
  });
  it('fails when the read completed and the file is not there', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: listing([]) });
    expect((await evaluateVerificationClaim({ kind: 'file_exists', path: 'C:/temp/marker' }, ok, device, 'u1')).outcome)
      .toBe('verification_failed');
  });
  it('is unknown, not failed, when the listing was truncated and the file was not seen', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: listing([], true) });
    expect((await evaluateVerificationClaim({ kind: 'file_exists', path: 'C:/temp/marker' }, ok, device, 'u1')).outcome)
      .toBe('unknown');
  });
  it('is unknown on an unparseable read-back', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: 'not json' });
    expect((await evaluateVerificationClaim({ kind: 'file_exists', path: 'C:/temp/marker' }, ok, device, 'u1')).outcome)
      .toBe('unknown');
  });
});

describe('malformed claim', () => {
  it('is unknown, never verified', async () => {
    const r = await evaluateVerificationClaim({ kind: 'nonsense' }, ok, device, 'u1');
    expect(r.outcome).toBe('unknown');
    expect(r.evidence).toMatchObject({ reason: 'claim_not_parseable' });
  });
});

describe('onUnattendedVerificationOutcome', () => {
  it('is a no-op with no handler and swallows a throwing handler', async () => {
    registerUnattendedVerificationOutcomeHandler(null);
    await expect(onUnattendedVerificationOutcome({ id: 'p1', orgId: 'o1' }, 'verified')).resolves.toBeUndefined();
    const handler = vi.fn(async () => { throw new Error('boom'); });
    registerUnattendedVerificationOutcomeHandler(handler);
    await expect(onUnattendedVerificationOutcome({ id: 'p1', orgId: 'o1' }, 'unknown')).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledWith({ id: 'p1', orgId: 'o1' }, 'unknown');
    registerUnattendedVerificationOutcomeHandler(null);
  });
});

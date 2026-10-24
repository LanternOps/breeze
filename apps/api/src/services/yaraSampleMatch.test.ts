/**
 * `breeze-yarac match` runner (#6263 W04-2): framing, admission, release on
 * child EXIT (not at the timeout), abort, the child env, and the mapping of
 * every exit/output shape. `spawn` is faked; the `real` case runs the actual
 * binary when BREEZE_YARAC_PATH is set:
 *
 *   cd agent && go build -o "$TMPDIR/breeze-yarac" ./cmd/breeze-yarac
 *   cd apps/api && BREEZE_YARAC_PATH="$TMPDIR/breeze-yarac" BREEZE_YARA_TEST_UNSANDBOXED=1 NODE_ENV=test \
 *     npx vitest run src/services/yaraSampleMatch.test.ts -t real
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, useReal } = vi.hoisted(() => ({ spawnMock: vi.fn(), useReal: { on: false } }));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: (...args: unknown[]) => (useReal.on ? (actual.spawn as any)(...args) : spawnMock(...args)) };
});

import { __resetYaracForTests, precheckYaraBundle } from './yaraPrecheck';
import {
  __resetSampleMatchForTests,
  matchSample,
  reserveSampleMatch,
  YARA_MATCH_TIMEOUT_MS,
  yaraTestUnsandboxedAllowed,
} from './yaraSampleMatch';

const REAL_YARAC = process.env.BREEZE_YARAC_PATH;
const ENV_KEYS = ['BREEZE_YARAC_PATH', 'BREEZE_YARA_TEST_UNSANDBOXED', 'NODE_ENV'] as const;
const saved: Record<string, string | undefined> = {};

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  stdinBytes: () => Buffer;
}

function fakeChild(opts: { killDelayMs?: number } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    setTimeout(() => child.emit('close', null, 'SIGKILL'), opts.killDelayMs ?? 0);
    return true;
  });
  const chunks: Buffer[] = [];
  child.stdin.on('data', (c: Buffer) => chunks.push(c));
  child.stdinBytes = () => Buffer.concat(chunks);
  return child;
}

/** The child writes `stdout`, then exits with `code` (after stdin is fully read). */
function respond(code: number, stdout: string, stderr = ''): FakeChild {
  const child = fakeChild();
  spawnMock.mockImplementationOnce(() => {
    child.stdin.on('finish', () => setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', code, null);
    }));
    return child;
  });
  return child;
}

/** A child that never exits on its own. */
function hang(opts: { killDelayMs?: number } = {}): FakeChild {
  const child = fakeChild(opts);
  spawnMock.mockImplementationOnce(() => child);
  return child;
}

const BUNDLE = '{"format":"breeze-yara-bundle","v":1,"ruleSetId":"S","version":1,"autoQuarantine":false,"rules":[]}';
const SAMPLE = Buffer.from([0x00, 0xff, 0x41, 0x42]);
const OK = JSON.stringify({
  ok: true,
  durationMs: 12,
  peakRssMb: 80,
  matches: [{
    ruleSetId: 'S', ruleId: 'r1', ruleName: 'ioc_x_string_0123456789abcdef', severity: 'high', tags: ['ioc', 'string'],
    matchedStrings: [{ id: '$i0', offset: 3, data: 'marker' }],
  }],
});

function reserve() {
  const r = reserveSampleMatch();
  if (!r) throw new Error('expected a free reservation');
  return r;
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  spawnMock.mockReset();
  useReal.on = false;
  __resetYaracForTests();
  __resetSampleMatchForTests();
  delete process.env.BREEZE_YARAC_PATH;
  delete process.env.BREEZE_YARA_TEST_UNSANDBOXED;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('matchSample — framing and arguments', () => {
  it('frames stdin as 4-byte big-endian bundle length, bundle, sample', async () => {
    const child = respond(0, OK);
    const res = await matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x.bin', sample: SAMPLE });
    expect(res.ok).toBe(true);
    const sent = child.stdinBytes();
    const len = Buffer.byteLength(BUNDLE);
    expect(sent.length).toBe(4 + len + SAMPLE.length);
    expect(sent.readUInt32BE(0)).toBe(len);
    expect(sent.subarray(4, 4 + len).toString('utf8')).toBe(BUNDLE);
    expect(sent.subarray(4 + len).equals(SAMPLE)).toBe(true);
  });

  it('passes filename/filepath as --flag=value (a leading dash can never become a flag)', async () => {
    respond(0, OK);
    await matchSample(reserve(), { bundleJson: BUNDLE, filename: '-x.exe', filepath: 'C:\\Users\\Public\\-x.exe', sample: SAMPLE });
    expect(spawnMock.mock.calls[0]![1]).toEqual(['match', '--filename=-x.exe', '--filepath=C:\\Users\\Public\\-x.exe']);
    respond(0, OK);
    await matchSample(reserve(), { bundleJson: BUNDLE, filename: 'a.bin', sample: SAMPLE });
    expect(spawnMock.mock.calls[1]![1]).toEqual(['match', '--filename=a.bin']);
  });

  it('parses matches and caps matched strings at 10', async () => {
    const strings = Array.from({ length: 12 }, (_, i) => ({ id: `$s${i}`, offset: i, data: 'x' }));
    respond(0, JSON.stringify({
      ok: true, durationMs: 5, matches: [
        JSON.parse(OK).matches[0],
        { ruleSetId: 'S', ruleId: 'r2', ruleName: 'r2', severity: 'low', tags: [], matchedStrings: strings },
      ],
    }));
    const res = await matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE });
    expect(res).toEqual({
      ok: true,
      durationMs: 5,
      matches: [
        { ruleSetId: 'S', ruleId: 'r1', ruleName: 'ioc_x_string_0123456789abcdef', severity: 'high', tags: ['ioc', 'string'], matchedStrings: [{ id: '$i0', offset: 3, data: 'marker' }] },
        { ruleSetId: 'S', ruleId: 'r2', ruleName: 'r2', severity: 'low', tags: [], matchedStrings: strings.slice(0, 10) },
      ],
    });
  });

  it.each([
    ['a non-object entry', ['junk']],
    ['a non-string ruleId', [{ ruleSetId: 'S', ruleId: 7, ruleName: 'bad', severity: 'high', tags: [], matchedStrings: [] }]],
    ['a non-string tag', [{ ruleSetId: 'S', ruleId: 'r', ruleName: 'r', severity: 'high', tags: ['ok', 3], matchedStrings: [] }]],
    ['missing matchedStrings', [{ ruleSetId: 'S', ruleId: 'r', ruleName: 'r', severity: 'high', tags: [] }]],
    ['a bad matched-string offset', [{ ruleSetId: 'S', ruleId: 'r', ruleName: 'r', severity: 'high', tags: [], matchedStrings: [{ id: '$a', offset: 'x', data: 'y' }] }]],
  ])('malformed output (%s) is unavailable, never "fewer matches"', async (_name, matches) => {
    respond(0, JSON.stringify({ ok: true, durationMs: 5, matches: [JSON.parse(OK).matches[0], ...(matches as unknown[])] }));
    const res = await matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE });
    expect(res).toMatchObject({ ok: false, unavailable: expect.stringContaining('bad_output') });
  });
});

describe('matchSample — exit codes (D2: every sandbox failure is sandboxUnavailable, everything else unavailable)', () => {
  it('exit 1 with a rule error list -> errors', async () => {
    respond(1, '{"ok":false,"errors":[{"ruleId":"r1","name":"broken","code":"compile","message":"syntax error","line":3}]}');
    await expect(matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE })).resolves.toEqual({
      ok: false, errors: [{ ruleId: 'r1', name: 'broken', code: 'compile', message: 'syntax error', line: 3 }],
    });
  });

  it('exit 3 -> sandboxUnavailable, with the failed step kept for the server log', async () => {
    respond(3, '{"ok":false,"unavailable":"sandbox"}\n', 'sandbox unavailable: landlock abi: function not implemented\n');
    await expect(matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE })).resolves.toEqual({
      ok: false, sandboxUnavailable: true, detail: 'sandbox unavailable: landlock abi: function not implemented',
    });
  });

  it('exit 3 is sandboxUnavailable even when stdout claims matches', async () => {
    respond(3, OK);
    const res = await matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE });
    expect(res).toMatchObject({ ok: false, sandboxUnavailable: true });
    expect(res).not.toHaveProperty('matches');
  });

  it('exit 3 is sandboxUnavailable even with garbled stdout', async () => {
    respond(3, 'garbage');
    const res = await matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE });
    expect(res).toMatchObject({ ok: false, sandboxUnavailable: true });
  });

  it.each([
    ['exit 2 (engine/usage failure)', 2, '', 'YARA engine failure'],
    ['exit 0 without ok:true', 0, '{"ok":false}', ''],
    ['exit 0 with malformed stdout', 0, 'not json', ''],
    ['exit 1 without an error list', 1, '{"ok":false}', ''],
    ['killed by a signal', null, '', ''],
  ])('%s -> unavailable', async (_name, code, stdout, stderr) => {
    respond(code as number, stdout, stderr);
    const res = await matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE });
    expect(res).toMatchObject({ ok: false, unavailable: expect.any(String) });
  });

  it('a spawn error (binary missing) -> unavailable ENOENT and the reservation is released', async () => {
    const child = fakeChild();
    child.pid = undefined as unknown as number;
    spawnMock.mockImplementationOnce(() => {
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    });
    await expect(matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE })).resolves.toEqual({
      ok: false, unavailable: 'ENOENT',
    });
    expect(reserveSampleMatch()).not.toBeNull();
  });

  it('a synchronous spawn throw -> unavailable and released', async () => {
    spawnMock.mockImplementationOnce(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    await expect(matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE })).resolves.toEqual({
      ok: false, unavailable: 'EACCES',
    });
    expect(reserveSampleMatch()).not.toBeNull();
  });
});

describe('admission and release', () => {
  it('one match at a time per process: a second reservation is refused until the first is released', () => {
    const first = reserve();
    expect(reserveSampleMatch()).toBeNull();
    first.release();
    first.release(); // idempotent: must not free a slot twice
    const second = reserve();
    expect(reserveSampleMatch()).toBeNull();
    second.release();
  });

  it('refuses (and holds nothing) when both shared yarac slots are taken by pre-checks', async () => {
    const a = hang();
    const b = hang();
    const pa = precheckYaraBundle(BUNDLE);
    const pb = precheckYaraBundle(BUNDLE);
    await new Promise((r) => setImmediate(r));
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(reserveSampleMatch()).toBeNull();
    // Nothing was taken by the refused attempt: once one pre-check exits, a match fits.
    a.stdout.end('{"ok":true,"errors":[]}');
    a.emit('close', 0, null);
    await pa;
    const r = reserve();
    r.release();
    b.stdout.end('{"ok":true,"errors":[]}');
    b.emit('close', 0, null);
    await pb;
  });

  it('a match holds a shared yarac slot: two pre-checks can no longer both run', async () => {
    const r = reserve();
    const a = hang();
    hang();
    const pa = precheckYaraBundle(BUNDLE);
    void precheckYaraBundle(BUNDLE);
    await new Promise((res) => setImmediate(res));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    a.stdout.end('{"ok":true,"errors":[]}');
    a.emit('close', 0, null);
    await pa;
    r.release();
  });

  it('releases when the child EXITS, not when the timeout fires', async () => {
    vi.useFakeTimers();
    const child = hang({ killDelayMs: 200 }); // ignores SIGKILL for 200 ms
    const pending = matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE });
    await vi.advanceTimersByTimeAsync(YARA_MATCH_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ ok: false, unavailable: 'timeout' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(reserveSampleMatch()).toBeNull(); // the child is still alive
    await vi.advanceTimersByTimeAsync(200);
    const again = reserveSampleMatch();
    expect(again).not.toBeNull();
    again!.release();
  });

  it('a client disconnect (abort) kills the child; released on exit', async () => {
    const child = hang();
    const ac = new AbortController();
    const pending = matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE, signal: ac.signal });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await expect(pending).resolves.toEqual({ ok: false, unavailable: 'aborted' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await new Promise((r) => setTimeout(r, 5));
    const again = reserveSampleMatch();
    expect(again).not.toBeNull();
    again!.release();
  });

  it('an already-aborted signal never spawns', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE, signal: ac.signal })).resolves.toEqual({
      ok: false, unavailable: 'aborted',
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(reserveSampleMatch()).not.toBeNull();
  });
});

describe('child environment', () => {
  it('is PATH only in production, even when the API has BREEZE_YARA_TEST_UNSANDBOXED=1', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BREEZE_YARA_TEST_UNSANDBOXED = '1';
    expect(yaraTestUnsandboxedAllowed()).toBe(false);
    respond(0, OK);
    await matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE });
    expect(spawnMock.mock.calls[0]![2].env).toEqual({ PATH: process.env.PATH ?? '' });
  });

  it('an unset NODE_ENV is not a dev environment', () => {
    delete process.env.NODE_ENV;
    process.env.BREEZE_YARA_TEST_UNSANDBOXED = '1';
    expect(yaraTestUnsandboxedAllowed()).toBe(false);
  });

  it('passes the escape hatch only under development/test with the flag set', async () => {
    process.env.BREEZE_YARA_TEST_UNSANDBOXED = '1';
    respond(0, OK);
    await matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE });
    expect(spawnMock.mock.calls[0]![2].env).toEqual({ PATH: process.env.PATH ?? '', BREEZE_YARA_TEST_UNSANDBOXED: '1' });

    delete process.env.BREEZE_YARA_TEST_UNSANDBOXED;
    respond(0, OK);
    await matchSample(reserve(), { bundleJson: BUNDLE, filename: 'x', sample: SAMPLE });
    expect(spawnMock.mock.calls[1]![2].env).toEqual({ PATH: process.env.PATH ?? '' });
  });
});

describe('real breeze-yarac (opt-in: BREEZE_YARAC_PATH)', () => {
  it.skipIf(!REAL_YARAC)('real: matches the golden IOC bundle against a sample holding one of its strings', async () => {
    process.env.BREEZE_YARAC_PATH = REAL_YARAC;
    process.env.BREEZE_YARA_TEST_UNSANDBOXED = saved.BREEZE_YARA_TEST_UNSANDBOXED ?? '';
    useReal.on = true;
    const golden = readFileSync(resolve(__dirname, '../../../../agent/internal/yarascan/testdata/ioc-import.golden.json'), 'utf8');
    const res = await matchSample(reserve(), {
      bundleJson: golden, filename: 'sample.bin', sample: Buffer.from('xx breeze_ioc_golden_marker xx'),
    });
    expect(res).toMatchObject({ ok: true });
    if (!res.ok || !('matches' in res)) throw new Error('unreachable');
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]!.matchedStrings[0]).toEqual({ id: '$i0', offset: 3, data: 'breeze_ioc_golden_marker' });
  }, 60_000);
});

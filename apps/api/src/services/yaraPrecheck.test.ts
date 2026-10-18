import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import {
  precheckYaraBundle,
  yaracVersion,
  __resetYaracForTests,
  YARAC_TIMEOUT_MS,
  YARAC_MAX_STDOUT_BYTES,
} from './yaraPrecheck';

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  stdinText: () => string;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    setImmediate(() => child.emit('close', null, 'SIGKILL'));
    return true;
  });
  const chunks: Buffer[] = [];
  child.stdin.on('data', (c: Buffer) => chunks.push(c));
  child.stdinText = () => Buffer.concat(chunks).toString('utf8');
  return child;
}

/** Spawn returns a child that writes `stdout`, then exits with `code`. */
function respond(code: number, stdout: string, stderr = ''): FakeChild {
  const child = fakeChild();
  spawnMock.mockImplementationOnce(() => {
    setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', code, null);
    });
    return child;
  });
  return child;
}

const BUNDLE = '{"format":"breeze-yara-bundle","v":1,"ruleSetId":"S","version":1,"autoQuarantine":false,"rules":[]}';

beforeEach(() => {
  spawnMock.mockReset();
  __resetYaracForTests();
  delete process.env.BREEZE_YARAC_PATH;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('precheckYaraBundle', () => {
  it('exit 0 with ok JSON -> ok, and the bundle is written to stdin of `validate`', async () => {
    const child = respond(0, '{"ok":true,"errors":[]}\n');
    await expect(precheckYaraBundle(BUNDLE)).resolves.toEqual({ ok: true });
    expect(spawnMock).toHaveBeenCalledWith('/usr/local/bin/breeze-yarac', ['validate'], expect.any(Object));
    expect(child.stdinText()).toBe(BUNDLE);
  });

  it('honours BREEZE_YARAC_PATH', async () => {
    process.env.BREEZE_YARAC_PATH = '/opt/yarac';
    respond(0, '{"ok":true,"errors":[]}');
    await precheckYaraBundle(BUNDLE);
    expect(spawnMock.mock.calls[0]![0]).toBe('/opt/yarac');
  });

  it('exit 1 with C5 JSON -> per-rule errors parsed', async () => {
    respond(1, JSON.stringify({
      ok: false,
      errors: [
        { ruleId: 'R2', name: 'bad_rule', code: 'compile', message: 'syntax error', line: 3 },
        { ruleId: '', name: '', code: 'cap_rules', message: 'too many rules' },
      ],
    }));
    await expect(precheckYaraBundle(BUNDLE)).resolves.toEqual({
      ok: false,
      errors: [
        { ruleId: 'R2', name: 'bad_rule', code: 'compile', message: 'syntax error', line: 3 },
        { ruleId: '', name: '', code: 'cap_rules', message: 'too many rules' },
      ],
    });
  });

  it('exit 1 with no parseable errors is "unavailable", never a clean pass', async () => {
    respond(1, '{"ok":false,"errors":[]}');
    await expect(precheckYaraBundle(BUNDLE)).resolves.toMatchObject({ ok: false, unavailable: expect.stringContaining('bad_output') });
    respond(1, 'not json');
    await expect(precheckYaraBundle(BUNDLE)).resolves.toMatchObject({ ok: false, unavailable: expect.stringContaining('bad_output') });
  });

  it('exit 0 whose JSON is not ok is "unavailable" (contract mismatch fails closed)', async () => {
    respond(0, '{"ok":false,"errors":[]}');
    await expect(precheckYaraBundle(BUNDLE)).resolves.toMatchObject({ ok: false, unavailable: expect.any(String) });
  });

  it('exit 2 (engine failure / usage) is "unavailable", not a rule error', async () => {
    respond(2, '', 'YARA engine failure: boom');
    await expect(precheckYaraBundle(BUNDLE)).resolves.toMatchObject({
      ok: false, unavailable: expect.stringContaining('exit_2'),
    });
  });

  it('ENOENT (binary missing) -> unavailable', async () => {
    const child = fakeChild();
    spawnMock.mockImplementationOnce(() => {
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    });
    await expect(precheckYaraBundle(BUNDLE)).resolves.toEqual({ ok: false, unavailable: 'ENOENT' });
  });

  it('a synchronous spawn throw -> unavailable', async () => {
    spawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    await expect(precheckYaraBundle(BUNDLE)).resolves.toEqual({ ok: false, unavailable: 'EACCES' });
  });

  it('timeout -> unavailable "timeout" and the child is killed', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnMock.mockImplementationOnce(() => child);
    const p = precheckYaraBundle(BUNDLE);
    await vi.advanceTimersByTimeAsync(YARAC_TIMEOUT_MS + 1);
    vi.useRealTimers();
    await expect(p).resolves.toEqual({ ok: false, unavailable: 'timeout' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('stdout over the cap -> unavailable and the child is killed', async () => {
    const child = fakeChild();
    spawnMock.mockImplementationOnce(() => {
      setImmediate(() => child.stdout.write(Buffer.alloc(YARAC_MAX_STDOUT_BYTES + 1, 0x61)));
      return child;
    });
    await expect(precheckYaraBundle(BUNDLE)).resolves.toEqual({ ok: false, unavailable: 'stdout_too_large' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('runs at most 2 validations concurrently', async () => {
    const children: FakeChild[] = [];
    spawnMock.mockImplementation(() => {
      const c = fakeChild();
      children.push(c);
      return c;
    });
    const all = [precheckYaraBundle(BUNDLE), precheckYaraBundle(BUNDLE), precheckYaraBundle(BUNDLE)];
    await new Promise((r) => setImmediate(r));
    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const c of children.slice(0, 2)) {
      c.stdout.end('{"ok":true,"errors":[]}');
      c.stderr.end();
      c.emit('close', 0, null);
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(spawnMock).toHaveBeenCalledTimes(3);
    const third = children[2]!;
    third.stdout.end('{"ok":true,"errors":[]}');
    third.stderr.end();
    third.emit('close', 0, null);
    await expect(Promise.all(all)).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }]);
  });
});

describe('yaracVersion', () => {
  it('parses `breeze-yarac version` and memoizes a success', async () => {
    respond(0, '{"engine":"yaraxwasm v1.1.0","policy":1,"format":1}\n');
    await expect(yaracVersion()).resolves.toEqual({ engine: 'yaraxwasm v1.1.0', policy: 1 });
    await expect(yaracVersion()).resolves.toEqual({ engine: 'yaraxwasm v1.1.0', policy: 1 });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![1]).toEqual(['version']);
  });

  it('returns null on failure and does not memoize it', async () => {
    respond(2, '', 'nope');
    await expect(yaracVersion()).resolves.toBeNull();
    respond(0, '{"engine":"e","policy":2,"format":1}');
    await expect(yaracVersion()).resolves.toEqual({ engine: 'e', policy: 2 });
  });
});

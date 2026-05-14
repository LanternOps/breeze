import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('runWingetReleaseTest validation', () => {
  it('throws ValidationError for invalid packageId', async () => {
    const mod = await import('./aiPatchTestRunner');
    await expect(
      mod.runWingetReleaseTest({ packageId: '../etc/passwd', version: '1.0.0' })
    ).rejects.toBeInstanceOf(mod.ValidationError);
  });

  it('throws ValidationError for invalid version', async () => {
    const mod = await import('./aiPatchTestRunner');
    await expect(
      mod.runWingetReleaseTest({ packageId: 'Mozilla.Firefox', version: '$(rm -rf /)' })
    ).rejects.toBeInstanceOf(mod.ValidationError);
  });

  it('returns skipped when VM env not configured', async () => {
    const oldTarget = process.env.WIN_TEST_VM_TARGET;
    const oldKey = process.env.WIN_TEST_VM_SSH_KEY;
    delete process.env.WIN_TEST_VM_TARGET;
    delete process.env.WIN_TEST_VM_SSH_KEY;
    try {
      const { runWingetReleaseTest } = await import('./aiPatchTestRunner');
      const result = await runWingetReleaseTest({ packageId: 'Mozilla.Firefox', version: '121.0' });
      expect(result.result).toBe('skipped');
      expect(result.notes).toMatch(/WIN_TEST_VM/);
    } finally {
      if (oldTarget !== undefined) process.env.WIN_TEST_VM_TARGET = oldTarget;
      if (oldKey !== undefined) process.env.WIN_TEST_VM_SSH_KEY = oldKey;
    }
  });
});

// Mock child_process and the Anthropic SDK at the module boundary so we can
// control the outcomes of runOnVm() and analyzeWithClaude() without spinning
// up SSH or hitting Claude.
const mockExecFile = vi.hoisted(() => vi.fn());
const mockMessagesCreate = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    messages = {
      create: mockMessagesCreate,
    };
  }
  return { default: Anthropic };
});

// promisify(execFile) means our mock receives a node-style callback as its
// last argument. Translate that into either an error or a successful
// { stdout, stderr } response.
function execCallback(opts: {
  err?: { code?: number; killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
  stdout?: string;
  stderr?: string;
}) {
  return (..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as (
      err: unknown,
      result?: { stdout: string; stderr: string }
    ) => void;
    if (opts.err) {
      const e = Object.assign(new Error(opts.err.message ?? 'exec failed'), opts.err);
      cb(e);
      return;
    }
    cb(null, { stdout: opts.stdout ?? '', stderr: opts.stderr ?? '' });
  };
}

describe('runWingetReleaseTest outcomes', () => {
  const savedTarget = process.env.WIN_TEST_VM_TARGET;
  const savedKey = process.env.WIN_TEST_VM_SSH_KEY;

  beforeEach(() => {
    mockExecFile.mockReset();
    mockMessagesCreate.mockReset();
    process.env.WIN_TEST_VM_TARGET = 'user@test-vm';
    process.env.WIN_TEST_VM_SSH_KEY = '/tmp/test-key';
  });

  afterEach(() => {
    if (savedTarget !== undefined) process.env.WIN_TEST_VM_TARGET = savedTarget;
    else delete process.env.WIN_TEST_VM_TARGET;
    if (savedKey !== undefined) process.env.WIN_TEST_VM_SSH_KEY = savedKey;
    else delete process.env.WIN_TEST_VM_SSH_KEY;
  });

  it('returns inconclusive on SSH timeout and does not call Claude', async () => {
    mockExecFile.mockImplementation(
      execCallback({ err: { killed: true, signal: 'SIGTERM', message: 'killed' } })
    );

    const { runWingetReleaseTest } = await import('./aiPatchTestRunner');
    const result = await runWingetReleaseTest({ packageId: 'Mozilla.Firefox', version: '121.0' });

    expect(result.result).toBe('inconclusive');
    expect(result.notes).toMatch(/SSH transport failed|timeout/i);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('returns inconclusive when SSH transport fails with no exit code', async () => {
    mockExecFile.mockImplementation(
      execCallback({ err: { message: 'host unreachable' } })
    );

    const { runWingetReleaseTest } = await import('./aiPatchTestRunner');
    const result = await runWingetReleaseTest({ packageId: 'Mozilla.Firefox', version: '121.0' });

    expect(result.result).toBe('inconclusive');
    expect(result.notes).toMatch(/SSH transport failed/i);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('returns fail when winget exits non-zero and does not call Claude', async () => {
    mockExecFile.mockImplementation(
      execCallback({ err: { code: 1, stdout: 'oops', stderr: 'err' } })
    );

    const { runWingetReleaseTest } = await import('./aiPatchTestRunner');
    const result = await runWingetReleaseTest({ packageId: 'Mozilla.Firefox', version: '121.0' });

    expect(result.result).toBe('fail');
    expect(result.notes).toMatch(/winget exit code/i);
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });

  it('returns inconclusive when Claude returns malformed JSON', async () => {
    mockExecFile.mockImplementation(execCallback({ stdout: 'upgrade ok' }));
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'banana' }],
    });

    const { runWingetReleaseTest } = await import('./aiPatchTestRunner');
    const result = await runWingetReleaseTest({ packageId: 'Mozilla.Firefox', version: '121.0' });

    expect(result.result).toBe('inconclusive');
    expect(result.notes).toMatch(/failed to parse|unexpected/i);
  });

  it('returns inconclusive when Claude throws', async () => {
    mockExecFile.mockImplementation(execCallback({ stdout: 'upgrade ok' }));
    mockMessagesCreate.mockRejectedValueOnce(new Error('rate limited'));

    const { runWingetReleaseTest } = await import('./aiPatchTestRunner');
    const result = await runWingetReleaseTest({ packageId: 'Mozilla.Firefox', version: '121.0' });

    expect(result.result).toBe('inconclusive');
    expect(result.notes).toMatch(/Claude analysis failed/i);
  });
});

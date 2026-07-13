import { describe, expect, it } from 'vitest';
import { commandAuditDetails, sanitizeCommandForHistory } from './commandAudit';

describe('commandAudit', () => {
  it('redacts file-write content while preserving metadata', () => {
    const details = commandAuditDetails('cmd-1', 'file_write', {
      path: '/tmp/secret.txt',
      encoding: 'utf8',
      content: 'super-secret-file-body',
    });

    expect(details).toMatchObject({
      commandId: 'cmd-1',
      type: 'file_write',
      payload: {
        path: '/tmp/secret.txt',
        encoding: 'utf8',
        content: {
          redacted: true,
          length: 22,
          sizeBytes: 22,
        },
      },
    });
    expect(JSON.stringify(details)).not.toContain('super-secret-file-body');
  });

  it('redacts script bodies and secret parameters', () => {
    const details = commandAuditDetails('cmd-2', 'script', {
      scriptId: 'script-1',
      executionId: 'exec-1',
      content: 'Write-Host $env:TOKEN',
      parameters: {
        username: 'alice',
        password: 'hunter2',
      },
      runAs: 'system',
    });

    expect(details).toMatchObject({
      payload: {
        scriptId: 'script-1',
        executionId: 'exec-1',
        content: {
          redacted: true,
          length: 21,
        },
        parameters: {
          username: 'alice',
          password: '[REDACTED]',
        },
        runAs: 'system',
      },
    });
    expect(JSON.stringify(details)).not.toContain('Write-Host');
    expect(JSON.stringify(details)).not.toContain('hunter2');
  });

  it('sanitizes command history payload and output fields', () => {
    const command = sanitizeCommandForHistory({
      id: 'cmd-3',
      type: 'script',
      payload: { content: 'echo secret', parameters: { token: 'abc123' } },
      result: { status: 'completed', stdout: 'token=abc123', stderr: 'password=hunter2' },
    });

    expect(JSON.stringify(command)).not.toContain('echo secret');
    expect(JSON.stringify(command)).not.toContain('abc123');
    expect(JSON.stringify(command)).not.toContain('hunter2');
    expect(command.result).toMatchObject({
      stdout: '[REDACTED]: stdout omitted from command history',
      stderr: '[REDACTED]: stderr omitted from command history',
    });
  });

  describe('capture_pprof raw stdout pass-through (#2401)', () => {
    const pprofStdout = JSON.stringify({
      capturedAt: '2026-07-12T10:00:00Z',
      heapProfileBase64: 'aGVhcC1wcm9maWxlLWJ5dGVz',
      heapProfileBytes: 2048,
    });

    it('keeps capture_pprof stdout when allowRawStdout is set (single-command GET)', () => {
      const command = sanitizeCommandForHistory(
        {
          id: 'cmd-4',
          type: 'capture_pprof',
          payload: { profile: 'heap' },
          result: { status: 'completed', stdout: pprofStdout, stderr: 'noise' },
        },
        { allowRawStdout: true },
      );

      expect((command.result as { stdout: string }).stdout).toBe(pprofStdout);
      // stderr is never passed through, even for allowlisted types.
      expect((command.result as { stderr: string }).stderr).toContain('stderr omitted');
    });

    it('still redacts capture_pprof stdout without the opt-in (list endpoints)', () => {
      const command = sanitizeCommandForHistory({
        id: 'cmd-5',
        type: 'capture_pprof',
        payload: { profile: 'heap' },
        result: { status: 'completed', stdout: pprofStdout },
      });

      expect((command.result as { stdout: string }).stdout).toContain('stdout omitted');
      expect(JSON.stringify(command)).not.toContain('aGVhcC1wcm9maWxlLWJ5dGVz');
    });

    it('never passes through stdout for non-allowlisted command types, even with the opt-in', () => {
      const command = sanitizeCommandForHistory(
        {
          id: 'cmd-6',
          type: 'script',
          payload: { content: 'echo secret' },
          result: { status: 'completed', stdout: 'token=abc123' },
        },
        { allowRawStdout: true },
      );

      expect((command.result as { stdout: string }).stdout).toContain('stdout omitted');
      expect(JSON.stringify(command)).not.toContain('abc123');
    });
  });
});

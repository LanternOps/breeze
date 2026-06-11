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
});

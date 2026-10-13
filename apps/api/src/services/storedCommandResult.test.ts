import { describe, it, expect } from 'vitest';
import { buildStoredCommandResult } from './storedCommandResult';

describe('buildStoredCommandResult', () => {
  it('persists the agent errorCode so executeCommand can hand it to the classifier (#4026)', () => {
    // device_commands.result is built field-by-field. A field left out here
    // never reaches waitForCommandResult → executeCommand → classifyCommandFailure,
    // and the API silently keeps classifying by prose even for agents that send
    // the typed code.
    const stored = buildStoredCommandResult(
      'file_read',
      { status: 'failed', exitCode: 1, error: 'path does not exist: /nope', errorCode: 'path_not_found' },
      undefined,
    );
    expect(stored.errorCode).toBe('path_not_found');
    expect(stored.error).toBe('path does not exist: /nope');
  });

  it('leaves errorCode absent for agents that predate it', () => {
    const stored = buildStoredCommandResult('file_read', { status: 'failed', error: 'boom' }, undefined);
    expect(stored.errorCode).toBeUndefined();
    expect('errorCode' in stored && stored.errorCode !== undefined).toBe(false);
  });

  it('keeps the existing redaction and timeout-collapse behaviour', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
    const stored = buildStoredCommandResult('script', { status: 'timeout', stderr: pem }, `out ${pem}`);
    expect(stored.status).not.toBe('timeout');
    expect(stored.error).toBe('Agent reported a timeout');
    expect(stored.stderr).not.toContain('MIIabc');
    expect(stored.stdout).not.toContain('MIIabc');
  });
});

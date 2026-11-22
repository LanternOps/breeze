import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

describe('buildStoredCommandResult installer secrecy (#8170)', () => {
  const FILE_NAME = 'setupdownloader_[aHR0cHM6Ly9leGFtcGxlLnRlc3Q=-synthetic].exe';
  const leak = `fork/exec C:\\Temp\\${FILE_NAME}: denied`;
  const scrubbed = 'fork/exec C:\\Temp\\[installer]: denied';
  const result = { status: 'failed', exitCode: 1, stderr: leak, error: leak } as never;

  it('a framework provider install stores no file name in stdout, stderr or error', () => {
    const stored = buildStoredCommandResult('software_install', result, leak, {
      integrationProvider: 'bitdefender', fileName: FILE_NAME,
    });
    expect(stored).toMatchObject({ stdout: scrubbed, stderr: scrubbed, error: scrubbed });
  });

  it('any other payload stores the text unchanged', () => {
    const stored = buildStoredCommandResult('software_install', result, leak, { fileName: FILE_NAME });
    expect(stored).toMatchObject({ stdout: leak, stderr: leak, error: leak });
  });

  it('no payload argument stores the text unchanged', () => {
    expect(buildStoredCommandResult('software_install', result, leak)).toMatchObject({ stdout: leak, error: leak });
  });
});

describe('both result-ingest routes hand the command payload to buildStoredCommandResult (#8170)', () => {
  it.each(['../routes/agentWs.ts', '../routes/agents/commands.ts'])('%s', (file) => {
    const source = readFileSync(join(__dirname, file), 'utf8');
    const calls = source.match(/buildStoredCommandResult\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/,\s*command\.payload\s*\)$/);
  });
});


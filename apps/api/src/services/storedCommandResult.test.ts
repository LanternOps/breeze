import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { buildStoredCommandResult } from './storedCommandResult';
import { redactSecretsFromOutput } from './secretRedaction';

// Passthrough spy: every test runs the real redactor; one test overrides a
// single call to reach a fail-closed branch no real input is known to reach.
vi.mock('./secretRedaction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secretRedaction')>();
  return { ...actual, redactSecretsFromOutput: vi.fn(actual.redactSecretsFromOutput) };
});

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

describe('buildStoredCommandResult screenshot image payloads (#12795)', () => {
  // A deterministic JPEG-shaped payload whose base64 text contains a full
  // `AKIA` + 16 [0-9A-Z] run: SOI + APP0 marker, 15 arbitrary bytes, 3 zero
  // bytes, EOI. Every SECRET_OUTPUT_REDACTIONS rule is unanchored, so before
  // the fix the AWS rule rewrote the middle of this string.
  const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
  const IMAGE = '/9j/4AAQ' + AWS_KEY + 'AAAA' + '/9k=';

  function screenshot(overrides: Record<string, unknown> = {}) {
    return {
      imageBase64: IMAGE, width: 4, height: 4, format: 'jpeg', sizeBytes: 29, monitor: 0,
      capturedAt: '2026-11-27T00:00:00Z', ...overrides,
    };
  }
  const completed = { status: 'completed', exitCode: 0 } as never;
  const storedText = (type: string, stdout: string) =>
    buildStoredCommandResult(type, completed, stdout).stdout as string;
  const storedJson = (type: string, value: unknown) => JSON.parse(storedText(type, JSON.stringify(value)));

  it('fixture sanity: the image is a canonical JPEG whose text matches the AWS rule', () => {
    const bytes = Buffer.from(IMAGE, 'base64');
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(bytes.toString('base64')).toBe(IMAGE);
    expect(IMAGE).toMatch(/AKIA[0-9A-Z]{16}/i);
  });

  it('take_screenshot: the image comes back byte-identical', () => {
    expect(storedJson('take_screenshot', screenshot()).imageBase64).toBe(IMAGE);
  });

  it('computer_action: the nested screenshot image comes back byte-identical', () => {
    const stored = storedJson('computer_action', { actionExecuted: 'left_click', screenshot: screenshot() });
    expect(stored.screenshot.imageBase64).toBe(IMAGE);
  });

  it('a secret in a text field of the same result is still redacted', () => {
    const shot = storedJson('take_screenshot', screenshot({ capturedAt: `password=hunter2hunter2 ${AWS_KEY}` }));
    expect(shot.imageBase64).toBe(IMAGE);
    expect(shot.capturedAt).toBe('password=[REDACTED] [AWS_KEY_REDACTED]');

    const action = storedJson('computer_action', {
      actionExecuted: 'type',
      error: `Bearer abc.def.ghi ${AWS_KEY}`,
      screenshotError: `token: ${'x'.repeat(12)} (retry)`,
      screenshot: screenshot({ format: AWS_KEY }),
    });
    expect(action.screenshot.imageBase64).toBe(IMAGE);
    expect(action.error).toBe('Bearer [TOKEN_REDACTED] [AWS_KEY_REDACTED]');
    expect(action.screenshotError).toBe('token=[REDACTED] (retry)');
    expect(action.screenshot.format).toBe('[AWS_KEY_REDACTED]');
  });

  it('a base64-looking secret in a text field is still redacted (exempt by field, not by shape)', () => {
    // The very same JPEG-shaped string, placed in a text field, is text.
    const shot = storedJson('take_screenshot', screenshot({ capturedAt: IMAGE }));
    expect(shot.imageBase64).toBe(IMAGE);
    expect(shot.capturedAt).not.toContain(AWS_KEY);
    expect(shot.capturedAt).toContain('[AWS_KEY_REDACTED]');
  });

  it.each([
    ['valid base64 that is not an image', AWS_KEY],
    ['not base64 at all', `not base64! ${AWS_KEY} and more`],
    ['a JPEG start marker without the end marker', '/9j/4AAQ' + AWS_KEY + 'AAAA'],
    ['non-canonical base64 (padding bits set)', '/9j/4AAQ' + AWS_KEY + 'AAAA' + '/9l='],
    ['JPEG base64 with whitespace in the text', '/9j/4AAQ ' + AWS_KEY + 'AAAA/9k='],
  ])('the image field is NOT exempt when it holds %s', (_label, value) => {
    const shot = storedJson('take_screenshot', screenshot({ imageBase64: value }));
    expect(shot.imageBase64).not.toContain(AWS_KEY);
    expect(shot.imageBase64).toContain('[AWS_KEY_REDACTED]');
  });

  it('a non-string image field is redacted as text', () => {
    expect(storedText('take_screenshot', JSON.stringify({ imageBase64: { nested: AWS_KEY } })))
      .toBe('{"imageBase64":{"nested":"[AWS_KEY_REDACTED]"}}');
  });

  it('a duplicate image key cannot carry text past the exemption', () => {
    // JSON.parse keeps the last duplicate; the stored text is re-serialized
    // from the parsed value, so the first (text) value is never persisted raw.
    const stored = storedText('take_screenshot', `{"imageBase64":"password=${AWS_KEY}","imageBase64":"${IMAGE}","width":4}`);
    expect(stored).not.toContain(`password=${AWS_KEY}`);
    expect(JSON.parse(stored).imageBase64).toBe(IMAGE);
  });

  it('only the typed result of an image command type is exempt', () => {
    // Same JSON from a script, or the image at a path the type does not define.
    const redactedImage = '/9j/4AAQ[AWS_KEY_REDACTED]AAAA/9k=';
    expect(storedJson('script', screenshot()).imageBase64).toBe(redactedImage);
    expect(storedJson('computer_action', screenshot()).imageBase64).toBe(redactedImage);
    expect(storedJson('take_screenshot', { screenshot: screenshot() }).screenshot.imageBase64).toBe(redactedImage);
  });

  it('nesting too deep to re-serialize falls back to the text pass instead of failing the ingest', () => {
    // JSON.parse accepts nesting that JSON.stringify refuses (RangeError).
    const depth = 200_000;
    const stdout = `{"imageBase64":"${IMAGE}","capturedAt":"${AWS_KEY}","x":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    expect(() => JSON.stringify(JSON.parse(stdout))).toThrow(RangeError);
    const stored = storedText('take_screenshot', stdout);
    expect(stored).not.toContain(AWS_KEY);
    expect(stored).toBe(redactSecretsFromOutput(stdout));
  });

  it('when redaction leaves valid JSON but changes the image field, the image is not re-attached', () => {
    vi.mocked(redactSecretsFromOutput).mockImplementationOnce(() => '{"imageBase64":"[REDACTED]","width":4}');
    const stored = storedText('take_screenshot', JSON.stringify(screenshot()));
    expect(stored).toBe('{"imageBase64":"[REDACTED]","width":4}');
  });

  it('the exempt field paths match the agent result types', () => {
    // A rename on either side would silently bring back the corruption (or
    // move the exemption onto a field that no longer carries the image).
    const types = readFileSync(join(__dirname, '../../../../agent/internal/remote/tools/types.go'), 'utf8');
    const struct = (name: string) => types.match(new RegExp(`type ${name} struct \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
    expect(struct('ScreenshotResponse')).toMatch(/ImageBase64\s+string\s+`json:"imageBase64"`/);
    expect(struct('ComputerActionResponse')).toMatch(/Screenshot\s+\*ScreenshotResponse\s+`json:"screenshot,omitempty"`/);
  });

  it.each([
    // The connection-string rule eats to the next whitespace, through the
    // closing quote and the rest of the JSON.
    ['a connection string', { capturedAt: 'redis://user:pw@host', imageBase64: IMAGE }, 'user:pw'],
    // The secret-pair rule's optional trailing quote eats the value's closing quote.
    ['a secret pair ending a value', { capturedAt: `token: ${'y'.repeat(12)}`, imageBase64: IMAGE }, 'y'.repeat(12)],
  ])('when text redaction of %s breaks the JSON, the image is dropped and the text stays redacted', (_label, value, secret) => {
    const stored = storedText('take_screenshot', JSON.stringify(value));
    expect(() => JSON.parse(stored)).toThrow();
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(IMAGE);
    expect(stored).not.toContain(AWS_KEY);
  });

  it('non-JSON stdout of an image command type is redacted as today', () => {
    expect(storedText('take_screenshot', `oops ${AWS_KEY}`)).toBe('oops [AWS_KEY_REDACTED]');
  });
});


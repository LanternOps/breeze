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
    // A JPEG-shaped string in a text field is text. (The same string as the
    // image field's value is two copies of the image: see the next block.)
    const other = '/9j/4AAQ' + AWS_KEY + 'BBBB' + '/9k=';
    const shot = storedJson('take_screenshot', screenshot({ capturedAt: other }));
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
    // JSON.parse keeps the last duplicate; the first (text) value stays in the
    // original text and gets the whole-text pass with everything else.
    const stored = storedText('take_screenshot', `{"imageBase64":"note ${AWS_KEY}","imageBase64":"${IMAGE}","width":4}`);
    expect(stored).toBe(`{"imageBase64":"note [AWS_KEY_REDACTED]","imageBase64":"${IMAGE}","width":4}`);
    expect(JSON.parse(stored).imageBase64).toBe(IMAGE);
  });

  it('only the typed result of an image command type is exempt', () => {
    // Same JSON from a script, or the image at a path the type does not define.
    const redactedImage = '/9j/4AAQ[AWS_KEY_REDACTED]AAAA/9k=';
    expect(storedJson('script', screenshot()).imageBase64).toBe(redactedImage);
    expect(storedJson('computer_action', screenshot()).imageBase64).toBe(redactedImage);
    expect(storedJson('take_screenshot', { screenshot: screenshot() }).screenshot.imageBase64).toBe(redactedImage);
  });

  it('nesting too deep to re-serialize is fine: nothing is re-serialized', () => {
    // JSON.parse accepts nesting that JSON.stringify refuses (RangeError).
    const depth = 200_000;
    const stdout = `{"imageBase64":"${IMAGE}","capturedAt":"${AWS_KEY}","x":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    expect(() => JSON.stringify(JSON.parse(stdout))).toThrow(RangeError);
    const stored = storedText('take_screenshot', stdout);
    expect(stored).toBe(`{"imageBase64":"${IMAGE}","capturedAt":"[AWS_KEY_REDACTED]","x":${'['.repeat(depth)}${']'.repeat(depth)}}`);
  });

  it('any throw while keeping the image falls back to the text pass over the original stdout', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(redactSecretsFromOutput).mockImplementationOnce(() => { throw new RangeError('boom'); });
      const stdout = JSON.stringify(screenshot({ capturedAt: AWS_KEY }));
      const stored = storedText('take_screenshot', stdout);
      expect(stored).not.toContain(AWS_KEY);
      expect(stored).toContain('[AWS_KEY_REDACTED]');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be processed'));
    } finally {
      warn.mockRestore();
    }
  });

  it('when redaction leaves valid JSON but changes the image field, the image is not re-attached', () => {
    vi.mocked(redactSecretsFromOutput).mockImplementationOnce(() => '{"imageBase64":"[REDACTED]","width":4}');
    const stored = storedText('take_screenshot', JSON.stringify(screenshot()));
    expect(stored).toBe('{"imageBase64":"[REDACTED]","width":4}');
  });

  it.each([
    // Depends on text on both sides of the cut: the sides redacted apart
    // differ from the whole, so where the cut lands is not known.
    [
      'depends on text across the cut',
      (t: string) => (t.includes('"note"') && t.includes('"width"') ? t.replace('"width":4', '"width":5') : t),
      'spans the image field',
    ],
    // Consistent on both sides of the cut, so only the later checks catch these.
    ['removes the quote that opens the image value', (t: string) => t.replace('"imageBase64":"', '"imageBase64":'), 'changed the image field'],
    ['renames the image key', (t: string) => t.replace('"imageBase64"', '"imageBase65"'), 'changed the result structure'],
  ])('when redaction %s, the image is dropped and the redacted text is stored', async (_label, rewrite, why) => {
    const actual = await vi.importActual<typeof import('./secretRedaction')>('./secretRedaction');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(redactSecretsFromOutput).mockImplementation((t: string) => rewrite(actual.redactSecretsFromOutput(t)));
    try {
      const stdout = JSON.stringify({ note: 'x', ...screenshot({ capturedAt: AWS_KEY }) });
      const blanked = stdout.replace(IMAGE, '');
      const stored = storedText('take_screenshot', stdout);
      expect(stored).toBe(rewrite(actual.redactSecretsFromOutput(blanked)));
      expect(stored).not.toContain(IMAGE);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(why));
    } finally {
      vi.mocked(redactSecretsFromOutput).mockImplementation(actual.redactSecretsFromOutput);
      warn.mockRestore();
    }
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

describe('buildStoredCommandResult screenshots: redaction runs on the original text (#12795)', () => {
  const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
  // JPEG-shaped (SOI ... EOI), canonical base64, and its text matches the AWS rule.
  const IMAGE = '/9j/4AAQ' + AWS_KEY + 'AAAA' + '/9k=';
  // A second canonical JPEG envelope whose text matches no rule.
  const PLAIN_IMAGE = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]).toString('base64');
  const completed = { status: 'completed', exitCode: 0 } as never;
  const storedText = (type: string, stdout: string) =>
    buildStoredCommandResult(type, completed, stdout).stdout as string;

  /** stdout with the one quoted copy of `image` emptied: the text the redaction pass must see. */
  function blank(stdout: string, image: string): string {
    const at = stdout.indexOf(`"${image}"`);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(stdout.indexOf(`"${image}"`, at + 1)).toBe(-1);
    return stdout.slice(0, at + 1) + stdout.slice(at + 1 + image.length);
  }
  /** stored with its re-attached image emptied again (or stored itself when the image was dropped). */
  function storedWithoutImage(stored: string, image: string): { text: string; kept: boolean } {
    const at = stored.indexOf(`"${image}"`);
    if (at < 0) return { text: stored, kept: false };
    return { text: stored.slice(0, at + 1) + stored.slice(at + 1 + image.length), kept: true };
  }

  it('a private key split by number-like keys is redacted as it is in the original order', () => {
    // JSON.parse moves integer-like keys first; the original text keeps the
    // body between BEGIN and END, so the whole-text pass removes it.
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
    const stdout = `{"a":"-----BEGIN PRIVATE KEY-----","1":"${body}","c":"-----END PRIVATE KEY-----","imageBase64":"${IMAGE}"}`;
    expect(redactSecretsFromOutput(stdout)).not.toContain(body);
    const stored = storedText('take_screenshot', stdout);
    expect(stored).not.toContain(body);
    expect(JSON.parse(stored).imageBase64).toBe(IMAGE);
    expect(storedWithoutImage(stored, IMAGE).text).toBe(redactSecretsFromOutput(blank(stdout, IMAGE)));
  });

  it('a token written with escapes is redacted as it is in the original text', () => {
    // Decoding the escape joins the token into one longer run, which the
    // token rule would end one segment early; the original text is redacted.
    const stdout = `{"title":"eyJa\\u002eeyJb.eyJc.SIG","imageBase64":"${IMAGE}"}`;
    expect(redactSecretsFromOutput(stdout)).not.toContain('SIG');
    const stored = storedText('take_screenshot', stdout);
    expect(stored).not.toContain('SIG');
    expect(JSON.parse(stored).imageBase64).toBe(IMAGE);
  });

  it('computer_action: a private key split by number-like keys inside screenshot is redacted', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
    const stdout = `{"actionExecuted":"left_click","screenshot":{"a":"-----BEGIN PRIVATE KEY-----","1":"${body}","c":"-----END PRIVATE KEY-----","imageBase64":"${IMAGE}"}}`;
    const stored = storedText('computer_action', stdout);
    expect(stored).not.toContain(body);
    expect(JSON.parse(stored).screenshot.imageBase64).toBe(IMAGE);
  });

  it('the stored non-image text equals the text pass over the blanked original (generated results)', () => {
    // Seeded PRNG: the same 600 results on every run.
    let seed = 12795;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    // Raw JSON string content: each fragment is complete on its own (escapes included).
    const FRAGMENTS = [
      AWS_KEY, 'akiaiosfodnn7example', 'AKIA\\u0049OSFODNN7EXAMPLE', '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----',
      'MIIBVgIBADANBgkq', 'eyJhbGci', 'eyJzdWIi', '.', '\\u002e', '\\/', '\\\\', '\\"', 'Bearer ', 'bearer\\t',
      'redis://u:p@h', 'redis:\\/\\/u:p@h', 'password=', 'token: ', 'hunter2hunter2', ' ', '\\n', 'x', '7', ',', ':', '{', '}',
    ];
    const KEYS = ['a', '1', 'c', 'note', '10', 'title', '2', 'format'];
    const SECRETS = [AWS_KEY, 'MIIBVgIBADANBgkq', 'hunter2hunter2', 'eyJzdWIi', 'u:p@h'];
    const text = () => Array.from({ length: 1 + Math.floor(rand() * 6) }, () => pick(FRAGMENTS)).join('');
    const sep = () => pick([',', ', ', ',\n', ' ,']);
    const fields = (image: string) => {
      const out = Array.from({ length: Math.floor(rand() * 5) }, () =>
        rand() < 0.15 ? `"${pick(KEYS)}":${Math.floor(rand() * 100)}` : `"${pick(KEYS)}":"${text()}"`);
      out.splice(Math.floor(rand() * (out.length + 1)), 0, `"imageBase64":"${image}"`);
      return out.join(sep());
    };
    const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    let kept = 0;
    let dropped = 0;
    for (let i = 0; i < 600; i++) {
      const image = pick([IMAGE, PLAIN_IMAGE]);
      const nested = rand() < 0.5;
      const type = nested ? 'computer_action' : 'take_screenshot';
      const stdout = nested
        ? `{"actionExecuted":"${text()}"${sep()}"screenshot":{${fields(image)}}${sep()}"error":"${text()}"}`
        : `{${fields(image)}}`;
      expect(() => JSON.parse(stdout), stdout).not.toThrow();

      const stored = storedText(type, stdout);
      const { text: rest, kept: wasKept } = storedWithoutImage(stored, image);
      expect(rest, stdout).toBe(redactSecretsFromOutput(blank(stdout, image)));
      // Nothing the plain text pass removes from the original survives outside the image.
      const plain = redactSecretsFromOutput(stdout);
      for (const secret of SECRETS) {
        expect(count(rest, secret), `${secret} in ${stdout}`).toBeLessThanOrEqual(count(plain, secret));
      }
      if (wasKept) {
        kept++;
        const parsed = JSON.parse(stored);
        expect((nested ? parsed.screenshot : parsed).imageBase64).toBe(image);
      } else {
        dropped++;
      }
    }
    // Not vacuous: both outcomes occur.
    expect(kept).toBeGreaterThan(100);
    expect(dropped).toBeGreaterThan(10);
  });

  it('there is no placeholder to forge: empty strings elsewhere in the result cannot take the image', () => {
    const stdout = `{"note":"","title":"${AWS_KEY}","imageBase64":"${IMAGE}","format":""}`;
    const stored = storedText('take_screenshot', stdout);
    expect(stored).toBe(`{"note":"","title":"[AWS_KEY_REDACTED]","imageBase64":"${IMAGE}","format":""}`);
  });

  it.each([
    ['before', `{"note":"${IMAGE}","imageBase64":"${IMAGE}"}`],
    ['after', `{"imageBase64":"${IMAGE}","note":"${IMAGE}"}`],
  ])('the image text also present as a text field value %s it is redacted as text there', (_label, stdout) => {
    // Two quoted copies: the image cannot be located unambiguously, so the
    // whole result takes the plain text pass.
    const stored = storedText('take_screenshot', stdout);
    expect(JSON.parse(stored).note).not.toContain(AWS_KEY);
    expect(stored).toBe(redactSecretsFromOutput(stdout));
  });

  it('the image text embedded inside a text field is redacted there while the image field is kept', () => {
    const stdout = `{"note":"see ${IMAGE} here","imageBase64":"${IMAGE}"}`;
    const stored = JSON.parse(storedText('take_screenshot', stdout));
    expect(stored.imageBase64).toBe(IMAGE);
    expect(stored.note).toBe('see /9j/4AAQ[AWS_KEY_REDACTED]AAAA/9k= here');
  });

  it('an escaped image that only decodes to the JPEG is redacted as text', () => {
    // The image cannot be found verbatim in the original text.
    const stdout = `{"imageBase64":"\\/9j\\/4AAQ${AWS_KEY}AAAA\\/9k="}`;
    expect(JSON.parse(stdout).imageBase64).toBe(IMAGE);
    expect(storedText('take_screenshot', stdout)).toBe(redactSecretsFromOutput(stdout));
  });

  it('a verbatim copy in an earlier duplicate key is redacted as text when a later escaped copy wins', () => {
    const stdout = `{"imageBase64":"${IMAGE}","imageBase64":"\\/9j\\/4AAQ${AWS_KEY}AAAA\\/9k="}`;
    expect(storedText('take_screenshot', stdout)).toBe(redactSecretsFromOutput(stdout));
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'command type %s takes the plain text pass without reaching the image logic',
    (type) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const stdout = JSON.stringify({ imageBase64: IMAGE });
        expect(storedText(type, stdout)).toBe(redactSecretsFromOutput(stdout));
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each([
    ['bytes before the JPEG start marker', JSON.stringify({ imageBase64: 'AAAA' + IMAGE })],
    ['the URL-safe base64 alphabet', JSON.stringify({ imageBase64: IMAGE.replaceAll('/', '_').replaceAll('+', '-') })],
    ['missing padding', JSON.stringify({ imageBase64: IMAGE.replace(/=+$/, '') })],
    ['an array as the JSON root', JSON.stringify([{ imageBase64: IMAGE }])],
    ['a __proto__ key holding the image', `{"__proto__":"${IMAGE}"}`],
    ['a __proto__ key holding the image object', `{"__proto__":{"imageBase64":"${IMAGE}"}}`],
  ])('take_screenshot is NOT exempt for %s', (_label, stdout) => {
    expect(stdout).toContain(AWS_KEY);
    const stored = storedText('take_screenshot', stdout);
    expect(stored).toBe(redactSecretsFromOutput(stdout));
    expect(stored).not.toContain(AWS_KEY);
  });

  it.each([
    ['a __proto__ key holding the screenshot', `{"__proto__":{"imageBase64":"${IMAGE}"}}`],
    ['the image under __proto__ inside screenshot', `{"screenshot":{"__proto__":{"imageBase64":"${IMAGE}"}}}`],
    ['an array as the JSON root', JSON.stringify([{ screenshot: { imageBase64: IMAGE } }])],
  ])('computer_action is NOT exempt for %s', (_label, stdout) => {
    const stored = storedText('computer_action', stdout);
    expect(stored).toBe(redactSecretsFromOutput(stdout));
    expect(stored).not.toContain(AWS_KEY);
  });
});


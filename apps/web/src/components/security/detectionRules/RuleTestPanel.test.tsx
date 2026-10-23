import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { YARA_TEST_SAMPLE_MAX_BYTES } from '@breeze/shared';

const { fetchWithAuth, showToast } = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), showToast: vi.fn() }));

vi.mock('@/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth,
}));
vi.mock('../../shared/Toast', () => ({ showToast }));

import RuleTestPanel from './RuleTestPanel';

const json = (status: number, payload: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

const RESULT = {
  sha256: 'f'.repeat(64),
  size: 12,
  filename: 'marker.txt',
  filepath: 'marker.txt',
  durationMs: 420,
  testedVersion: 3,
  publishedVersion: 3,
  testedDigest: 'e'.repeat(64),
  matches: [
    {
      ruleId: 'r1',
      ruleName: 'ioc_advisory_string_abc',
      severity: 'high',
      tags: ['ioc', 'string'],
      matchedStrings: [{ id: '$i0', offset: 7, data: 'MARKER\\x00' }],
    },
  ],
};

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function pick(file: File) {
  fireEvent.change(screen.getByTestId('rule-test-file'), { target: { files: [file] } });
}

async function runWith(response: Response, file = new File(['hello MARKER'], 'marker.txt')) {
  fetchWithAuth.mockResolvedValue(response);
  render(<RuleTestPanel setId="set-1" />);
  pick(file);
  fireEvent.click(screen.getByTestId('rule-test-run'));
  await settle();
}

const errorText = () => screen.getByTestId('rule-test-error').textContent ?? '';

describe('RuleTestPanel (W04-2, D1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says the file is scanned on the Breeze server and not stored', () => {
    render(<RuleTestPanel setId="set-1" />);
    expect(screen.getByTestId('rule-test-privacy').textContent).toMatch(/Breeze server/);
    expect(screen.getByTestId('rule-test-privacy').textContent).toMatch(/not stored/);
  });

  it('a file over 10 MiB shows the size error and sends nothing', () => {
    render(<RuleTestPanel setId="set-1" />);
    const big = new File(['x'], 'big.bin');
    Object.defineProperty(big, 'size', { value: YARA_TEST_SAMPLE_MAX_BYTES + 1 });
    pick(big);

    expect(errorText()).toMatch(/10 MB/);
    expect((screen.getByTestId('rule-test-run') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('rule-test-run'));
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('POSTs the raw file as octet-stream with filename and filepath query params, and toasts no success', async () => {
    fetchWithAuth.mockResolvedValue(json(200, { data: RESULT }));
    render(<RuleTestPanel setId="set-1" />);
    const file = new File(['hello MARKER'], 'marker.txt');
    pick(file);
    fireEvent.change(screen.getByTestId('rule-test-filepath'), { target: { value: 'C:\\Users\\Public\\marker.txt' } });
    fireEvent.click(screen.getByTestId('rule-test-run'));
    await settle();

    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url, 'http://x');
    expect(parsed.pathname).toBe('/security/yara/rule-sets/set-1/test');
    expect(parsed.searchParams.get('filename')).toBe('marker.txt');
    expect(parsed.searchParams.get('filepath')).toBe('C:\\Users\\Public\\marker.txt');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(file);
    expect(init.body instanceof FormData).toBe(false);
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/octet-stream');
    // Trap 1: the test carries its own long timeout instead of fetchWithAuth's 30 s default.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a 200 renders each match with tags and matched strings as text', async () => {
    await runWith(json(200, { data: RESULT }));

    const row = screen.getByTestId('rule-test-match-ioc_advisory_string_abc');
    expect(row.textContent).toContain('ioc');
    expect(row.textContent).toContain('string');
    // Agent-escaped data is rendered verbatim, never re-escaped.
    expect(row.textContent).toContain('MARKER\\x00');
    expect(row.textContent).not.toContain('MARKER\\\\x00');
    expect(screen.getByTestId('rule-test-header').textContent).toMatch(/version 3/);
    expect(screen.queryByTestId('rule-test-unpublished')).toBeNull();
  });

  it('an empty match list says no rules matched', async () => {
    await runWith(json(200, { data: { ...RESULT, matches: [] } }));
    expect(screen.getByTestId('rule-test-no-matches')).toBeInTheDocument();
  });

  it('testing a draft that is not the published version says so', async () => {
    await runWith(json(200, { data: { ...RESULT, testedVersion: 5, publishedVersion: 3 } }));
    expect(screen.getByTestId('rule-test-unpublished').textContent).toMatch(/Testing your unpublished changes/);
  });

  it('413 YARA_TEST_TOO_LARGE shows the size copy', async () => {
    await runWith(json(413, { error: 'raw', code: 'YARA_TEST_TOO_LARGE' }));
    expect(errorText()).toMatch(/10 MB/);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('413 from the body limit (no code) shows the same size copy', async () => {
    await runWith(json(413, { error: 'File too large (max 10 MB)' }));
    expect(errorText()).toMatch(/10 MB/);
  });

  it('429 YARA_TEST_BUSY says another test is running', async () => {
    await runWith(json(429, { error: 'raw', code: 'YARA_TEST_BUSY' }));
    expect(errorText()).toMatch(/Another test is running/);
  });

  it('429 with no code is the per-user rate limit, not "busy"', async () => {
    await runWith(json(429, { error: 'Rate limit exceeded', retryAfter: 120 }));
    expect(errorText()).toMatch(/too many tests/i);
    expect(errorText()).not.toMatch(/Another test is running/);
  });

  it('503 YARA_TEST_UNAVAILABLE says the checker is unavailable and stays usable', async () => {
    await runWith(json(503, { error: 'raw', code: 'YARA_TEST_UNAVAILABLE' }));
    expect(errorText()).toMatch(/checker is unavailable/);
    expect(screen.queryByTestId('rule-test-disabled')).toBeNull();
    expect((screen.getByTestId('rule-test-file') as HTMLInputElement).disabled).toBe(false);
  });

  it('503 YARA_TEST_SANDBOX_UNAVAILABLE disables the panel', async () => {
    await runWith(json(503, { error: 'raw', code: 'YARA_TEST_SANDBOX_UNAVAILABLE' }));
    expect(screen.getByTestId('rule-test-disabled').textContent).toMatch(/File tests are not available on this server/);
    expect((screen.getByTestId('rule-test-file') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('rule-test-run') as HTMLButtonElement).disabled).toBe(true);
  });

  it('422 YARA_TEST_NO_RULES says the set has no enabled rules', async () => {
    await runWith(json(422, { error: 'raw', code: 'YARA_TEST_NO_RULES' }));
    expect(errorText()).toMatch(/no enabled rules to test/);
  });

  it('422 YARA_TEST_COMPILE_FAILED lists the compile errors', async () => {
    await runWith(
      json(422, {
        error: 'raw',
        code: 'YARA_TEST_COMPILE_FAILED',
        errors: [{ ruleId: 'r1', name: 'bad_rule', code: 'E009', message: 'unknown identifier', line: 4 }],
      }),
    );
    expect(errorText()).toMatch(/does not compile/);
    expect(screen.getByTestId('rule-test-compile-error-0').textContent).toContain('bad_rule');
    expect(screen.getByTestId('rule-test-compile-error-0').textContent).toContain('unknown identifier');
  });

  it('a 422 with an unknown code is not reported as "no enabled rules"', async () => {
    await runWith(json(422, { error: 'raw', code: 'SOMETHING_NEW' }));
    expect(errorText()).not.toMatch(/no enabled rules/);
    expect(errorText()).toMatch(/did not finish|could not/i);
  });

  it('a 200 without a result renders an error, never a blank panel', async () => {
    await runWith(json(200, { ok: true }));
    expect(screen.queryByTestId('rule-test-result')).toBeNull();
    expect(errorText()).toMatch(/could not/i);
  });

  it('leaving the panel aborts the in-flight test (the server kills the scan on disconnect)', async () => {
    let seen: AbortSignal | undefined;
    fetchWithAuth.mockImplementation((_url: string, init: RequestInit) => {
      seen = init.signal ?? undefined;
      return new Promise(() => {});
    });
    const { unmount } = render(<RuleTestPanel setId="set-1" />);
    pick(new File(['x'], 'x.txt'));
    fireEvent.click(screen.getByTestId('rule-test-run'));
    await settle();
    expect(seen?.aborted).toBe(false);
    unmount();
    expect(seen?.aborted).toBe(true);
  });

  it('408 says the upload took too long', async () => {
    await runWith(json(408, { error: 'raw', code: 'YARA_TEST_BODY_TIMEOUT' }));
    expect(errorText()).toMatch(/upload took too long/);
  });
});

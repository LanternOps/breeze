import { afterEach, describe, expect, it, vi } from 'vitest';

// #3992: every sender that talks HTTP spliced the destination's raw response
// body into `HTTP <status>: <500 chars>`. When the destination answers with an
// HTML error page — the usual answer from a misconfigured URL — the operator
// got a wall of markup in the channel card and in the test toast, with the one
// useful token (`HTTP 405`) buried in the first ten characters. These tests are
// at the COMPOSITION point, which is where the fix lives; they fail against the
// old splice on both counts (length, and markup surviving).

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock('../urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../urlSafety')>();
  return { ...actual, safeFetch: safeFetchMock };
});

import { sendWebhookNotification } from './webhookSender';
import { sendPagerDutyNotification } from './pagerDutySender';
import { sendPushoverNotification } from './pushoverSender';
import { MAX_OPERATOR_ERROR_LENGTH } from '../httpFailureMessage';
import type { AlertSeverity } from '../email';

// The body from the issue report, cut down but the same shape: doctype, head
// with an inline stylesheet, then the one sentence a human wants.
const HTML_405 =
  '<!doctype html><html lang="en"><head><title>Example Domain</title>' +
  '<style>body{background:#eee;width:60vw;margin:15vh auto;font-family:system-ui,sans-serif}h1{font-size:1.5em}</style>' +
  '</head><body><h1>Example Domain</h1><p>The method is not allowed for the requested URL.</p></body></html>';

function htmlResponse(status: number): Response {
  return {
    ok: false,
    status,
    text: async () => HTML_405,
  } as unknown as Response;
}

const basePayload = {
  alertId: 'alert-1',
  alertName: 'Test Alert',
  severity: 'high' as AlertSeverity,
  summary: 'summary',
  orgId: 'org-1',
  triggeredAt: '2026-08-25T00:00:00.000Z',
};

/** What a debugger is entitled to: the unshortened body reached a log line. */
function expectFullBodyLogged(errorSpy: { mock: { calls: unknown[][] } }) {
  const logged = errorSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
  expect(logged).toContain('<!doctype html>');
  expect(logged).toContain('background:#eee');
}

/** What the operator is entitled to: the status, a readable sentence, no markup. */
function expectOperatorReadable(message: string | undefined, status: number) {
  expect(message).toBeDefined();
  expect(message!).toContain(`HTTP ${status}`);
  expect(message!).toContain('The method is not allowed');
  expect(message!.length).toBeLessThanOrEqual(MAX_OPERATOR_ERROR_LENGTH);
  expect(message!).not.toContain('<');
  expect(message!).not.toContain('doctype');
  expect(message!).not.toContain('background:#eee');
}

describe('sender failure messages are operator-readable (#3992)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    safeFetchMock.mockReset();
  });

  it('webhookSender: an HTML error page becomes one short line', async () => {
    safeFetchMock.mockResolvedValue(htmlResponse(405));
    // console.error is the sender's own log line; silence it but keep the arg.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendWebhookNotification(
      { url: 'https://example.com/hook', method: 'POST', retryCount: 0 },
      basePayload
    );

    expect(result.success).toBe(false);
    expectOperatorReadable(result.error, 405);

    // ...and the full body is still there for whoever has to debug it.
    expectFullBodyLogged(errorSpy);
  });

  // PagerDuty and Pushover carry no second copy of the body — their result
  // objects have no `responseBody` field and neither logged anything before
  // #3992 — and their `error` string is NOT a toast: the dispatcher persists it
  // into alert_notifications.error_message on the LIVE alert path. Shortening
  // it without a log line would have left on-call with 160 characters and
  // nothing else, so each asserts BOTH halves.
  it('pagerDutySender: an HTML error page becomes one short line, full body logged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse(502));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendPagerDutyNotification({ routingKey: 'R0UT1NGK3Y0123456789' }, basePayload);

    expect(result.success).toBe(false);
    expectOperatorReadable(result.error, 502);
    expectFullBodyLogged(errorSpy);
  });

  it('pushoverSender: an HTML error page becomes one short line, full body logged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(htmlResponse(500));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await sendPushoverNotification(
      { token: 'atokenatokenatoken12', user: 'auseruseruseruser123' },
      basePayload
    );

    expect(result.success).toBe(false);
    expectOperatorReadable(result.error, 500);
    expectFullBodyLogged(errorSpy);
  });

  // Pushover reports its own structured errors; those were already readable and
  // must keep bypassing the body-summarising path entirely.
  it('pushoverSender still prefers the provider\'s own error list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ status: 0, errors: ['application token is invalid'] }),
    } as unknown as Response);

    const result = await sendPushoverNotification(
      { token: 'atokenatokenatoken12', user: 'auseruseruseruser123' },
      basePayload
    );

    expect(result.error).toBe('application token is invalid');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CW_ALERT_MARKER_STRATEGY,
  CW_SUMMARY_MAX,
  ConnectWiseProvider,
  connectwiseTicketUiUrl,
  cwAlertExternalXRef,
  cwAlertSummaryMarker,
} from './connectwise';
import { psaFetch } from './http';
import { PsaAdapterError, PSA_ADAPTER_ERROR_BODY_MAX, supportsAlertTicketing } from './types';
import { SsrfBlockedError } from '../urlSafety';

vi.mock('./http', () => ({ psaFetch: vi.fn() }));

const psaFetchMock = vi.mocked(psaFetch);

const BASE = 'https://api-na.example-psa.test/v4_6_release/apis/3.0';
const credentials = {
  baseUrl: BASE,
  companyId: 'mspco',
  publicKey: 'pub-key-123',
  privateKey: 'priv-key-456',
  clientId: 'client-789',
};
const AUTH = `Basic ${Buffer.from('mspco+pub-key-123:priv-key-456').toString('base64')}`;
const ALERT_ID = '0f8a2b3c-1d2e-4f50-8a6b-7c8d9e0f1a2b';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function provider() {
  return new ConnectWiseProvider(credentials);
}

async function captureError(promise: Promise<unknown>): Promise<PsaAdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PsaAdapterError);
    return error as PsaAdapterError;
  }
  throw new Error('expected the call to reject');
}

function netError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

const createInput = {
  alertId: ALERT_ID,
  summary: '[CRITICAL] Disk full — HOST01',
  description: 'Disk C: is 99% full',
  companyId: '250',
  boardId: 12,
  statusId: 101,
  priorityId: 3,
  typeId: 44,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConnectWise alert-ticketing capability', () => {
  it('is detected by supportsAlertTicketing', () => {
    expect(supportsAlertTicketing(provider())).toBe(true);
  });

  it('exposes the LAB-pending limits and marker as named constants', () => {
    // LAB pending (#10534): placeholders until the developer-instance lab records them.
    expect(CW_SUMMARY_MAX).toBe(100);
    expect(CW_ALERT_MARKER_STRATEGY).toBe('external_xref');
    expect(cwAlertExternalXRef(ALERT_ID)).toBe(`breeze-alert:${ALERT_ID}`);
    expect(cwAlertSummaryMarker(ALERT_ID)).toBe('[breeze-alert:0f8a2b3c]');
    expect(provider().alertTicketLimits.summaryMaxCodePoints).toBe(CW_SUMMARY_MAX);
    // externalXRef strategy: the summary carries no marker.
    expect(provider().alertTicketLimits.summaryMarkerSuffix(ALERT_ID)).toBeNull();
  });
});

describe('createAlertTicket', () => {
  it('posts ids (never names), the company id and the externalXRef marker', async () => {
    psaFetchMock.mockResolvedValueOnce(json({ id: 9001, summary: createInput.summary, dateEntered: '2026-10-30T10:00:00Z' }, 201));

    const ref = await provider().createAlertTicket(createInput);

    expect(psaFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = psaFetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/service/tickets`);
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: AUTH, clientId: 'client-789' }),
    });
    expect(JSON.parse(String(init!.body))).toEqual({
      summary: createInput.summary,
      initialDescription: createInput.description,
      board: { id: 12 },
      status: { id: 101 },
      priority: { id: 3 },
      type: { id: 44 },
      company: { id: 250 },
      externalXRef: `breeze-alert:${ALERT_ID}`,
    });
    expect(ref).toEqual({
      ticketId: '9001',
      ticketNumber: '9001',
      externalUrl: connectwiseTicketUiUrl(BASE, 'mspco', 9001),
      createdAt: '2026-10-30T10:00:00Z',
    });
  });

  it('omits optional priority and type', async () => {
    psaFetchMock.mockResolvedValueOnce(json({ id: 1 }, 201));
    await provider().createAlertTicket({ ...createInput, priorityId: undefined, typeId: undefined });
    const body = JSON.parse(String(psaFetchMock.mock.calls[0]![1]!.body));
    expect(body).not.toHaveProperty('priority');
    expect(body).not.toHaveProperty('type');
  });

  it('refuses a non-numeric company id or a non-UUID alert id without calling the PSA', async () => {
    expect((await captureError(provider().createAlertTicket({ ...createInput, companyId: 'Acme' }))).errorClass).toBe('rejected');
    expect((await captureError(provider().createAlertTicket({ ...createInput, alertId: 'x" OR 1=1' }))).errorClass).toBe('rejected');
    expect(psaFetchMock).not.toHaveBeenCalled();
  });

  it('refuses a summary longer than the limit (the caller must truncate)', async () => {
    const err = await captureError(provider().createAlertTicket({ ...createInput, summary: 'x'.repeat(CW_SUMMARY_MAX + 1) }));
    expect(err.errorClass).toBe('rejected');
    expect(psaFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a timeout after sending', () => Promise.reject(new Error('request timed out after 20000ms'))],
    ['a reset after sending', () => Promise.reject(netError('ECONNRESET', 'socket hang up'))],
    ['a 504', () => Promise.resolve(json({ message: 'gateway' }, 504))],
    ['a 502', () => Promise.resolve(json({ message: 'bad gateway' }, 502))],
    ['an unreadable success body', () => Promise.resolve(new Response('<html>', { status: 201 }))],
  ])('classifies %s as unknown_outcome', async (_label, response) => {
    psaFetchMock.mockImplementationOnce(response as () => Promise<Response>);
    const err = await captureError(provider().createAlertTicket(createInput));
    expect(err.errorClass).toBe('unknown_outcome');
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'classifies %s (never reached the PSA) as transient',
    async (code) => {
      psaFetchMock.mockRejectedValueOnce(netError(code));
      expect((await captureError(provider().createAlertTicket(createInput))).errorClass).toBe('transient');
    },
  );

  it.each([
    [500, 'unknown_outcome'],
    [502, 'unknown_outcome'],
    [504, 'unknown_outcome'],
    // 503 = the PSA refused the request (maintenance); safe to retry.
    [503, 'transient'],
    [429, 'rate_limited'],
    [401, 'auth'],
    [400, 'rejected'],
  ])('maps HTTP %i on a create (non-idempotent) to %s', async (status, errorClass) => {
    psaFetchMock.mockResolvedValueOnce(json({ message: 'x' }, status));
    expect((await captureError(provider().createAlertTicket(createInput))).errorClass).toBe(errorClass);
  });

  it('a 2xx create without a ticket id is unknown_outcome (the ticket may exist)', async () => {
    psaFetchMock.mockResolvedValueOnce(json({ summary: 'no id' }, 201));
    expect((await captureError(provider().createAlertTicket(createInput))).errorClass).toBe('unknown_outcome');
  });

  it('reads a pre-send network code from error.cause too', async () => {
    psaFetchMock.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: netError('ECONNREFUSED') }));
    expect((await captureError(provider().createAlertTicket(createInput))).errorClass).toBe('transient');
  });

  it('classifies an SSRF-refused URL as rejected', async () => {
    psaFetchMock.mockRejectedValueOnce(new SsrfBlockedError('PSA URL rejected: private address'));
    expect((await captureError(provider().createAlertTicket(createInput))).errorClass).toBe('rejected');
  });
});

describe('error classification', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [400, 'rejected'],
    [404, 'rejected'],
    [422, 'rejected'],
    [500, 'transient'],
    [503, 'transient'],
    [502, 'transient'],
  ])('maps HTTP %i on an idempotent call to %s', async (status, errorClass) => {
    psaFetchMock.mockResolvedValueOnce(json({ code: 'X', message: 'nope' }, status));
    const err = await captureError(provider().listBoards());
    expect(err.errorClass).toBe(errorClass);
    expect(err.httpStatus).toBe(status);
  });

  it('maps 429 to rate_limited with Retry-After seconds', async () => {
    psaFetchMock.mockResolvedValueOnce(json({ message: 'slow down' }, 429, { 'retry-after': '30' }));
    const err = await captureError(provider().listBoards());
    expect(err).toMatchObject({ errorClass: 'rate_limited', httpStatus: 429, retryAfterMs: 30_000 });
  });

  it('maps 429 with an HTTP-date Retry-After to a non-negative delay', async () => {
    const at = new Date(Date.now() + 45_000).toUTCString();
    psaFetchMock.mockResolvedValueOnce(json({}, 429, { 'retry-after': at }));
    const err = await captureError(provider().listBoards());
    expect(err.retryAfterMs).toBeGreaterThan(0);
    expect(err.retryAfterMs).toBeLessThanOrEqual(46_000);
  });

  it('leaves retryAfterMs null without a usable Retry-After', async () => {
    psaFetchMock.mockResolvedValueOnce(json({}, 429, { 'retry-after': 'soon' }));
    expect((await captureError(provider().listBoards())).retryAfterMs).toBeNull();
  });

  it('classifies a network failure on an idempotent call as transient', async () => {
    psaFetchMock.mockRejectedValueOnce(new Error('request timed out after 20000ms'));
    expect((await captureError(provider().listBoards())).errorClass).toBe('transient');
  });

  it('keeps the response body out of the message and scrubs + caps the snippet', async () => {
    const body = `echo Authorization: ${AUTH} Bearer abc.def.ghi priv-key-456 pub-key-123 client-789 ${'z'.repeat(2000)}`;
    psaFetchMock.mockResolvedValueOnce(new Response(body, { status: 400 }));
    const err = await captureError(provider().listBoards());
    expect(err.message).not.toContain('echo');
    expect(err.message).not.toContain('zzz');
    expect(err.bodySnippet.length).toBeLessThanOrEqual(PSA_ADAPTER_ERROR_BODY_MAX);
    for (const secret of [AUTH.slice(6), 'priv-key-456', 'pub-key-123', 'client-789', 'abc.def.ghi']) {
      expect(err.bodySnippet).not.toContain(secret);
    }
  });
});

describe('closeTicket and addNote', () => {
  it('closes by status id with a JSON patch', async () => {
    psaFetchMock.mockResolvedValueOnce(json({ id: 9001 }));
    await provider().closeTicket('9001', 109);
    const [url, init] = psaFetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/service/tickets/9001`);
    expect(init).toMatchObject({ method: 'PATCH', headers: expect.objectContaining({ 'Content-Type': 'application/json-patch+json' }) });
    expect(JSON.parse(String(init!.body))).toEqual([{ op: 'replace', path: 'status', value: { id: 109 } }]);
  });

  it('a network failure while closing is transient (setting a status is idempotent)', async () => {
    psaFetchMock.mockRejectedValueOnce(netError('ECONNRESET'));
    expect((await captureError(provider().closeTicket('9001', 109))).errorClass).toBe('transient');
  });

  it('posts an internal-analysis note that is not a customer update', async () => {
    psaFetchMock.mockResolvedValueOnce(json({ id: 5 }, 201));
    await provider().addNote('9001', 'Alert acknowledged in Breeze');
    const [url, init] = psaFetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/service/tickets/9001/notes`);
    expect(JSON.parse(String(init!.body))).toEqual({
      text: 'Alert acknowledged in Breeze',
      detailDescriptionFlag: false,
      internalAnalysisFlag: true,
      resolutionFlag: false,
      customerUpdatedFlag: false,
    });
  });

  it('a timeout while posting a note is unknown_outcome (never re-post)', async () => {
    psaFetchMock.mockRejectedValueOnce(new Error('request timed out after 20000ms'));
    expect((await captureError(provider().addNote('9001', 'x'))).errorClass).toBe('unknown_outcome');
  });

  it('a 504 while posting a note is unknown_outcome', async () => {
    psaFetchMock.mockResolvedValueOnce(json({}, 504));
    expect((await captureError(provider().addNote('9001', 'x'))).errorClass).toBe('unknown_outcome');
  });

  it('refuses a non-numeric ticket id without calling the PSA', async () => {
    expect((await captureError(provider().closeTicket('../system/info', 1))).errorClass).toBe('rejected');
    expect((await captureError(provider().addNote('9001/../../x', 'x'))).errorClass).toBe('rejected');
    expect(psaFetchMock).not.toHaveBeenCalled();
  });
});

describe('findTicketsByMarker', () => {
  it('searches externalXRef for the full marker and returns the matches oldest first', async () => {
    psaFetchMock.mockResolvedValueOnce(json([
      { id: 9005, dateEntered: '2026-10-30T10:05:00Z' },
      { id: 9001, dateEntered: '2026-10-30T10:00:00Z' },
    ]));
    const refs = await provider().findTicketsByMarker(ALERT_ID);
    const url = new URL(String(psaFetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v4_6_release/apis/3.0/service/tickets');
    expect(url.searchParams.get('conditions')).toBe(`externalXRef="breeze-alert:${ALERT_ID}"`);
    expect(refs.map((ref) => ref.ticketId)).toEqual(['9001', '9005']);
  });

  it('a non-array body, or matches with no usable id, is an error, never "no ticket"', async () => {
    psaFetchMock.mockResolvedValueOnce(json({ code: 'Unexpected' }));
    expect((await captureError(provider().findTicketsByMarker(ALERT_ID))).errorClass).toBe('rejected');
    psaFetchMock.mockResolvedValueOnce(json([{ id: 'x' }, { summary: 'no id' }]));
    expect((await captureError(provider().findTicketsByMarker(ALERT_ID))).errorClass).toBe('rejected');
  });

  it('an empty array is a genuine "no match"', async () => {
    psaFetchMock.mockResolvedValueOnce(json([]));
    expect(await provider().findTicketsByMarker(ALERT_ID)).toEqual([]);
  });

  it('refuses a non-UUID alert id (no condition injection)', async () => {
    expect((await captureError(provider().findTicketsByMarker('x" OR id>0'))).errorClass).toBe('rejected');
    expect(psaFetchMock).not.toHaveBeenCalled();
  });
});

describe('pickers', () => {
  it('lists active boards by id and name', async () => {
    psaFetchMock.mockResolvedValueOnce(json([{ id: 12, name: 'Help Desk' }, { id: 14, name: 'Alerts' }, { id: 'bad' }]));
    const boards = await provider().listBoards();
    const url = new URL(String(psaFetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v4_6_release/apis/3.0/service/boards');
    expect(url.searchParams.get('conditions')).toBe('inactiveFlag=false');
    expect(boards).toEqual({ options: [{ id: 12, name: 'Help Desk' }, { id: 14, name: 'Alerts' }], truncated: false });
  });

  it('lists a board\'s statuses with the closed flag', async () => {
    psaFetchMock.mockResolvedValueOnce(json([
      { id: 101, name: 'New', closedStatus: false },
      { id: 109, name: 'Closed', closedStatus: true },
      { id: 110, name: 'Odd' },
    ]));
    const statuses = await provider().listStatuses(12);
    expect(new URL(String(psaFetchMock.mock.calls[0]![0])).pathname).toBe('/v4_6_release/apis/3.0/service/boards/12/statuses');
    expect(statuses.options).toEqual([
      { id: 101, name: 'New', closed: false },
      { id: 109, name: 'Closed', closed: true },
      { id: 110, name: 'Odd', closed: null },
    ]);
  });

  it('lists priorities', async () => {
    psaFetchMock.mockResolvedValueOnce(json([{ id: 1, name: 'Priority 1 - Emergency' }]));
    const priorities = await provider().listPriorities();
    expect(new URL(String(psaFetchMock.mock.calls[0]![0])).pathname).toBe('/v4_6_release/apis/3.0/service/priorities');
    expect(priorities.options).toEqual([{ id: 1, name: 'Priority 1 - Emergency' }]);
  });

  it('a non-array picker body is an error, never an empty list', async () => {
    psaFetchMock.mockResolvedValueOnce(json({ message: 'not a list' }));
    expect((await captureError(provider().listBoards())).errorClass).toBe('rejected');
  });

  it('flags a full page as truncated', async () => {
    psaFetchMock.mockResolvedValueOnce(json(Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `B${i}` }))));
    expect((await provider().listBoards()).truncated).toBe(true);
  });
});

describe('connectwiseTicketUiUrl', () => {
  it('builds the Manage UI ticket link from the API host (LAB pending #10534)', () => {
    expect(connectwiseTicketUiUrl(BASE, 'mspco', 9001)).toBe(
      'https://na.example-psa.test/v4_6_release/services/system_io/Service/fv_sr100_request.rails?service_recid=9001&companyName=mspco',
    );
  });

  it('is null for an unparseable base URL', () => {
    expect(connectwiseTicketUiUrl('not a url', 'mspco', 1)).toBeNull();
  });
});

describe('PsaAdapterError invariants', () => {
  const base = { provider: 'connectwise', httpStatus: 429, message: 'x' };
  it('keeps retryAfterMs only for rate_limited, finite and non-negative', () => {
    expect(new PsaAdapterError({ ...base, errorClass: 'rate_limited', retryAfterMs: 30_000 }).retryAfterMs).toBe(30_000);
    expect(new PsaAdapterError({ ...base, errorClass: 'rate_limited', retryAfterMs: -5 }).retryAfterMs).toBe(0);
    expect(new PsaAdapterError({ ...base, errorClass: 'rate_limited', retryAfterMs: Number.NaN }).retryAfterMs).toBeNull();
    expect(new PsaAdapterError({ ...base, errorClass: 'rate_limited', retryAfterMs: Number.POSITIVE_INFINITY }).retryAfterMs).toBeNull();
    expect(new PsaAdapterError({ ...base, errorClass: 'transient', retryAfterMs: 30_000 }).retryAfterMs).toBeNull();
  });

  it('caps the snippet', () => {
    expect(new PsaAdapterError({ ...base, errorClass: 'rejected', bodySnippet: 'y'.repeat(900) }).bodySnippet.length).toBe(PSA_ADAPTER_ERROR_BODY_MAX);
  });
});

describe('legacy ticket methods', () => {
  it('createTicket no longer reads a defaultBoardId setting', async () => {
    psaFetchMock.mockResolvedValueOnce(json({ id: 1 }, 201));
    await new ConnectWiseProvider(credentials, { defaultBoardId: 5 } as never).createTicket({ title: 'x' });
    expect(JSON.parse(String(psaFetchMock.mock.calls[0]![1]!.body))).not.toHaveProperty('board');
  });

  it('testConnection keeps a scrubbed PSA explanation for the admin', async () => {
    psaFetchMock.mockResolvedValueOnce(new Response('{"message":"Invalid company priv-key-456"}', { status: 401 }));
    const result = await provider().testConnection();
    expect(result.success).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('Invalid company');
    expect(result.message).not.toContain('priv-key-456');
  });
});

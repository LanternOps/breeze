import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// logForwarding imports ../db and ./secretCrypto at module load. We only test
// the transport (bulkIndexToEndpoint), which takes config directly and never
// touches the DB, so stub those modules to keep the unit isolated.
vi.mock('../db', () => ({ db: {} }));
vi.mock('../db/schema', () => ({ organizations: {} }));
vi.mock('./secretCrypto', () => ({ decryptForColumn: (_t: string, _c: string, v: unknown) => v }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

// The outbound request goes through safeFetch (SSRF-pinned). Mock it but keep
// the real SsrfBlockedError so instanceof checks work.
vi.mock('./urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./urlSafety')>();
  return { ...actual, safeFetch: vi.fn() };
});

import { bulkIndexToEndpoint } from './logForwarding';
import { safeFetch, SsrfBlockedError } from './urlSafety';
import { captureException } from './sentry';

const safeFetchMock = vi.mocked(safeFetch);
const captureExceptionMock = vi.mocked(captureException);

const baseConfig = {
  enabled: true,
  elasticsearchUrl: 'https://logs.example.com:9200',
  indexPrefix: 'breeze-logs',
};

const event = {
  deviceId: 'd1',
  orgId: 'o1',
  hostname: 'host-1',
  category: 'system',
  level: 'info',
  source: 'agent',
  message: 'hello',
  timestamp: '2026-03-31T12:00:00.000Z',
};

function okBulkResponse(body: unknown = { errors: false, items: [] }) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe('bulkIndexToEndpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    safeFetchMock.mockReset();
    captureExceptionMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs idempotent NDJSON to the /_bulk endpoint via safeFetch', async () => {
    safeFetchMock.mockResolvedValue(okBulkResponse());

    const result = await bulkIndexToEndpoint(baseConfig, [event]);

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = safeFetchMock.mock.calls[0]!;
    expect(url).toBe('https://logs.example.com:9200/_bulk');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['content-type']).toBe('application/x-ndjson');

    // NDJSON: action line + source line per event, trailing newline.
    const lines = (init!.body as string).split('\n');
    const action = JSON.parse(lines[0]!);
    expect(action.index._index).toBe('breeze-logs-2026.03.31');
    // Deterministic _id makes retries idempotent (no duplicate documents).
    expect(typeof action.index._id).toBe('string');
    expect(action.index._id).toHaveLength(64);
    expect(JSON.parse(lines[1]!)).toMatchObject({ hostname: 'host-1', message: 'hello' });
    expect(init!.body).toMatch(/\n$/);

    expect(result).toEqual({ indexed: 1, errors: 0 });
  });

  it('assigns the same _id to identical events (idempotency)', async () => {
    safeFetchMock.mockResolvedValue(okBulkResponse());

    await bulkIndexToEndpoint(baseConfig, [event, { ...event }]);

    const lines = (safeFetchMock.mock.calls[0]![1]!.body as string).split('\n');
    const id1 = JSON.parse(lines[0]!).index._id;
    const id2 = JSON.parse(lines[2]!).index._id;
    expect(id1).toBe(id2);
  });

  it('sends ApiKey auth when an API key is configured', async () => {
    safeFetchMock.mockResolvedValue(okBulkResponse());

    await bulkIndexToEndpoint({ ...baseConfig, elasticsearchApiKey: 'abc123' }, [event]);

    const headers = safeFetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.authorization).toBe('ApiKey abc123');
  });

  it('sends Basic auth when username and password are configured', async () => {
    safeFetchMock.mockResolvedValue(okBulkResponse());

    await bulkIndexToEndpoint(
      { ...baseConfig, elasticsearchUsername: 'elastic', elasticsearchPassword: 'pw' },
      [event],
    );

    const headers = safeFetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('elastic:pw').toString('base64')}`);
  });

  it('strips a trailing slash from the configured URL', async () => {
    safeFetchMock.mockResolvedValue(okBulkResponse());

    await bulkIndexToEndpoint({ ...baseConfig, elasticsearchUrl: 'https://logs.example.com:9200/' }, [event]);

    expect(safeFetchMock.mock.calls[0]![0]).toBe('https://logs.example.com:9200/_bulk');
  });

  it('drops the batch (no throw) on a terminal 4xx so BullMQ does not retry a poison batch', async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' } as Response);

    const result = await bulkIndexToEndpoint(baseConfig, [event, event]);

    expect(result).toEqual({ indexed: 0, errors: 2 });
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('throws on a 429 so the worker retries with backoff', async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => 'too many requests' } as Response);

    await expect(bulkIndexToEndpoint(baseConfig, [event])).rejects.toThrow(/429/);
  });

  it('throws on a 5xx so the worker retries with backoff', async () => {
    safeFetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'service unavailable' } as Response);

    await expect(bulkIndexToEndpoint(baseConfig, [event])).rejects.toThrow(/503/);
  });

  it('drops the batch (terminal, no retry) when safeFetch blocks an SSRF target', async () => {
    safeFetchMock.mockRejectedValue(new SsrfBlockedError('URL points to blocked address: 169.254.169.254'));

    const result = await bulkIndexToEndpoint(baseConfig, [event, event]);

    expect(result).toEqual({ indexed: 0, errors: 2 });
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('propagates a transport rejection (TLS/timeout/connection) so the worker retries', async () => {
    safeFetchMock.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(bulkIndexToEndpoint(baseConfig, [event])).rejects.toThrow('ETIMEDOUT');
  });

  it('treats a 2xx response with a non-JSON body as indexed (server accepted it)', async () => {
    safeFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as Response);

    const result = await bulkIndexToEndpoint(baseConfig, [event, event]);

    expect(result).toEqual({ indexed: 2, errors: 0 });
  });

  it('counts terminal per-item errors and drops them (no retry)', async () => {
    safeFetchMock.mockResolvedValue(
      okBulkResponse({
        errors: true,
        items: [
          { index: { status: 400, error: { type: 'mapper_parsing_exception' } } },
          { index: { status: 201 } },
        ],
      }),
    );

    const result = await bulkIndexToEndpoint(baseConfig, [event, event]);

    expect(result).toEqual({ indexed: 1, errors: 1 });
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('throws when any per-item error is retryable (idempotent _id makes batch retry safe)', async () => {
    safeFetchMock.mockResolvedValue(
      okBulkResponse({
        errors: true,
        items: [
          { index: { status: 429, error: { type: 'es_rejected_execution_exception' } } },
          { index: { status: 201 } },
        ],
      }),
    );

    await expect(bulkIndexToEndpoint(baseConfig, [event, event])).rejects.toThrow(/retry/i);
  });

  it('does not call safeFetch for an empty event batch', async () => {
    const result = await bulkIndexToEndpoint(baseConfig, []);

    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ indexed: 0, errors: 0 });
  });
});

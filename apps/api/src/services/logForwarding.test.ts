import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// logForwarding imports ../db and ./secretCrypto at module load. We only test
// the transport (bulkIndexToEndpoint), which takes config directly and never
// touches the DB, so stub those modules to keep the unit isolated.
vi.mock('../db', () => ({ db: {} }));
vi.mock('../db/schema', () => ({ organizations: {} }));
vi.mock('./secretCrypto', () => ({ decryptForColumn: (_t: string, _c: string, v: unknown) => v }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { bulkIndexToEndpoint } from './logForwarding';

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
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

describe('bulkIndexToEndpoint', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('POSTs NDJSON to the /_bulk endpoint without the @elastic client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBulkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await bulkIndexToEndpoint(baseConfig, [event]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://logs.example.com:9200/_bulk');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/x-ndjson');

    // NDJSON: one action line + one doc line per event, trailing newline.
    const lines = (init.body as string).split('\n');
    expect(lines[0]).toBe(JSON.stringify({ index: { _index: 'breeze-logs-2026.03.31' } }));
    expect(JSON.parse(lines[1]!)).toMatchObject({ hostname: 'host-1', message: 'hello' });
    expect(init.body).toMatch(/\n$/);

    expect(result).toEqual({ indexed: 1, errors: 0 });
  });

  it('sends ApiKey auth when an API key is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBulkResponse());
    vi.stubGlobal('fetch', fetchMock);

    await bulkIndexToEndpoint({ ...baseConfig, elasticsearchApiKey: 'abc123' }, [event]);

    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe('ApiKey abc123');
  });

  it('sends Basic auth when username and password are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBulkResponse());
    vi.stubGlobal('fetch', fetchMock);

    await bulkIndexToEndpoint(
      { ...baseConfig, elasticsearchUsername: 'elastic', elasticsearchPassword: 'pw' },
      [event],
    );

    const expected = `Basic ${Buffer.from('elastic:pw').toString('base64')}`;
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBe(expected);
  });

  it('strips a trailing slash from the configured URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okBulkResponse());
    vi.stubGlobal('fetch', fetchMock);

    await bulkIndexToEndpoint({ ...baseConfig, elasticsearchUrl: 'https://logs.example.com:9200/' }, [event]);

    expect(fetchMock.mock.calls[0]![0]).toBe('https://logs.example.com:9200/_bulk');
  });

  it('counts per-item errors from the bulk response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okBulkResponse({
        errors: true,
        items: [{ index: { error: { type: 'mapper_parsing_exception' } } }, { index: {} }],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await bulkIndexToEndpoint(baseConfig, [event, event]);

    expect(result).toEqual({ indexed: 1, errors: 1 });
  });

  it('drops the batch (no throw) on a terminal 4xx so BullMQ does not retry a poison batch', async () => {
    // 401/403/400 are misconfiguration — retrying every batch 5x won't help.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await bulkIndexToEndpoint(baseConfig, [event, event]);

    expect(result).toEqual({ indexed: 0, errors: 2 });
  });

  it('throws on a 429 so the worker retries with backoff', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'too many requests',
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(bulkIndexToEndpoint(baseConfig, [event])).rejects.toThrow(/429/);
  });

  it('throws on a 5xx so the worker retries with backoff', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(bulkIndexToEndpoint(baseConfig, [event])).rejects.toThrow(/503/);
  });

  it('propagates a fetch rejection (network/DNS/TLS error) so the worker retries', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(bulkIndexToEndpoint(baseConfig, [event])).rejects.toThrow('ECONNREFUSED');
  });

  it('treats a 2xx response with a non-JSON body as indexed (server accepted it)', async () => {
    // Some compatible sinks/proxies 200 with an empty or plain-text ack body.
    // Hard-failing here would retry and risk duplicate indexing.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const result = await bulkIndexToEndpoint(baseConfig, [event, event]);

    expect(result).toEqual({ indexed: 2, errors: 0 });
  });

  it('does not call fetch for an empty event batch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await bulkIndexToEndpoint(baseConfig, []);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ indexed: 0, errors: 0 });
  });
});

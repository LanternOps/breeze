import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'organization', currentPartnerId: 'stale-partner' })),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));
vi.mock('../db/schema', () => ({
  organizations: { id: 'organizations.id', settings: 'organizations.settings', partnerId: 'organizations.partner_id' },
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));
vi.mock('drizzle-orm', () => ({ eq: vi.fn((column, value) => ({ column, value })) }));
vi.mock('./secretCrypto', () => ({ decryptForColumn: vi.fn((_t: string, _c: string, v: unknown) => v) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

// The outbound request goes through safeFetch (SSRF-pinned). Mock it but keep
// the real SsrfBlockedError so instanceof checks work.
vi.mock('./urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./urlSafety')>();
  return { ...actual, safeFetch: vi.fn() };
});

import { bulkIndexEvents, getOrgForwardingConfig, bulkIndexToEndpoint } from './logForwarding';
import { safeFetch, SsrfBlockedError } from './urlSafety';
import { captureException } from './sentry';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { decryptForColumn } from './secretCrypto';

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

  it('assigns the same _id to byte-identical events (idempotency)', async () => {
    safeFetchMock.mockResolvedValue(okBulkResponse());

    await bulkIndexToEndpoint(baseConfig, [event, { ...event }]);

    const lines = (safeFetchMock.mock.calls[0]![1]!.body as string).split('\n');
    const id1 = JSON.parse(lines[0]!).index._id;
    const id2 = JSON.parse(lines[2]!).index._id;
    expect(id1).toBe(id2);
  });

  it('assigns distinct _ids to events that differ only in level (no overwrite)', async () => {
    safeFetchMock.mockResolvedValue(okBulkResponse());

    const result = await bulkIndexToEndpoint(baseConfig, [event, { ...event, level: 'warn' }]);

    const lines = (safeFetchMock.mock.calls[0]![1]!.body as string).split('\n');
    expect(JSON.parse(lines[0]!).index._id).not.toBe(JSON.parse(lines[2]!).index._id);
    expect(result).toEqual({ indexed: 2, errors: 0 });
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

  it('throws when a batch mixes retryable and terminal items (retryable wins)', async () => {
    safeFetchMock.mockResolvedValue(
      okBulkResponse({
        errors: true,
        items: [
          { index: { status: 429, error: { type: 'es_rejected_execution_exception' } } },
          { index: { status: 400, error: { type: 'mapper_parsing_exception' } } },
        ],
      }),
    );

    await expect(bulkIndexToEndpoint(baseConfig, [event, event])).rejects.toThrow(/retry/i);
  });

  it('treats an item error with no status as terminal (drops, does not throw)', async () => {
    safeFetchMock.mockResolvedValue(
      okBulkResponse({
        errors: true,
        items: [{ index: { error: { type: 'unavailable_shards_exception' } } }],
      }),
    );

    const result = await bulkIndexToEndpoint(baseConfig, [event]);

    expect(result).toEqual({ indexed: 0, errors: 1 });
    expect(captureExceptionMock).toHaveBeenCalled();
  });

  it('does not call safeFetch for an empty event batch', async () => {
    const result = await bulkIndexToEndpoint(baseConfig, []);

    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ indexed: 0, errors: 0 });
  });
});


describe('organization forwarding destination resolution', () => {
  const orgId = '00000000-0000-4000-8000-000000000001';
  const partnerId = '00000000-0000-4000-8000-000000000002';
  const partnerConfig = {
    ...baseConfig,
    elasticsearchUrl: 'https://partner-logs.example.com',
    elasticsearchApiKey: 'partner-key',
    elasticsearchPassword: 'partner-password',
    indexPrefix: 'partner-events',
  };
  const where = vi.fn();

  function prime(orgSettings: unknown, partnerSettings: unknown, exists = true) {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn((table: { id: string }) => ({
        where: (condition: unknown) => {
          where(table.id, condition);
          return { limit: vi.fn(async () => table.id === 'organizations.id'
            ? (exists ? [{ settings: orgSettings, partnerId }] : [])
            : [{ settings: partnerSettings }]) };
        },
      })),
    } as never);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    safeFetchMock.mockResolvedValue(okBulkResponse());
  });

  it('delivers to the org destination when the partner has no forwarding settings', async () => {
    prime({ logForwarding: { ...baseConfig, elasticsearchApiKey: 'org-key' } }, {});
    await bulkIndexEvents(orgId, [event]);
    expect(safeFetchMock).toHaveBeenCalledWith(`${baseConfig.elasticsearchUrl}/_bulk`, expect.anything());
    expect(decryptForColumn).toHaveBeenCalledWith('organizations', 'settings', 'org-key');
  });

  it('delivers to the partner destination when the org has none', async () => {
    prime({}, { eventLogs: partnerConfig });
    expect(await bulkIndexEvents(orgId, [event])).toEqual({ indexed: 1, errors: 0 });
    expect(safeFetchMock).toHaveBeenCalledWith(`${partnerConfig.elasticsearchUrl}/_bulk`, expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'ApiKey partner-key' }),
      body: expect.stringContaining('partner-events-'),
    }));
    expect(decryptForColumn).toHaveBeenCalledWith('partners', 'settings', 'partner-key');
    expect(decryptForColumn).toHaveBeenCalledWith('partners', 'settings', 'partner-password');
  });

  it('uses the enabled partner destination even when the org has its own', async () => {
    prime({ logForwarding: { ...baseConfig, elasticsearchApiKey: 'org-key' } }, { eventLogs: partnerConfig });
    expect(await getOrgForwardingConfig(orgId)).toEqual(partnerConfig);
    expect(decryptForColumn).not.toHaveBeenCalledWith('organizations', 'settings', 'org-key');
  });

  it('does not send org credentials to a partner destination without credentials', async () => {
    prime({ logForwarding: { ...baseConfig, elasticsearchApiKey: 'org-secret' } }, {
      eventLogs: { enabled: true, elasticsearchUrl: partnerConfig.elasticsearchUrl },
    });
    await bulkIndexEvents(orgId, [event]);
    expect(safeFetchMock).toHaveBeenCalledWith(`${partnerConfig.elasticsearchUrl}/_bulk`, expect.objectContaining({
      headers: { 'content-type': 'application/x-ndjson' },
      body: expect.stringContaining('breeze-logs-'),
    }));
  });

  it.each([
    ['neither configured', {}, {}],
    ['org disabled', { logForwarding: { ...baseConfig, enabled: false } }, {}],
  ])('does not deliver when %s', async (_name, orgSettings, partnerSettings) => {
    prime(orgSettings, partnerSettings);
    expect(await bulkIndexEvents(orgId, [event])).toEqual({ indexed: 0, errors: 0 });
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['partner disabled', { ...partnerConfig, enabled: false }],
    ['partner missing endpoint', { enabled: true }],
  ])('delivers to the org destination when %s', async (_name, eventLogs) => {
    prime({ logForwarding: { ...baseConfig, elasticsearchApiKey: 'org-key' } }, { eventLogs });
    expect(await bulkIndexEvents(orgId, [event])).toEqual({ indexed: 1, errors: 0 });
    expect(safeFetchMock).toHaveBeenCalledWith(`${baseConfig.elasticsearchUrl}/_bulk`, expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'ApiKey org-key' }),
    }));
    expect(decryptForColumn).toHaveBeenCalledWith('organizations', 'settings', 'org-key');
  });

  it('pins the elevated partner read to the live org relationship', async () => {
    prime({}, { eventLogs: partnerConfig });
    await getOrgForwardingConfig(orgId);
    expect(where.mock.calls).toEqual([
      ['organizations.id', { column: 'organizations.id', value: orgId }],
      ['partners.id', { column: 'partners.id', value: partnerId }],
    ]);
    expect(runOutsideDbContext).toHaveBeenCalledOnce();
    expect(withSystemDbAccessContext).toHaveBeenCalledOnce();
  });

  it('does not elevate or deliver if the org is absent or hidden by RLS', async () => {
    prime({}, { eventLogs: partnerConfig }, false);
    expect(await bulkIndexEvents(orgId, [event])).toEqual({ indexed: 0, errors: 0 });
    expect(db.select).toHaveBeenCalledOnce();
    expect(runOutsideDbContext).not.toHaveBeenCalled();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});

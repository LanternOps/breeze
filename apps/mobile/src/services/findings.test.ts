import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above every other statement, so both the spy and the
// stand-in error class have to be created inside `vi.hoisted` — a plain
// top-level `const`/`class` is still in its temporal dead zone when the
// factory runs.
const { coreRequest, FakeApiError } = vi.hoisted(() => {
  class HoistedApiError extends Error {
    code?: string;
    statusCode?: number;
    constructor(params: { message: string; code?: string; statusCode?: number }) {
      super(params.message);
      this.name = 'ApiError';
      this.code = params.code;
      this.statusCode = params.statusCode;
    }
  }
  return { coreRequest: vi.fn(), FakeApiError: HoistedApiError };
});

vi.mock('./api', () => ({ coreRequest, ApiError: FakeApiError }));

import { getFinding, isFindingNotFound, listFindings, patchFinding } from './findings';

beforeEach(() => {
  coreRequest.mockReset();
});

describe('listFindings', () => {
  it('defaults to the findings a tech can still act on', async () => {
    coreRequest.mockResolvedValue({ findings: [], total: 0 });
    await listFindings({ orgId: 'org-1' });
    expect(coreRequest).toHaveBeenCalledWith(
      '/fleet/findings?orgId=org-1&status=open%2Cacknowledged&limit=50',
    );
  });

  it('passes an explicit status set, severity, kind and paging through', async () => {
    coreRequest.mockResolvedValue({ findings: [], total: 0 });
    await listFindings({
      orgId: 'org-1',
      statuses: ['dismissed'],
      severity: 'critical',
      kind: 'log_correlation',
      limit: 10,
      offset: 20,
    });
    const url = coreRequest.mock.calls[0][0] as string;
    const query = new URLSearchParams(url.split('?')[1]);
    expect(query.get('orgId')).toBe('org-1');
    expect(query.get('status')).toBe('dismissed');
    expect(query.get('severity')).toBe('critical');
    expect(query.get('kind')).toBe('log_correlation');
    expect(query.get('limit')).toBe('10');
    expect(query.get('offset')).toBe('20');
  });

  it('joins several statuses into the CSV the API parses', async () => {
    coreRequest.mockResolvedValue({ findings: [], total: 0 });
    await listFindings({ orgId: 'org-1', statuses: ['open', 'dismissed'] });
    const query = new URLSearchParams((coreRequest.mock.calls[0][0] as string).split('?')[1]);
    expect(query.get('status')).toBe('open,dismissed');
  });

  it('omits an empty status list rather than sending status= and getting a 400', async () => {
    coreRequest.mockResolvedValue({ findings: [], total: 0 });
    await listFindings({ orgId: 'org-1', statuses: [] });
    const url = coreRequest.mock.calls[0][0] as string;
    expect(url).not.toContain('status=');
  });

  it('tolerates a body with no findings array', async () => {
    coreRequest.mockResolvedValue({});
    expect(await listFindings({ orgId: 'org-1' })).toEqual({ findings: [], total: 0 });
  });

  it('falls back to the row count when the server omits total', async () => {
    coreRequest.mockResolvedValue({ findings: [{ id: 'f-1' }] });
    const result = await listFindings({ orgId: 'org-1' });
    expect(result.total).toBe(1);
  });
});

describe('getFinding', () => {
  it('fetches one finding by id and url-encodes it', async () => {
    coreRequest.mockResolvedValue({ id: 'f-1', members: [], runs: [] });
    await getFinding('f/1');
    expect(coreRequest).toHaveBeenCalledWith('/fleet/findings/f%2F1');
  });

  it('defaults members to an empty array when the server omits them', async () => {
    coreRequest.mockResolvedValue({ id: 'f-1', title: 'x' });
    const finding = await getFinding('f-1');
    expect(finding.members).toEqual([]);
  });
});

describe('patchFinding', () => {
  it('sends the action alone when there are no notes', async () => {
    coreRequest.mockResolvedValue({ id: 'f-1', status: 'acknowledged' });
    await patchFinding('f-1', 'acknowledge');
    expect(coreRequest).toHaveBeenCalledWith('/fleet/findings/f-1', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'acknowledge' }),
    });
  });

  it('sends notes with a dismiss', async () => {
    coreRequest.mockResolvedValue({ id: 'f-1', status: 'dismissed' });
    await patchFinding('f-1', 'dismiss', 'known false positive');
    expect(coreRequest).toHaveBeenCalledWith('/fleet/findings/f-1', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'dismiss', notes: 'known false positive' }),
    });
  });

  it('drops a blank note rather than sending an empty string', async () => {
    coreRequest.mockResolvedValue({ id: 'f-1' });
    await patchFinding('f-1', 'reopen', '   ');
    expect(coreRequest).toHaveBeenCalledWith('/fleet/findings/f-1', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'reopen' }),
    });
  });
});

describe('isFindingNotFound', () => {
  it('recognises the API 404 the screens turn into an empty state', () => {
    expect(isFindingNotFound(new FakeApiError({ message: 'Finding not found', statusCode: 404 }))).toBe(
      true,
    );
  });

  it('does not swallow other API failures', () => {
    expect(isFindingNotFound(new FakeApiError({ message: 'Permission denied', statusCode: 403 }))).toBe(
      false,
    );
    expect(isFindingNotFound(new FakeApiError({ message: 'Boom', statusCode: 500 }))).toBe(false);
  });

  it('does not treat a network failure as an empty result', () => {
    expect(isFindingNotFound(new TypeError('Network request failed'))).toBe(false);
    expect(isFindingNotFound(undefined)).toBe(false);
  });
});

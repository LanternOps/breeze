/**
 * Tool catalog W01 PR C (#5216) — the typed client for `/tool-sources`.
 *
 * Two things this pins that the components themselves cannot: the CREATE body
 * carries `ownerScope` (and `orgId` only for an org-owned source — never a
 * literal null, which the API schema's `.optional()` rejects), and the tool
 * TEST route's HTTP-200-with-`success:false` shape is treated as a failure
 * rather than a green toast over a failed remote call (the API deliberately
 * answers 200 there — `routes/toolSources.ts`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import {
  bulkTools,
  createToolSource,
  deleteToolSource,
  discoverToolSource,
  getToolSource,
  listSourceTools,
  listToolSources,
  patchSourceTool,
  testSourceTool,
  updateToolSource,
} from './api';
import { ActionError } from '../../lib/runAction';

const fetcher = vi.fn();

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  fetcher.mockReset();
});

describe('tool sources API client', () => {
  it('preserves discovery warnings on create, update, and re-discover', async () => {
    fetcher.mockImplementation(async () => ok({
      success: true, data: { id: 's-1' }, source: { id: 's-1' }, warning: 'discovery_not_queued',
    }, 202));
    const body = {
      ownerScope: 'partner' as const, name: 'Hudu', slug: 'hudu', kind: 'mcp' as const,
      endpointUrl: 'https://hudu.example.test/mcp', rateLimitPerMinute: 120, authKind: 'none' as const,
    };
    await expect(createToolSource(fetcher, body)).resolves.toMatchObject({ id: 's-1', warning: 'discovery_not_queued' });
    await expect(updateToolSource(fetcher, 's-1', {})).resolves.toMatchObject({ id: 's-1', warning: 'discovery_not_queued' });
    await expect(discoverToolSource(fetcher, 's-1')).resolves.toMatchObject({ warning: 'discovery_not_queued' });
  });

  it('lists sources and unwraps the data envelope', async () => {
    fetcher.mockResolvedValueOnce(ok({ data: [{ id: 's-1' }], pagination: { total: 1, limit: 50, offset: 0 } }));
    await expect(listToolSources(fetcher)).resolves.toEqual([{ id: 's-1' }]);
    expect(fetcher).toHaveBeenCalledWith('/tool-sources');
  });

  it('creates a PARTNER-wide source with ownerScope and no orgId', async () => {
    fetcher.mockResolvedValueOnce(ok({ data: { id: 's-1' } }, 201));

    await createToolSource(fetcher, {
      ownerScope: 'partner',
      name: 'Hudu',
      slug: 'hudu',
      kind: 'mcp',
      endpointUrl: 'https://hudu.example.test/mcp',
      rateLimitPerMinute: 120,
      authKind: 'bearer',
      authConfig: { token: 't' },
    });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/tool-sources');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.ownerScope).toBe('partner');
    expect(body).not.toHaveProperty('orgId');
    expect(body.authKind).toBe('bearer');
    expect(body.authConfig).toEqual({ token: 't' });
  });

  it('creates an ORG-owned source carrying its orgId', async () => {
    fetcher.mockResolvedValueOnce(ok({ data: { id: 's-2' } }, 201));

    await createToolSource(fetcher, {
      ownerScope: 'organization',
      orgId: 'org-1',
      name: 'Hudu',
      slug: 'hudu',
      kind: 'mcp',
      endpointUrl: 'https://hudu.example.test/mcp',
      rateLimitPerMinute: 120,
      authKind: 'none',
    });

    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    expect(body.orgId).toBe('org-1');
    expect(body.ownerScope).toBe('organization');
  });

  it('PATCHes a single tool at /:id/tools/:toolId', async () => {
    fetcher.mockResolvedValueOnce(ok({ data: { id: 't-1', enabled: true } }));

    await patchSourceTool(fetcher, 's-1', 't-1', { enabled: true });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('/tool-sources/s-1/tools/t-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
  });

  it('routes the rest of the surface at the paths the API mounts', async () => {
    fetcher.mockImplementation(async () => ok({ data: {} }));
    await getToolSource(fetcher, 's-1');
    await updateToolSource(fetcher, 's-1', { name: 'New' });
    await deleteToolSource(fetcher, 's-1');
    await discoverToolSource(fetcher, 's-1');
    await listSourceTools(fetcher, 's-1');
    await bulkTools(fetcher, 's-1', 'enable_reads');

    expect(fetcher.mock.calls.map((c) => [c[0], (c[1] as RequestInit | undefined)?.method ?? 'GET'])).toEqual([
      ['/tool-sources/s-1', 'GET'],
      ['/tool-sources/s-1', 'PATCH'],
      ['/tool-sources/s-1', 'DELETE'],
      ['/tool-sources/s-1/discover', 'POST'],
      ['/tool-sources/s-1/tools', 'GET'],
      ['/tool-sources/s-1/tools/bulk', 'POST'],
    ]);
    expect(JSON.parse(fetcher.mock.calls[5]![1].body as string)).toEqual({ mode: 'enable_reads' });
  });

  it('resolves a successful delete even though the route answers {success,id}, not a data envelope', async () => {
    // DELETE /tool-sources/:id returns `{ success: true, id }` like every
    // other delete route (CLAUDE.md delete-route convention) — it never
    // carries a `data` envelope. Running it through `unwrapData` would throw
    // "missing data envelope" on a successful delete.
    fetcher.mockResolvedValueOnce(ok({ success: true, id: 's-1' }));
    await expect(deleteToolSource(fetcher, 's-1')).resolves.toBeUndefined();
  });

  it('rejects a failed delete with the server-provided error', async () => {
    fetcher.mockResolvedValueOnce(ok({ error: 'Partner-wide sources require partner-policy access' }, 403));
    await expect(deleteToolSource(fetcher, 's-1')).rejects.toMatchObject({
      status: 403,
      message: 'Partner-wide sources require partner-policy access',
    });
  });

  it('ids are URL-encoded, so a hostile id cannot escape the path', async () => {
    fetcher.mockResolvedValueOnce(ok({ data: {} }));
    await getToolSource(fetcher, 'a/b?c');
    expect(fetcher.mock.calls[0]![0]).toBe('/tool-sources/a%2Fb%3Fc');
  });

  it('treats an HTTP-200 test call with success:false as a FAILURE, not a green result', async () => {
    // The API answers 200 with the failure text inside `data.result` — a naive
    // client would toast "Test call succeeded" over a failed remote call.
    fetcher.mockResolvedValueOnce(
      ok({ success: false, data: { result: '{"error":"502"}', isError: true, durationMs: 12 } }),
    );

    await expect(testSourceTool(fetcher, 's-1', 't-1', {})).rejects.toBeInstanceOf(ActionError);
  });

  it('resolves a successful test call with its result text and duration', async () => {
    fetcher.mockResolvedValueOnce(
      ok({ success: true, data: { result: '{"ok":true}', isError: false, durationMs: 12 } }),
    );

    await expect(testSourceTool(fetcher, 's-1', 't-1', { id: 'a' })).resolves.toEqual({
      result: '{"ok":true}',
      isError: false,
      durationMs: 12,
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1].body as string)).toEqual({ input: { id: 'a' } });
  });

  it('rejects a test call on EITHER failure signal alone, not only when both agree', async () => {
    // `success:false` with `isError:false` (an envelope-level refusal) and
    // `success:true` with `isError:true` (the executor's own verdict) are both
    // failures; asserting only the both-true case would not discriminate `||`
    // from `&&`.
    fetcher.mockResolvedValueOnce(
      ok({ success: false, data: { result: 'refused', isError: false, durationMs: 1 } }),
    );
    await expect(testSourceTool(fetcher, 's-1', 't-1', {})).rejects.toMatchObject({ code: 'tool_test_failed' });

    fetcher.mockResolvedValueOnce(
      ok({ success: true, data: { result: 'MCP call failed', isError: true, durationMs: 1 } }),
    );
    await expect(testSourceTool(fetcher, 's-1', 't-1', {})).rejects.toMatchObject({ code: 'tool_test_failed' });
  });

  it('a test call that 500s rejects with the server reason, not a parsed result', async () => {
    fetcher.mockResolvedValueOnce(ok({ error: 'Tool not found', code: 'not_found' }, 404));
    await expect(testSourceTool(fetcher, 's-1', 't-1', {})).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      message: 'Tool not found',
    });
  });

  it('a malformed or envelope-less test response is a failure, never a silent success', async () => {
    fetcher.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json'); },
    } as unknown as Response);
    await expect(testSourceTool(fetcher, 's-1', 't-1', {})).rejects.toBeInstanceOf(ActionError);

    fetcher.mockResolvedValueOnce(ok({ success: true }));
    await expect(testSourceTool(fetcher, 's-1', 't-1', {})).rejects.toBeInstanceOf(ActionError);
  });

  it('surfaces an API error body as an ActionError carrying its code', async () => {
    fetcher.mockResolvedValueOnce(
      ok({ error: 'This slug is already used by a partner-wide tool source', code: 'slug_shadows_partner_source' }, 409),
    );

    await expect(
      createToolSource(fetcher, {
        ownerScope: 'organization',
        orgId: 'org-1',
        name: 'Hudu',
        slug: 'hudu',
        kind: 'mcp',
        endpointUrl: 'https://hudu.example.test/mcp',
        rateLimitPerMinute: 120,
        authKind: 'none',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'slug_shadows_partner_source' });
  });
});

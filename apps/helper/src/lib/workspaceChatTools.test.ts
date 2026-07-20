import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./helperFetch', () => ({
  helperRequest: vi.fn(),
  getTauriInvoke: vi.fn(async () => null),
  requireDevBearerToken: vi.fn(),
}));

import { helperRequest } from './helperFetch';
import { useChatStore } from '../stores/chatStore';
import { WORKSPACE_CHAT_TOOLS, executeWorkspaceChatTool } from './workspaceChatTools';

const helperRequestMock = vi.mocked(helperRequest);
const AGENT_CONFIG = { api_url: 'http://localhost:3001', agent_id: 'agent-1' };

function ok(body: unknown, status = 200) {
  return { ok: true, status, body: JSON.stringify(body) };
}
function fail(body: unknown, status = 500) {
  return { ok: false, status, body: JSON.stringify(body) };
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ agentConfig: AGENT_CONFIG });
});

describe('WORKSPACE_CHAT_TOOLS declarations', () => {
  it('declares exactly the two chat tools with valid names and object schemas', () => {
    expect(WORKSPACE_CHAT_TOOLS.map((t) => t.name)).toEqual([
      'search_workspace_files',
      'get_file_passages',
    ]);
    for (const t of WORKSPACE_CHAT_TOOLS) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{2,40}$/);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.required).toContain('q');
    }
  });

  it('instructs the citation format in get_file_passages description', () => {
    const passages = WORKSPACE_CHAT_TOOLS.find((t) => t.name === 'get_file_passages')!;
    expect(passages.description).toContain('[file:<fileIndexId>|<relPath>]');
  });
});

describe('search_workspace_files executor', () => {
  it('calls /search with q/project/docType and returns files trimmed to 8 summaries', async () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      id: `f${i}`,
      relPath: `clients/henderson/${i}.pdf`,
      openPath: `\\\\srv\\share\\${i}.pdf`,
      inferredProjectLabel: 'Henderson',
      inferredDocType: 'easement',
      // extraneous FinderFile fields that must NOT leak into the summary
      name: `${i}.pdf`,
      sourceId: 's1',
      size: 1024,
    }));
    helperRequestMock.mockResolvedValue(ok({ results }));

    const out = (await executeWorkspaceChatTool('search_workspace_files', {
      q: 'henderson',
      project: 'Henderson',
      docType: 'easement',
    })) as { files: Array<Record<string, unknown>> };

    expect(helperRequestMock).toHaveBeenCalledTimes(1);
    const [, url, opts] = helperRequestMock.mock.calls[0];
    expect(url).toContain('/api/v1/workspace/helper/search?');
    expect(url).toContain('q=henderson');
    expect(url).toContain('project=Henderson');
    expect(url).toContain('docType=easement');
    expect(opts?.method).toBe('GET');

    expect(out.files).toHaveLength(8);
    expect(out.files[0]).toEqual({
      fileIndexId: 'f0',
      relPath: 'clients/henderson/0.pdf',
      project: 'Henderson',
      docType: 'easement',
      openPath: '\\\\srv\\share\\0.pdf',
    });
  });

  it('falls back to declaredProjectLabel and null docType/openPath', async () => {
    helperRequestMock.mockResolvedValue(
      ok({ results: [{ id: 'f1', relPath: 'a.pdf', declaredProjectLabel: 'Alder', openPath: null }] }),
    );
    const out = (await executeWorkspaceChatTool('search_workspace_files', { q: 'a' })) as {
      files: Array<Record<string, unknown>>;
    };
    expect(out.files[0]).toEqual({
      fileIndexId: 'f1',
      relPath: 'a.pdf',
      project: 'Alder',
      docType: null,
      openPath: null,
    });
  });

  it('omits absent optional params from the query string', async () => {
    helperRequestMock.mockResolvedValue(ok({ results: [] }));
    await executeWorkspaceChatTool('search_workspace_files', { q: 'x' });
    const [, url] = helperRequestMock.mock.calls[0];
    expect(url).toContain('q=x');
    expect(url).not.toContain('project=');
    expect(url).not.toContain('docType=');
  });

  it('truncates a q longer than 200 chars in the request URL', async () => {
    helperRequestMock.mockResolvedValue(ok({ results: [] }));
    const longQ = 'a'.repeat(300);
    await executeWorkspaceChatTool('search_workspace_files', { q: longQ });
    const [, url] = helperRequestMock.mock.calls[0];
    const sent = new URL(url).searchParams.get('q');
    expect(sent).toBe('a'.repeat(200));
  });
});

describe('get_file_passages executor', () => {
  it('hits /content/passages, caps to 6 passages and 700-char snippets', async () => {
    const long = 'x'.repeat(1000);
    const passages = Array.from({ length: 8 }, (_, i) => ({
      fileIndexId: `f${i}`,
      relPath: `p${i}.pdf`,
      sourceId: 's1',
      openPath: null,
      snippet: long,
      score: 1 - i * 0.1,
    }));
    helperRequestMock.mockResolvedValue(ok({ passages }));

    const out = (await executeWorkspaceChatTool('get_file_passages', {
      q: 'easement terms',
      fileIndexId: '11111111-1111-1111-1111-111111111111',
    })) as { passages: Array<{ snippet: string }> };

    const [, url] = helperRequestMock.mock.calls[0];
    expect(url).toContain('/api/v1/workspace/helper/content/passages?');
    expect(url).toContain('q=easement');
    expect(url).toContain('fileIndexId=11111111-1111-1111-1111-111111111111');
    expect(url).toContain('limit=6');

    expect(out.passages).toHaveLength(6);
    expect(out.passages[0].snippet.length).toBe(700);
  });

  it('omits fileIndexId when not provided', async () => {
    helperRequestMock.mockResolvedValue(ok({ passages: [] }));
    await executeWorkspaceChatTool('get_file_passages', { q: 'q' });
    const [, url] = helperRequestMock.mock.calls[0];
    expect(url).not.toContain('fileIndexId=');
  });

  it('truncates a q longer than 200 chars in the request URL', async () => {
    helperRequestMock.mockResolvedValue(ok({ passages: [] }));
    const longQ = 'b'.repeat(500);
    await executeWorkspaceChatTool('get_file_passages', { q: longQ });
    const [, url] = helperRequestMock.mock.calls[0];
    const sent = new URL(url).searchParams.get('q');
    expect(sent).toBe('b'.repeat(200));
  });
});

describe('executor error handling (never throws)', () => {
  it('returns {error} on a non-ok response', async () => {
    helperRequestMock.mockResolvedValue(fail({ error: 'boom' }));
    const out = (await executeWorkspaceChatTool('search_workspace_files', { q: 'x' })) as {
      error: string;
    };
    expect(out.error).toBe('boom');
  });

  it('returns {error} when helperRequest rejects', async () => {
    helperRequestMock.mockRejectedValue(new Error('network down'));
    const out = (await executeWorkspaceChatTool('get_file_passages', { q: 'x' })) as {
      error: string;
    };
    expect(out).toEqual({ error: 'network down' });
  });

  it('returns {error} for an unknown tool name', async () => {
    const out = (await executeWorkspaceChatTool('no_such_tool', {})) as { error: string };
    expect(out.error).toContain('no_such_tool');
    expect(helperRequestMock).not.toHaveBeenCalled();
  });

  it('returns {error} when the workspace is not connected', async () => {
    useChatStore.setState({ agentConfig: null });
    const out = (await executeWorkspaceChatTool('search_workspace_files', { q: 'x' })) as {
      error: string;
    };
    expect(typeof out.error).toBe('string');
    expect(helperRequestMock).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiTool } from './aiTools';

const createArtifact = vi.fn();
vi.mock('./artifacts/artifactService', () => ({ createArtifact: (i: unknown) => createArtifact(i) }));
// W01's region accessor — the only region source (reconciliation R1).
// Partially mocked (importOriginal + spread) rather than a bare replacement:
// a transitive import (aiToolsExportDatasets -> aiTools -> aiToolsM365) reads
// other config/env exports (e.g. DELEGANT_BASE_URL), and a bare mock object
// starves them, failing the whole module graph before this test's handler
// ever runs.
vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return { ...actual, breezeRegion: () => 'eu' as const };
});
vi.mock('./aiAgents/runProgress', () => ({ emitRunProgress: vi.fn(async () => undefined) }));

const sanitizeThrownToolError = vi.fn((..._a: unknown[]) => 'sanitized');
vi.mock('./aiToolErrors', () => ({ sanitizeThrownToolError: (...a: unknown[]) => sanitizeThrownToolError(...a) }));

const createPager = vi.fn();
vi.mock('./aiToolsExportDatasets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiToolsExportDatasets')>();
  return {
    ...actual,
    DATASET_ADAPTERS: new Proxy({}, {
      get: () => ({ tier: 1, deviceScoped: false, createPager: (r: unknown) => createPager(r) }),
      has: () => true,
      ownKeys: () => [...actual.EXPORT_DATASETS],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    }),
  };
});

const { registerExportTools } = await import('./aiToolsExport');

/** A run's auth context: the run id rides on the principal (agentAuthContext.ts:78). */
const auth = {
  orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: null,
  principal: { kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' },
  user: { id: 'agent-1' },
} as never;
/** A direct chat/MCP caller: a human principal, so no run to own the artifact. */
const chatAuth = {
  orgId: 'org-1', accessibleOrgIds: ['org-1'], allowedSiteIds: null,
  principal: { kind: 'user', userId: 'u1' },
  user: { id: 'u1' },
} as never;

function getTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerExportTools(map);
  const tool = map.get('export_dataset');
  if (!tool) throw new Error('export_dataset not registered');
  return tool;
}

function pagesOf(pages: Array<{ rows: Array<Record<string, unknown>>; nextCursor: string | null }>) {
  let i = 0;
  return async () => pages[i++] ?? { rows: [], nextCursor: null };
}

describe('export_dataset', () => {
  beforeEach(() => {
    createArtifact.mockReset();
    createPager.mockReset();
    createArtifact.mockImplementation(async (input: { body: NodeJS.ReadableStream }) => {
      const chunks: Buffer[] = [];
      for await (const c of input.body) chunks.push(Buffer.from(c as Buffer));
      const bytes = Buffer.concat(chunks);
      return { id: 'art-1', bytes: bytes.length, sha256: 'sha', headPreview: '', tailPreview: '' };
    });
  });

  it('is Tier 1, capture-exempt and device-gated on deviceIds', () => {
    const tool = getTool();
    expect(tool.tier).toBe(1);
    expect(tool.captureExempt).toBe(true);
    expect(tool.deviceArgs).toEqual(['deviceIds']);
    expect(tool.definition.name).toBe('export_dataset');
  });

  it('pages a three-page source to completion and returns one artifact handle', async () => {
    createPager.mockResolvedValue(pagesOf([
      { rows: [{ id: 1 }, { id: 2 }], nextCursor: 'c1' },
      { rows: [{ id: 3 }], nextCursor: 'c2' },
      { rows: [{ id: 4 }], nextCursor: null },
    ]));
    const tool = getTool();
    const raw = await tool.handler({ dataset: 'event_logs', format: 'jsonl' }, auth, { runTargets: [], stagedBytesRemaining: 1_000_000 });
    const parsed = JSON.parse(raw);
    expect(parsed.artifact.handle).toBe('art-1');
    expect(parsed.artifact.rows).toBe(4);
    expect(parsed.truncated).toBe(false);
    expect(createArtifact).toHaveBeenCalledTimes(1);
    expect(createArtifact.mock.calls[0]![0]).toMatchObject({
      orgId: 'org-1', runId: 'run-1', kind: 'input_capture',
      createdByTool: 'export_dataset', contentType: 'application/x-ndjson', region: 'eu',
    });
  });

  it('stops at the row cap and reports truncated: true', async () => {
    createPager.mockResolvedValue(pagesOf([
      { rows: [{ id: 1 }, { id: 2 }], nextCursor: 'c1' },
      { rows: [{ id: 3 }, { id: 4 }], nextCursor: 'c2' },
    ]));
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler(
      { dataset: 'event_logs', format: 'jsonl', maxRows: 3 }, auth,
      { runTargets: [], stagedBytesRemaining: 1_000_000 },
    ));
    expect(parsed.artifact.rows).toBe(3);
    expect(parsed.truncated).toBe(true);
  });

  it('returns a typed artifact_bytes_exceeded error when the byte cap is crossed', async () => {
    createPager.mockResolvedValue(pagesOf([
      { rows: [{ blob: 'x'.repeat(4096) }], nextCursor: 'more' },
      { rows: [{ blob: 'x'.repeat(4096) }], nextCursor: 'more' },
    ]));
    createArtifact.mockImplementation(async (input: { body: NodeJS.ReadableStream }) => {
      for await (const _ of input.body) { /* drain until the writer throws */ }
      return { id: 'never', bytes: 0 };
    });
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler(
      { dataset: 'event_logs', format: 'jsonl' }, auth,
      { runTargets: [], stagedBytesRemaining: 4096 },
    ));
    expect(parsed.error).toBe('artifact_bytes_exceeded');
  });

  it('treats an exhausted stagedBytesRemaining (0) as zero budget, not "no override"', async () => {
    // 0 is falsy in JS — a naive `context?.stagedBytesRemaining && ...` check
    // would silently grant the full EXPORT_DEFAULT_MAX_BYTES default instead
    // of refusing. W04 sets exactly 0 when a run's staged-byte budget is spent.
    createPager.mockResolvedValue(pagesOf([{ rows: [{ id: 1 }], nextCursor: null }]));
    createArtifact.mockImplementation(async (input: { body: NodeJS.ReadableStream }) => {
      for await (const _ of input.body) { /* drain until the writer throws */ }
      return { id: 'never', bytes: 0 };
    });
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler(
      { dataset: 'event_logs', format: 'jsonl' }, auth,
      { runTargets: [], stagedBytesRemaining: 0 },
    ));
    expect(parsed.error).toBe('artifact_bytes_exceeded');
  });

  it('refuses deviceIds outside the run targets', async () => {
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler(
      { dataset: 'event_logs', deviceIds: ['d1', 'd-outside'] }, auth,
      { runTargets: ['d1'], stagedBytesRemaining: 1_000_000 },
    ));
    expect(parsed.error).toBe('device_outside_run_targets');
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it('allows any caller-reachable deviceIds when the run froze no target set', async () => {
    createPager.mockResolvedValue(pagesOf([{ rows: [{ id: 1 }], nextCursor: null }]));
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler(
      { dataset: 'event_logs', deviceIds: ['d-any'] }, auth,
      { runTargets: [], stagedBytesRemaining: 1_000_000 },
    ));
    expect(parsed.error).toBeUndefined();
  });

  it('takes the run id from the ai_agent principal, not from the context', async () => {
    createPager.mockResolvedValue(pagesOf([{ rows: [{ id: 1 }], nextCursor: null }]));
    const tool = getTool();
    await tool.handler({ dataset: 'event_logs' }, auth, { runTargets: [], stagedBytesRemaining: 1_000_000 });
    expect(createArtifact.mock.calls[0]![0]).toMatchObject({ runId: 'run-1', orgId: 'org-1' });
  });

  it('refuses a direct chat/MCP call with export_requires_run — an artifact needs an owning run', async () => {
    createPager.mockResolvedValue(pagesOf([{ rows: [{ id: 1 }], nextCursor: null }]));
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler({ dataset: 'event_logs' }, chatAuth));
    expect(parsed.error).toBe('export_requires_run');
    expect(createArtifact).not.toHaveBeenCalled();
  });

  it('escapes quotes and newlines in CSV output', async () => {
    createPager.mockResolvedValue(pagesOf([
      { rows: [{ name: 'say "hi"', note: 'a\nb' }], nextCursor: null },
    ]));
    let captured = '';
    createArtifact.mockImplementation(async (input: { body: NodeJS.ReadableStream }) => {
      const chunks: Buffer[] = [];
      for await (const c of input.body) chunks.push(Buffer.from(c as Buffer));
      captured = Buffer.concat(chunks).toString('utf8');
      return { id: 'art-csv', bytes: captured.length };
    });
    const tool = getTool();
    await tool.handler({ dataset: 'event_logs', format: 'csv' }, auth, { runTargets: [], stagedBytesRemaining: 1e6 });
    expect(captured.split('\n')[0]).toBe('"name","note"');
    expect(captured).toContain('"say ""hi"""');
    expect(captured).toContain('a\nb"');
  });

  it('rejects an unknown dataset', async () => {
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler({ dataset: 'passwords' }, auth));
    expect(parsed.error).toBe('unknown_dataset');
  });

  it('logs orgId/runId/dataset context when an unexpected error escapes the handler', async () => {
    sanitizeThrownToolError.mockClear();
    createPager.mockRejectedValueOnce(new Error('boom'));
    const tool = getTool();
    const parsed = JSON.parse(await tool.handler(
      { dataset: 'event_logs' }, auth,
      { runTargets: [], stagedBytesRemaining: 1_000_000 },
    ));
    expect(parsed.error).toBe('export_failed');
    expect(sanitizeThrownToolError).toHaveBeenCalledTimes(1);
    expect(sanitizeThrownToolError.mock.calls[0]![2]).toMatchObject({
      orgId: 'org-1', runId: 'run-1', dataset: 'event_logs',
    });
  });
});

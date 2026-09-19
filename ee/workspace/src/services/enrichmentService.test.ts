import { describe, it, expect, vi } from 'vitest';
import { ExtensionAiError } from '@breeze/extension-sdk';
import type { WorkspaceDatabase } from '../hostTypes';
import {
  buildEnrichmentPrompt, createEnrichmentService, extractJson, type EnrichmentInvoke,
} from './enrichmentService';
import { TransientIngestError, isTransientIngestError } from './ingestErrors';

const ORG = '11111111-1111-1111-1111-111111111111';

function fakeInvoke(reply: string | (() => string)): EnrichmentInvoke {
  return vi.fn(async () => ({
    text: typeof reply === 'function' ? reply() : reply,
  }));
}

const GOOD = JSON.stringify({
  docType: 'easement deed',
  projectKey: '2023-041',
  projectLabel: 'Henderson Water Main Replacement',
  docDate: '2023-10-12',
  confidence: 'high',
  people: [
    { name: 'Kowalski Family Trust', kind: 'org' },
    { name: 'City of Fairoaks', kind: 'org' },
  ],
});

describe('extractJson', () => {
  it('parses bare and fenced JSON objects', () => {
    expect(extractJson('{"a":1}', 't')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```', 't')).toEqual({ a: 1 });
    expect(extractJson('noise before {"a":1} after', 't')).toEqual({ a: 1 });
  });
  it('throws with a labeled error when no object is present', () => {
    expect(() => extractJson('nothing here', 'wsp')).toThrow(/wsp/);
  });
});

describe('buildEnrichmentPrompt', () => {
  it('carries the path, registry, and truncated text', () => {
    const p = buildEnrichmentPrompt({
      relPath: 'Projects/x/scan.md',
      text: 'BODY '.repeat(10_000),
      projects: [{ key: '2023-041', label: 'Henderson Water Main Replacement' }],
    });
    expect(p).toContain('File path: Projects/x/scan.md');
    expect(p).toContain('2023-041 — Henderson Water Main Replacement');
    expect(p.length).toBeLessThan(13_000);
  });
});

describe('classifyOne', () => {
  const db = {} as unknown as WorkspaceDatabase;

  it('returns the validated result for well-formed output', async () => {
    const svc = createEnrichmentService(db, { invoke: fakeInvoke(GOOD) });
    const r = await svc.classifyOne(ORG, 'Projects/x/scan.md', 'text', []);
    expect(r).toMatchObject({ docType: 'easement deed', projectKey: '2023-041', confidence: 'high' });
    expect(r?.people).toHaveLength(2);
  });

  it('calls invoke with the org id, surface tag, and system principal', async () => {
    const invoke = fakeInvoke(GOOD);
    const svc = createEnrichmentService(db, { invoke });
    await svc.classifyOne(ORG, 'a.md', 'text', []);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG,
      surface: 'workspace_enrichment',
      principal: { type: 'system', id: null },
      maxTokens: 1024,
    }));
  });

  it('fails soft (null) on malformed JSON', async () => {
    const svc = createEnrichmentService(db, { invoke: fakeInvoke('not json at all') });
    expect(await svc.classifyOne(ORG, 'a.md', 'text', [])).toBeNull();
  });

  it('fails soft (null) on schema violations', async () => {
    const svc = createEnrichmentService(db, {
      invoke: fakeInvoke(JSON.stringify({ docType: 'x', confidence: 'very sure', people: [] })),
    });
    expect(await svc.classifyOne(ORG, 'a.md', 'text', [])).toBeNull();
  });

  it('fails soft (null) when invoke throws a plain (non-ExtensionAiError) error', async () => {
    const invoke: EnrichmentInvoke = vi.fn(async () => { throw new Error('boom'); });
    const svc = createEnrichmentService(db, { invoke });
    expect(await svc.classifyOne(ORG, 'a.md', 'text', [])).toBeNull();
  });

  it('rethrows ExtensionAiError (ai_unavailable) instead of failing soft', async () => {
    const invoke: EnrichmentInvoke = vi.fn(async () => {
      throw new ExtensionAiError('ai_unavailable', 'BYOK key invalid');
    });
    const svc = createEnrichmentService(db, { invoke });
    await expect(svc.classifyOne(ORG, 'a.md', 'text', [])).rejects.toThrow(ExtensionAiError);
  });

  it('rethrows ExtensionAiError (budget_exceeded) instead of failing soft', async () => {
    const invoke: EnrichmentInvoke = vi.fn(async () => {
      throw new ExtensionAiError('budget_exceeded', 'org over budget');
    });
    const svc = createEnrichmentService(db, { invoke });
    await expect(svc.classifyOne(ORG, 'a.md', 'text', [])).rejects.toThrow(ExtensionAiError);
  });

  it('rethrows ExtensionAiError (rate_limited) instead of failing soft', async () => {
    const invoke: EnrichmentInvoke = vi.fn(async () => {
      throw new ExtensionAiError('rate_limited', 'too fast');
    });
    const svc = createEnrichmentService(db, { invoke });
    await expect(svc.classifyOne(ORG, 'a.md', 'text', [])).rejects.toThrow(ExtensionAiError);
  });
});

describe('run', () => {
  // A minimal fake WorkspaceDatabase whose `execute` answers the three shapes
  // run() issues: the project registry select, the pending-files select, and
  // everything else (per-file insert / remaining count) as empty/zero.
  /** Drizzle's `sql` tagged template doesn't stringify usefully via String()
   * — reassemble the literal text from its queryChunks so the fake can match
   * on the query shape, same as a real driver would see the SQL text. */
  function sqlText(query: unknown): string {
    const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks;
    if (!Array.isArray(chunks)) return '';
    return chunks
      .map((c) => (c && typeof c === 'object' && 'value' in (c as object)
        ? (c as { value: string[] }).value.join('')
        : ''))
      .join(' ');
  }

  function fakeDb(pending: Array<{ id: string; rel_path: string; extracted_text: string }>) {
    const execute = vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes('workspace_projects')) return [];
      if (text.includes('SELECT fi.id, fi.rel_path')) return pending;
      if (text.includes('count(*)')) return [{ n: 0 }];
      return []; // INSERT INTO workspace_file_enrichment / workspace_content_entities
    });
    return { execute } as unknown as WorkspaceDatabase;
  }

  it('aborts the run when invoke throws ExtensionAiError, wrapping it as TransientIngestError with zero files errored', async () => {
    const pending = [
      { id: 'f1', rel_path: 'a.md', extracted_text: 'text a' },
      { id: 'f2', rel_path: 'b.md', extracted_text: 'text b' },
    ];
    const db = fakeDb(pending);
    const invoke: EnrichmentInvoke = vi.fn(async () => {
      throw new ExtensionAiError('ai_unavailable', 'BYOK key invalid');
    });
    const svc = createEnrichmentService(db, { invoke });

    let caught: unknown;
    try {
      await svc.run(ORG, 8);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransientIngestError);
    expect(isTransientIngestError(caught)).toBe(true);
    expect((caught as Error).message).toContain('ai_unavailable');
    // Aborted on the first file: only one invoke call, no per-file error rows.
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('degrades to a drained phase when the deployment has no AI provider at all', async () => {
    const pending = [
      { id: 'f1', rel_path: 'a.md', extracted_text: 'text a' },
      { id: 'f2', rel_path: 'b.md', extracted_text: 'text b' },
    ];
    // count(*) answers non-zero so `remaining: 0` can only come from the
    // short-circuit, never from the fake happening to report a drained queue.
    const execute = vi.fn(async (query: unknown) => {
      const text = sqlText(query);
      if (text.includes('workspace_projects')) return [];
      if (text.includes('SELECT fi.id, fi.rel_path')) return pending;
      if (text.includes('count(*)')) return [{ n: 5 }];
      return [];
    });
    const db = { execute } as unknown as WorkspaceDatabase;
    const invoke: EnrichmentInvoke = vi.fn(async () => {
      throw new ExtensionAiError('not_configured', 'AI is not configured on this deployment.');
    });
    const svc = createEnrichmentService(db, { invoke });

    const result = await svc.run(ORG, 8);

    // No AI configured is the default self-hosted shape, not a failure: report
    // the phase drained so the ingest job advances to crosswalk instead of
    // backing off to max_attempts and killing indexing/crosswalk with it.
    expect(result).toMatchObject({ processed: 0, remaining: 0, errors: [], aiUnavailable: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  /**
   * PERMANENT AI failures drain the phase; TRANSIENT ones abort it.
   *
   * Before this split, every ExtensionAiError became a TransientIngestError:
   * an org that had simply switched AI off, a partner on a plan without AI, or
   * a deployment with a typo'd WORKSPACE_CONTENT_LLM_MODEL burned all
   * `max_attempts`, failed the ingest job, and a fresh job repeated it forever
   * — so indexing and crosswalk never finished either. The classification now
   * comes from the HOST (`ExtensionAiError.permanent`), which is the only side
   * that can tell a rolling daily cap from an "AI is off" switch.
   */
  describe('permanent vs transient AI failures', () => {
    function drainingDb(pending: Array<{ id: string; rel_path: string; extracted_text: string }>) {
      // count(*) answers NON-zero so a `remaining: 0` in the result can only
      // come from the drain short-circuit, never from a fake that happens to
      // report an empty queue.
      const execute = vi.fn(async (query: unknown) => {
        const text = sqlText(query);
        if (text.includes('workspace_projects')) return [];
        if (text.includes('SELECT fi.id, fi.rel_path')) return pending;
        if (text.includes('count(*)')) return [{ n: 5 }];
        return [];
      });
      return { execute } as unknown as WorkspaceDatabase;
    }

    const pending = [
      { id: 'f1', rel_path: 'a.md', extracted_text: 'text a' },
      { id: 'f2', rel_path: 'b.md', extracted_text: 'text b' },
    ];

    it.each([
      ['budget_exceeded', 'AI features are disabled for this organization'],
      ['budget_exceeded', 'AI assistant requires the Community plan.'],
      ['ai_unavailable', 'AI model "claude-hiaku-4-5" is not available for metered extension use.'],
      ['not_configured', 'AI is not configured on this deployment.'],
    ] as const)('drains the phase on a PERMANENT %s', async (code, message) => {
      const db = drainingDb(pending);
      const invoke: EnrichmentInvoke = vi.fn(async () => {
        throw new ExtensionAiError(code, message, { permanent: true });
      });
      const svc = createEnrichmentService(db, { invoke });

      const result = await svc.run(ORG, 8);

      expect(result).toMatchObject({ processed: 0, remaining: 0, errors: [], aiUnavailable: true });
      // Aborted on the FIRST file — the rest of the batch is not burned into
      // model=NULL rows, so they stay re-enrichable if AI comes back.
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['rate_limited', 'Organization rate limit exceeded'],
      ['ai_unavailable', 'AI is unavailable until the partner Anthropic API key is reconnected.'],
      ['budget_exceeded', 'Daily AI budget exceeded ($10.00)'],
    ] as const)('stays TRANSIENT on %s (retrying can still help)', async (code, message) => {
      const db = drainingDb(pending);
      const invoke: EnrichmentInvoke = vi.fn(async () => {
        throw new ExtensionAiError(code, message);
      });
      const svc = createEnrichmentService(db, { invoke });

      const caught = await svc.run(ORG, 8).catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(TransientIngestError);
      expect(isTransientIngestError(caught)).toBe(true);
      expect((caught as Error).message).toContain(code);
      expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('treats an ExtensionAiError with NO permanent field as transient (older host)', async () => {
      // Belt and braces for a host built before the flag existed: `permanent`
      // arriving undefined must never be read as "drain the phase".
      const db = drainingDb(pending);
      const legacyError = Object.assign(
        new Error('BYOK key invalid'),
        { name: 'ExtensionAiError', code: 'ai_unavailable' },
      );
      Object.setPrototypeOf(legacyError, ExtensionAiError.prototype);
      // The field the current constructor would have set, removed.
      delete (legacyError as { permanent?: unknown }).permanent;

      const svc = createEnrichmentService(db, {
        invoke: vi.fn(async () => { throw legacyError; }) as EnrichmentInvoke,
      });

      await expect(svc.run(ORG, 8)).rejects.toBeInstanceOf(TransientIngestError);
    });
  });

  it('still fail-softs a plain Error from invoke into a per-file error, not an abort', async () => {
    const pending = [{ id: 'f1', rel_path: 'a.md', extracted_text: 'text a' }];
    const db = fakeDb(pending);
    const invoke: EnrichmentInvoke = vi.fn(async () => { throw new Error('transient hiccup'); });
    const svc = createEnrichmentService(db, { invoke });

    const result = await svc.run(ORG, 8);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ fileIndexId: 'f1', relPath: 'a.md' });
  });

  it('processes a good invoke reply end to end', async () => {
    const pending = [{ id: 'f1', rel_path: 'a.md', extracted_text: 'text a' }];
    const db = fakeDb(pending);
    const invoke = fakeInvoke(GOOD);
    const svc = createEnrichmentService(db, { invoke });

    const result = await svc.run(ORG, 8);
    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { WorkspaceDatabase } from '../hostTypes';
import {
  buildEnrichmentPrompt, createEnrichmentService, extractJson, type AnthropicLike,
} from './enrichmentService';
import { TransientIngestError, isTransientIngestError } from './ingestErrors';

const ORG = '11111111-1111-1111-1111-111111111111';

function fakeClient(reply: string | (() => string)): AnthropicLike {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: typeof reply === 'function' ? reply() : reply }],
      })),
    },
  };
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
    const svc = createEnrichmentService(db, { client: fakeClient(GOOD), model: 'claude-haiku-4-5' });
    const r = await svc.classifyOne('Projects/x/scan.md', 'text', []);
    expect(r).toMatchObject({ docType: 'easement deed', projectKey: '2023-041', confidence: 'high' });
    expect(r?.people).toHaveLength(2);
  });

  it('fails soft (null) on malformed JSON', async () => {
    const svc = createEnrichmentService(db, { client: fakeClient('not json at all') });
    expect(await svc.classifyOne('a.md', 'text', [])).toBeNull();
  });

  it('fails soft (null) on schema violations', async () => {
    const svc = createEnrichmentService(db, {
      client: fakeClient(JSON.stringify({ docType: 'x', confidence: 'very sure', people: [] })),
    });
    expect(await svc.classifyOne('a.md', 'text', [])).toBeNull();
  });

  it('fails soft (null) when the client throws a plain (statusless) error', async () => {
    const client: AnthropicLike = {
      messages: { create: vi.fn(async () => { throw new Error('rate limited'); }) },
    };
    const svc = createEnrichmentService(db, { client });
    expect(await svc.classifyOne('a.md', 'text', [])).toBeNull();
  });

  function throwingClient(err: unknown): AnthropicLike {
    return { messages: { create: vi.fn(async () => { throw err; }) } };
  }

  it('rethrows an APIError 429 as TransientIngestError (rate cap backs the job off)', async () => {
    const svc = createEnrichmentService(db, { client: throwingClient({ status: 429, message: 'rate' }) });
    await expect(svc.classifyOne('a.md', 'text', [])).rejects.toThrow(TransientIngestError);
    await expect(svc.classifyOne('a.md', 'text', [])).rejects.toSatisfy(isTransientIngestError);
  });

  it('rethrows an APIError >= 500 as TransientIngestError (provider outage)', async () => {
    const svc = createEnrichmentService(db, { client: throwingClient({ status: 503 }) });
    await expect(svc.classifyOne('a.md', 'text', [])).rejects.toThrow(TransientIngestError);
  });

  it('keeps fail-soft null for a non-retryable APIError (e.g. 400)', async () => {
    const svc = createEnrichmentService(db, { client: throwingClient({ status: 400 }) });
    expect(await svc.classifyOne('a.md', 'text', [])).toBeNull();
  });
});

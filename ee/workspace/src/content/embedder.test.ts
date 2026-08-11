import { describe, it, expect, vi } from 'vitest';
import {
  chunkText, FakeEmbedder, VoyageEmbedder, toVectorLiteral, EMBEDDING_DIM,
} from './embedder';

describe('chunkText', () => {
  it('packs paragraphs to ~1200 chars without splitting them', () => {
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} `.repeat(20).trim());
    const chunks = chunkText(paras.join('\n\n'));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1600);
    // nothing lost
    expect(chunks.join(' ')).toContain('Paragraph 9');
  });

  it('hard-splits a monster paragraph', () => {
    const chunks = chunkText('x'.repeat(5000));
    expect(chunks.length).toBe(Math.ceil(5000 / 1200));
  });

  it('returns one chunk for short text and none for empty', () => {
    expect(chunkText('short note')).toEqual(['short note']);
    expect(chunkText('  \n  ')).toEqual([]);
  });
});

describe('FakeEmbedder', () => {
  it('is deterministic, unit-norm, and 1024-dim', async () => {
    const e = new FakeEmbedder();
    const [a1] = await e.embed(['hello']);
    const [a2] = await e.embed(['hello']);
    const [b] = await e.embed(['world']);
    expect(a1).toEqual(a2);
    expect(a1).toHaveLength(EMBEDDING_DIM);
    expect(a1).not.toEqual(b);
    const norm = Math.sqrt(a1.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

describe('VoyageEmbedder', () => {
  it('posts the batch and returns vectors in input order', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { index: 1, embedding: [2, 2] },
        { index: 0, embedding: [1, 1] },
      ],
    }), { status: 200 }));
    const e = new VoyageEmbedder('key', 'voyage-3', 100, fetchImpl as unknown as typeof fetch);
    const out = await e.embed(['a', 'b'], 'document');
    expect(out).toEqual([[1, 1], [2, 2]]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ input: ['a', 'b'], input_type: 'document' });
  });

  it('throws on the soft rate cap rather than hammering the API', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const e = new VoyageEmbedder('key', 'voyage-3', 2, fetchImpl as unknown as typeof fetch);
    await e.embed(['a'], 'query');
    await e.embed(['b'], 'query');
    await expect(e.embed(['c'], 'query')).rejects.toThrow(/voyage_rate_limited/);
  });

  it('surfaces API errors with status', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const e = new VoyageEmbedder('bad', 'voyage-3', 100, fetchImpl as unknown as typeof fetch);
    await expect(e.embed(['a'], 'query')).rejects.toThrow(/401/);
  });
});

describe('toVectorLiteral', () => {
  it('formats a pgvector literal', () => {
    expect(toVectorLiteral([1, -0.5, 0])).toBe('[1,-0.5,0]');
  });
});

// Embeddings for content chunks (dev-preview). Pattern copied from hive's
// colony-memory embedder: a narrow Embedder interface, a Voyage AI
// implementation with a sliding-window soft rate cap, and a deterministic
// FakeEmbedder for tests (FakeEmbedder is acceptable ONLY in plumbing tests —
// never behind a real search result; see the demo gate rules).
import { createHash } from 'node:crypto';

export const EMBEDDING_DIM = 1024;

export interface Embedder {
  /** One vector per input text, EMBEDDING_DIM wide. */
  embed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]>;
}

export class VoyageEmbedder implements Embedder {
  private requestTimestamps: number[] = [];

  constructor(
    private readonly apiKey: string,
    private readonly model = 'voyage-3',
    private readonly requestsPerMinute = 100,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private throttle(): void {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < 60_000);
    if (this.requestTimestamps.length >= this.requestsPerMinute) {
      throw new Error(`voyage_rate_limited:${this.requestTimestamps.length}/${this.requestsPerMinute}rpm`);
    }
    this.requestTimestamps.push(now);
  }

  async embed(texts: string[], inputType: 'document' | 'query'): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.throttle();
    const res = await this.fetchImpl('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: texts, input_type: inputType }),
    });
    if (!res.ok) {
      throw new Error(`voyage embeddings failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = await res.json() as { data: Array<{ index: number; embedding: number[] }> };
    const out: number[][] = new Array(texts.length);
    for (const item of body.data) out[item.index] = item.embedding;
    return out;
  }
}

/** Deterministic sha256-derived unit vectors; plumbing tests only. */
export class FakeEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vec = new Array<number>(EMBEDDING_DIM);
      let seed = createHash('sha256').update(text).digest();
      let offset = 0;
      for (let i = 0; i < EMBEDDING_DIM; i += 1) {
        if (offset >= seed.length) {
          seed = createHash('sha256').update(seed).digest();
          offset = 0;
        }
        vec[i] = (seed[offset] - 127.5) / 127.5;
        offset += 1;
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return vec.map((v) => v / norm);
    });
  }
}

/** Voyage when a key exists, otherwise undefined (vector arm disabled). */
export function buildEmbedder(): Embedder | undefined {
  const key = process.env.VOYAGE_API_KEY;
  return key ? new VoyageEmbedder(key) : undefined;
}

/** pgvector literal for a numeric vector. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

const CHUNK_TARGET = 1200;
const CHUNK_MAX = 1600;

/**
 * Paragraph-aware chunking: split on blank lines, pack paragraphs up to
 * ~CHUNK_TARGET chars, hard-split anything longer than CHUNK_MAX.
 */
export function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  for (const para of paragraphs) {
    if (para.length > CHUNK_MAX) {
      flush();
      for (let i = 0; i < para.length; i += CHUNK_TARGET) {
        chunks.push(para.slice(i, i + CHUNK_TARGET));
      }
      continue;
    }
    if (current.length + para.length + 2 > CHUNK_TARGET && current) flush();
    current = current ? `${current}\n\n${para}` : para;
  }
  flush();
  return chunks;
}

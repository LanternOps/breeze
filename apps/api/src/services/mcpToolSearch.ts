/**
 * BM25 ranking for the MCP `search_tools` meta-tool (#12427, OD-3 A).
 *
 * In-process and dependency-free: a few hundred short documents do not need a
 * search engine. Each tool is one document of four weighted fields — its name,
 * its searchHint, the first sentence of its description and its domain's
 * vocabulary — scored with BM25F-style weighted term frequency (knobs
 * below). An exact name match is pinned first.
 *
 * The catalog is whatever the caller passes in: the route passes exactly the
 * caller's `full` tool list, so nothing outside it can be ranked.
 */
import { DOMAIN_VOCABULARY } from './aiToolIndex';
import { isAiToolDomain } from '@breeze/shared';

export type RankableTool = { name: string; description: string; domain: string; searchHint?: string };

/**
 * Tuned on the golden gate (mcpToolSearch.golden.test.ts) by a grid over
 * k1 ∈ {0.9…2}, b ∈ {0.3…0.75} and the field weights: the best point that
 * keeps the vocabulary field (several neighbours score the same, so it is not
 * a one-case spike). The domain vocabulary is shared
 * by every tool in a domain, so it is weighted low: it helps a query find
 * the right area without drowning the words that tell its tools apart.
 */
const knobs = { k1: 2, b: 0.5, weights: { name: 4, hint: 1, description: 1, vocabulary: 0.5 } } as const;

/** Words that carry no tool-choosing signal in an operator's request. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'at', 'by', 'with', 'from', 'into', 'about',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those', 'there', 'their',
  'me', 'my', 'we', 'our', 'us', 'you', 'your', 'i', 'am', 'do', 'does', 'did', 'have', 'has', 'had',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'can', 'could', 'should', 'would', 'will',
  'please', 'show', 'tell', 'give', 'get', 'any', 'all', 'every', 'some', 'right', 'now', 'today', 'just',
  'up', 'out', 'so', 'if', 'than', 'then', 'too', 'very', 'still', 'last', 'also', 'not', 'no', 'as',
]);

/** Plural and verb-form folding, enough for "patches"/"patch", "devices"/"device", "running"/"run". */
function stem(token: string): string {
  if (token.length < 3) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('sses')) return token.slice(0, -2);
  if (/(ches|shes|xes|zes)$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us') && !token.endsWith('is') && !token.endsWith('os')) return token.slice(0, -1);
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  return token;
}

export function tokenizeForSearch(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
    .map(stem);
}

function firstSentence(description: string): string {
  return description.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? description;
}

type Doc = { name: string; tf: Map<string, number>; length: number };

function buildDoc(tool: RankableTool): Doc {
  const tf = new Map<string, number>();
  let length = 0;
  const add = (text: string | undefined, weight: number) => {
    if (!text) return;
    for (const token of tokenizeForSearch(text)) {
      tf.set(token, (tf.get(token) ?? 0) + weight);
      length += weight;
    }
  };
  add(tool.name.replace(/_/g, ' '), knobs.weights.name);
  add(tool.searchHint, knobs.weights.hint);
  add(firstSentence(tool.description), knobs.weights.description);
  add(isAiToolDomain(tool.domain) ? DOMAIN_VOCABULARY[tool.domain] : undefined, knobs.weights.vocabulary);
  return { name: tool.name, tf, length };
}

/** Catalog names, best match first. `domain` filters before ranking; `limit` defaults to 8. */
export function rankTools(
  catalog: readonly RankableTool[],
  query: string,
  opts: { domain?: string; limit?: number } = {},
): string[] {
  const limit = opts.limit ?? 8;
  const pool = opts.domain === undefined ? catalog : catalog.filter((tool) => tool.domain === opts.domain);
  if (pool.length === 0 || limit <= 0) return [];

  const exact = query.trim().toLowerCase();
  const pinned = pool.find((tool) => tool.name === exact)?.name;

  const docs = pool.map(buildDoc);
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const terms = [...new Set(tokenizeForSearch(query))];
  const df = new Map<string, number>();
  for (const term of terms) df.set(term, docs.filter((doc) => doc.tf.has(term)).length);

  const scored = docs.map((doc) => {
    let score = 0;
    for (const term of terms) {
      const tf = doc.tf.get(term);
      if (!tf) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (knobs.k1 + 1)) / (tf + knobs.k1 * (1 - knobs.b + knobs.b * (doc.length / avgLength))));
    }
    return { name: doc.name, score };
  });

  const ranked = scored
    .filter((row) => row.score > 0 && row.name !== pinned)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'en'))
    .map((row) => row.name);
  return (pinned ? [pinned, ...ranked] : ranked).slice(0, limit);
}

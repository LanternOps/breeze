// Deterministic entity extraction for the content layer.
// The structured types below are owned by THIS regex pass — the LLM enrichment
// pass may only contribute person/org entities. Query-side detection
// (normalizeQueryEntities) reuses the exact same patterns/normalizer so an
// entity typed at ingest always matches the same string typed into search.
export type EntityType =
  | 'apn' | 'po' | 'wdr' | 'invoice' | 'permit' | 'job' | 'license'
  | 'person' | 'org';

export interface ExtractedEntity {
  type: EntityType;
  valueNorm: string;
  valueRaw: string;
}

interface Pattern {
  type: EntityType;
  re: RegExp;
  norm: (m: RegExpMatchArray) => string;
}

// Order matters only for readability; matches are deduped by (type, valueNorm).
const PATTERNS: Pattern[] = [
  // Assessor parcel numbers: 057-071-012 (the "APN" literal is optional).
  { type: 'apn', re: /\b(\d{3}-\d{3}-\d{3})\b/g, norm: (m) => m[1]! },
  // Purchase orders: PO 4021, P.O. #4021, po#4021 — but never a P.O. Box, and
  // never a glued token (PO4021 is a part/lot-number shape, not a PO mention):
  // at least one space/# separator is required before the digits.
  { type: 'po', re: /\bP\.?O\.?[\s#]+(?!Box\b)(\d{3,6})\b/gi, norm: (m) => `PO ${m[1]}` },
  // Water board / waste discharge requirement ids: WDR-2023-0117.
  { type: 'wdr', re: /\bWDR[- ]?(\d{4})[- ]?(\d{4})\b/gi, norm: (m) => `WDR-${m[1]}-${m[2]}` },
  // Agency reference ids like FP-26-1142 (fish passage). WDR is caught above;
  // exclude it here so one mention never lands in two buckets.
  { type: 'permit', re: /\b(?!WDR)([A-Z]{2,3}-\d{2,4}-\d{3,5})\b/g, norm: (m) => m[1]! },
  // Invoices: invoice 8841, Invoice #23-1088, inv 92-311 (separator required —
  // same glued-token rule as PO).
  { type: 'invoice', re: /\binv(?:oice)?\.?[\s#]+(\d{2,4}(?:-\d{3,4})?)\b/gi, norm: (m) => `INV ${m[1]}` },
  // Surveyor license stamps: L.S. 4102, LS 8841. Extracted so the digits can
  // NEVER be mistaken for an invoice/PO (the corpus plants this collision).
  { type: 'license', re: /\bL\.?S\.?[\s#]+(\d{3,5})\b/g, norm: (m) => `LS ${m[1]}` },
  // Job / project numbers: Job 87-143, bare 2023-041 (yyyy-nnn or yy-nnn).
  { type: 'job', re: /\b(\d{2}|\d{4})-(\d{3})\b/g, norm: (m) => `${m[1]}-${m[2]}` },
];

/**
 * Extract typed, normalized entities from document text. Deduped by
 * (type, valueNorm); a job-number match that is part of an APN is dropped.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const seen = new Set<string>();
  const out: ExtractedEntity[] = [];
  const apnSpans: Array<[number, number]> = [];

  for (const p of PATTERNS) {
    for (const m of text.matchAll(p.re)) {
      const index = m.index ?? 0;
      if (p.type === 'apn') apnSpans.push([index, index + m[0].length]);
      // A yy-nnn "job" hit inside an APN span is APN noise, not a job number.
      if (p.type === 'job' && apnSpans.some(([s, e]) => index >= s && index < e)) continue;
      const valueNorm = p.norm(m).toUpperCase().replace(/\s+/g, ' ').trim()
        // preserve APN/job digit groups exactly as matched (norm above), but
        // canonicalize prefixed forms: strip any stray '#'
        .replace(/#/g, '');
      const key = `${p.type}:${valueNorm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: p.type, valueNorm, valueRaw: m[0] });
    }
  }
  return out;
}

/** Query-side entity detection — same patterns, same normalizer as ingest. */
export function normalizeQueryEntities(query: string): Array<Pick<ExtractedEntity, 'type' | 'valueNorm'>> {
  // license/job hits in queries are far more often prose (years, phone
  // fragments) than a deliberate lookup; keep the high-precision types only.
  const QUERY_TYPES: ReadonlySet<EntityType> = new Set(['apn', 'po', 'wdr', 'invoice', 'permit']);
  return extractEntities(query)
    .filter((e) => QUERY_TYPES.has(e.type))
    .map(({ type, valueNorm }) => ({ type, valueNorm }));
}

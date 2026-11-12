/**
 * The wizard's URL state (#8313 W6; spec 2026-10-19 §5.11, CLAUDE.md URL
 * state rule): `#source=<id>&step=<step>`. Both are optional. No source and
 * no step is the source list; `step=connect` without a source connects a new
 * one. Pure: takes the raw hash with its `#` already stripped (useHashState).
 */
export const IMPORT_STEPS = ['connect', 'preflight', 'mappings', 'dry-run', 'window', 'bulk', 'delta', 'close'] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

export type ImportHash = { sourceId: string | null; step: ImportStep | null };
export const DEFAULT_IMPORT_HASH: ImportHash = { sourceId: null, step: null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isImportStep = (value: string): value is ImportStep =>
  (IMPORT_STEPS as readonly string[]).includes(value);

export function parseImportHash(hash: string): ImportHash {
  let sourceId: string | null = null;
  let step: ImportStep | null = null;
  for (const part of hash.replace(/^#/, '').split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = decodeURIComponent(part.slice(eq + 1));
    if (key === 'source' && UUID.test(value)) sourceId = value.toLowerCase();
    else if (key === 'step' && isImportStep(value)) step = value;
  }
  return { sourceId, step };
}

export function formatImportHash({ sourceId, step }: ImportHash): string {
  const parts: string[] = [];
  if (sourceId) parts.push(`source=${sourceId}`);
  if (step) parts.push(`step=${step}`);
  return parts.length > 0 ? `#${parts.join('&')}` : '';
}

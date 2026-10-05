/**
 * W11 (#7609): the quality view tells an automatic flag (a tool error) from a
 * person's flag by the reason prefix the platform writes. Every
 * platform-written `flagReason:` template in the API must start with one of
 * AUTO_FLAG_REASON_PREFIXES, and each prefix must still have a writer, or the
 * flag rate silently counts tool errors as people's flags (or the reverse).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTO_FLAG_REASON_PREFIXES } from './qualityQueries';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

function templates(): Array<{ file: string; literal: string }> {
  const out: Array<{ file: string; literal: string }> = [];
  for (const rel of readdirSync(SRC, { recursive: true }) as string[]) {
    if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
    const text = readFileSync(join(SRC, rel), 'utf8');
    for (const m of text.matchAll(/flagReason:\s*`([^`]*)`/g)) out.push({ file: rel, literal: m[1]! });
  }
  return out;
}

describe('automatic flag reasons', () => {
  const found = templates();
  it('every platform-written flag reason starts with a known prefix', () => {
    expect(found.length).toBeGreaterThanOrEqual(2);
    for (const t of found) {
      expect(AUTO_FLAG_REASON_PREFIXES.some((p) => t.literal.startsWith(p)), `${t.file}: ${t.literal}`).toBe(true);
    }
  });
  it('every prefix still has a writer', () => {
    for (const p of AUTO_FLAG_REASON_PREFIXES) expect(found.some((t) => t.literal.startsWith(p)), p).toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

function fallbackExcludePrefixesSource(): string {
  const match = indexSource.match(
    /const FALLBACK_AUDIT_EXCLUDE_PREFIXES = \[(?<entries>[\s\S]*?)\n\];/,
  );
  if (!match?.groups?.entries) {
    throw new Error('Could not locate FALLBACK_AUDIT_EXCLUDE_PREFIXES');
  }
  return match.groups.entries;
}

describe('time-entry fallback audit exclusion', () => {
  it('excludes the time-entry subtree without excluding unrelated mutations', () => {
    const prefixes = fallbackExcludePrefixesSource();

    expect(prefixes).toContain("'/time-entries'");
    expect(prefixes).not.toContain("'/tickets'");
  });
});

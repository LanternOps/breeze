import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

function fallbackExcludePathsSource(): string {
  const match = indexSource.match(
    /const FALLBACK_AUDIT_EXCLUDE_PATHS: RegExp\[\] = \[(?<entries>[\s\S]*?)\n\];/,
  );
  if (!match?.groups?.entries) {
    throw new Error('Could not locate FALLBACK_AUDIT_EXCLUDE_PATHS');
  }
  return match.groups.entries;
}

// Mirrors the pattern added to FALLBACK_AUDIT_EXCLUDE_PATHS in index.ts. Kept
// as a literal (not eval'd from source) so this test exercises real regex
// behaviour without importing index.ts, which has module-load side effects
// (DB pool creation, server startup).
const WS_TICKET_EXCLUDE_PATTERN = /^\/api\/v1\/events\/ws-ticket$/;

describe('ws-ticket fallback audit exclusion', () => {
  it('is present in FALLBACK_AUDIT_EXCLUDE_PATHS (drift guard)', () => {
    const entries = fallbackExcludePathsSource();
    expect(entries).toContain(WS_TICKET_EXCLUDE_PATTERN.source);
  });

  it('matches the ws-ticket route and only that route', () => {
    expect(WS_TICKET_EXCLUDE_PATTERN.test('/api/v1/events/ws-ticket')).toBe(true);
    expect(WS_TICKET_EXCLUDE_PATTERN.test('/api/v1/events/subscribe')).toBe(false);
    expect(WS_TICKET_EXCLUDE_PATTERN.test('/api/v1/events')).toBe(false);
    expect(WS_TICKET_EXCLUDE_PATTERN.test('/api/v1/events/ws-ticket/extra')).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { transpile } from 'typescript';
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

// Behavioural check against the REAL fallbackAuditEligible + exclusion lists
// (sliced from index.ts source, which cannot be imported: it boots servers).
// Guards both halves of #3991: ws-ticket is not audited, mutating routes are.
describe('fallbackAuditEligible (real source)', () => {
  const start = indexSource.indexOf('const FALLBACK_AUDIT_EXCLUDE_PREFIXES');
  const fnStart = indexSource.indexOf('function fallbackAuditEligible');
  const end = indexSource.indexOf('\n}\n', fnStart) + 3;
  if (start < 0 || fnStart < start) {
    throw new Error('index.ts layout changed: cannot locate fallback audit eligibility code');
  }
  const eligible = new Function(
    transpile(`${indexSource.slice(start, end)}\nreturn fallbackAuditEligible;`),
  )() as (path: string) => boolean;

  it('does not audit the ws-ticket mint', () => {
    expect(eligible('/api/v1/events/ws-ticket')).toBe(false);
  });

  it.each([
    '/api/v1/orgs/123e4567-e89b-42d3-a456-426614174000/billing-settings',
    '/api/v1/quotes/123e4567-e89b-42d3-a456-426614174000/send',
    '/api/v1/alerts/channels',
  ])('still audits mutating route %s', (path) => {
    expect(eligible(path)).toBe(true);
  });
});

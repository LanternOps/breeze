import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  LIVE_SESSION_MAX_DEFER_MS,
  LIVE_SESSION_QUIET_MS,
  clientStubPredicate,
  stubDeletePredicate,
  technicianStubPredicate,
} from './aiTranscriptRetentionPredicates';
import { CLIENT_SESSION_TYPES } from './clientAiHosts';

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q);
const norm = (s: string) => s.replace(/\s+/g, ' ');

const ORG = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-06-01T12:00:00.000Z');
const CUTOFF = '2025-06-01T12:00:00.000Z';

describe('stub predicates', () => {
  it('technician renders NOT IN with every client session type; client renders IN', () => {
    const tech = render(technicianStubPredicate(ORG, CUTOFF, NOW));
    const client = render(clientStubPredicate(ORG, CUTOFF, NOW));
    expect(norm(tech.sql)).toContain('ai_sessions.type NOT IN');
    expect(norm(tech.sql)).not.toMatch(/ai_sessions\.type IN/);
    expect(norm(client.sql)).toMatch(/ai_sessions\.type IN/);
    expect(norm(client.sql)).not.toContain('NOT IN');
    for (const t of CLIENT_SESSION_TYPES) {
      expect(tech.params).toContain(t);
      expect(client.params).toContain(t);
    }
    expect(CLIENT_SESSION_TYPES).toHaveLength(4);
  });

  it.each([
    ['technician', technicianStubPredicate],
    ['client', clientStubPredicate],
  ] as const)('%s renders every eligibility clause against the bare outer table', (_k, build) => {
    const q = render(build(ORG, CUTOFF, NOW));
    const s = norm(q.sql);
    expect(s).toContain('ai_sessions.org_id = $');
    expect(s).toContain('ai_sessions.transcript_purged_at IS NULL');
    expect(s).toContain('ai_sessions.flagged_at IS NULL');
    expect(s).toMatch(/ai_sessions\.status IN \('closed', 'expired'\) OR \(ai_sessions\.status = 'active' AND ai_sessions\.last_activity_at </);
    expect(s).toMatch(/NOT EXISTS \( SELECT 1 FROM ai_messages live WHERE live\.session_id = ai_sessions\.id AND live\.created_at >= /);
    expect(s).toContain("AT TIME ZONE 'UTC'");
    // Never a bare ::timestamp cast on a tz-less column (Review Focus 5).
    expect(s).not.toMatch(/::timestamp(?!tz)/);
    expect(q.params).toContain(ORG);
  });

  it('binds the cutoff, the abandoned-active cutoff and the quiet-window start', () => {
    const q = render(technicianStubPredicate(ORG, CUTOFF, NOW));
    const deferIso = new Date(Date.parse(CUTOFF) - LIVE_SESSION_MAX_DEFER_MS).toISOString();
    const quietIso = new Date(NOW.getTime() - LIVE_SESSION_QUIET_MS).toISOString();
    expect(q.params).toEqual(expect.arrayContaining([CUTOFF, deferIso, quietIso]));
  });

  it('is deterministic: the same inputs render the same SQL and params (report = enforce)', () => {
    expect(render(technicianStubPredicate(ORG, CUTOFF, NOW))).toEqual(render(technicianStubPredicate(ORG, CUTOFF, NOW)));
    expect(render(stubDeletePredicate(ORG, CUTOFF))).toEqual(render(stubDeletePredicate(ORG, CUTOFF)));
  });
});

describe('stubDeletePredicate', () => {
  it('selects only unflagged stubs past the audit cutoff with no screenshots left', () => {
    const q = render(stubDeletePredicate(ORG, CUTOFF));
    const s = norm(q.sql);
    expect(s).toContain('ai_sessions.org_id = $');
    expect(s).toContain('ai_sessions.transcript_purged_at IS NOT NULL');
    expect(s).toContain('ai_sessions.flagged_at IS NULL');
    expect(s).toMatch(/ai_sessions\.last_activity_at < \(\$\d+::timestamptz AT TIME ZONE 'UTC'\)/);
    expect(s).toMatch(/NOT EXISTS \( SELECT 1 FROM ai_screenshots sc WHERE sc\.session_id = ai_sessions\.id \)/);
    expect(q.params).toEqual([ORG, CUTOFF]);
  });
});

/**
 * Renders psaTicketMappingOrgCondition through the REAL Postgres dialect.
 *
 * routes/psa.test.ts mocks the entire db layer, so a malformed sql template
 * there produces a passing test and a runtime 500. That is how
 * `d.org_id = ANY(${orgIds}::uuid[])` shipped to CI: drizzle expands a JS array
 * in a sql template into a comma-separated parameter list, so Postgres saw a
 * record (`cannot cast type record to uuid[]`) — or, with a single element,
 * `malformed array literal`. These tests assert the emitted SQL and parameter
 * binding directly, catching that class in the fast unit job.
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { psaTicketMappingOrgCondition } from './ticketScope';

const dialect = new PgDialect();

function render(orgIds: string[] | null) {
  const condition = psaTicketMappingOrgCondition(orgIds);
  if (!condition) return null;
  const query = dialect.sqlToQuery(condition);
  return { sql: query.sql.replace(/\s+/g, ' ').trim(), params: query.params };
}

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('psaTicketMappingOrgCondition', () => {
  it('returns undefined for system scope (no filter)', () => {
    expect(psaTicketMappingOrgCondition(null)).toBeUndefined();
  });

  it('returns an impossible condition when the caller reaches no orgs', () => {
    const rendered = render([]);
    expect(rendered?.sql).toBe('false');
    expect(rendered?.params).toEqual([]);
  });

  it('binds a SINGLE org as one parameter, not an array literal', () => {
    // The one-element case is what produced `malformed array literal`.
    const rendered = render([ORG_A])!;
    expect(rendered.sql).toContain('IN ($1::uuid)');
    expect(rendered.sql).not.toContain('ANY(');
    expect(rendered.params).toEqual([ORG_A, ORG_A]);
  });

  it('binds MULTIPLE orgs as separate parameters', () => {
    const rendered = render([ORG_A, ORG_B])!;
    expect(rendered.sql).toContain('IN ($1::uuid, $2::uuid)');
    expect(rendered.sql).toContain('IN ($3::uuid, $4::uuid)');
    // Once per anchor (device, then alert).
    expect(rendered.params).toEqual([ORG_A, ORG_B, ORG_A, ORG_B]);
  });

  it('checks BOTH anchors, each null-tolerant, combined with AND', () => {
    const rendered = render([ORG_A])!;
    // A row is withheld if EITHER anchor points outside the caller's orgs...
    expect(rendered.sql).toContain('AND (');
    // ...but an absent anchor never withholds it.
    expect(rendered.sql).toContain('"psa_ticket_mappings"."device_id" IS NULL OR EXISTS');
    expect(rendered.sql).toContain('"psa_ticket_mappings"."alert_id" IS NULL OR EXISTS');
    // Correlated to the outer mapping row, joining devices/alerts for the org.
    expect(rendered.sql).toContain('FROM devices d');
    expect(rendered.sql).toContain('FROM alerts a');
    expect(rendered.sql).toContain('d.id = "psa_ticket_mappings"."device_id"');
    expect(rendered.sql).toContain('a.id = "psa_ticket_mappings"."alert_id"');
  });
});

/**
 * #3258 W03 — portal ticket ownership, on COMPILED SQL.
 *
 * A portal user's own tickets used to be exactly `submitted_by = <their id>`.
 * Once inbound email attributes to a contact instead of a password-less login,
 * a customer who emails support and then logs into the portal would see none
 * of their own tickets: the emailed ones carry `requester_contact_id` and no
 * `submitted_by` at all.
 *
 * The OR arm is conditional, and that condition is the whole test. Drizzle
 * compiles `eq(col, null)` to a literal `= NULL`, which is never true in SQL —
 * a portal user with no linked contact would silently match nothing on that
 * arm, and (worse) the same construction on a broader predicate is how rows go
 * missing without an error. A builder-shape assertion cannot see any of this;
 * only the compiled string and its params can.
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { portalTicketOwnership } from './ticketOwnership';

const dialect = new PgDialect();
const compile = (w: unknown) => dialect.sqlToQuery(w as never);

describe('portalTicketOwnership', () => {
  it('matches EITHER the portal login or the linked contact when the user has one', () => {
    const { sql, params } = compile(portalTicketOwnership({ id: 'pu-1', contactId: 'ct-1' }));

    expect(sql).toMatch(/"tickets"\."submitted_by" = \$\d/);
    expect(sql).toMatch(/"tickets"\."requester_contact_id" = \$\d/);
    expect(sql).toMatch(/\bor\b/i);
    expect(params).toEqual(expect.arrayContaining(['pu-1', 'ct-1']));
  });

  it('omits the contact arm entirely when the user has no linked contact', () => {
    const { sql, params } = compile(portalTicketOwnership({ id: 'pu-1', contactId: null }));

    expect(sql).toMatch(/"tickets"\."submitted_by" = \$\d/);
    // NOT `requester_contact_id = NULL`, which matches nothing and reads as a
    // deliberate filter to anyone auditing the query later.
    expect(sql).not.toMatch(/requester_contact_id/);
    // The PARAMS are the discriminating half. `not.toMatch(/null/i)` cannot
    // see the failure it was written for: `eq(col, null)` compiles to
    // `"requester_contact_id" = $2` with a NULL bound in the params — the word
    // "null" never appears in the SQL text at all.
    expect(params).toEqual(['pu-1']);
    expect(params).not.toContain(null);
    expect(params).not.toContain(undefined);
  });

  it('binds the contact id itself, not a placeholder, when one is present', () => {
    const { params } = compile(portalTicketOwnership({ id: 'pu-1', contactId: 'ct-1' }));
    // Order matters only in so far as both are present and neither is null:
    // a swapped pair would match the wrong column and is caught by the
    // column-name assertions in the first case.
    expect(params).toEqual(['pu-1', 'ct-1']);
  });
});

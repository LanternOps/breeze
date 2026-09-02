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
    expect(sql).not.toMatch(/null/i);
    expect(params).toEqual(['pu-1']);
  });

  it('treats an undefined contactId the same as null (a stale session object)', () => {
    // portalAuth is built by the middleware, but the attachment route reads it
    // through a hand-written cast — a shape that predates the contact link
    // must not compile to `= NULL`.
    const { sql } = compile(portalTicketOwnership({ id: 'pu-1' }));
    expect(sql).not.toMatch(/requester_contact_id/);
  });
});

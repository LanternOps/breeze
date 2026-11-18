/**
 * #8972 W1 Task 1.12 (D1(b), spec §6.1): portalTicketReadAccess = ownership OR
 * "the survivor of a tombstone this user owns". Compiled-SQL assertions; the
 * behaviour on real RLS is portalTicketMerge.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { portalTicketReadAccess } from './ticketReadAccess';
import { portalTicketOwnership } from './ticketOwnership';

const dialect = new PgDialect();
const compile = (s: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(s);

describe('portalTicketReadAccess (#8972 D1(b))', () => {
  it('keeps the ownership arms and adds the merged-survivor arm (login + contact)', () => {
    const q = compile(portalTicketReadAccess({ id: 'pu-1', contactId: 'ct-1' }) as never);
    const own = compile(portalTicketOwnership({ id: 'pu-1', contactId: 'ct-1' }) as never);
    expect(q.sql).toContain(own.sql);
    expect(q.sql).toMatch(/"tickets"\."id" IN \(\s*SELECT t2\.merged_into_ticket_id FROM tickets t2/);
    expect(q.sql).toContain('merged_into_ticket_id IS NOT NULL');
    expect(q.params).toEqual(expect.arrayContaining(['pu-1', 'ct-1']));
  });

  it('a user without a contact gets the login arm only, on both sides (no dead `= NULL`)', () => {
    const q = compile(portalTicketReadAccess({ id: 'pu-2', contactId: null }) as never);
    expect(q.params).toEqual(['pu-2', 'pu-2']);
    expect(q.sql).not.toMatch(/requester_contact_id"? = \$\d+.*requester_contact_id"? = \$\d+/);
  });

  it('a soft-deleted tombstone grants nothing, and the grant never leaves the survivor\'s org', () => {
    const q = compile(portalTicketReadAccess({ id: 'pu-4', contactId: null }) as never);
    expect(q.sql).toContain('t2.deleted_at IS NULL');
    expect(q.sql).toContain('t2.org_id = "tickets"."org_id"');
  });

  it('the survivor arm is keyed on the tombstone\'s requester, never on the survivor\'s', () => {
    const q = compile(portalTicketReadAccess({ id: 'pu-3', contactId: 'ct-3' }) as never);
    expect(q.sql).toContain('t2.submitted_by =');
    expect(q.sql).toContain('t2.requester_contact_id =');
  });
});

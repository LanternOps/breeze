import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { INVOICE_OPEN_STATUSES, TICKET_OPEN_STATUSES, sqlStatusList } from './openWorkStatuses';

describe('openWorkStatuses', () => {
  it('pins the open-ticket vocabulary (mirrors OPEN_STATUSES in routes/tickets/tickets.ts)', () => {
    expect([...TICKET_OPEN_STATUSES]).toEqual(['new', 'open', 'pending', 'on_hold']);
  });

  it('treats every non-draft, non-terminal invoice status as outstanding', () => {
    expect([...INVOICE_OPEN_STATUSES]).toEqual(['sent', 'partially_paid', 'overdue']);
  });

  it('renders a status list as bound parameters, never as literals', () => {
    const query = new PgDialect().sqlToQuery(sql`status in (${sqlStatusList(TICKET_OPEN_STATUSES)})`);
    expect(query.sql).toBe('status in ($1, $2, $3, $4)');
    expect(query.params).toEqual(['new', 'open', 'pending', 'on_hold']);
  });
});

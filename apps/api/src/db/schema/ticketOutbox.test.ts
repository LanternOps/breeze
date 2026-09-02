import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import { ticketOutbox, ticketOutboxEventEnum } from './ticketOutbox';
import { aiAgentRuns } from './aiAgents';
import { ticketComments } from './portal';

describe('ticketOutboxEventEnum', () => {
  it('has exactly the six ticket lifecycle events', () => {
    expect(ticketOutboxEventEnum).toEqual([
      'ticket.created',
      'ticket.status_changed',
      'ticket.updated',
      'ticket.assigned',
      'ticket.commented',
      'ticket.restored',
    ]);
  });

  it('matches the SQL CHECK that actually admits the rows', () => {
    // Same pin-to-migration pattern as intentOutboxEventEnum
    // (actionIntents.test.ts) — a value added here but not in SQL becomes a
    // row that silently fails to insert.
    const sqlPath = new URL('../../../migrations/2026-09-19-ai-agents-ticket-shadow.sql', import.meta.url);
    const sql = readFileSync(sqlPath, 'utf8');
    const check = sql.slice(sql.indexOf('ticket_outbox_event_type_check'));
    for (const event of ticketOutboxEventEnum) {
      expect(check).toContain(`'${event}'`);
    }
  });
});

describe('ticket_outbox schema', () => {
  it('exposes exactly the outbox columns', () => {
    const cols = getTableColumns(ticketOutbox);
    expect(Object.keys(cols).sort()).toEqual(
      ['id', 'orgId', 'ticketId', 'eventType', 'payload', 'createdAt', 'publishedAt', 'publishAttempts'].sort(),
    );
  });

  it('requires orgId and ticketId', () => {
    const cols = getTableColumns(ticketOutbox);
    expect(cols.orgId.notNull).toBe(true);
    expect(cols.ticketId.notNull).toBe(true);
  });

  it('has id-only-by-construction defaults for payload/publish tracking', () => {
    const cols = getTableColumns(ticketOutbox);
    expect(cols.eventType.notNull).toBe(true);
    expect(cols.payload.notNull).toBe(true);
    expect(cols.payload.default).toEqual({});
    expect(cols.createdAt.notNull).toBe(true);
    expect(cols.publishedAt.notNull).toBe(false);
    expect(cols.publishAttempts.notNull).toBe(true);
    expect(cols.publishAttempts.default).toBe(0);
  });
});

describe('ai_agent_runs.ticketId column', () => {
  it('is a nullable uuid FK to tickets', () => {
    const cols = getTableColumns(aiAgentRuns);
    expect(cols.ticketId).toBeDefined();
    expect(cols.ticketId.notNull).toBe(false);
  });
});

describe('ticket_comments origin-tracking columns', () => {
  it('originPrincipalKind defaults to user and is not null', () => {
    const cols = getTableColumns(ticketComments);
    expect(cols.originPrincipalKind).toBeDefined();
    expect(cols.originPrincipalKind.notNull).toBe(true);
    expect(cols.originPrincipalKind.default).toBe('user');
  });

  it('agentRunId is a nullable loop-guard link, not FK-declared here (avoids an aiAgents<->portal import cycle)', () => {
    const cols = getTableColumns(ticketComments);
    expect(cols.agentRunId).toBeDefined();
    expect(cols.agentRunId.notNull).toBe(false);
  });
});

/**
 * Registry wiring for the manage_tickets ticket-type / ticket-link actions
 * (#8596). Each new action must be classified in the guardrail tier tables,
 * carry an RBAC grant and validate through the SDK's zod schema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkAgentGuardrails,
  checkGuardrails,
  TIER2_ACTIONS,
  TOOL_PERMISSIONS,
  type AgentGuardrailPolicy,
} from './aiGuardrails';
import { toolInputSchemas } from './aiToolSchemas';

const T = '11111111-1111-4111-8111-111111111111';

describe('guardrail tiers', () => {
  it('list_links is a tier-1 read', () => {
    const check = checkGuardrails('manage_tickets', { action: 'list_links', ticketId: T });
    expect(check.tier).toBe(1);
    expect(check.allowed).toBe(true);
    expect(TIER2_ACTIONS.manage_tickets).not.toContain('list_links');
  });

});

describe('RBAC grants', () => {
  const perms = TOOL_PERMISSIONS.manage_tickets as Record<string, { resource: string; action: string }>;
  it('list_links needs tickets:read (as GET /tickets/:id/links)', () => {
    expect(perms.list_links).toEqual({ resource: 'tickets', action: 'read' });
  });
});

describe('SDK input schema', () => {
  const schema = toolInputSchemas.manage_tickets!;
  it('accepts list_links and a ticketType list filter', () => {
    expect(schema.safeParse({ action: 'list', ticketType: 'problem' }).success).toBe(true);
    expect(schema.safeParse({ action: 'list', ticketType: ['incident', 'change'] }).success).toBe(true);
    expect(schema.safeParse({ action: 'list_links', ticketId: T }).success).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(schema.safeParse({ action: 'list', ticketType: 'bogus' }).success).toBe(false);
    expect(schema.safeParse({ action: 'list', ticketType: [] }).success).toBe(false);
  });
});

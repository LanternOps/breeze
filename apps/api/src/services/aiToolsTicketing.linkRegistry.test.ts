/**
 * Registry wiring for the manage_tickets ticket-type / ticket-link actions
 * (#8596). Each new action must be classified in the guardrail tier tables,
 * carry an RBAC grant, validate through the SDK's strict zod schema, and the
 * route module must flip from `tool_in_later_wave` to a real tool mapping.
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
import { MCP_COVERAGE } from './mcpCoverage';

const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';

describe('guardrail tiers', () => {
  it('list_links is a tier-1 read', () => {
    const check = checkGuardrails('manage_tickets', { action: 'list_links', ticketId: T });
    expect(check.tier).toBe(1);
    expect(check.allowed).toBe(true);
    expect(TIER2_ACTIONS.manage_tickets).not.toContain('list_links');
  });

  it.each(['link_ticket', 'unlink_ticket'])('%s sits with the other ticket writes (tier 2, no approval)', (action) => {
    expect(TIER2_ACTIONS.manage_tickets).toContain(action);
    const check = checkGuardrails('manage_tickets', { action, ticketId: T });
    expect(check.tier).toBe(2);
    expect(check.requiresApproval).toBe(false);
    // Same tier as comment / assign.
    expect(checkGuardrails('manage_tickets', { action: 'assign', ticketId: T }).tier).toBe(check.tier);
  });
});

describe('RBAC grants', () => {
  const perms = TOOL_PERMISSIONS.manage_tickets as Record<string, { resource: string; action: string }>;
  it('list_links needs tickets:read; link_ticket and unlink_ticket need tickets:write (as the HTTP routes)', () => {
    expect(perms.list_links).toEqual({ resource: 'tickets', action: 'read' });
    expect(perms.link_ticket).toEqual({ resource: 'tickets', action: 'write' });
    expect(perms.unlink_ticket).toEqual({ resource: 'tickets', action: 'write' });
  });
});

describe('a ticket-triggered (device-less, shadow) run cannot link or unlink', () => {
  const POLICY: AgentGuardrailPolicy = {
    enabled: true,
    mode: 'shadow',
    toolAllowlist: ['manage_tickets'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    deviceId: null,
    deviceSiteId: null,
  };
  beforeEach(() => { process.env.BREEZE_AI_AGENTS_ENABLED = 'true'; });
  afterEach(() => { delete process.env.BREEZE_AI_AGENTS_ENABLED; });

  it.each(['link_ticket', 'unlink_ticket'])('%s is denied', (action) => {
    const verdict = checkAgentGuardrails('manage_tickets', { action, ticketId: T, targetTicketId: U, linkType: 'related' }, POLICY);
    expect(verdict.disposition).toBe('deny');
    expect(verdict.allowed).toBe(false);
  });

  it('list_links (a read) is still allowed', () => {
    expect(checkAgentGuardrails('manage_tickets', { action: 'list_links', ticketId: T }, POLICY).disposition).toBe('allow');
  });
});

describe('SDK input schema (strict)', () => {
  const schema = toolInputSchemas.manage_tickets!;
  it('accepts the new actions and inputs', () => {
    expect(schema.safeParse({ action: 'list', ticketType: 'problem' }).success).toBe(true);
    expect(schema.safeParse({ action: 'list', ticketType: ['incident', 'change'] }).success).toBe(true);
    expect(schema.safeParse({ action: 'list_links', ticketId: T }).success).toBe(true);
    expect(schema.safeParse({ action: 'link_ticket', ticketId: T, targetTicketId: U, linkType: 'duplicate_of' }).success).toBe(true);
    expect(schema.safeParse({ action: 'link_ticket', ticketId: T, targetTicketNumber: 'T-2026-0001', linkType: 'related' }).success).toBe(true);
    expect(schema.safeParse({ action: 'unlink_ticket', ticketId: T, linkId: U }).success).toBe(true);
    expect(schema.safeParse({ action: 'create', orgId: T, subject: 's', ticketType: 'change' }).success).toBe(true);
    expect(schema.safeParse({ action: 'update_fields', ticketId: T, fields: { ticketType: 'problem' } }).success).toBe(true);
  });

  it('rejects unknown types and link types', () => {
    expect(schema.safeParse({ action: 'list', ticketType: 'bogus' }).success).toBe(false);
    expect(schema.safeParse({ action: 'list', ticketType: [] }).success).toBe(false);
    expect(schema.safeParse({ action: 'link_ticket', ticketId: T, targetTicketId: U, linkType: 'blocks' }).success).toBe(false);
    expect(schema.safeParse({ action: 'update_fields', ticketId: T, fields: { ticketType: 'bogus' } }).success).toBe(false);
  });
});

describe('mcpCoverage', () => {
  it('routes/tickets/links.ts is covered by manage_tickets', () => {
    expect(MCP_COVERAGE['tickets/links.ts']).toEqual({ tools: ['manage_tickets'] });
  });

  it('no tool_in_later_wave entry still names #8596', () => {
    const stale = Object.entries(MCP_COVERAGE)
      .filter(([, e]) => 'exempt' in e && e.exempt === 'tool_in_later_wave' && /#8596\b/.test(e.note ?? ''))
      .map(([k]) => k);
    expect(stale).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { ticketOpsToolShapes } from './aiToolSchemasTicketOps';
import { toolActionEnum } from './aiToolActions';

// W06 (#6776): the registry input_schema, the toolInputSchemas entry and the SDK shape must agree
// (inputShape() takes the Zod .shape directly, so Zod IS the SDK surface).
const W06_TOOLS = Object.keys(ticketOpsToolShapes);
const UUID = '11111111-1111-4111-8111-111111111111';

describe('W06 ticket-ops tool input schemas', () => {
  it('covers exactly the seven W06 tools', () => {
    expect(W06_TOOLS.sort()).toEqual([
      'manage_ticket_attachments', 'manage_ticket_checklist_templates', 'manage_ticket_config', 'manage_ticket_forms',
      'manage_ticket_inbox', 'manage_ticket_response_templates', 'manage_time_suggestions',
    ]);
  });

  it.each(W06_TOOLS)('%s: registry properties, Zod keys and action enum agree', (name) => {
    const def = aiTools.get(name)!.definition;
    const schema = def.input_schema as { properties: Record<string, { enum?: string[] }>; required?: string[]; additionalProperties?: boolean };
    const zodKeys = Object.keys((toolInputSchemas[name] as unknown as { shape: Record<string, unknown> }).shape).sort();
    expect(Object.keys(schema.properties).sort()).toEqual(zodKeys);
    expect(schema.additionalProperties).toBe(false);
    expect([...(schema.properties.action!.enum ?? [])].sort()).toEqual([...(toolActionEnum(name) ?? [])].sort());
  });

  it.each(W06_TOOLS)('%s: every registry-required key is required by Zod too', (name) => {
    const required = (aiTools.get(name)!.definition.input_schema as { required?: string[] }).required ?? [];
    for (const key of required) {
      const shape = (toolInputSchemas[name] as unknown as { shape: Record<string, { isOptional: () => boolean }> }).shape;
      expect(shape[key]!.isOptional(), `${name}.${key} is required in the registry but optional in Zod`).toBe(false);
    }
  });

  it.each(W06_TOOLS)('%s: lives in the tickets domain at registry tier 1', (name) => {
    const tool = aiTools.get(name)!;
    expect(tool.domain).toBe('tickets');
    expect(tool.tier).toBe(1);
  });

  it.each(W06_TOOLS)('%s rejects an unknown key (strict) and an unknown action', (name) => {
    expect(validateToolInput(name, { action: 'definitely_not_an_action' }).success).toBe(false);
    const first = (toolActionEnum(name) ?? [])[0]!;
    const base = name === 'manage_ticket_attachments' ? { ticketId: UUID } : {};
    expect(validateToolInput(name, { action: first, ...base, surprise: true }).success).toBe(false);
  });

  it('accepts representative valid inputs', () => {
    expect(validateToolInput('manage_ticket_config', { action: 'create_category', data: { name: 'Hardware' } }).success).toBe(true);
    expect(validateToolInput('manage_ticket_config', { action: 'reorder_statuses', ids: [UUID] }).success).toBe(true);
    expect(validateToolInput('manage_ticket_checklist_templates', { action: 'reorder_items', id: UUID, itemIds: [UUID] }).success).toBe(true);
    expect(validateToolInput('manage_ticket_inbox', { action: 'convert', id: UUID, orgId: UUID }).success).toBe(true);
    expect(validateToolInput('manage_ticket_attachments', { action: 'read_content', ticketId: UUID, attachmentId: UUID }).success).toBe(true);
    expect(validateToolInput('manage_ticket_forms', { action: 'available', orgId: UUID }).success).toBe(true);
    expect(validateToolInput('manage_ticket_response_templates', { action: 'delete', id: UUID }).success).toBe(true);
    expect(validateToolInput('manage_time_suggestions', { action: 'list', date: '2026-10-25' }).success).toBe(true);
  });

  it('rejects malformed ids, dates and over-long id lists', () => {
    expect(validateToolInput('manage_ticket_config', { action: 'update_category', id: 'not-a-uuid' }).success).toBe(false);
    expect(validateToolInput('manage_ticket_config', { action: 'reorder_categories', ids: Array(201).fill(UUID) }).success).toBe(false);
    expect(validateToolInput('manage_ticket_attachments', { action: 'list' }).success).toBe(false); // ticketId is required
    expect(validateToolInput('manage_time_suggestions', { action: 'list', date: '25/10/2026' }).success).toBe(false);
  });

  it('manage_tickets takes bulk_update with ticketIds (1-50) and a nullable assigneeId', () => {
    expect(validateToolInput('manage_tickets', { action: 'bulk_update', ticketIds: [UUID], assigneeId: null }).success).toBe(true);
    expect(validateToolInput('manage_tickets', { action: 'bulk_update', ticketIds: [] }).success).toBe(false);
    expect(validateToolInput('manage_tickets', { action: 'bulk_update', ticketIds: Array(51).fill(UUID), priority: 'high' }).success).toBe(false);
  });
});

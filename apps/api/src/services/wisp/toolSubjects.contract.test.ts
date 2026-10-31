import { describe, expect, it } from 'vitest';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { getToolDefinitions } from '../aiTools';
import { subjectRefsOf, WISP_NON_FOCAL_TOOLS, WISP_TOOL_SUBJECTS } from './toolSubjects';

const id = '00000000-0000-4000-8000-000000000001';
const definitions = new Map(getToolDefinitions().map((tool) => [tool.name, tool]));

describe('focal tool subject manifest', () => {
  it('classifies every TOOL_TIERS tool exactly once, with no stale entries', () => {
    const classified = [...Object.keys(WISP_TOOL_SUBJECTS), ...WISP_NON_FOCAL_TOOLS];
    expect(classified.sort()).toEqual(Object.keys(TOOL_TIERS).sort());
    expect(new Set(classified).size).toBe(classified.length);
    expect(Object.values(WISP_TOOL_SUBJECTS).every((subjects) => subjects.length > 0)).toBe(true);
  });

  it('never classifies list, search, query, find or fleet tools as focal', () => {
    expect(Object.keys(WISP_TOOL_SUBJECTS).filter((name) => /^(list_|search_|query_|find_|get_fleet)/.test(name))).toEqual([]);
  });

  it('every subject arg exists in the real tool input schema', () => {
    for (const [name, subjects] of Object.entries(WISP_TOOL_SUBJECTS)) {
      const properties = definitions.get(name)?.input_schema.properties ?? {};
      for (const subject of subjects) expect(properties, `${name}.${subject.arg}`).toHaveProperty(subject.arg);
    }
  });

  it('every focal action is in the real tool action enum', () => {
    for (const [name, subjects] of Object.entries(WISP_TOOL_SUBJECTS)) {
      const action = definitions.get(name)?.input_schema.properties?.action as { enum?: string[] } | undefined;
      for (const subject of subjects) {
        for (const value of subject.actions ?? []) expect(action?.enum, `${name}.${value}`).toContain(value);
      }
    }
  });
});

describe('subjectRefsOf', () => {
  it('ignores manage_tickets list and unknown tools', () => {
    expect(subjectRefsOf('manage_tickets', { action: 'list', ticketId: id })).toEqual([]);
    expect(subjectRefsOf('unknown', { deviceId: id })).toEqual([]);
  });
  it('reads quoteId on send, never from an output or creation action', () => {
    expect(subjectRefsOf('manage_quotes', { action: 'send', quoteId: id })).toEqual([{ kind: 'quote', id }]);
    expect(subjectRefsOf('manage_quotes', { action: 'create_draft', quoteId: id })).toEqual([]);
  });
  it.each(['T-1234', '', 42, null, [id], undefined])('drops a non-GUID id: %s', (deviceId) => {
    expect(subjectRefsOf('get_device_details', { deviceId })).toEqual([]);
  });
  it('accepts GUID-shaped strings and all prescribed ticket focal actions', () => {
    expect(subjectRefsOf('get_device_context', { deviceId: id })).toEqual([{ kind: 'device', id }]);
    for (const action of ['get', 'comment', 'assign', 'update_status', 'update_fields', 'link_device', 'draft', 'log_time_entry']) {
      expect(subjectRefsOf('manage_tickets', { action, ticketId: id })).toEqual([{ kind: 'ticket', id }]);
    }
  });
  it('does not link invoice actions whose subject is a payment or a new draft', () => {
    for (const action of ['create_draft', 'assemble_from_org', 'assemble_from_ticket', 'void_payment']) {
      expect(subjectRefsOf('manage_invoices', { action, invoiceId: id })).toEqual([]);
    }
    expect(subjectRefsOf('manage_invoices', { action: 'issue', invoiceId: id })).toEqual([{ kind: 'invoice', id }]);
  });
});

import { describe, expect, it } from 'vitest';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { getToolDefinitions } from '../aiTools';
import { subjectRefsOf, WISP_NON_FOCAL_TOOLS, WISP_TOOL_SUBJECTS } from './toolSubjects';
import { isNeverDelegableToolAction, WISP_CHAT_CALLABLE_AGENT_DENIED_ACTIONS } from './grantAuthority';
import { AGENT_HUMAN_ONLY_TOOLS } from '../aiToolExposure';
import { TIER3_FOUR_EYES_ACTIONS } from '../aiGuardrails';
import { requiresPinnedEffectDigest } from '../actionIntents/pinnedEffectPolicy';
import { isOrgWideGovernanceIntent } from '../actionIntents/orgWideGovernanceTools';

const id = '00000000-0000-4000-8000-000000000001';
const definitions = new Map(getToolDefinitions().map((tool) => [tool.name, tool]));

describe('focal tool subject manifest', () => {
  it('pins the plan\'s fourteen focal tools by name', () => {
    expect(Object.keys(WISP_TOOL_SUBJECTS).sort()).toEqual([
      'get_ai_agent_run', 'get_contract', 'get_device_context', 'get_device_details',
      'get_invoice', 'get_operator_task', 'get_quote', 'get_site', 'manage_alerts',
      'manage_contracts', 'manage_invoices', 'manage_organizations', 'manage_quotes', 'manage_tickets',
    ]);
  });

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
      const properties = definitions.get(name)?.input_schema.properties as Record<string, { enum?: string[] }> | undefined;
      const action = properties?.action;
      for (const subject of subjects) {
        for (const value of subject.actions ?? []) expect(action?.enum, `${name}.${value}`).toContain(value);
      }
    }
  });
});

describe('subjectRefsOf', () => {
  it('skips actions-bearing subjects when input.action is absent', () => {
    for (const [toolName, subjects] of Object.entries(WISP_TOOL_SUBJECTS)) {
      for (const subject of subjects.filter((subject) => subject.actions)) {
        expect(subjectRefsOf(toolName, { [subject.arg]: id }), toolName).toEqual([]);
      }
    }
  });
  it('matches lowercase actions exactly without normalizing other casing', () => {
    expect(subjectRefsOf('manage_tickets', { action: 'get', ticketId: id })).toEqual([{ kind: 'ticket', id }]);
    expect(subjectRefsOf('manage_tickets', { action: 'GET', ticketId: id })).toEqual([]);
    expect(subjectRefsOf('manage_tickets', { action: 'Get', ticketId: id })).toEqual([]);
  });
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

// #11433: the action-level ceiling floor names the agent-denied actions a human
// may still delegate to Wisp. It is matched by exact action string, so a renamed
// action would silently fall back to "refused"; and it must never open a
// two-approver action (four-eyes, pinned effect digest, org-wide governance).
describe('agent-denied actions a human may call under a Wisp grant (#11433)', () => {
  const actionEnum = (tool: string): string[] =>
    (definitions.get(tool)?.input_schema.properties as Record<string, { enum?: string[] }> | undefined)?.action?.enum ?? [];

  it('pins the reviewed set', () => {
    expect(Object.fromEntries([...WISP_CHAT_CALLABLE_AGENT_DENIED_ACTIONS].map(([tool, actions]) => [tool, [...actions].sort()]))).toEqual({
      manage_fleet_designs: ['applied', 'document', 'preview', 'run'],
    });
  });

  it('every entry is a real tool action that stays agent-denied', () => {
    for (const [tool, actions] of WISP_CHAT_CALLABLE_AGENT_DENIED_ACTIONS) {
      expect(AGENT_HUMAN_ONLY_TOOLS.has(tool), tool).toBe(true);
      for (const action of actions) expect(actionEnum(tool), `${tool}.${action}`).toContain(action);
    }
  });

  it('never opens a four-eyes, pinned-effect or org-wide governance action', () => {
    for (const [tool, actions] of WISP_CHAT_CALLABLE_AGENT_DENIED_ACTIONS) {
      for (const action of actions) {
        expect(TIER3_FOUR_EYES_ACTIONS[tool] ?? [], `${tool}.${action}`).not.toContain(action);
        expect(requiresPinnedEffectDigest(tool, { action }), `${tool}.${action}`).toBe(false);
        expect(isOrgWideGovernanceIntent(tool, { action }), `${tool}.${action}`).toBe(false);
      }
    }
  });

  it('every other action of such a tool stays refused per call', () => {
    for (const [tool, actions] of WISP_CHAT_CALLABLE_AGENT_DENIED_ACTIONS) {
      const all = actionEnum(tool);
      expect(all.length, tool).toBeGreaterThan(actions.size);
      for (const action of all) expect(isNeverDelegableToolAction(tool, action), `${tool}.${action}`).toBe(!actions.has(action));
    }
  });
});

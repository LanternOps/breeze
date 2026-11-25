/**
 * #12453 — `browse_device_event_log` query / get_event on the System and Setup
 * channels run without an approval card in interactive CHAT sessions, the
 * #7906 precedent (`execute_command event_logs_query`) applied to the
 * dedicated event-log tool.
 *
 * Eligible ONLY when ALL hold:
 *   - the action is `query` or `get_event`;
 *   - logName is System or Setup after trimming and case-folding (no
 *     wildcard, no path-style channel, no list);
 *   - the input passes a strict per-action schema (no unknown keys, the
 *     tool's own paging caps, a conservative `source` charset).
 * Everything else — Security, Application, custom channels, a missing
 * logName — and every non-chat principal (MCP, headless agent runs) keeps
 * the Tier 3 approval.
 *
 * NOTE: no vi.mock — needs the REAL aiTools registry for base tiers (same
 * rationale as aiGuardrails.chatEventLogsReadOnly.test.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  checkAgentGuardrails,
  checkGuardrails,
  isReadOnlyResolution,
  TIER2_READONLY_ACTIONS,
  TIER3_ACTIONS,
  type AgentGuardrailPolicy,
} from './aiGuardrails';
import {
  classifyChatReadOnlyDeviceEventLogRead,
  MAX_READONLY_EVENT_LOG_PAGE,
  READONLY_DEVICE_EVENT_LOG_LEVELS,
  READONLY_DEVICE_EVENT_LOG_QUERY_LIMIT,
} from './aiChatEventLogsReadOnly';
import { EVENT_LOG_LEVELS, MAX_EVENT_LOG_PAGE } from './aiToolSchemasDeviceOps';
import { buildMcpToolPresentation, isActionReadOnly } from './mcpToolPresentation';
import { getToolTier } from './aiTools';

const TOOL = 'browse_device_event_log';
const DEVICE = '11111111-1111-4111-8111-111111111111';
const CHAT = { chatSession: true } as const;

const query = (over: Record<string, unknown> = {}) => ({ action: 'query', deviceId: DEVICE, logName: 'System', ...over });
const getEvent = (over: Record<string, unknown> = {}) => ({ action: 'get_event', deviceId: DEVICE, logName: 'System', recordId: 42, ...over });

describe('classifyChatReadOnlyDeviceEventLogRead (#12453)', () => {
  it.each([
    ['System query', query(), { action: 'query', logName: 'System' }],
    ['Setup query', query({ logName: 'Setup' }), { action: 'query', logName: 'Setup' }],
    ['lower-case', query({ logName: 'system' }), { action: 'query', logName: 'System' }],
    ['upper-case', query({ logName: 'SETUP' }), { action: 'query', logName: 'Setup' }],
    ['padded (normalised, canonical name pinned)', query({ logName: '  System\t' }), { action: 'query', logName: 'System' }],
    [
      'every query filter at its cap',
      query({ level: 'warning', source: 'Service Control Manager', eventId: 7036, page: MAX_EVENT_LOG_PAGE, limit: 100 }),
      { action: 'query', logName: 'System', level: 'warning', source: 'Service Control Manager', eventId: 7036, page: MAX_EVENT_LOG_PAGE, limit: 100 },
    ],
    ['hyphenated provider', query({ source: 'Microsoft-Windows-Kernel-General' }), { action: 'query', logName: 'System', source: 'Microsoft-Windows-Kernel-General' }],
    ['System get_event', getEvent(), { action: 'get_event', logName: 'System', recordId: 42 }],
    ['Setup get_event', getEvent({ logName: 'setup', recordId: 0 }), { action: 'get_event', logName: 'Setup', recordId: 0 }],
  ])('eligible: %s', (_label, input, expected) => {
    const pinned = classifyChatReadOnlyDeviceEventLogRead(TOOL, input);
    expect(pinned).not.toBeNull();
    expect(pinned).toEqual(expected);
    expect(Object.isFrozen(pinned)).toBe(true);
  });

  it.each([
    ['Security', query({ logName: 'Security' })],
    ['Application', query({ logName: 'Application' })],
    ['Security get_event', getEvent({ logName: 'Security' })],
    ['Application get_event', getEvent({ logName: 'Application' })],
    ['custom channel', query({ logName: 'MyVendorApp' })],
    ['path-style channel', query({ logName: 'Microsoft-Windows-PowerShell/Operational' })],
    ['path-style under System', query({ logName: 'System/Operational' })],
    ['backslash path', query({ logName: 'System\\Security' })],
    ['wildcard', query({ logName: 'Sys*' })],
    ['wildcard star', query({ logName: '*' })],
    ['prefix match', query({ logName: 'SystemX' })],
    ['inner whitespace', query({ logName: 'Sys tem' })],
    ['zero-width char', query({ logName: 'System​' })],
    ['comma list', query({ logName: 'System,Security' })],
    ['array (list) logName', query({ logName: ['System', 'Security'] })],
    ['array of allowed channels only', query({ logName: ['System'] })],
    ['missing logName', { action: 'query', deviceId: DEVICE }],
    ['missing logName on get_event', { action: 'get_event', deviceId: DEVICE, recordId: 1 }],
    ['empty logName', query({ logName: '' })],
    ['whitespace-only logName', query({ logName: '   ' })],
    ['null logName', query({ logName: null })],
    ['non-string logName', query({ logName: 1 })],
    ['list_logs is not this classifier', { action: 'list_logs', deviceId: DEVICE }],
    ['unknown action', query({ action: 'export' })],
    ['missing action', { deviceId: DEVICE, logName: 'System' }],
    ['unknown extra key', query({ xpath: '*' })],
    ['recordId on a query', query({ recordId: 5 })],
    ['query filter on a get_event', getEvent({ source: 'disk' })],
    ['get_event without recordId', getEvent({ recordId: undefined })],
    ['negative recordId', getEvent({ recordId: -1 })],
    ['fractional recordId', getEvent({ recordId: 1.5 })],
    ['string recordId (no coercion)', getEvent({ recordId: '42' })],
    ['page over the cap', query({ page: MAX_EVENT_LOG_PAGE + 1 })],
    ['page zero', query({ page: 0 })],
    ['limit over the cap', query({ limit: 101 })],
    ['limit zero', query({ limit: 0 })],
    ['string page (no coercion)', query({ page: '2' })],
    ['negative eventId', query({ eventId: -1 })],
    ['unknown level', query({ level: 'debug' })],
    ['numeric level', query({ level: 2 })],
    ['quote injection in source', query({ source: "x'; LogName='Security" })],
    ['double quote in source', query({ source: 'x"y' })],
    ['XPath bracket in source', query({ source: 'x]]or[System' })],
    ['empty source', query({ source: '' })],
    ['overlong source', query({ source: 'a'.repeat(256) })],
    ['non-string deviceId', query({ deviceId: 5 })],
    ['missing deviceId', { action: 'query', logName: 'System' }],
  ])('NOT eligible: %s', (_label, input) => {
    expect(classifyChatReadOnlyDeviceEventLogRead(TOOL, input as Record<string, unknown>)).toBeNull();
  });

  it('only browse_device_event_log qualifies', () => {
    expect(classifyChatReadOnlyDeviceEventLogRead('execute_command', query())).toBeNull();
    expect(classifyChatReadOnlyDeviceEventLogRead('search_logs', query())).toBeNull();
  });

  it('returns a detached copy: mutating the raw input afterwards cannot change the pinned values', () => {
    const input: Record<string, unknown> = query({ source: 'disk' });
    const pinned = classifyChatReadOnlyDeviceEventLogRead(TOOL, input)!;
    input.logName = 'Security';
    input.source = 'other';
    expect(pinned).toEqual({ action: 'query', logName: 'System', source: 'disk' });
  });

  it('the duplicated caps match the tool schema (aiGuardrails may not import aiToolSchemas*)', () => {
    expect([...READONLY_DEVICE_EVENT_LOG_LEVELS].sort()).toEqual([...EVENT_LOG_LEVELS].sort());
    expect(MAX_READONLY_EVENT_LOG_PAGE).toBe(MAX_EVENT_LOG_PAGE);
    expect(READONLY_DEVICE_EVENT_LOG_QUERY_LIMIT).toBe(100);
  });
});

describe('checkGuardrails — chat-session opt-in (#12453)', () => {
  it('the static tables are unchanged: base tier 1, query/get_event Tier 3, list_logs Tier 2 read-only', () => {
    expect(getToolTier(TOOL)).toBe(1);
    expect(TIER3_ACTIONS[TOOL]).toEqual(['query', 'get_event']);
    expect(TIER2_READONLY_ACTIONS[TOOL]).toEqual(['list_logs']);
  });

  it.each([
    ['System query', query({ level: 'error' })],
    ['Setup query', query({ logName: 'Setup' })],
    ['System get_event', getEvent()],
    ['Setup get_event', getEvent({ logName: 'Setup' })],
  ])('%s in a chat session runs without a card (Tier 2 read-only) with the pinned read', (_label, input) => {
    const check = checkGuardrails(TOOL, input, CHAT);
    expect(check.tier).toBe(2);
    expect(check.allowed).toBe(true);
    expect(check.requiresApproval).toBe(false);
    expect(check.readOnly).toBe(true);
    expect(isReadOnlyResolution(TOOL, check)).toBe(true);
    const { deviceId: _deviceId, ...expected } = input;
    expect(check.pinnedDeviceEventLogRead).toEqual(expected);
    expect(check.pinnedEventLogsQuery).toBeUndefined();
  });

  it.each([
    ['Security query', query({ logName: 'Security' })],
    ['Application query', query({ logName: 'Application' })],
    ['Security get_event', getEvent({ logName: 'Security' })],
    ['Application get_event', getEvent({ logName: 'Application' })],
    ['list of channels', query({ logName: ['System', 'Security'] })],
    ['unknown channel', query({ logName: 'MyVendorApp' })],
    ['path-style channel', query({ logName: 'Microsoft-Windows-Sysmon/Operational' })],
    ['wildcard', query({ logName: '*' })],
    ['missing channel', { action: 'query', deviceId: DEVICE }],
    ['missing channel on get_event', { action: 'get_event', deviceId: DEVICE, recordId: 1 }],
    ['unknown key', query({ extra: true })],
  ])('%s still needs approval in a chat session', (_label, input) => {
    const check = checkGuardrails(TOOL, input as Record<string, unknown>, CHAT);
    expect(check.tier).toBe(3);
    expect(check.requiresApproval).toBe(true);
    expect(check.readOnly).toBeUndefined();
    expect(check.pinnedDeviceEventLogRead).toBeUndefined();
  });

  it('list_logs is unchanged (Tier 2 read-only, nothing pinned) with or without the chat opt-in', () => {
    for (const ctx of [CHAT, undefined]) {
      const check = checkGuardrails(TOOL, { action: 'list_logs', deviceId: DEVICE }, ctx);
      expect(check.tier).toBe(2);
      expect(check.readOnly).toBe(true);
      expect(check.pinnedDeviceEventLogRead).toBeUndefined();
    }
  });

  it('without the chat opt-in (MCP, intents, catalog) a System read stays Tier 3', () => {
    for (const ctx of [undefined, {}]) {
      for (const input of [query(), getEvent(), query({ logName: 'Setup' })]) {
        const check = checkGuardrails(TOOL, input, ctx);
        expect(check.tier).toBe(3);
        expect(check.requiresApproval).toBe(true);
        expect(check.pinnedDeviceEventLogRead).toBeUndefined();
      }
    }
  });
});

describe('non-chat principals keep the approval (#12453)', () => {
  const policy: AgentGuardrailPolicy = {
    enabled: true,
    mode: 'act',
    toolAllowlist: [],
    protectedResources: {} as any,
    deviceSiteId: null,
    deviceId: DEVICE,
  } as AgentGuardrailPolicy;

  it('a headless agent run cannot claim the chat opt-in, even if a caller passes it', () => {
    for (const input of [query(), getEvent()]) {
      const check = checkAgentGuardrails(TOOL, input, policy, CHAT as any);
      expect(check.tier).toBe(3);
      expect(check.readOnly).toBeUndefined();
      expect(check.pinnedDeviceEventLogRead).toBeUndefined();
      expect(isReadOnlyResolution(TOOL, check)).toBe(false);
    }
  });

  it('MCP: query and get_event are not annotated read-only', () => {
    expect(isActionReadOnly(TOOL, 'query', 3)).toBe(false);
    expect(isActionReadOnly(TOOL, 'get_event', 3)).toBe(false);
    const presentation = buildMcpToolPresentation({ name: TOOL }, 3, 'devices');
    expect(presentation.annotations.readOnlyHint).toBe(false);
  });
});

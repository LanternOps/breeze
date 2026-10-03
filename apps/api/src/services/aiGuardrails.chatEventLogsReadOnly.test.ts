/**
 * #7906 — payload-aware Tier-2 read-only classification of
 * `execute_command { commandType: 'event_logs_query' }` for interactive CHAT
 * sessions only.
 *
 * Eligible ONLY when ALL hold:
 *   - logName is exactly System or Setup (case-insensitive, no wildcards);
 *   - `query` (the agent's XPath field) is absent;
 *   - the payload passes a strict schema (no unknown keys, bounded paging).
 * Everything else — and every non-chat principal (MCP, headless agent runs)
 * — stays at the tool's base Tier 3.
 *
 * NOTE: no vi.mock — needs the REAL aiTools registry for base tiers (same
 * rationale as aiGuardrails.readonly.contract.test.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  checkAgentGuardrails,
  checkGuardrails,
  isReadOnlyResolution,
  TIER2_READONLY_ACTIONS,
  type AgentGuardrailPolicy,
} from './aiGuardrails';
import { classifyChatReadOnlyEventLogsQuery } from './aiChatEventLogsReadOnly';
import { buildMcpToolPresentation, isActionReadOnly } from './mcpToolPresentation';
import { getToolTier } from './aiTools';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const CHAT = { chatSession: true } as const;

function call(payload: unknown, commandType = 'event_logs_query'): Record<string, unknown> {
  return payload === undefined
    ? { deviceId: DEVICE, commandType }
    : { deviceId: DEVICE, commandType, payload };
}

describe('classifyChatReadOnlyEventLogsQuery (#7906)', () => {
  it.each([
    [{ logName: 'System' }],
    [{ logName: 'Setup' }],
    [{ logName: 'system' }],
    [{ logName: 'SETUP' }],
    [{ logName: 'System', level: 'warning', source: 'Service Control Manager', eventId: 7036, page: 2, limit: 100 }],
    [{ logName: 'System', level: 3 }],
    [{ logName: 'System', source: 'Microsoft-Windows-Kernel-General' }],
  ])('eligible: %j', (payload) => {
    const pinned = classifyChatReadOnlyEventLogsQuery('execute_command', call(payload));
    expect(pinned).not.toBeNull();
    expect(pinned!.payload).toEqual(payload);
  });

  it.each([
    ['Application', { logName: 'Application' }],
    ['Security', { logName: 'Security' }],
    ['PowerShell operational', { logName: 'Microsoft-Windows-PowerShell/Operational' }],
    ['Sysmon', { logName: 'Microsoft-Windows-Sysmon/Operational' }],
    ['custom channel', { logName: 'MyVendorApp' }],
    ['wildcard', { logName: 'Sys*' }],
    ['wildcard star', { logName: '*' }],
    ['padded logName', { logName: ' System' }],
    ['trailing space', { logName: 'System ' }],
    ['prefix match', { logName: 'SystemX' }],
    ['missing logName (agent would default to System)', {}],
    ['missing payload entirely', undefined],
    ['non-string logName', { logName: 1 }],
    ['array logName', { logName: ['System'] }],
    ['null payload', null],
    ['array payload', [{ logName: 'System' }]],
    ['XPath query', { logName: 'System', query: '*[System[(Level=2)]]' }],
    ['empty XPath query', { logName: 'System', query: '' }],
    [
      'QueryList selecting Security under logName System',
      { logName: 'System', query: '<QueryList><Query><Select Path="Security">*</Select></Query></QueryList>' },
    ],
    ['unknown extra field', { logName: 'System', recordId: 5 }],
    ['passthrough-style extra field', { logName: 'System', path: 'C:\\' }],
    ['page over the agent cap', { logName: 'System', page: 21 }],
    ['page zero', { logName: 'System', page: 0 }],
    ['limit over the cap', { logName: 'System', limit: 501 }],
    ['limit zero', { logName: 'System', limit: 0 }],
    ['fractional page', { logName: 'System', page: 1.5 }],
    ['string page (no coercion)', { logName: 'System', page: '2' }],
    ['negative eventId', { logName: 'System', eventId: -1 }],
    ['unknown level', { logName: 'System', level: 'debug' }],
    ['out-of-range level', { logName: 'System', level: 9 }],
    // Escaping: a quote-injection attempt never qualifies.
    ['quote injection in logName', { logName: "System'; Get-WinEvent -LogName 'Security" }],
    ['quote injection in source', { logName: 'System', source: "x'; LogName='Security" }],
    ['double quote in source', { logName: 'System', source: 'x"y' }],
    ['backtick in source', { logName: 'System', source: 'x`$(whoami)' }],
    ['semicolon in source', { logName: 'System', source: 'a;b' }],
    ['overlong source', { logName: 'System', source: 'a'.repeat(256) }],
  ])('NOT eligible: %s', (_label, payload) => {
    expect(classifyChatReadOnlyEventLogsQuery('execute_command', call(payload))).toBeNull();
  });

  it('only event_logs_query qualifies', () => {
    expect(classifyChatReadOnlyEventLogsQuery('execute_command', call({ logName: 'System' }, 'file_read'))).toBeNull();
    expect(classifyChatReadOnlyEventLogsQuery('execute_command', call({ logName: 'System' }, 'kill_process'))).toBeNull();
    expect(classifyChatReadOnlyEventLogsQuery('run_script', call({ logName: 'System' }))).toBeNull();
  });

  it('returns a detached copy — later mutation of the raw input cannot change the pinned values', () => {
    const raw = { logName: 'System', source: 'disk' };
    const input = call(raw);
    const pinned = classifyChatReadOnlyEventLogsQuery('execute_command', input)!;
    raw.logName = 'Security';
    (input as any).payload = { logName: 'Security' };
    expect(pinned.payload).toEqual({ logName: 'System', source: 'disk' });
    expect(Object.isFrozen(pinned.payload)).toBe(true);
  });
});

describe('checkGuardrails — chat-session opt-in (#7906)', () => {
  it('base tier of execute_command is still 3', () => {
    expect(getToolTier('execute_command')).toBe(3);
  });

  it.each(['System', 'Setup'])('%s in a chat session resolves Tier 2 read-only with the pinned payload', (logName) => {
    const check = checkGuardrails('execute_command', call({ logName, level: 'error' }), CHAT);
    expect(check.tier).toBe(2);
    expect(check.requiresApproval).toBe(false);
    expect(check.readOnly).toBe(true);
    expect(isReadOnlyResolution('execute_command', check)).toBe(true);
    expect(check.pinnedEventLogsQuery?.payload).toEqual({ logName, level: 'error' });
  });

  it.each([
    { logName: 'Application' },
    { logName: 'Security' },
    { logName: 'System', query: '<QueryList><Query><Select Path="Security">*</Select></Query></QueryList>' },
    { logName: 'System', extra: true },
    {},
  ])('ineligible payload stays Tier 3 even in a chat session: %j', (payload) => {
    const check = checkGuardrails('execute_command', call(payload), CHAT);
    expect(check.tier).toBe(3);
    expect(check.requiresApproval).toBe(true);
    expect(check.readOnly).toBeUndefined();
    expect(check.pinnedEventLogsQuery).toBeUndefined();
  });

  it('without the chat opt-in (MCP, intents, catalog) an eligible payload stays Tier 3', () => {
    const check = checkGuardrails('execute_command', call({ logName: 'System' }));
    expect(check.tier).toBe(3);
    expect(check.pinnedEventLogsQuery).toBeUndefined();
    const withProposalCtx = checkGuardrails('execute_command', call({ logName: 'System' }), {});
    expect(withProposalCtx.tier).toBe(3);
  });

  it('the opt-in never relaxes any other commandType', () => {
    for (const commandType of ['file_read', 'list_services', 'kill_process', 'start_service']) {
      const check = checkGuardrails('execute_command', call({ logName: 'System' }, commandType), CHAT);
      expect(check.tier).toBe(3);
    }
  });
});

describe('non-chat principals stay Tier 3 (#7906)', () => {
  const policy: AgentGuardrailPolicy = {
    enabled: true,
    mode: 'act',
    toolAllowlist: [],
    protectedResources: {} as any,
    deviceSiteId: null,
    deviceId: DEVICE,
  } as AgentGuardrailPolicy;

  it('a headless agent run cannot claim the chat opt-in, even if a caller passes it', () => {
    const check = checkAgentGuardrails('execute_command', call({ logName: 'System' }), policy, CHAT as any);
    expect(check.tier).toBe(3);
    expect(check.readOnly).toBeUndefined();
    expect(check.pinnedEventLogsQuery).toBeUndefined();
    expect(isReadOnlyResolution('execute_command', check)).toBe(false);
  });

  it('MCP: the effective tier (max of base and guardrail tier) stays 3 and the tool is not annotated read-only', () => {
    const check = checkGuardrails('execute_command', call({ logName: 'System' }));
    expect(Math.max(getToolTier('execute_command')!, check.tier)).toBe(3);
    expect(isActionReadOnly('execute_command', 'event_logs_query', 3)).toBe(false);
    const presentation = buildMcpToolPresentation({ name: 'execute_command' }, 3, 'scripts');
    expect(presentation.annotations.readOnlyHint).toBe(false);
  });

  it('event_logs_query is NOT on the static TIER2_READONLY_ACTIONS allowlist', () => {
    expect(TIER2_READONLY_ACTIONS.execute_command).not.toContain('event_logs_query');
  });
});

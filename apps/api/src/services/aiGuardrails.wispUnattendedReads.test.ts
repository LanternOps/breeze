/**
 * #10973 / Wisp delegation W3 — the guardrail half of the unattended-reads
 * switch. `wispUnattendedReads` only lowers a Security `event_logs_query` from
 * Tier 3 to Tier 2 for a chat session; registry reads and set_device_context are
 * Tier 2 already, and the card skip belongs to the chat gate.
 *
 * NOTE: no vi.mock — needs the REAL aiTools registry for base tiers (same
 * rationale as aiGuardrails.chatEventLogsReadOnly.test.ts).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  checkAgentGuardrails,
  checkGuardrails,
  TIER1_ACTIONS,
  TIER2_READONLY_ACTIONS,
  TIER2_READONLY_TOOLS,
  type AgentGuardrailPolicy,
} from './aiGuardrails';
import { getToolTier } from './aiTools';
import { classifyWispUnattendedRead } from './wisp/unattendedReads';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const ON = { chatSession: true, wispUnattendedReads: true } as const;

const security = (payload: Record<string, unknown> = {}) => ({
  deviceId: DEVICE,
  commandType: 'event_logs_query',
  payload: { logName: 'Security', ...payload },
});
const XPATH = '*[System[(EventID=4625 or EventID=4624) and TimeCreated[timediff(@SystemTime) <= 86400000]]]';

describe('checkGuardrails with the switch on', () => {
  it('lowers a grammar-valid Security query to Tier 2, not read-only, with the classified call', () => {
    const check = checkGuardrails('execute_command', security({ query: XPATH }), ON);
    expect(check).toMatchObject({ tier: 2, allowed: true, requiresApproval: false });
    expect(check.readOnly).toBeUndefined();
    expect(check.wispUnattendedRead).toMatchObject({
      kind: 'security_event_query',
      tool: 'execute_command',
      pinned: { deviceId: DEVICE, commandType: 'event_logs_query', payload: { logName: 'Security', query: XPATH } },
    });
  });

  it('a filter-only Security query qualifies too', () => {
    expect(checkGuardrails('execute_command', security({ eventId: 4625 }), ON).tier).toBe(2);
  });

  it.each([
    ['a QueryList selector', security({ query: '<QueryList><Query Path="Microsoft-Windows-Sysmon/Operational"><Select>*</Select></Query></QueryList>' })],
    ['EventData', security({ query: "*[EventData[Data[@Name='TargetUserName']='x']]" })],
    ['a padded channel', { deviceId: DEVICE, commandType: 'event_logs_query', payload: { logName: 'Security ' } }],
    ['another channel', { deviceId: DEVICE, commandType: 'event_logs_query', payload: { logName: 'Microsoft-Windows-Sysmon/Operational' } }],
    ['a query plus a filter', security({ query: XPATH, eventId: 1 })],
    ['an over-limit read', security({ limit: 501 })],
    ['another command', { deviceId: DEVICE, commandType: 'kill_process', payload: { pid: 1 } }],
  ])('%s stays Tier 3', (_label, input) => {
    const check = checkGuardrails('execute_command', input, ON);
    expect(check.tier).toBe(3);
    expect(check.wispUnattendedRead).toBeUndefined();
  });

  it('never changes a registry write', () => {
    for (const action of ['set_value', 'create_key', 'delete_key']) {
      expect(checkGuardrails('registry_operations', { action, deviceId: DEVICE, keyPath: 'HKLM\\A', valueName: 'b', valueData: 'c' }, ON).tier).toBe(3);
    }
  });

  it('leaves the System/Setup read-only classification alone', () => {
    const check = checkGuardrails('execute_command', { deviceId: DEVICE, commandType: 'event_logs_query', payload: { logName: 'System' } }, ON);
    expect(check).toMatchObject({ tier: 2, readOnly: true });
    expect(check.wispUnattendedRead).toBeUndefined();
  });
});

describe('the real tiers the chat gate depends on', () => {
  it.each([
    ['registry read_key', 'registry_operations', { action: 'read_key', deviceId: DEVICE, keyPath: 'HKLM\\SOFTWARE' }],
    ['registry get_value', 'registry_operations', { action: 'get_value', deviceId: DEVICE, keyPath: 'HKLM\\SOFTWARE', valueName: 'Path' }],
    ['Security query', 'execute_command', security({ query: XPATH })],
    ['device note', 'set_device_context', { deviceId: DEVICE, contextType: 'issue', summary: 'Disk is failing' }],
  ])('%s is Tier 2 and classified with the switch on', (_label, tool, input) => {
    expect(checkGuardrails(tool, input, ON)).toMatchObject({ tier: 2, allowed: true });
    expect(classifyWispUnattendedRead(tool, input)).not.toBeNull();
  });
});

describe('the flag reaches nothing else', () => {
  it('no context: MCP and every other non-chat caller keep Tier 3 and a non-read-only registry read', () => {
    expect(checkGuardrails('execute_command', security({ query: XPATH })).tier).toBe(3);
    const read = checkGuardrails('registry_operations', { action: 'read_key', deviceId: DEVICE, keyPath: 'HKLM\\A' });
    expect(read.tier).toBe(2);
    expect(read.readOnly).toBeUndefined();
    expect(getToolTier('registry_operations')).toBe(2);
  });

  it('a chat session with the switch off keeps Tier 3', () => {
    expect(checkGuardrails('execute_command', security({ query: XPATH }), { chatSession: true }).tier).toBe(3);
  });

  it('the flag without a chat session does nothing', () => {
    expect(checkGuardrails('execute_command', security({ query: XPATH }), { wispUnattendedReads: true }).tier).toBe(3);
  });

  it('checkAgentGuardrails strips it: the same disposition with or without', () => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
    try {
      const policy = {
        enabled: true, mode: 'shadow', toolAllowlist: ['execute_command', 'registry_operations'],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        deviceId: DEVICE, deviceSiteId: null,
      } as unknown as AgentGuardrailPolicy;
      const input = security({ query: XPATH });
      const withFlag = checkAgentGuardrails('execute_command', input, policy, { wispUnattendedReads: true, chatSession: true });
      const without = checkAgentGuardrails('execute_command', input, policy);
      expect(withFlag).toEqual(without);
      expect(withFlag).toMatchObject({ tier: 3, disposition: 'propose' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the static read-only and Tier-1 tables are untouched', () => {
    expect(TIER2_READONLY_ACTIONS.registry_operations).toBeUndefined();
    expect(TIER2_READONLY_ACTIONS.execute_command ?? []).not.toContain('event_logs_query');
    expect(TIER2_READONLY_TOOLS.has('set_device_context')).toBe(false);
    expect(TIER1_ACTIONS.registry_operations).toBeUndefined();
    expect(TIER1_ACTIONS.execute_command).toBeUndefined();
  });

  it('only the chat gate sets the flag; the MCP server and routes never mention it', () => {
    const routeDir = new URL('../routes/', import.meta.url);
    const mcpFiles = readdirSync(routeDir).filter((f) => f.startsWith('mcpServer') && f.endsWith('.ts') && !f.includes('.test.'));
    expect(mcpFiles.length).toBeGreaterThan(0);
    for (const file of mcpFiles) {
      expect(readFileSync(new URL(file, routeDir), 'utf8'), file).not.toContain('wispUnattendedRead');
    }
    expect(readFileSync(new URL('./aiAgents/runLoop.ts', import.meta.url), 'utf8')).not.toContain('wispUnattendedReads:');
  });
});

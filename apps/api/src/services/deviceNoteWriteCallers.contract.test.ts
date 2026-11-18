/**
 * CONTRACT — every path that can write a device note (`set_device_context`)
 * with no person approving it is bounded (#12140, #12161).
 *
 * The bounds (deviceNoteBounds.ts) are opt-in: a dispatcher pins
 * `unattendedNoteWrite` through `unattendedNoteWriteContext`, or a gate pins a
 * Wisp unattended read / the chat card-free flag. A new dispatcher that pins
 * none writes unbounded notes, so every module that references `executeTool`
 * (the one door to the tool handler) must be classified here:
 *   - BOUNDED: runs tools with no approval step, and must pass
 *     `unattendedNoteWriteContext(` to `executeTool`;
 *   - GATED: runs only what a pre-tool gate allowed, with the gate's context;
 *     the gate decides approved vs bounded (proved below for agent runs);
 *   - APPROVED: runs only a call a person approved;
 *   - NO_NOTE: cannot reach `set_device_context` (proved below where it is
 *     cheap to prove).
 * An unclassified module fails; a stale entry fails.
 *
 * Reads the source tree (comments stripped) plus the real guardrail tables;
 * no vi.mock. The handler/service bound itself is proved on Postgres in
 * integration/unattendedNoteBounds.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

import { checkAgentGuardrails, checkGuardrails, type AgentGuardrailPolicy } from './aiGuardrails';
import { resolveActOperation } from './aiAgents/actManifest';
import { TROUBLESHOOT_PROPOSABLE_TOOLS } from './aiAgents/troubleshootProfile';
import { unattendedNoteWriteContext } from './deviceNoteBounds';
import { SCRIPT_BUILDER_HANDLER_BY_MCP_TOOL, SCRIPT_BUILDER_TOOL_TIERS } from './scriptBuilderTools';

const SRC = resolve(import.meta.dirname, '..');
const EE = resolve(import.meta.dirname, '../../../../ee');
const NOTE_TOOL = 'set_device_context';

type Kind = 'bounded' | 'gated' | 'approved' | 'no_note';

/** Module (relative to apps/api/src, or `ee/...`) -> how its executeTool calls reach a note. */
const CALLERS: Record<string, { kind: Kind; why: string }> = {
  'routes/mcpServer.ts': {
    kind: 'bounded',
    why: 'direct Tier-2 MCP dispatch has no approval card (#12140)',
  },
  'services/flows/stepExecutor.ts': {
    kind: 'bounded',
    why: 'a Tier-1/2 flow step runs unattended; only Tier 3 parks (#12161)',
  },
  'services/aiAgentSdkTools.ts': {
    kind: 'gated',
    why: 'the SDK tool handler for chat sessions and agent runs; it runs only what createSessionPreToolUse / '
      + 'the run loop hook allowed, with that gate\'s context: a chat card or plan step or auto-approve mode '
      + '(approved), the card-free path (aiNoteWrites.ts bounds), a Wisp unattended read (bounded); an agent '
      + 'run outside a grant only proposes (below)',
  },
  'jobs/intentReleaseWorker.ts': {
    kind: 'approved',
    why: 'releases an action intent a person approved; a Tier-2 intent is never policy-decided',
  },
  'services/scriptBuilderTools.ts': {
    kind: 'no_note',
    why: 'the script builder exposes its own tool set, which has no note tool (below)',
  },
  'services/flows/builtins/aiStep.ts': {
    kind: 'no_note',
    why: 'a flow ai step runs only Tier-1 core tools; set_device_context is Tier 2 (below)',
  },
  'services/aiAgents/playbookActExecutor.ts': {
    kind: 'no_note',
    why: 'runs built-in playbooks only; an act step must match the act manifest, which has no note op (below)',
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '__snapshots__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function key(file: string): string {
  return file.startsWith(EE) ? `ee/${relative(EE, file)}` : relative(SRC, file);
}

function discoverCallers(): Map<string, string> {
  const files = [...walk(SRC), ...(existsSync(EE) ? walk(EE) : [])];
  const found = new Map<string, string>();
  for (const file of files) {
    const k = key(file);
    if (k === 'services/aiTools.ts') continue; // the definition
    const code = stripComments(readFileSync(file, 'utf8'));
    if (/\bexecuteTool\b/.test(code)) found.set(k, code);
  }
  return found;
}

describe('device-note write callers', () => {
  const callers = discoverCallers();

  it('discovers the callers it is meant to (the scan works)', () => {
    expect(callers.has('routes/mcpServer.ts')).toBe(true);
    expect(callers.has('services/flows/stepExecutor.ts')).toBe(true);
  });

  it('every module that references executeTool is classified', () => {
    const unclassified = [...callers.keys()].filter((k) => !(k in CALLERS)).sort();
    expect(unclassified, 'classify each new executeTool caller in CALLERS (see header)').toEqual([]);
  });

  it('no classified module is stale', () => {
    const stale = Object.keys(CALLERS).filter((k) => !callers.has(k)).sort();
    expect(stale).toEqual([]);
  });

  it.each(Object.entries(CALLERS).filter(([, c]) => c.kind === 'bounded').map(([k]) => k))(
    '%s passes the unattended-note context to executeTool',
    (k) => {
      expect(callers.get(k)).toMatch(/unattendedNoteWriteContext\(/);
    },
  );

  it('the unattended-note context covers exactly the note tool', () => {
    expect(unattendedNoteWriteContext(NOTE_TOOL)).toEqual({ unattendedNoteWrite: true });
    expect(unattendedNoteWriteContext('get_device_details')).toBeUndefined();
    expect(unattendedNoteWriteContext('resolve_device_context')).toBeUndefined();
  });
});

describe('NO_NOTE callers cannot reach set_device_context', () => {
  it('flow ai step: set_device_context is not Tier 1', () => {
    const check = checkGuardrails(NOTE_TOOL, {
      deviceId: '44444444-4444-4444-8444-444444444444', contextType: 'issue', summary: 's',
    });
    expect(check.tier).not.toBe(1);
  });

  it('script builder: no tool is, or dispatches to, set_device_context', () => {
    expect(Object.keys(SCRIPT_BUILDER_TOOL_TIERS)).not.toContain(NOTE_TOOL);
    expect(Object.values(SCRIPT_BUILDER_HANDLER_BY_MCP_TOOL)).not.toContain(NOTE_TOOL);
  });

  it('playbook act steps: the act manifest has no note operation', () => {
    expect(resolveActOperation(NOTE_TOOL, { deviceId: 'dev-1', contextType: 'issue', summary: 's' })).toBeNull();
  });
});

describe('agent runs outside a Wisp grant: a note is always a proposal a person approves', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const policy = (mode: 'shadow' | 'act'): AgentGuardrailPolicy => ({
    enabled: true,
    mode,
    toolAllowlist: [NOTE_TOOL],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    deviceSiteId: 'site-a',
    deviceId: 'dev-1',
  });

  it('a troubleshooting run may only propose a note', () => {
    expect(TROUBLESHOOT_PROPOSABLE_TOOLS).toContain(NOTE_TOOL);
  });

  // The run loop executes only 'allow' and 'act'; 'propose' becomes an action
  // intent a person decides (the Wisp unattended-reads switch is the only way
  // past it, and that pins the bounded `device_context` read).
  it.each(['shadow', 'act'] as const)('%s mode: even allowlisted, set_device_context is propose, never allow/act', (mode) => {
    const check = checkAgentGuardrails(NOTE_TOOL, { deviceId: 'dev-1', contextType: 'issue', summary: 's' }, policy(mode));
    expect(check.disposition).toBe('propose');
    expect(check.allowed).toBe(false);
  });
});

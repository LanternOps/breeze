import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aiTools, toolManagesDbContext } from './aiTools';

/**
 * Contract (#7918): an AI tool whose handler WAITS on a device-command result
 * must not hold the per-call DB transaction across that wait.
 *
 * By default the chat/agent SDK wrapper, the MCP route and the intent-release
 * worker run every tool call inside ONE `withDbAccessContext` transaction. A
 * handler that then polls for a device result keeps that pooled connection
 * idle in transaction for the whole wait, and production Postgres kills a
 * session idle in transaction for one minute (`idle_in_transaction_session_timeout`).
 * `run_script` waited 60 s per device that way: every script longer than a
 * minute "failed" with CONNECTION_CLOSED while it completed on the device.
 * `runOutsideDbContext` around the wait does NOT help — it re-routes new
 * queries but cannot release the caller's transaction.
 *
 * Every waiting tool is therefore classified here, one of:
 *
 *  - `self-managed`: declares `selfManagedDbContext` (for every action that
 *    waits), so no caller opens the per-call transaction and the handler opens
 *    its own short contexts (`inToolDbPhase`, aiToolDbContext.ts).
 *  - `bounded`: the worst-case wait per call is at most HALF the production
 *    timeout, so the held transaction cannot be killed even with the
 *    handler's other work on top. Anything longer must be self-managed.
 *
 * Completeness is checked statically: every wait-primitive call in a tool
 * source file is attributed to the registered tool whose `name: '…'` precedes
 * it, and an unclassified one fails. A wait reached only through a helper in
 * ANOTHER module is invisible to that scan; such a helper must be named in
 * WAIT_PRIMITIVES.
 */

/** Production managed Postgres `idle_in_transaction_session_timeout`. */
const PROD_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
/** A bounded tool's worst-case wait must leave this much headroom. */
const BOUNDED_CEILING_MS = PROD_IDLE_IN_TRANSACTION_TIMEOUT_MS / 2;

/**
 * Calls that wait on a device (or another process) before returning. The
 * device-command family plus the two module helpers that poll on a caller's
 * behalf (`awaitSystemCleanupResult`, `waitForReviewCompletion`).
 */
const WAIT_PRIMITIVES =
  /\b(aiExecuteCommand|aiExecuteCommandWithSystemPrecheck|executeCommand|executeCommandWithSystemPrecheck|executeCommandWithCallerPrecheck|waitForCommandResult|awaitSystemCleanupResult|waitForReviewCompletion)\s*\(/g;

type WaitEntry = {
  /** Source file (relative to services/) the waiting handler lives in. */
  file: string;
  /** Actions that wait; omitted = every call waits. */
  waitingActions?: readonly string[];
  /** Worst-case wait for ONE call, all sequential waits included. */
  maxWaitMs: number;
} & ({ disposition: 'self-managed' } | { disposition: 'bounded'; why: string });

const ONE_30S_COMMAND = 'one aiExecuteCommand with timeoutMs 30000';

const DEVICE_WAIT_TOOLS: Readonly<Record<string, WaitEntry>> = {
  // ---- self-managed: can exceed the production timeout --------------------
  run_script: { file: 'aiToolsScripts.ts', disposition: 'self-managed', maxWaitMs: 10 * 60_000 }, // 60 s × ≤10 devices
  take_screenshot: { file: 'aiToolsRemote.ts', disposition: 'self-managed', maxWaitMs: 120_000 },
  analyze_screen: { file: 'aiToolsRemote.ts', disposition: 'self-managed', maxWaitMs: 120_000 },
  computer_control: { file: 'aiToolsRemote.ts', disposition: 'self-managed', maxWaitMs: 120_000 },
  network_discovery: { file: 'aiToolsNetwork.ts', disposition: 'self-managed', maxWaitMs: 120_000 },
  security_scan: {
    file: 'aiToolsSecurity.ts', disposition: 'self-managed', maxWaitMs: 60_000,
    waitingActions: ['scan', 'status', 'quarantine', 'remove', 'restore'],
  },
  trigger_agent_upgrade: { file: 'aiToolsAgentMgmt.ts', disposition: 'self-managed', maxWaitMs: 50 * 60_000 }, // 60 s × ≤50 devices
  trigger_agent_restart: { file: 'aiToolsAgentMgmt.ts', disposition: 'self-managed', maxWaitMs: 50 * 60_000 },
  analyze_disk_usage: { file: 'aiToolsFilesystem.ts', disposition: 'self-managed', maxWaitMs: 975_000 }, // (900 s + 75 s) with refresh
  disk_cleanup: {
    file: 'aiToolsFilesystem.ts', disposition: 'self-managed', maxWaitMs: 270_000, // 240 s budget + one 30 s path
    waitingActions: ['execute'],
  },
  system_cleanup: {
    file: 'aiToolsFilesystem.ts', disposition: 'self-managed', maxWaitMs: 60_000,
    waitingActions: ['list'],
  },
  // Not a device command: polls the review worker for up to 45 s (#7128).
  propose_script: { file: 'aiToolsScriptProposals.ts', disposition: 'self-managed', maxWaitMs: 45_000 },

  // ---- bounded: one short device round-trip -------------------------------
  execute_command: { file: 'aiToolsScripts.ts', disposition: 'bounded', maxWaitMs: 30_000, why: ONE_30S_COMMAND },
  manage_services: { file: 'aiToolsScripts.ts', disposition: 'bounded', maxWaitMs: 30_000, why: ONE_30S_COMMAND },
  manage_processes: {
    file: 'aiToolsScripts.ts', disposition: 'bounded', maxWaitMs: 30_000,
    why: 'list and kill are separate branches, each one aiExecuteCommand with timeoutMs 30000',
  },
  manage_scheduled_tasks: { file: 'aiToolsScripts.ts', disposition: 'bounded', maxWaitMs: 30_000, why: ONE_30S_COMMAND },
  registry_operations: { file: 'aiToolsScripts.ts', disposition: 'bounded', maxWaitMs: 30_000, why: ONE_30S_COMMAND },
  set_agent_log_level: { file: 'aiToolsAgentLogs.ts', disposition: 'bounded', maxWaitMs: 30_000, why: ONE_30S_COMMAND },
  capture_agent_pprof: { file: 'aiToolsAgentLogs.ts', disposition: 'bounded', maxWaitMs: 30_000, why: ONE_30S_COMMAND },
  manage_startup_items: { file: 'aiToolsPerformance.ts', disposition: 'bounded', maxWaitMs: 30_000, why: ONE_30S_COMMAND },
  analyze_boot_performance: {
    file: 'aiToolsPerformance.ts', disposition: 'bounded', maxWaitMs: 15_000,
    why: 'one aiExecuteCommand with timeoutMs 15000, only when triggerCollection is set',
  },
  file_operations: { file: 'aiToolsFilesystem.ts', disposition: 'bounded', maxWaitMs: 30_000, why: ONE_30S_COMMAND },
};

/**
 * Wait sites that sit at module scope BEFORE the file's first registration
 * (a handler extracted to a named function), keyed by file, with the tool
 * that owns them. Any other module-scope wait is unattributable and fails.
 */
const MODULE_SCOPE_WAIT_OWNERS: Readonly<Record<string, string>> = {
  'aiToolsScripts.ts': 'run_script', // runScriptHandler, both paths
};

const SERVICES_DIR = __dirname;

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...listSourceFiles(path));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** Block and whole-line comments out, so prose naming a primitive is not a call. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
}

/** tool name → wait-call count, plus module-scope waits, for one file. */
function attributeWaits(source: string, registered: ReadonlySet<string>): {
  byTool: Map<string, number>;
  moduleScope: number;
} {
  const code = stripComments(source);
  const markers: Array<{ at: number; tool: string }> = [];
  for (const m of code.matchAll(/\bname:\s*['"]([a-z0-9_]+)['"]/g)) {
    if (registered.has(m[1]!)) markers.push({ at: m.index!, tool: m[1]! });
  }
  const byTool = new Map<string, number>();
  let moduleScope = 0;
  for (const m of code.matchAll(WAIT_PRIMITIVES)) {
    const owner = [...markers].reverse().find((k) => k.at < m.index!);
    if (!owner) { moduleScope++; continue; }
    byTool.set(owner.tool, (byTool.get(owner.tool) ?? 0) + 1);
  }
  return { byTool, moduleScope };
}

describe('contract: AI tools that wait on a device never hold the per-call transaction (#7918)', () => {
  const registered = new Set(aiTools.keys());

  it('every classified tool is registered', () => {
    expect(Object.keys(DEVICE_WAIT_TOOLS).filter((t) => !registered.has(t))).toEqual([]);
  });

  it.each(Object.entries(DEVICE_WAIT_TOOLS).filter(([, e]) => e.disposition === 'self-managed'))(
    '%s declares selfManagedDbContext for every action that waits',
    (name, entry) => {
      const tool = aiTools.get(name);
      const inputs = entry.waitingActions?.map((action) => ({ action })) ?? [{}];
      for (const input of inputs) {
        expect(toolManagesDbContext(tool, input), `${name} ${JSON.stringify(input)}`).toBe(true);
      }
    },
  );

  it.each(Object.entries(DEVICE_WAIT_TOOLS).filter(([, e]) => e.disposition === 'bounded'))(
    '%s is bounded well under the production idle-in-transaction timeout',
    (_name, entry) => {
      expect(entry.maxWaitMs).toBeLessThanOrEqual(BOUNDED_CEILING_MS);
    },
  );

  it('a tool whose wait can exceed half the production timeout is never classified bounded', () => {
    const misfiled = Object.entries(DEVICE_WAIT_TOOLS)
      .filter(([, e]) => e.maxWaitMs > BOUNDED_CEILING_MS && e.disposition !== 'self-managed')
      .map(([name]) => name);
    expect(misfiled).toEqual([]);
  });

  it('every wait-primitive call in a tool source file belongs to a classified tool', () => {
    const unclassified: string[] = [];
    const unattributable: string[] = [];
    const misplaced: string[] = [];
    const seen = new Set<string>();

    for (const path of listSourceFiles(SERVICES_DIR)) {
      const file = relative(SERVICES_DIR, path);
      const source = readFileSync(path, 'utf8');
      const { byTool, moduleScope } = attributeWaits(source, registered);
      // A file with no registered tool name is a primitive or helper module
      // (commandQueue.ts, systemCleanup.ts, …), not a handler.
      const declaresTools = [...source.matchAll(/\bname:\s*['"]([a-z0-9_]+)['"]/g)].some((m) => registered.has(m[1]!));
      if (!declaresTools) continue;

      if (moduleScope > 0) {
        const owner = MODULE_SCOPE_WAIT_OWNERS[file];
        if (!owner) unattributable.push(`${file}: ${moduleScope} wait call(s) before the first registration`);
        else { seen.add(owner); if (DEVICE_WAIT_TOOLS[owner]?.file !== file) misplaced.push(`${owner} (${file})`); }
      }
      for (const tool of byTool.keys()) {
        seen.add(tool);
        const entry = DEVICE_WAIT_TOOLS[tool];
        if (!entry) unclassified.push(`${tool} (${file})`);
        else if (entry.file !== file) misplaced.push(`${tool} (${file}, classified under ${entry.file})`);
      }
    }

    expect(unattributable).toEqual([]);
    expect(unclassified).toEqual([]);
    expect(misplaced).toEqual([]);
    // Shrink-guard: an entry whose wait was removed must be dropped too, so
    // the table never vouches for code that no longer exists.
    expect(Object.keys(DEVICE_WAIT_TOOLS).filter((t) => !seen.has(t))).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { CommandTypes } from './commandTypes';
import { REMOTE_TOOLS_COMMAND_TYPES } from './aiRemoteToolsPolicy';

// ============================================================================
// AI device dispatch honours the per-device remote-tools
// policy BY CONSTRUCTION. Source scans, same shape as aiDispatch.contract.test.ts:
//   1. the set cannot drift from what the /system-tools routes gate;
//   2. no exported aiDispatch entry point can reach the device without the check;
//   3. the two AI lanes that dispatch outside aiDispatch (reviewed lazy imports)
//      run the same check.
// Each scan asserts it found something, so an empty scan can never read green.
// ============================================================================

const API_SRC = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(API_SRC, rel), 'utf8');

const CHECK_CALL = /\b(?:checkAiRemoteToolsPolicy|assertAiRemoteToolsAllowed)\s*\(/;
const RAW_DISPATCH_CALL =
  /\b(?:queueCommand|queueCommandForExecution|executeCommand|executeCommandWithSystemPrecheck|dispatchDeviceCommand|insertQueuedCommandInTransaction)\s*\(/;

describe('REMOTE_TOOLS_COMMAND_TYPES matches what /system-tools gates', () => {
  const routeDir = 'routes/systemTools';
  const routeFiles = readdirSync(path.join(API_SRC, routeDir))
    .filter((f) => f.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(f))
    .map((f) => `${routeDir}/${f}`);

  const commandTypeValues = CommandTypes as Record<string, string>;
  const dispatched = new Map<string, string>();
  for (const file of routeFiles) {
    for (const m of read(file).matchAll(/\bCommandTypes\.([A-Z0-9_]+)\b/g)) {
      const value = commandTypeValues[m[1]!];
      expect(value, `${file} references CommandTypes.${m[1]} which does not exist`).toBeTypeOf('string');
      dispatched.set(value!, file);
    }
  }

  it('the route scan finds the command families (non-empty)', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(6);
    expect(dispatched.size).toBeGreaterThanOrEqual(30);
  });

  it('every command type a /system-tools route dispatches is in the set', () => {
    const missing = [...dispatched.entries()]
      .filter(([type]) => !REMOTE_TOOLS_COMMAND_TYPES.has(type))
      .map(([type, file]) => `${type} (${file})`);
    expect(
      missing,
      'A /system-tools route dispatches a command type the AI path does not gate on the '
        + 'remote-tools policy. Add it to REMOTE_TOOLS_COMMAND_TYPES in services/aiRemoteToolsPolicy.ts.',
    ).toEqual([]);
  });

  it('the /system-tools router still applies checkRemoteAccess(..., remoteTools) to every device route', () => {
    expect(read(`${routeDir}/index.ts`)).toMatch(/checkRemoteAccess\(\s*deviceId\s*,\s*'remoteTools'\s*\)/);
  });

  it('every set member is a real command type (no typo can make the gate a no-op)', () => {
    const known = new Set(Object.values(commandTypeValues));
    expect([...REMOTE_TOOLS_COMMAND_TYPES].filter((t) => !known.has(t))).toEqual([]);
  });
});

describe('every aiDispatch entry point runs the remote-tools check before dispatch', () => {
  const source = read('services/aiDispatch.ts');
  const starts = [...source.matchAll(/^export async function (\w+)/gm)];
  const bodies = starts.map((m, i) => ({
    name: m[1]!,
    body: source.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index : source.length),
  }));

  // The script lane takes no command `type` -- it can only dispatch `script`,
  // which /system-tools does not gate. Adding an entry here is a deliberate act.
  const EXEMPT = new Map([['aiDispatchScriptToDevice', 'script-only lane; dispatchScriptToDevice has no type input']]);

  it('scans every exported async entry point (non-empty)', () => {
    expect(bodies.map((b) => b.name)).toEqual(expect.arrayContaining([
      'aiExecuteCommand',
      'aiExecuteCommandWithSystemPrecheck',
      'aiQueueCommandForExecution',
      'aiQueueCommand',
      'aiDispatchDeviceCommand',
      'aiDispatchScriptToDevice',
      'aiInsertQueuedCommandInTransaction',
    ]));
  });

  it('each one that reaches a raw dispatch calls the check first', () => {
    const offenders = bodies
      .filter((b) => !EXEMPT.has(b.name))
      .filter((b) => {
        const raw = b.body.search(RAW_DISPATCH_CALL);
        const check = b.body.search(CHECK_CALL);
        return raw >= 0 && (check < 0 || check > raw);
      })
      .map((b) => b.name);
    expect(
      offenders,
      'An aiDispatch entry point reaches the device without checkAiRemoteToolsPolicy / '
        + 'assertAiRemoteToolsAllowed; every tool that uses it must run the check.',
    ).toEqual([]);
  });

  it('every exemption still names an existing entry point', () => {
    expect([...EXEMPT.keys()].filter((n) => !bodies.some((b) => b.name === n))).toEqual([]);
  });
});

describe('AI lanes that dispatch outside aiDispatch run the same check', () => {
  // These reach commandQueue by a reviewed lazy import (see
  // aiDispatch.contract.test.ts AI_LAZY_DISPATCH_ALLOWED) and dispatch
  // list_services / list_processes, which are remote-tools types.
  const LANES = ['services/aiAgents/actVerify.ts', 'services/aiAgents/playbookActExecutor.ts'];

  it.each(LANES)('%s calls the remote-tools check', (file) => {
    const text = read(file);
    expect(RAW_DISPATCH_CALL.test(text), `${file} no longer dispatches; drop it from LANES`).toBe(true);
    expect(CHECK_CALL.test(text)).toBe(true);
  });
});

describe('REST routes outside /system-tools that dispatch remote-tools work stay gated and in sync', () => {
  // Each file here dispatches (directly or through the named service) command
  // types that are remote-tools class, and enforces checkDeviceRemoteToolsPolicy
  // on the dispatching routes. NOT_REMOTE_TOOLS records the types these files
  // also send that are deliberately outside the policy.
  const ROUTE_FILES = [
    'routes/devices/bootMetrics.ts', // startup-item enable/disable
    'routes/devices/filesystem.ts', // disk scan + cleanup-execute
    'routes/devices/filesystemSystemCleanup.ts', // OS-native cleanup list/run
    'services/systemCleanup.ts', // the queue seam filesystemSystemCleanup.ts + the AI tool share
  ];
  const NOT_REMOTE_TOOLS = new Map([
    ['collect_boot_performance', 'boot-time inventory collection (bootMetrics.ts), not a remote-tools operation'],
  ]);
  const DISPATCH_LITERAL =
    /\b(?:executeCommand|executeCommandWithSystemPrecheck|queueCommandForExecution|queueCommandForExecutionWithSystemPrecheck|queueCommand|dispatchDeviceCommand)\(\s*[^,()]+,\s*'([a-z0-9_]+)'/g;

  const commandTypeValues = CommandTypes as Record<string, string>;
  const sent = new Map<string, string>();
  for (const file of ROUTE_FILES) {
    const text = read(file);
    for (const m of text.matchAll(/\bCommandTypes\.([A-Z0-9_]+)\b/g)) {
      const value = commandTypeValues[m[1]!];
      expect(value, `${file} references CommandTypes.${m[1]} which does not exist`).toBeTypeOf('string');
      sent.set(value!, file);
    }
    for (const m of text.matchAll(DISPATCH_LITERAL)) sent.set(m[1]!, file);
  }

  it('the scan finds the startup-item and disk-cleanup command types (non-empty)', () => {
    for (const t of ['manage_startup_item', 'filesystem_analysis', 'file_delete', 'system_cleanup_list', 'system_cleanup_run']) {
      expect(sent.has(t), t).toBe(true);
    }
  });

  it('every command type these routes send is in REMOTE_TOOLS_COMMAND_TYPES or explicitly excluded', () => {
    const missing = [...sent.entries()]
      .filter(([type]) => !REMOTE_TOOLS_COMMAND_TYPES.has(type) && !NOT_REMOTE_TOOLS.has(type))
      .map(([type, file]) => `${type} (${file})`);
    expect(
      missing,
      'A startup-item / disk-cleanup route sends a command type the AI path does not gate. Add it to '
        + 'REMOTE_TOOLS_COMMAND_TYPES, or to NOT_REMOTE_TOOLS here with a reason.',
    ).toEqual([]);
  });

  it('no exclusion is also a set member, and every exclusion is still sent', () => {
    expect([...NOT_REMOTE_TOOLS.keys()].filter((t) => REMOTE_TOOLS_COMMAND_TYPES.has(t) || !sent.has(t))).toEqual([]);
  });

  it.each(ROUTE_FILES.filter((f) => f.startsWith('routes/')))('%s enforces checkDeviceRemoteToolsPolicy', (file) => {
    expect(read(file)).toMatch(/\bcheckDeviceRemoteToolsPolicy\(/);
  });

  it('bootMetrics.ts checks the policy on BOTH startup-item routes', () => {
    expect(read('routes/devices/bootMetrics.ts').match(/\bcheckDeviceRemoteToolsPolicy\(/g)?.length).toBe(2);
  });

  it('services/systemCleanup.ts checks the policy before each of its dispatches', () => {
    const text = read('services/systemCleanup.ts');
    const dispatches = [...text.matchAll(/\bqueueCommandForExecutionWithSystemPrecheck\(/g)].map((m) => m.index!);
    const checks = [...text.matchAll(/\bcheckAiRemoteToolsPolicy\(/g)].map((m) => m.index!);
    expect(dispatches.length).toBe(2);
    expect(checks.length).toBe(2);
    dispatches.forEach((d, i) => expect(checks[i]!).toBeLessThan(d));
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each `db.select()` resolves to the next queued row set, in call order:
// the prior run, its intents, then their approval labels.
const h = vi.hoisted(() => ({ rows: [] as unknown[][] }));

vi.mock('../../db', () => {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit']) c[m] = () => c;
    c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(rows).then(ok, ko);
    return c;
  };
  return {
    db: {
      select: () => {
        // A query this test did not queue fails loudly rather than shifting the data.
        const rows = h.rows.shift();
        if (!rows) throw new Error('unexpected db.select: no queued rows');
        return chain(rows);
      },
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { buildContinuationSeed } from './troubleshootContinuation';
import { TROUBLESHOOT_CONTINUATION_SEED_MAX_BYTES } from '../aiAgents/troubleshootProfile';

const PRIOR = '00000000-0000-4000-8000-0000000000c1';
const ORG = '00000000-0000-4000-8000-0000000000a1';

/** The agent escapes event text a second time: `\r\n` arrives as the four characters `\` `r` `\` `n`. */
const esc = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** A process-creation event whose identifying fields sit well past the first 600 characters. */
function processStart(recordId: number, time: string, exe: string, parent: string, commandLine: string) {
  const boilerplate = 'Creator Subject:\\r\\n\\tSecurity ID:\\t\\tS-1-5-18\\r\\n\\tAccount Name:\\t\\tWORKSTATION$\\r\\n'
    + '\\tAccount Domain:\\t\\tWORKGROUP\\r\\n\\tLogon ID:\\t\\t0x3E7\\r\\n\\r\\nTarget Subject:\\r\\n'
    + '\\tSecurity ID:\\t\\tS-1-0-0\\r\\n\\tAccount Name:\\t\\t-\\r\\n\\tAccount Domain:\\t\\t-\\r\\n\\tLogon ID:\\t\\t0x0\\r\\n';
  return {
    recordId, logName: 'Security', level: 'Information', timeCreated: time,
    source: 'Microsoft-Windows-Security-Auditing', eventId: 4688,
    message: `A new process has been created.\\r\\n\\r\\n${boilerplate}${boilerplate}`
      + `\\r\\nProcess Information:\\r\\n\\tNew Process ID:\\t\\t0x436c\\r\\n\\tNew Process Name:\\t${esc(exe)}\\r\\n`
      + `\\tCreator Process Name:\\t${esc(parent)}\\r\\n\\tProcess Command Line:\\t${esc(commandLine)}\\r\\n\\r\\n`
      + 'Token Elevation Type indicates the type of token that was assigned to the new process. '.repeat(6),
  };
}

const commandResult = (payload: unknown) => ({ status: 'completed', exitCode: 0, stdout: JSON.stringify(payload) });

/** ~49,000 characters: the process the query was run to find first, then routine starts. */
function bigEventResult(targetExe: string, targetCommandLine: string) {
  const events = [
    processStart(9_000_100, '2026-11-16T00:32:38Z', targetExe, 'C:\\Windows\\System32\\services.exe', targetCommandLine),
    ...Array.from({ length: 24 }, (_, i) => processStart(
      9_000_000 + i, `2026-11-16T00:${String(30 - i).padStart(2, '0')}:00Z`,
      'C:\\Windows\\System32\\svchost.exe', 'C:\\Windows\\System32\\services.exe', `svchost.exe -k group${i}`,
    )),
  ];
  return commandResult({ events });
}

const registryResult = commandResult({
  values: [
    { name: 'ImagePath', type: 'REG_EXPAND_SZ', data: 'C:\\Program Files\\Updater\\updater.exe --service' },
    { name: 'Start', type: 'REG_DWORD', data: '2' },
  ],
});

function queue(steps: Array<{ id: string; label: string; status: string; result: unknown; errorCode?: string | null }>, summary: string) {
  h.rows = [
    [{ orgId: ORG, summary }],
    steps.map((s) => ({ id: s.id, status: s.status, actionName: 'execute_command', result: s.result, errorCode: s.errorCode ?? null })),
    steps.map((s) => ({ intentId: s.id, actionLabel: s.label })),
  ];
}

describe('buildContinuationSeed (#11967)', () => {
  beforeEach(() => { h.rows = []; });

  it('keeps every released step and the fields each event-log query was run to find', async () => {
    const first = bigEventResult('C:\\Windows\\Temp\\dropper.exe', 'dropper.exe /silent /install');
    const second = bigEventResult('C:\\Users\\Public\\beacon.exe', 'beacon.exe --connect');
    expect(first.stdout.length).toBeGreaterThan(40_000);
    queue([
      { id: 'i1', label: 'Read the Updater service registry key', status: 'completed', result: registryResult },
      { id: 'i2', label: 'Query Security log for process creation', status: 'completed', result: first },
      { id: 'i3', label: 'Query Security log for the second process', status: 'completed', result: second },
    ], `The device started an unknown service. ${'The service starts at boot and spawns child processes. '.repeat(30)}`);

    const seed = await buildContinuationSeed(PRIOR);

    expect(Buffer.byteLength(seed, 'utf8')).toBeLessThanOrEqual(TROUBLESHOOT_CONTINUATION_SEED_MAX_BYTES);
    // No step is dropped to make room.
    expect(seed).not.toMatch(/omitted/);
    expect(seed).toContain('Read the Updater service registry key');
    expect(seed).toContain('ImagePath = C:\\Program Files\\Updater\\updater.exe --service');
    // The identifying fields of each event, not the first 600 characters of its JSON.
    expect(seed).toContain('event 4688: dropper.exe, started by services.exe (dropper.exe /silent /install)');
    expect(seed).toContain('event 4688: beacon.exe, started by services.exe (beacon.exe --connect)');
    expect(seed).not.toContain('"recordId"');
    // What was cut is said: how many events were left out, and that the result is partial.
    expect(seed).toMatch(/Query Security log for process creation — outcome: 25 events from the Security log.*and \d+ more\. \[shortened\]/);
  });

  it('a long earlier summary is shortened (and says so) before any step is left out', async () => {
    queue([
      { id: 'i1', label: 'Read the Updater service registry key', status: 'completed', result: registryResult },
      { id: 'i2', label: 'Query Security log for process creation', status: 'completed', result: bigEventResult('C:\\Windows\\Temp\\dropper.exe', 'dropper.exe /silent') },
      { id: 'i3', label: 'Query Security log for the second process', status: 'completed', result: bigEventResult('C:\\Users\\Public\\beacon.exe', 'beacon.exe') },
    ], `Started. ${'The service starts at boot and spawns child processes. '.repeat(400)}`);
    const seed = await buildContinuationSeed(PRIOR);
    expect(Buffer.byteLength(seed, 'utf8')).toBeLessThanOrEqual(TROUBLESHOOT_CONTINUATION_SEED_MAX_BYTES);
    expect(seed).not.toMatch(/omitted/);
    for (const label of ['Read the Updater service registry key', 'Query Security log for process creation', 'Query Security log for the second process']) {
      expect(seed).toContain(label);
    }
    expect(seed).toMatch(/Earlier summary: Started\. The service.*\[shortened\]\n/);
    expect(seed).toContain('dropper.exe, started by services.exe (dropper.exe /silent)');
  });

  it('a step that failed reports its error code; one still waiting has no outcome', async () => {
    queue([
      { id: 'i1', label: 'Restart the Updater service', status: 'failed', result: null, errorCode: 'AGENT_TIMEOUT' },
      { id: 'i2', label: 'Stop the Updater service', status: 'pending_approval', result: null },
    ], 'Short summary.');
    const seed = await buildContinuationSeed(PRIOR);
    expect(seed).toContain('[already run, failed] Restart the Updater service — outcome: AGENT_TIMEOUT');
    expect(seed).toMatch(/\[still waiting for approval \(do not propose it again\)\] Stop the Updater service\n/);
  });
});

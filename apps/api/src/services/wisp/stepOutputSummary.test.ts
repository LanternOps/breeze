import { describe, expect, it } from 'vitest';
import { summarizeStepResult } from './stepOutputSummary';

/** The agent's wire shape: a command result whose stdout is itself a JSON document. */
const agent = (payload: unknown, extra: Record<string, unknown> = {}) => ({
  status: 'completed', exitCode: 0, commandId: 'c1', stdout: JSON.stringify(payload), ...extra,
});

// The agent escapes the event message a second time, so after parsing stdout a
// message still holds the two characters `\` `r` (not a CR), `\\` for one
// backslash and `\"` for a quote. `esc` writes a value the way the agent does.
const esc = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const processStart = (recordId: number, time: string, exe: string, parent: string, commandLine: string) => ({
  recordId, logName: 'Security', level: 'Information', timeCreated: time,
  source: 'Microsoft-Windows-Security-Auditing', eventId: 4688,
  message: 'A new process has been created.\\r\\n\\r\\nCreator Subject:\\r\\n\\tSecurity ID:\\t\\tS-1-5-18\\r\\n'
    + `\\r\\nProcess Information:\\r\\n\\tNew Process ID:\\t\\t0x436c\\r\\n\\tNew Process Name:\\t${esc(exe)}\\r\\n`
    + `\\tCreator Process Name:\\t${esc(parent)}\\r\\n\\tProcess Command Line:\\t${esc(commandLine)}\\r\\n\\r\\n`
    + 'Token Elevation Type indicates the type of token that was assigned to the new process.',
});

describe('summarizeStepResult — event log queries', () => {
  const result = agent({
    events: [
      processStart(9564762, '2026-11-16T00:32:38.4984641Z', 'C:\\Windows\\SysWOW64\\sc.exe', 'C:\\Program Files (x86)\\NinjaOne\\NinjaRMMAgent.exe', 'sc.exe  query csagent'),
      processStart(9564760, '2026-11-16T00:32:10.1Z', 'C:\\Windows\\System32\\svchost.exe', 'C:\\Windows\\System32\\services.exe', '"C:\\Windows\\System32\\svchost.exe" -k netsvcs'),
      processStart(9564700, '2026-11-16T00:31:02.9Z', 'C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\explorer.exe', 'cmd.exe'),
    ],
  });
  const text = summarizeStepResult(result, 1500);

  it('leads with how many events, from which log, over what span', () => {
    expect(text).toMatch(/^3 events from the Security log, 2026-11-16 00:31:02 to 00:32:38 UTC\./);
  });

  it('names what each event was, not the boilerplate first line', () => {
    expect(text).toContain('00:32:38 event 4688: sc.exe, started by NinjaRMMAgent.exe (sc.exe query csagent)');
    expect(text).not.toContain('A new process has been created');
  });

  it('undoes the agent\'s second escaping of paths and quotes', () => {
    expect(text).toContain('svchost.exe, started by services.exe ("C:\\Windows\\System32\\svchost.exe" -k netsvcs)');
  });

  it('dates each event when the result spans more than one day', () => {
    const twoDays = agent({ events: [
      { logName: 'System', timeCreated: '2026-11-15T20:13:46Z', eventId: 506, message: 'Entering standby' },
      { logName: 'System', timeCreated: '2026-11-14T01:23:59Z', eventId: 507, message: 'Exiting standby' },
    ] });
    expect(summarizeStepResult(twoDays, 1500)).toBe(
      '2 events from the System log, 2026-11-14 01:23:59 to 2026-11-15 20:13:46 UTC. '
      + '11-15 20:13:46 event 506: Entering standby; 11-14 01:23:59 event 507: Exiting standby',
    );
  });

  it('shows no JSON, no escape sequences and no field labels from the raw record', () => {
    expect(text).not.toMatch(/[{}]|"recordId"|\\r|\\n|\\t|Token Elevation/);
  });

  it('falls back to the first line of the message for an event with no known fields', () => {
    const power = agent({ events: [{
      recordId: 135400, logName: 'System', timeCreated: '2026-11-15T20:13:46.38Z', eventId: 506,
      source: 'Microsoft-Windows-Kernel-Power', message: 'The system is entering Modern Standby \\r\\n\\r\\nReason: Idle Timeout.',
    }] });
    expect(summarizeStepResult(power, 1500)).toBe(
      '1 event from the System log, 2026-11-15 20:13:46 UTC. 20:13:46 event 506: The system is entering Modern Standby (Reason: Idle Timeout.)',
    );
  });

  it('says how many events were left out when they do not fit', () => {
    const many = agent({ events: Array.from({ length: 40 }, (_, i) =>
      processStart(1000 - i, `2026-11-16T00:${String(59 - i).padStart(2, '0')}:00Z`, 'C:\\Windows\\System32\\svchost.exe', 'C:\\Windows\\System32\\services.exe', 'svchost.exe -k netsvcs')) });
    const out = summarizeStepResult(many, 600);
    expect(Array.from(out).length).toBeLessThanOrEqual(600);
    expect(out).toMatch(/^40 events from the Security log/);
    expect(out).toMatch(/and \d+ more\.$/);
  });

  it('an empty result says so', () => {
    expect(summarizeStepResult(agent({ events: [] }), 1500)).toBe('No events matched.');
  });
});

describe('summarizeStepResult — registry reads', () => {
  it('lists the values by name', () => {
    const result = agent({ values: [
      { name: 'ACSettingIndex', type: 'REG_DWORD', data: '300' },
      { name: 'DCSettingIndex', type: 'REG_DWORD', data: '300' },
    ] });
    expect(summarizeStepResult(result, 1500)).toBe('2 registry values: ACSettingIndex = 300; DCSettingIndex = 300');
  });

  it('a key with no values says so', () => {
    expect(summarizeStepResult(agent({ values: [] }), 1500)).toBe('The key has no values.');
  });
});

describe('summarizeStepResult — everything else', () => {
  it('keeps plain text output as it is', () => {
    expect(summarizeStepResult({ stdout: 'Service restarted' }, 1500)).toBe('Service restarted');
  });

  it('prefers an explicit summary, then a message', () => {
    expect(summarizeStepResult({ summary: 'Restarted the spooler', stdout: '{"x":1}' }, 1500)).toBe('Restarted the spooler');
    expect(summarizeStepResult({ message: 'Queued' }, 1500)).toBe('Queued');
  });

  it('describes an unknown JSON document by its fields, never as raw JSON', () => {
    const out = summarizeStepResult(agent({ services: [{ name: 'Spooler' }, { name: 'BITS' }], rebootPending: false, host: 'WS-01' }), 1500);
    expect(out).toBe('services: 2 items; rebootPending: false; host: WS-01');
  });

  it('describes a result with no text field by its fields', () => {
    expect(summarizeStepResult({ status: 'completed', exitCode: 0, detail: { a: 1 } }, 1500)).toBe('status: completed; exitCode: 0; detail: 1 field');
  });

  it('empty and missing results read as plain words', () => {
    expect(summarizeStepResult(null, 1500)).toBe('no result recorded');
    expect(summarizeStepResult({ stdout: '   ' }, 1500)).toBe('no output');
    expect(summarizeStepResult({}, 1500)).toBe('no output');
  });

  it('never exceeds the cap', () => {
    expect(Array.from(summarizeStepResult({ stdout: 'x'.repeat(5000) }, 100)).length).toBeLessThanOrEqual(100);
  });
});

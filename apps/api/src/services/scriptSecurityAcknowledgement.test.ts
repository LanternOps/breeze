import { describe, expect, it } from 'vitest';

import {
  resolveScriptSecurityAcknowledgement,
  scriptSecurityAcknowledgementColumns,
  unknownSecurityPatternDescriptions,
} from './scriptSecurityAcknowledgement';

const HKLM = 'PowerShell HKLM modification';
const SCHTASKS = 'scheduled task creation';
const CREDENTIAL_DUMP = 'LSA dump';

const hklmLine = "Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Contoso' -Name Enabled -Value 1";
const schtasksLine = 'schtasks /create /tn Nightly /tr C:\\x.exe /sc daily';
// Matches the agent's `reg\s+add\s+HKLM` pattern, a different description from
// the Set-ItemProperty one above.
const regAddLine = 'reg add HKLM\\Software\\Contoso /v Enabled /d 1';

describe('resolveScriptSecurityAcknowledgement', () => {
  it('reports a matched pattern as unacknowledged when nothing was submitted', () => {
    const resolution = resolveScriptSecurityAcknowledgement({ content: hklmLine });

    expect(resolution.matched).toEqual([HKLM]);
    expect(resolution.acknowledged).toEqual([]);
    expect(resolution.unacknowledged).toEqual([HKLM]);
    expect(resolution.changed).toBe(false);
  });

  it('stores an acknowledgement the content actually matches', () => {
    const resolution = resolveScriptSecurityAcknowledgement({
      content: hklmLine,
      submitted: [HKLM],
    });

    expect(resolution.acknowledged).toEqual([HKLM]);
    expect(resolution.unacknowledged).toEqual([]);
    expect(resolution.added).toEqual([HKLM]);
    expect(resolution.changed).toBe(true);
  });

  it('drops an acknowledgement for a pattern the content does not match', () => {
    // This is the rule that stops anyone pre-acknowledging the whole
    // vocabulary once and permanently disarming Strict checking.
    const resolution = resolveScriptSecurityAcknowledgement({
      content: hklmLine,
      submitted: [HKLM, SCHTASKS, CREDENTIAL_DUMP],
    });

    expect(resolution.acknowledged).toEqual([HKLM]);
    expect(resolution.added).toEqual([HKLM]);
  });

  it('acknowledging one pattern does not acknowledge another in the same script', () => {
    const resolution = resolveScriptSecurityAcknowledgement({
      content: `${hklmLine}\n${schtasksLine}`,
      submitted: [HKLM],
    });

    expect(resolution.acknowledged).toEqual([HKLM]);
    expect(resolution.unacknowledged).toEqual([SCHTASKS]);
  });

  it('keeps an existing approval and refuses a newly-introduced pattern on edit', () => {
    // THE security property. The script was approved for an HKLM write; an
    // edit adds a credential dump. The HKLM approval survives, the new
    // pattern is unacknowledged, and the agent will block it.
    const resolution = resolveScriptSecurityAcknowledgement({
      content: `${hklmLine}\nmimi${'katz'} sekurlsa::logonpasswords`,
      existing: [HKLM],
      submitted: undefined,
    });

    expect(resolution.acknowledged).toEqual([HKLM]);
    expect(resolution.unacknowledged).toContain('credential dumping tool');
    expect(resolution.added).toEqual([]);
    expect(resolution.changed).toBe(false);
  });

  it('carries the existing set forward when the field is absent', () => {
    // A metadata-only edit (rename, timeout) must not silently revoke.
    const resolution = resolveScriptSecurityAcknowledgement({
      content: hklmLine,
      existing: [HKLM],
    });

    expect(resolution.acknowledged).toEqual([HKLM]);
    expect(resolution.changed).toBe(false);
  });

  it('treats an explicit empty array as a revoke', () => {
    const resolution = resolveScriptSecurityAcknowledgement({
      content: hklmLine,
      existing: [HKLM],
      submitted: [],
    });

    expect(resolution.acknowledged).toEqual([]);
    expect(resolution.removed).toEqual([HKLM]);
    expect(resolution.changed).toBe(true);
  });

  it('treats an explicit null as a revoke', () => {
    const resolution = resolveScriptSecurityAcknowledgement({
      content: hklmLine,
      existing: [HKLM],
      submitted: null,
    });

    expect(resolution.acknowledged).toEqual([]);
    expect(resolution.removed).toEqual([HKLM]);
  });

  it('drops a stored acknowledgement once the edit removes the risky line', () => {
    const resolution = resolveScriptSecurityAcknowledgement({
      content: 'Write-Output "nothing risky here"',
      existing: [HKLM],
    });

    expect(resolution.acknowledged).toEqual([]);
    expect(resolution.matched).toEqual([]);
    expect(resolution.removed).toEqual([HKLM]);
  });

  it('never acknowledges a Basic-level pattern', () => {
    // Basic patterns are unconditional at the agent; they must not even
    // appear as matched here, so no UI can offer them for acknowledgement.
    const resolution = resolveScriptSecurityAcknowledgement({
      content: 'rm -rf /',
      submitted: ['recursive delete on root directory'],
    });

    expect(resolution.matched).toEqual([]);
    expect(resolution.acknowledged).toEqual([]);
  });

  it('normalizes whitespace and duplicates in the submitted set', () => {
    const resolution = resolveScriptSecurityAcknowledgement({
      content: hklmLine,
      submitted: [`  ${HKLM}  `, HKLM, '   '],
    });

    expect(resolution.acknowledged).toEqual([HKLM]);
  });

  it('orders the stored set by the agent’s pattern order, not submission order', () => {
    // Stable storage means an audit diff shows real changes, not reordering.
    const content = `${hklmLine}\n${schtasksLine}\n${regAddLine}`;
    const a = resolveScriptSecurityAcknowledgement({
      content,
      submitted: [HKLM, 'HKLM registry modification', SCHTASKS],
    });
    const b = resolveScriptSecurityAcknowledgement({
      content,
      submitted: [SCHTASKS, HKLM, 'HKLM registry modification'],
    });

    expect(a.acknowledged).toEqual(b.acknowledged);
    expect(a.acknowledged).toEqual([SCHTASKS, 'HKLM registry modification', HKLM]);
  });
});

describe('unknownSecurityPatternDescriptions', () => {
  it('accepts every real description', () => {
    expect(unknownSecurityPatternDescriptions([HKLM, SCHTASKS])).toEqual([]);
  });

  it('rejects an invented description', () => {
    expect(unknownSecurityPatternDescriptions([HKLM, 'allow everything'])).toEqual([
      'allow everything',
    ]);
  });

  it('rejects a Basic-level description — those are not acknowledgeable', () => {
    expect(unknownSecurityPatternDescriptions(['fork bomb pattern'])).toEqual([
      'fork bomb pattern',
    ]);
  });
});

describe('scriptSecurityAcknowledgementColumns', () => {
  const actor = '11111111-1111-4111-8111-111111111111';
  const now = new Date('2026-10-12T10:00:00.000Z');

  it('writes nothing when the set did not change', () => {
    const resolution = resolveScriptSecurityAcknowledgement({
      content: hklmLine,
      existing: [HKLM],
    });

    expect(scriptSecurityAcknowledgementColumns(resolution, actor, now)).toBeNull();
  });

  it('stamps who and when on a new acknowledgement', () => {
    const resolution = resolveScriptSecurityAcknowledgement({
      content: hklmLine,
      submitted: [HKLM],
    });

    expect(scriptSecurityAcknowledgementColumns(resolution, actor, now)).toEqual({
      acknowledgedSecurityPatterns: [HKLM],
      securityAcknowledgedBy: actor,
      securityAcknowledgedAt: now,
    });
  });

  it('clears the attribution when everything is revoked', () => {
    const resolution = resolveScriptSecurityAcknowledgement({
      content: hklmLine,
      existing: [HKLM],
      submitted: [],
    });

    expect(scriptSecurityAcknowledgementColumns(resolution, actor, now)).toEqual({
      acknowledgedSecurityPatterns: [],
      securityAcknowledgedBy: null,
      securityAcknowledgedAt: null,
    });
  });

  it('leaves the earlier attribution alone when a save only revokes', () => {
    // Revoking is not an act of approval and must not be recorded as one.
    const resolution = resolveScriptSecurityAcknowledgement({
      content: `${hklmLine}\n${schtasksLine}`,
      existing: [HKLM, SCHTASKS],
      submitted: [SCHTASKS],
    });

    const columns = scriptSecurityAcknowledgementColumns(resolution, actor, now);
    expect(columns).toEqual({ acknowledgedSecurityPatterns: [SCHTASKS] });
    expect(columns).not.toHaveProperty('securityAcknowledgedBy');
    expect(columns).not.toHaveProperty('securityAcknowledgedAt');
  });
});

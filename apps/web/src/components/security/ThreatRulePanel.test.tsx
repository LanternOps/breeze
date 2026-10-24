import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { YaraThreatRuleView } from '@breeze/shared';
import ThreatRulePanel from './ThreatRulePanel';

const SET_ID = '00000000-0000-4000-8000-00000000b001';

function view(over: Partial<YaraThreatRuleView> = {}): YaraThreatRuleView {
  return {
    engine: 'yara',
    ruleName: 'ioc_advisory_string_0123456789abcdef',
    ruleId: 'r1',
    ruleSetId: SET_ID,
    ruleSet: { id: SET_ID, name: 'Breeze built-in', isBuiltin: true, partnerWide: false },
    tags: ['ioc', 'string'],
    // The agent already escaped the bytes: this is the 4-character text `\x00`.
    matchedStrings: [{ id: '$i0', offset: 4096, data: 'MZ\\x00\\x90' }],
    sha256: 'a'.repeat(64),
    quarantinedTo: 'C:\\ProgramData\\Breeze\\quarantine\\abc',
    quarantineFailed: false,
    ...over,
  };
}

describe('ThreatRulePanel (W04-5)', () => {
  it('renders the rule, its set with the Built-in badge and a link to the set', () => {
    render(<ThreatRulePanel rule={view()} />);

    expect(screen.getByTestId('threat-rule-name').textContent).toBe('ioc_advisory_string_0123456789abcdef');
    const link = screen.getByTestId('threat-rule-set-link');
    expect(link.getAttribute('href')).toBe(`/security/detection-rules#${SET_ID}`);
    expect(link.textContent).toContain('Breeze built-in');
    expect(screen.getByTestId('threat-rule-set-badge-builtin')).toBeInTheDocument();
    expect(screen.getByTestId('threat-rule-tags').textContent).toContain('ioc');
  });

  it('a partner-wide set carries the All orgs badge', () => {
    render(
      <ThreatRulePanel rule={view({ ruleSet: { id: SET_ID, name: 'MSP wide', isBuiltin: false, partnerWide: true } })} />,
    );
    expect(screen.getByTestId('threat-rule-set-badge-all-orgs')).toBeInTheDocument();
    expect(screen.queryByTestId('threat-rule-set-badge-builtin')).toBeNull();
  });

  it('renders matched strings as text with offsets — a stored \\x00 stays the four characters \\x00', () => {
    render(<ThreatRulePanel rule={view()} />);
    const row = screen.getByTestId('threat-rule-string-0');
    expect(row.textContent).toContain('4096');
    expect(row.textContent).toContain('MZ\\x00\\x90');
    expect(row.textContent).not.toContain('\\\\x00');
    expect(row.textContent).not.toContain('\u0000');
  });

  it('shows the sha256 with a copy button and the scan-time quarantine path', () => {
    render(<ThreatRulePanel rule={view()} />);
    expect(screen.getByTestId('threat-rule-sha256').textContent).toContain('a'.repeat(64));
    expect(screen.getByTestId('threat-rule-sha256-copy')).toBeInTheDocument();
    expect(screen.getByTestId('threat-rule-quarantined-to').textContent).toMatch(/Quarantined to \(at scan time\)/);
    expect(screen.getByTestId('threat-rule-quarantined-to').textContent).toContain('quarantine');
    expect(screen.queryByTestId('threat-rule-quarantine-failed')).toBeNull();
  });

  it('flags a failed auto-quarantine', () => {
    render(<ThreatRulePanel rule={view({ quarantineFailed: true, quarantinedTo: null })} />);
    expect(screen.getByTestId('threat-rule-quarantine-failed').textContent).toMatch(/Auto-quarantine failed/);
  });

  it('ruleSet null says the set is no longer available and shows the id', () => {
    render(<ThreatRulePanel rule={view({ ruleSet: null })} />);
    const missing = screen.getByTestId('threat-rule-set-missing');
    expect(missing.textContent).toMatch(/Rule set no longer available/);
    expect(missing.textContent).toContain(SET_ID);
    expect(screen.queryByTestId('threat-rule-set-link')).toBeNull();
  });

  it('a legacy hit says built-in signature and shows no rule fields', () => {
    render(
      <ThreatRulePanel
        rule={view({ engine: 'legacy', ruleName: null, ruleId: null, ruleSetId: null, ruleSet: null, tags: [], matchedStrings: [] })}
      />,
    );
    expect(screen.getByTestId('threat-rule-legacy').textContent).toMatch(/Built-in signature \(legacy scan\)/);
    expect(screen.queryByTestId('threat-rule-name')).toBeNull();
    expect(screen.queryByTestId('threat-rule-set-link')).toBeNull();
    expect(screen.queryByTestId('threat-rule-set-missing')).toBeNull();
  });

  it('claims no rule version (the agent does not report one)', () => {
    render(<ThreatRulePanel rule={view()} />);
    expect(screen.getByTestId('threat-rule-panel').textContent).not.toMatch(/version/i);
  });
});

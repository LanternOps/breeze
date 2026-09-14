import { describe, expect, it } from 'vitest';
import type { FleetDesignOutcome } from '@breeze/shared';
import { parseAutomationRef, proposalRefForRule, withScriptCreated } from './scripts';

const script = (name: string) => ({ name, purpose: 'p', osTypes: ['windows' as const], language: 'powershell' as const, content: 'x' });

function outcome(automation: FleetDesignOutcome['sections']['automation']): FleetDesignOutcome {
  return { sections: { automation } } as unknown as FleetDesignOutcome;
}

describe('proposalRefForRule', () => {
  const o = outcome([
    { functionKey: 'file_server', playbooks: [], scripts: [script('Restart service'), script('Clean temp')] },
    { functionKey: 'print_server', playbooks: [], scripts: [script('Restart service')] },
  ]);

  it('resolves an item ref exactly', () => {
    expect(proposalRefForRule(o, { kind: 'script', ref: 'automation:print_server:script:0' }, 'file_server')).toBe('automation:print_server:script:0');
  });

  it("prefers the rule's own function when two functions propose the same name", () => {
    expect(proposalRefForRule(o, { kind: 'script', ref: 'Restart service' }, 'print_server')).toBe('automation:print_server:script:0');
    expect(proposalRefForRule(o, { kind: 'script', ref: 'Restart service' }, 'file_server')).toBe('automation:file_server:script:0');
  });

  it('falls back to another function when the rule\'s own proposes no such name', () => {
    expect(proposalRefForRule(o, { kind: 'script', ref: 'Clean temp' }, 'print_server')).toBe('automation:file_server:script:1');
  });

  it('is null for none, a playbook, or a name no proposal carries', () => {
    expect(proposalRefForRule(o, 'none', 'file_server')).toBeNull();
    expect(proposalRefForRule(o, { kind: 'playbook', ref: 'Restart service' }, 'file_server')).toBeNull();
    expect(proposalRefForRule(o, { kind: 'script', ref: 'Unknown' }, 'file_server')).toBeNull();
  });
});

describe('withScriptCreated / parseAutomationRef', () => {
  it('appends the created id once', () => {
    const once = withScriptCreated('why', 's1');
    expect(once).toBe('why [script created: s1]');
    expect(withScriptCreated(once, 's2')).toBe(once);
  });

  it('parses automation refs and rejects others', () => {
    expect(parseAutomationRef('automation:custom:pos-terminal:script:3')).toEqual({ functionKey: 'custom:pos-terminal', index: 3 });
    expect(parseAutomationRef('monitoring:file_server:rule:0')).toBeNull();
  });
});

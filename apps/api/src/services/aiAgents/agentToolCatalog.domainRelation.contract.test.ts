import { describe, expect, it } from 'vitest';
import { aiTools } from '../aiToolNames';
import '../aiTools'; // populates the registry
import { getToolDomain } from '../aiTools';
import { AGENT_CAPABILITIES, CAPABILITY_DOMAINS, TOOL_CAPABILITY } from './agentToolCatalog';

describe('capability ↔ domain relation (A-W02)', () => {
  it('declares a domain set for every capability and nothing else', () => {
    expect(Object.keys(CAPABILITY_DOMAINS).sort()).toEqual(AGENT_CAPABILITIES.map((c) => c.id).sort());
    for (const domains of Object.values(CAPABILITY_DOMAINS)) expect(domains.length).toBeGreaterThan(0);
  });

  it('every registered tool sits in a domain its capability allows', () => {
    const offenders = [...aiTools.keys()].filter((name) => {
      const capability = TOOL_CAPABILITY[name];
      const domain = getToolDomain(name);
      return !capability || !domain || !CAPABILITY_DOMAINS[capability].includes(domain);
    }).map((name) => `${name}: capability=${TOOL_CAPABILITY[name]} domain=${getToolDomain(name)}`);
    expect(offenders, 'widen CAPABILITY_DOMAINS with a reason, or fix the tool domain').toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS } from '@breeze/shared';
import './aiTools'; // populates the registry
import { listChatSurfaceToolNames } from './aiAgentSdkTools';
import { DOMAIN_NOTES, listToolIndex, renderToolIndexByDomain } from './aiToolIndex';

describe('renderToolIndexByDomain (A-W02)', () => {
  const names = listChatSurfaceToolNames();
  const text = renderToolIndexByDomain(names);

  it('renders domains in spec order under the standing heading', () => {
    expect(text.startsWith('## Available Tools by Domain\n')).toBe(true);
    const labelsInOrder = text.match(/^- \*\*([^*]+)\*\*: /gm)!.map((l) => l.replace(/^- \*\*|\*\*: $/g, ''));
    const expected = AI_TOOL_DOMAINS
      .filter((d) => listToolIndex(names).some((e) => e.domain === d))
      .map((d) => AI_TOOL_DOMAIN_LABELS[d]);
    expect(labelsInOrder).toEqual(expected);
  });

  it('names every chat-callable tool exactly once and nothing else', () => {
    const mentioned = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
    const set = new Set(names);
    const unknown = mentioned.filter((m) => !set.has(m) && !isActionToken(text, m));
    expect(unknown).toEqual([]);
    for (const n of names) expect(mentioned.filter((token) => token === n).length, n).toBe(1);
  });

  it('keeps the vulnerability tools findable with CVE vocabulary (#2605 pin moves here)', () => {
    expect(text).toContain('get_vulnerability_report');
    expect(text).toContain('get_device_vulnerabilities');
    expect(text).toContain('remediate_vulnerability');
    expect(text).toMatch(/CVE/);
  });

  it('skips names that have no domain instead of throwing', () => {
    expect(listToolIndex(['query_devices', 'propose_action_plan', 'not_a_tool']).map((e) => e.name)).toEqual(['query_devices']);
  });

  it('stays small: the whole index is under 5 KB and every note under 400 chars', () => {
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(5 * 1024);
    for (const note of Object.values(DOMAIN_NOTES)) expect(note!.length).toBeLessThanOrEqual(400);
  });
});

/** Action tokens are rendered inside parentheses after a tool name; ignore those in the unknown-name check. */
function isActionToken(text: string, token: string): boolean {
  return new RegExp(`\\(([a-z0-9_]+/)*${token}(/[a-z0-9_]+)*\\)`).test(text);
}

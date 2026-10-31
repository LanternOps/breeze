import { describe, expect, it } from 'vitest';
import '../../aiTools';
import { aiTools } from '../../aiToolNames';
import { listChatSurfaceToolNames } from '../../aiAgentSdkTools';
import { getToolAlwaysLoad, getToolDomain } from '../../aiTools';
import { pageContextToolDomains } from '../../aiToolIndex';
import { LAZY_INDEX_CASES, LAZY_INDEX_PAGES, buildLazyIndexCasePrompt } from './lazyIndexCases';

describe('LAZY_INDEX_CASES (W19)', () => {
  const chat = new Set(listChatSurfaceToolNames());

  it('has 10 unique ids covering every case kind', () => {
    expect(LAZY_INDEX_CASES).toHaveLength(10);
    expect(new Set(LAZY_INDEX_CASES.map((c) => c.id)).size).toBe(10);
    expect(new Set(LAZY_INDEX_CASES.map((c) => c.kind))).toEqual(new Set(['page-expanded', 'unexpanded-domain', 'always-on', 'action-enum']));
  });

  it('expects chat-declared tools and declared actions only', () => {
    for (const c of LAZY_INDEX_CASES) for (const e of c.expect) {
      expect(chat.has(e.tool), `${c.id}: ${e.tool} not chat-declared`).toBe(true);
      if (e.action) {
        const schema = aiTools.get(e.tool)?.definition.input_schema as { properties?: { action?: { enum?: string[] } } };
        expect(schema.properties?.action?.enum, `${c.id}: ${e.tool}`).toContain(e.action);
      }
    }
  });

  it('labels each case by what the prompt gives the model', () => {
    for (const c of LAZY_INDEX_CASES) {
      const pageDomains: readonly string[] = pageContextToolDomains(LAZY_INDEX_PAGES[c.page]);
      const domains = c.expect.map((e) => getToolDomain(e.tool));
      if (c.kind === 'page-expanded') expect(domains.some((d) => pageDomains.includes(d!)), c.id).toBe(true);
      if (c.kind === 'unexpanded-domain') expect(domains.every((d) => !pageDomains.includes(d!)), c.id).toBe(true);
      if (c.kind === 'always-on') expect(c.expect.some((e) => getToolAlwaysLoad(e.tool)), c.id).toBe(true);
    }
  });

  it('builds the production page prompt without a database', async () => {
    const device = await buildLazyIndexCasePrompt(LAZY_INDEX_CASES[0]!);
    expect(device).toContain('## Current Page Context');
    expect(device).toContain('The user is viewing device "FS-01"');
    expect(device).toContain('### Tools for this page');
    expect(device).toContain('analyze_disk_usage');
    const dashboard = await buildLazyIndexCasePrompt(LAZY_INDEX_CASES.find((c) => c.page === 'dashboard')!);
    expect(dashboard).not.toContain('### Tools for this page');
    expect(dashboard).not.toContain('list_invoices');
  });
});

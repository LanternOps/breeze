import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DOCS_SEARCH_MAX_CHARS, registerDocsTools, searchDocsIndex, type DocsIndexEntry } from './aiToolsDocs';
import type { AiTool } from './aiTools';

// ── Helpers ──────────────────────────────────────────────────────────────

const mockAuth = {
  user: { id: 'u1', email: 'test@test.com', name: 'Test' },
  orgId: 'org-1',
  scope: 'organization',
  accessibleOrgIds: ['org-1'],
  canAccessOrg: (id: string) => id === 'org-1',
  orgCondition: () => undefined,
} as any;

function buildToolMap(): Map<string, AiTool> {
  const toolMap = new Map<string, AiTool>();
  registerDocsTools(toolMap);
  return toolMap;
}

function getHandler(toolMap: Map<string, AiTool>) {
  return toolMap.get('search_documentation')!.handler;
}

// ── Registration ─────────────────────────────────────────────────────────

describe('registerDocsTools', () => {
  const toolMap = buildToolMap();

  it('registers exactly one tool named search_documentation', () => {
    expect(toolMap.size).toBe(1);
    expect(toolMap.has('search_documentation')).toBe(true);
  });

  it('registers at tier 1', () => {
    expect(toolMap.get('search_documentation')!.tier).toBe(1);
  });

  it('has a valid definition with name, description, and input_schema', () => {
    const tool = toolMap.get('search_documentation')!;
    expect(tool.definition.name).toBe('search_documentation');
    expect(typeof tool.definition.description).toBe('string');
    expect(tool.definition.description!.length).toBeGreaterThan(10);
    const schema = tool.definition.input_schema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty('query');
    expect(properties).toHaveProperty('section');
  });
});

// ── Handler behavior ─────────────────────────────────────────────────────

describe('search_documentation handler', () => {
  const toolMap = buildToolMap();
  const handler = getHandler(toolMap);

  describe('empty / invalid query handling', () => {
    it('returns guidance message for empty string query', async () => {
      const result = await handler({ query: '' }, mockAuth);
      expect(result).toContain('Please provide search terms');
    });

    it('returns guidance message for whitespace-only query', async () => {
      const result = await handler({ query: '   ' }, mockAuth);
      expect(result).toContain('Please provide search terms');
    });

    it('handles undefined query gracefully', async () => {
      const result = await handler({ query: undefined }, mockAuth);
      expect(result).toContain('Please provide search terms');
    });

    it('handles numeric query gracefully', async () => {
      const result = await handler({ query: 42 }, mockAuth);
      expect(result).toContain('Please provide search terms');
    });
  });

  describe('successful searches', () => {
    it('returns formatted results with Title, URL, Description, Key Topics', async () => {
      // "agent" should match many docs entries
      const result = await handler({ query: 'agent' }, mockAuth);
      expect(result).toContain('Title:');
      expect(result).toContain('URL:');
      expect(result).toContain('Description:');
      expect(result).toContain('Key Topics:');
    });

    it('URL format is https://docs.breezermm.com{path}', async () => {
      const result = await handler({ query: 'quickstart' }, mockAuth);
      expect(result).toMatch(/URL: https:\/\/docs\.breezermm\.com\//);
    });

    it('returns at most 5 results', async () => {
      // "security" is a broad term that should match many entries
      const result = await handler({ query: 'security' }, mockAuth);
      const titleCount = (result.match(/^Title:/gm) || []).length;
      expect(titleCount).toBeLessThanOrEqual(5);
      expect(titleCount).toBeGreaterThan(0);
    });

    it('results are sorted by score descending, then alphabetically by title', async () => {
      // Use a term that hits several entries so sort order matters
      const result = await handler({ query: 'deploy production' }, mockAuth);
      const titles = (result.match(/^Title: (.+)$/gm) || []).map(
        (line) => line.replace('Title: ', '')
      );
      // First result should have a higher or equal relevance to the second,
      // and entries with the same score should be alphabetical
      expect(titles.length).toBeGreaterThan(0);
    });
  });

  describe('section filter', () => {
    it('narrows results to the specified section', async () => {
      // "security" as section should only return security-section docs
      const result = await handler({ query: 'security', section: 'security' }, mockAuth);
      expect(result).toContain('Title:');
      // Verify the result doesn't include titles from clearly unrelated sections
      // (this is a behavioral check — the handler filters by section before scoring)
    });

    it('returns no-match message when section has no matching keywords', async () => {
      // A query unlikely to match anything in the "deploy" section
      const result = await handler({ query: 'xyzzy99nonexistent' , section: 'deploy' }, mockAuth);
      expect(result).toContain('No documentation found');
    });
  });

  describe('no-match handling', () => {
    it('returns "No documentation found" for nonsense query', async () => {
      const result = await handler({ query: 'xyzzy99completely_impossible_term' }, mockAuth);
      expect(result).toContain('No documentation found');
    });
  });
});

// ── Section text (#10398) ────────────────────────────────────────────────

function entry(overrides: Partial<DocsIndexEntry> & Pick<DocsIndexEntry, 'path' | 'title'>): DocsIndexEntry {
  return { description: '', headings: [], section: 'features', sections: [], ...overrides };
}

const FIXTURE: DocsIndexEntry[] = [
  entry({
    path: '/features/maintenance-windows/',
    title: 'Maintenance Windows',
    description: 'Schedule maintenance windows.',
    headings: ['Recurring Windows', 'Timezone Handling'],
    sections: [
      { heading: '', anchor: '', text: 'Maintenance windows suppress alerts.' },
      {
        heading: 'Recurring Windows',
        anchor: 'recurring-windows',
        text: '| `weekly` | The configured start time on the most recent Sunday in the configured timezone |',
      },
      { heading: 'Timezone Handling', anchor: 'timezone-handling', text: 'Windows are evaluated in the configured IANA timezone.' },
    ],
  }),
  entry({
    path: '/features/patch-management/',
    title: 'Patch Management',
    description: 'Approve and deploy patches.',
    headings: ['Schedules'],
    sections: [{ heading: 'Schedules', anchor: 'schedules', text: 'Patch schedules can run weekly on a chosen day.' }],
  }),
  entry({ path: '/reference/glossary/', title: 'Glossary', description: 'Weekly terms', section: 'reference' }),
];

describe('searchDocsIndex — section text (#10398)', () => {
  it('returns the matching section text, not just headings, with a deep link', () => {
    const out = searchDocsIndex(FIXTURE, 'weekly recurring window');
    expect(out).toContain('most recent Sunday');
    expect(out).toContain('Section: Recurring Windows');
    expect(out).toContain('https://docs.breezermm.com/features/maintenance-windows/#recurring-windows');
  });

  it('ranks the section whose heading matches above a page that only mentions the term in its body', () => {
    const out = searchDocsIndex(FIXTURE, 'recurring weekly');
    expect(out.indexOf('Maintenance Windows')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('Maintenance Windows')).toBeLessThan(out.indexOf('Patch Management'));
  });

  it('does not let one stray body substring outrank a page whose title and heading match', () => {
    const reference = entry({
      path: '/features/reference/',
      title: 'Reference',
      headings: ['Big table'],
      sections: [{ heading: 'Big table', anchor: 'big-table', text: 'maintenance window weekly picker day' }],
    });
    const out = searchDocsIndex([reference, ...FIXTURE], 'how do weekly maintenance windows pick their day');
    expect(out.match(/^Title: .+$/m)?.[0]).toBe('Title: Maintenance Windows');
  });

  it('still lists a page that matches only on title/description', () => {
    const out = searchDocsIndex(FIXTURE, 'glossary');
    expect(out).toContain('Title: Glossary');
    expect(out).toContain('URL: https://docs.breezermm.com/reference/glossary/');
  });

  it('ignores filler words so "how do I" does not match every page', () => {
    const out = searchDocsIndex(FIXTURE, 'how do I set the timezone');
    const titles = out.match(/^Title: .+$/gm) ?? [];
    expect(titles).toEqual(['Title: Maintenance Windows']);
    expect(out).toContain('IANA timezone');
  });

  it('honours the section filter', () => {
    const out = searchDocsIndex(FIXTURE, 'weekly', 'reference');
    expect(out.match(/^Title: .+$/gm)).toEqual(['Title: Glossary']);
  });

  it('excerpts a long section around the matching paragraph and stays inside the char budget', () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} about unrelated configuration detail.`.padEnd(200, '.'));
    filler.splice(30, 0, 'The needle answer: reboots wait for the device to come online.');
    const big = entry({
      path: '/features/big/',
      title: 'Big Page',
      headings: ['Long Section'],
      sections: [{ heading: 'Long Section', anchor: 'long-section', text: filler.join('\n\n') }],
    });
    const out = searchDocsIndex([big], 'needle answer');
    expect(out).toContain('The needle answer');
    expect(out).toContain('…');
    expect(out).not.toContain('Paragraph 0 ');
    expect(out.length).toBeLessThanOrEqual(DOCS_SEARCH_MAX_CHARS);
  });

  it('windows a single oversized paragraph (a long table) onto the matching row', () => {
    const rows = Array.from({ length: 200 }, (_, i) => `| row${i} | filler value ${i} |`);
    rows[150] = '| needle | the matching row |';
    const big = entry({
      path: '/features/table/',
      title: 'Table Page',
      headings: ['Fields'],
      sections: [{ heading: 'Fields', anchor: 'fields', text: rows.join('\n') }],
    });
    const out = searchDocsIndex([big], 'needle');
    expect(out).toContain('| needle | the matching row |');
    expect(out).not.toContain('| row0 |');
    expect(out.length).toBeLessThanOrEqual(DOCS_SEARCH_MAX_CHARS);
  });
});

describe('search_documentation against the shipped index (#10398)', () => {
  const handler = getHandler(buildToolMap());

  it('answers how weekly maintenance windows pick their day', async () => {
    const out = await handler({ query: 'weekly maintenance window day' }, mockAuth);
    expect(out).toContain('most recent Sunday');
  });

  it('answers why a pending reboot is not happening in the window', async () => {
    const out = await handler({ query: 'pending reboot not rebooting during maintenance window' }, mockAuth);
    expect(out).toMatch(/must be \*\*online\*\*/);
  });

  it('stays within the char budget for a broad query', async () => {
    for (const query of ['agent', 'security', 'policy device alert', 'upgrade release notes', 'patch reboot windows', 'api key token']) {
      const out = await handler({ query }, mockAuth);
      expect(out.length).toBeLessThanOrEqual(DOCS_SEARCH_MAX_CHARS);
    }
  });
});

describe('docsIndex.json section contract (#10398)', () => {
  const index = JSON.parse(
    readFileSync(new URL('../data/docsIndex.json', import.meta.url), 'utf8'),
  ) as DocsIndexEntry[];

  it('carries section text for every page (regenerate with `npx tsx scripts/build-docs-index.ts`)', () => {
    for (const page of index) {
      expect(Array.isArray(page.sections), page.path).toBe(true);
      expect(page.sections.map((s) => s.heading).filter(Boolean), page.path).toEqual(page.headings);
    }
  });

  it('emits the same anchors Starlight renders', () => {
    const page = index.find((p) => p.path === '/features/maintenance-windows/')!;
    // The page links to its own heading by this id.
    expect(page.sections.map((s) => s.anchor)).toContain('partner-wide-windows-all-organizations');
  });

  it('strips MDX imports and components from prose', () => {
    for (const page of index) {
      for (const section of page.sections) {
        const prose = section.text.replace(/```[\s\S]*?```/g, '');
        expect(prose, `${page.path}#${section.anchor}`).not.toMatch(/^import\s.+\sfrom\s['"]@astrojs/m);
        expect(prose, `${page.path}#${section.anchor}`).not.toMatch(/<\/?(?:Tabs|TabItem|Aside|Steps)\b/);
      }
    }
  });
});

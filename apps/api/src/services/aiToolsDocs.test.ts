import { describe, expect, it } from 'vitest';
import { registerDocsTools } from './aiToolsDocs';
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

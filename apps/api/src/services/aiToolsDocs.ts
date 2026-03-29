/**
 * AI Documentation Tools
 *
 * Tools for searching Breeze documentation content.
 * - search_documentation (Tier 1): Search how-to guides, feature docs, and reference material
 */

import docsIndex from '../data/docsIndex.json';
import type { AiTool, AiToolTier } from './aiTools';

type DocsSection =
  | 'getting-started'
  | 'deploy'
  | 'agents'
  | 'security'
  | 'features'
  | 'monitoring'
  | 'reference';

interface DocsIndexEntry {
  path: string;
  title: string;
  description: string;
  headings: string[];
  section: DocsSection;
}

const typedDocsIndex = docsIndex as DocsIndexEntry[];

export function registerDocsTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'search_documentation',
      description: 'Search Breeze RMM documentation for how-to guides, feature explanations, and reference material. Use when users ask how to do something, need help understanding a feature, or want to learn about Breeze capabilities.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Search terms to find relevant documentation' },
          section: {
            type: 'string',
            enum: ['getting-started', 'deploy', 'agents', 'security', 'features', 'monitoring', 'reference'],
            description: 'Optional: filter results to a specific documentation section'
          }
        },
        required: ['query']
      }
    },
    handler: async (input, _auth) => {
      const rawQuery = typeof input.query === 'string' ? input.query : '';
      const keywords = rawQuery
        .toLowerCase()
        .split(' ')
        .map((keyword) => keyword.trim())
        .filter(Boolean);

      if (keywords.length === 0) {
        return 'Please provide search terms to find relevant documentation.';
      }

      const sectionFilter = typeof input.section === 'string' ? (input.section as DocsSection) : undefined;
      const candidates = sectionFilter
        ? typedDocsIndex.filter((entry) => entry.section === sectionFilter)
        : typedDocsIndex;

      const results = candidates
        .map((entry) => {
          const searchableText = [
            entry.title,
            entry.description,
            ...entry.headings
          ].join(' ').toLowerCase();
          const score = keywords.reduce((total, keyword) => (
            searchableText.includes(keyword) ? total + 1 : total
          ), 0);

          return { entry, score };
        })
        .filter((result) => result.score > 0)
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return left.entry.title.localeCompare(right.entry.title);
        })
        .slice(0, 5);

      if (results.length === 0) {
        return 'No documentation found matching your query. Try different search terms.';
      }

      return results.map(({ entry }) => [
        `Title: ${entry.title}`,
        `URL: https://docs.breezermm.com${entry.path}`,
        `Description: ${entry.description}`,
        `Key Topics: ${entry.headings.join(', ')}`
      ].join('\n')).join('\n\n');
    }
  });
}

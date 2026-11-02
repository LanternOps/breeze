/**
 * #9855: every tool name the chat system prompt hands the model must be a
 * real registry tool.
 *
 * A live chat run opened with a call to `list_processes_placeholder`, a tool
 * that never existed. No Breeze text named it (checked on main 06c2f51a38),
 * so the model invented it. This suite keeps it that way: any snake_case
 * token in the static chat prompt (base, generated tool index in both
 * `AI_TOOL_INDEX` modes, page-context blocks, tail, diagnosis prompt) is
 * either a registered tool or a reviewed non-tool term in NON_TOOL_TERMS
 * below. A stub, a placeholder, a renamed tool or a test fixture leaking into
 * the prompt fails here instead of reaching a model as a callable name.
 */
import { describe, expect, it } from 'vitest';
import { AI_RECORD_KINDS, type AiPageContext } from '@breeze/shared';
import './aiTools'; // populates the registry
import { aiTools, getAllRegisteredToolNames } from './aiTools';
import { listChatSurfaceToolNames } from './aiAgentSdkTools';
import { AI_SYSTEM_PROMPT_BASE, AI_SYSTEM_PROMPT_TAIL } from './aiAgentSystemPrompt';
import { AI_SYSTEM_PROMPT_DIAGNOSIS } from './aiAgentDiagnosisPrompt';
import {
  composeStaticSystemPrompt,
  DOMAIN_NOTES,
  pageContextToolDomains,
  renderPageContextToolBlocks,
} from './aiToolIndex';

/**
 * One page context per page type, plus one record page per record kind, so
 * every branch of `pageContextToolDomains` renders into the scan. The
 * `satisfies` clause fails to compile when a new page type is added without
 * a fixture here.
 */
const PAGE_FIXTURES = {
  device: { type: 'device', id: 'dddddddd-1111-4222-8333-444455556666', hostname: 'WS-01' },
  alert: { type: 'alert', id: 'aaaaaaaa-1111-4222-8333-444455556666', title: 'Disk full' },
  dashboard: { type: 'dashboard' },
  custom: { type: 'custom', label: 'Custom page', data: {} },
  topology: { type: 'topology', siteId: 'bbbbbbbb-1111-4222-8333-444455556666', subject: { kind: 'node', id: 'node-1' }, view: 'overview', graphRevision: 'rev-1' },
} as const satisfies Record<Exclude<AiPageContext['type'], 'record'>, AiPageContext>;
const PAGE_CONTEXTS: ReadonlyArray<[string, AiPageContext]> = [
  ...Object.entries(PAGE_FIXTURES),
  ...AI_RECORD_KINDS.map((kind): [string, AiPageContext] => [`record:${kind}`, {
    type: 'record', kind, id: 'dddddddd-1111-4222-8333-444455556666', label: 'Record', orgId: 'aaaaaaaa-1111-4222-8333-444455556666',
  }]),
];

// Same tool-shaped token as mcpGuidancePromptTools.test.ts: snake_case with at
// least one underscore. camelCase fields and `manage_*` globs never match.
const TOOL_TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const tokensOf = (text: string): string[] => text.match(TOOL_TOKEN) ?? [];

/**
 * Every string enum value in a registered tool's input schema: `action`
 * values the index inlines (`manage_x (list/create_rule/...)`),
 * execute_command commandTypes, feature types. They are real vocabulary the
 * model passes as arguments, never tool names.
 */
function schemaEnumVocabulary(): Set<string> {
  const vocabulary = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.enum)) {
      for (const value of record.enum) if (typeof value === 'string') vocabulary.add(value);
    }
    Object.values(record).forEach(walk);
  };
  for (const tool of aiTools.values()) walk(tool.definition.input_schema);
  return vocabulary;
}

/**
 * snake_case prose terms that are neither a tool nor a schema enum value
 * (field values, kinds). Adding one is a review decision: it must never
 * collide with a registry name (checked), and it must still appear in the
 * prompt (checked, so the list cannot rot).
 */
const NON_TOOL_TERMS: ReadonlySet<string> = new Set([
  'not_installed', // software_presence monitor condition value (base prompt, Monitors)
]);

function chatPromptTexts(): Array<[string, string]> {
  const names = listChatSurfaceToolNames();
  const texts: Array<[string, string]> = [
    ['AI_SYSTEM_PROMPT_BASE', AI_SYSTEM_PROMPT_BASE],
    ['AI_SYSTEM_PROMPT_TAIL', AI_SYSTEM_PROMPT_TAIL],
    ['AI_SYSTEM_PROMPT_DIAGNOSIS', AI_SYSTEM_PROMPT_DIAGNOSIS],
    ['composeStaticSystemPrompt(lazy)', composeStaticSystemPrompt(names, 'lazy')],
    ['composeStaticSystemPrompt(full)', composeStaticSystemPrompt(names, 'full')],
  ];
  for (const [domain, note] of Object.entries(DOMAIN_NOTES)) texts.push([`DOMAIN_NOTES.${domain}`, note ?? '']);
  for (const [page, ctx] of PAGE_CONTEXTS) {
    texts.push([`page:${page}`, renderPageContextToolBlocks(ctx, names)]);
  }
  return texts;
}

describe('chat system prompt names only real tools (#9855)', () => {
  const registered = new Set(getAllRegisteredToolNames());
  const vocabulary = schemaEnumVocabulary();
  const texts = chatPromptTexts();

  it('is not vacuous: every prompt piece renders and the scan sees real tool names', () => {
    for (const [source, text] of texts.filter(([source]) => !source.startsWith('page:'))) {
      expect(text.length, source).toBeGreaterThan(0);
    }
    const all = tokensOf(texts.map(([, text]) => text).join('\n'));
    expect(all).toContain('execute_command');
    expect(all).toContain('get_device_context');
    expect(texts.filter(([source]) => source.startsWith('page:')).map(([source]) => source)).toEqual(
      expect.arrayContaining(['page:device', 'page:alert', 'page:record:ticket']),
    );
    expect(renderPageContextToolBlocks(PAGE_FIXTURES.device, listChatSurfaceToolNames()).length).toBeGreaterThan(0);
  });

  it('every tool-shaped token is a registered tool, a schema enum value or a reviewed non-tool term', () => {
    const unknown = new Set<string>();
    for (const [source, text] of texts) {
      for (const token of tokensOf(text)) {
        if (!registered.has(token) && !vocabulary.has(token) && !NON_TOOL_TERMS.has(token)) unknown.add(`${source}: ${token}`);
      }
    }
    expect([...unknown], 'Prompt names a tool that is not registered; fix the name or add a reviewed NON_TOOL_TERMS entry').toEqual([]);
  });

  it('no NON_TOOL_TERMS entry shadows a registered tool, and every entry is still used', () => {
    const all = texts.map(([, text]) => text).join('\n');
    const used = new Set(tokensOf(all));
    expect([...NON_TOOL_TERMS].filter((term) => registered.has(term)), 'term is a real tool; drop it from NON_TOOL_TERMS').toEqual([]);
    expect([...NON_TOOL_TERMS].filter((term) => !used.has(term)), 'stale NON_TOOL_TERMS entry').toEqual([]);
  });

  it('no stub or placeholder tool name reaches the prompt or the registry', () => {
    const stubShaped = /(?:^|_)(?:placeholder|stub|dummy|fake|todo|example)(?:_|$)/;
    const all = texts.map(([, text]) => text).join('\n');
    expect(tokensOf(all).filter((token) => stubShaped.test(token))).toEqual([]);
    expect([...registered].filter((name) => stubShaped.test(name))).toEqual([]);
  });
});

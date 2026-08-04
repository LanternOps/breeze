import { describe, expect, it } from 'vitest';

import {
  extractCellText,
  parseMarkdownTable,
  type MarkdownTableNode,
} from './markdownTable';

// Fixture builders mirroring the react-native-markdown-display AST shape:
// table → thead → tr → th → textgroup → text (see markdownTable.ts header).
const text = (content: string): MarkdownTableNode => ({ type: 'text', content });
const textgroup = (...children: MarkdownTableNode[]): MarkdownTableNode => ({
  type: 'textgroup',
  children,
});
const node = (type: string, ...children: MarkdownTableNode[]): MarkdownTableNode => ({
  type,
  children,
});
const cell = (type: 'th' | 'td', content: string): MarkdownTableNode =>
  node(type, textgroup(text(content)));

const fleetTable: MarkdownTableNode = node(
  'table',
  node('thead', node('tr', cell('th', 'Device'), cell('th', 'OS'), cell('th', 'Last Seen'))),
  node(
    'tbody',
    node(
      'tr',
      cell('td', 'Domain Controller (RVW-DC-01)'),
      cell('td', 'Windows Server'),
      cell('td', 'July 11, 2:03 AM'),
    ),
    node(
      'tr',
      cell('td', 'Reception PC (RVW-WIN-01)'),
      cell('td', 'Windows'),
      cell('td', 'July 11, 2:02 AM'),
    ),
  ),
);

describe('parseMarkdownTable', () => {
  it('parses header labels and body rows from a GFM table AST', () => {
    expect(parseMarkdownTable(fleetTable)).toEqual({
      labels: ['Device', 'OS', 'Last Seen'],
      rows: [
        ['Domain Controller (RVW-DC-01)', 'Windows Server', 'July 11, 2:03 AM'],
        ['Reception PC (RVW-WIN-01)', 'Windows', 'July 11, 2:02 AM'],
      ],
    });
  });

  it('finds rows without relying on thead/tbody wrappers', () => {
    const bare = node(
      'table',
      node('tr', cell('th', 'A'), cell('th', 'B')),
      node('tr', cell('td', '1'), cell('td', '2')),
    );
    expect(parseMarkdownTable(bare)).toEqual({
      labels: ['A', 'B'],
      rows: [['1', '2']],
    });
  });

  it('keeps ragged rows (fewer or more cells than the header)', () => {
    const ragged = node(
      'table',
      node('thead', node('tr', cell('th', 'A'), cell('th', 'B'))),
      node('tbody', node('tr', cell('td', 'only')), node('tr', cell('td', '1'), cell('td', '2'), cell('td', '3'))),
    );
    expect(parseMarkdownTable(ragged).rows).toEqual([['only'], ['1', '2', '3']]);
  });

  it('treats extra header rows as body rows so content is not dropped', () => {
    const twoHeaders = node(
      'table',
      node('thead', node('tr', cell('th', 'A')), node('tr', cell('th', 'A2'))),
      node('tbody', node('tr', cell('td', '1'))),
    );
    expect(parseMarkdownTable(twoHeaders)).toEqual({
      labels: ['A'],
      rows: [['A2'], ['1']],
    });
  });

  it('returns empty labels for a table without a header row', () => {
    const headerless = node('table', node('tbody', node('tr', cell('td', 'x'), cell('td', 'y'))));
    expect(parseMarkdownTable(headerless)).toEqual({ labels: [], rows: [['x', 'y']] });
  });

  it('returns a header-only table as labels with no rows', () => {
    const headerOnly = node('table', node('thead', node('tr', cell('th', 'A'), cell('th', 'B'))));
    expect(parseMarkdownTable(headerOnly)).toEqual({ labels: ['A', 'B'], rows: [] });
  });

  it('handles an empty table node', () => {
    expect(parseMarkdownTable(node('table'))).toEqual({ labels: [], rows: [] });
  });

  it('collapses whitespace and trims cell text', () => {
    const table = node(
      'table',
      node('thead', node('tr', node('th', textgroup(text('  Last '), text(' Seen  '))))),
    );
    expect(parseMarkdownTable(table).labels).toEqual(['Last Seen']);
  });
});

describe('extractCellText', () => {
  it('flattens inline markup to its text content', () => {
    const rich = node(
      'td',
      textgroup(
        node('strong', text('RVW-DC-01')),
        text(' is '),
        { type: 'code_inline', content: 'offline' },
      ),
    );
    expect(extractCellText(rich)).toBe('RVW-DC-01 is offline');
  });

  it('renders soft/hard breaks as spaces', () => {
    const broken = node('td', textgroup(text('a'), { type: 'softbreak' }, text('b')));
    expect(extractCellText(broken)).toBe('a b');
  });

  it('uses alt text for images', () => {
    const img: MarkdownTableNode = {
      type: 'image',
      attributes: { alt: 'screenshot' },
    };
    expect(extractCellText(node('td', img))).toBe('screenshot');
  });
});

// Pure AST helpers behind the chat markdown table renderer (issue #3119).
//
// react-native-markdown-display parses GFM tables into an AST shaped like
//   table → thead → tr → th → textgroup → text
//         → tbody → tr → td → textgroup → text
// but the wrapper layers vary (textgroup only appears around inline runs,
// and some pipelines emit tr directly under table), so discovery here is
// recursive rather than positional.
//
// Deliberately free of React / React Native imports so the mobile Vitest
// config (node env, .ts only) can cover it.

export interface MarkdownTableNode {
  type: string;
  content?: string;
  children?: readonly MarkdownTableNode[];
  attributes?: Record<string, unknown>;
}

export interface ParsedMarkdownTable {
  /** Header cell texts, in column order. Empty when the table has no header row. */
  labels: string[];
  /** Body rows (plus any extra header rows), each as cell texts in column order. */
  rows: string[][];
}

/** Depth-first collect of descendant nodes matching `types`, without descending into a match. */
function collectDescendants(
  node: MarkdownTableNode,
  types: readonly string[],
  out: MarkdownTableNode[] = [],
): MarkdownTableNode[] {
  for (const child of node.children ?? []) {
    if (types.includes(child.type)) {
      out.push(child);
    } else {
      collectDescendants(child, types, out);
    }
  }
  return out;
}

/** Flatten a cell subtree to plain text (inline markup is dropped, content kept). */
export function extractCellText(node: MarkdownTableNode): string {
  if (node.type === 'softbreak' || node.type === 'hardbreak') {
    return ' ';
  }
  if (node.type === 'image') {
    return String(node.attributes?.alt ?? '');
  }
  const children = node.children ?? [];
  if (children.length === 0) {
    return node.content ?? '';
  }
  return children.map(extractCellText).join('');
}

function cellText(node: MarkdownTableNode): string {
  return extractCellText(node).replace(/\s+/g, ' ').trim();
}

/**
 * Parse a `table` AST node into header labels and body rows.
 *
 * A row counts as a header row when any of its cells is a `th`. Only the
 * first header row supplies labels; any further header rows are kept as
 * ordinary rows so no content is silently dropped.
 */
export function parseMarkdownTable(table: MarkdownTableNode): ParsedMarkdownTable {
  const headerRows: string[][] = [];
  const bodyRows: string[][] = [];

  for (const tr of collectDescendants(table, ['tr'])) {
    const cells = collectDescendants(tr, ['th', 'td']);
    if (cells.length === 0) {
      continue;
    }
    const values = cells.map(cellText);
    if (cells.some((cell) => cell.type === 'th')) {
      headerRows.push(values);
    } else {
      bodyRows.push(values);
    }
  }

  const [labels = [], ...extraHeaderRows] = headerRows;
  return { labels, rows: [...extraHeaderRows, ...bodyRows] };
}

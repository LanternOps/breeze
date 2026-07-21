/**
 * Contract test: the published AI docs page
 * (apps/docs/src/content/docs/features/ai.mdx) must agree with the real
 * guardrail tables in aiGuardrails.ts. Issue #2686.
 *
 * Same contract as aiGuardrailsTierConfig.parity.test.ts, different mirror —
 * label parsing and the checkGuardrails comparison are shared via
 * aiGuardrailsTierParity.shared.ts. The page is read as text rather than
 * imported (it is MDX, and @breeze/docs is not a dependency of @breeze/api);
 * precedent for an API test reading a repo file: config/proxyTrustCompose.test.ts.
 *
 * Strictness: markdown is far looser than a TS object literal, so the parser is
 * deliberately narrow and LOUD.
 *   • It recognises exactly two table shapes by their header row:
 *     `| Tier | Execution | Examples |` and `| Tool | Tier | Description |`.
 *   • Inside a recognised table EVERY body row must parse — an unreadable row
 *     fails the suite, it is never skipped. A row the guard cannot read is a
 *     row it is not guarding.
 *   • Any OTHER markdown table whose header mentions "Tier" is reported as
 *     unrecognised, so a new tier table in a new shape cannot slip in
 *     unguarded.
 *
 * NOTE: no vi.mock — this suite needs the REAL aiTools registry, because base
 * tiers are half the answer.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  driftMessage,
  findTierMismatches,
  parseToolLabel,
  type ClaimedTierEntry,
} from './aiGuardrailsTierParity.shared';

// apps/api/src/services -> repo root is 4 levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOC_REL = 'apps/docs/src/content/docs/features/ai.mdx';
const DOC_PATH = path.join(REPO_ROOT, DOC_REL);

const TIER_MATRIX_HEADER = '| Tier | Execution | Examples |';
const TOOL_TABLE_HEADER = '| Tool | Tier | Description |';

/** `| a | b | c |` -> ['a','b','c']; null when the line is not a table row. */
function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((c) => c.trim());
}

const isSeparatorRow = (cells: string[]): boolean =>
  cells.every((c) => /^:?-{2,}:?$/.test(c));

/** `**Tier 3**`, `Tier 3` or a bare `3`. */
function parseTierCell(cell: string): number | null {
  const m = /^(?:\*\*)?(?:Tier\s+)?([1-4])(?:\*\*)?$/.exec(cell.trim());
  return m ? Number(m[1]) : null;
}

const claims: ClaimedTierEntry[] = [];
const unparseableRows: string[] = [];
const unrecognisedTierTables: string[] = [];
let tierMatrixRows = 0;
let toolTableRows = 0;

{
  const lines = readFileSync(DOC_PATH, 'utf8').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]!;
    const headerCells = splitRow(header);
    if (!headerCells) continue;
    // A header row is a table row immediately followed by a separator row.
    const nextCells = splitRow(lines[i + 1] ?? '');
    if (!nextCells || !isSeparatorRow(nextCells)) continue;

    const normalisedHeader = `| ${headerCells.join(' | ')} |`;
    const isTierMatrix = normalisedHeader === TIER_MATRIX_HEADER;
    const isToolTable = normalisedHeader === TOOL_TABLE_HEADER;

    if (!isTierMatrix && !isToolTable) {
      if (headerCells.some((c) => /tier/i.test(c))) {
        unrecognisedTierTables.push(`${DOC_REL}:${i + 1} — ${normalisedHeader}`);
      }
      continue;
    }

    // Walk the body rows.
    for (let j = i + 2; j < lines.length; j++) {
      const cells = splitRow(lines[j]!);
      if (!cells) break;
      const where = `${DOC_REL}:${j + 1}`;

      if (isToolTable) {
        toolTableRows++;
        const [toolCell, tierCell] = cells;
        const tier = parseTierCell(tierCell ?? '');
        const label = parseToolLabel((toolCell ?? '').replace(/`/g, ''));
        if (tier === null || !label) {
          unparseableRows.push(`${where} — ${lines[j]!.trim()}`);
          continue;
        }
        // Tier 4 is "blocked", never a per-tool claim; treat it like any other.
        claims.push({ claimedTier: tier, label: toolCell!, where, ...label });
        continue;
      }

      // Tier-matrix row: `| **Tier N** | execution | examples |`.
      tierMatrixRows++;
      const tier = parseTierCell(cells[0] ?? '');
      if (tier === null) {
        unparseableRows.push(`${where} — ${lines[j]!.trim()}`);
        continue;
      }
      // Tier 4 lists concepts ("Cross-org operations"), not tools — same
      // carve-out as tierConfig.ts.
      if (tier === 4) continue;

      for (const rawExample of (cells[2] ?? '').split(',')) {
        const example = rawExample.trim();
        if (!example) continue;
        // `tool` or `tool` (action/action) — backticks around the tool only.
        const m = /^`([a-z0-9_]+)`(?:\s+\(([a-z0-9_/]+)\))?$/.exec(example);
        const label = m
          ? parseToolLabel(m[2] ? `${m[1]} (${m[2]})` : m[1]!)
          : null;
        if (!label) {
          unparseableRows.push(`${where} — unreadable example "${example}"`);
          continue;
        }
        claims.push({ claimedTier: tier, label: example, where, ...label });
      }
    }
  }
}

describe('features/ai.mdx ↔ aiGuardrails tier tables parity (#2686)', () => {
  it('found the tier tables it expects to guard', () => {
    // Guards against a rename/restructure silently emptying the sweep.
    expect(tierMatrixRows).toBeGreaterThanOrEqual(4);
    expect(toolTableRows).toBeGreaterThanOrEqual(10);
    expect(claims.length).toBeGreaterThan(40);
    expect(claims.some((c) => c.actions.length > 0)).toBe(true);
  });

  it('every row of every recognised tier table is machine-checkable', () => {
    expect(
      unparseableRows,
      `Unreadable tier rows in ${DOC_REL}. Each must be either \`tool\` or ` +
      `\`tool\` (action/action) using REAL guardrail action identifiers — ` +
      `prose such as "acknowledge/resolve actions" is not checkable, and an ` +
      `unchecked row is an unguarded row.\n` +
      unparseableRows.map((r) => `  • ${r}`).join('\n'),
    ).toEqual([]);
  });

  it('has no tier table in an unrecognised shape', () => {
    expect(
      unrecognisedTierTables,
      `${DOC_REL} contains a table whose header mentions "Tier" but is not one ` +
      `of the two shapes this guard parses (${TIER_MATRIX_HEADER} / ` +
      `${TOOL_TABLE_HEADER}). Either use a recognised shape or teach the ` +
      `parser about the new one — do not leave it unguarded.\n` +
      unrecognisedTierTables.map((r) => `  • ${r}`).join('\n'),
    ).toEqual([]);
  });

  it('every documented tool/action pair resolves to the tier the docs claim', () => {
    const mismatches = findTierMismatches(claims);
    expect(mismatches, driftMessage(DOC_REL, mismatches)).toEqual([]);
  });
});

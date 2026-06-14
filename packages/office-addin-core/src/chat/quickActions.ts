/**
 * Selection-aware quick-action chips (empty-state UX). A non-technical user
 * doesn't know what to ask the assistant, so we read the captured workbook
 * selection and offer a few canned prompts that fit what they have highlighted.
 *
 * This module is PURE: `summarizeSelection` distils a WorkbookContext into a
 * small shape descriptor, and `quickActionsFor` maps that shape to a fixed,
 * deterministic chip list. The chips' prompts reference "the selection"
 * naturally — the model already receives the selection as workbook context on
 * every message, so the prompt text only needs to point at it.
 */
import type { CellValue, WorkbookContext } from '../api/types';

export type SelectionShape =
  | 'empty' // no/empty/over-cap selection, or an explicit "none" context
  | 'single' // a single cell with a plain (non-formula) value
  | 'formula' // a single cell whose value is a formula
  | 'numeric' // a multi-cell range that is mostly numbers
  | 'table' // a multi-cell range that looks tabular (text header over a body)
  | 'range' // a multi-cell range that is neither numeric nor tabular
  | 'sheet'; // the whole active sheet (context kind 'sheet')

export type SelectionSummary = { shape: SelectionShape; address?: string };

export type QuickAction = {
  /** Stable id (also the data-testid suffix). */
  id: string;
  /** Short button label shown in the chip. */
  label: string;
  /** Canned prompt sent verbatim to the assistant on click. */
  prompt: string;
};

function isFormula(value: CellValue): boolean {
  return typeof value === 'string' && value.startsWith('=');
}

function flatten(cells: CellValue[][]): CellValue[] {
  return cells.flat();
}

function nonEmpty(value: CellValue): boolean {
  return value !== null && value !== '';
}

function isNumeric(value: CellValue): boolean {
  return typeof value === 'number';
}

/** A header row of text sitting over a body that has at least one number. */
function looksTabular(cells: CellValue[][]): boolean {
  if (cells.length < 2) return false;
  const header = cells[0] ?? [];
  const headerAllText =
    header.length > 1 && header.every((c) => typeof c === 'string' && c.trim() !== '');
  if (!headerAllText) return false;
  const body = cells.slice(1);
  const bodyHasNumber = body.some((row) => row.some(isNumeric));
  return bodyHasNumber;
}

/** Mostly-numbers (≥ 60% of the non-empty cells are numeric). */
function mostlyNumeric(cells: CellValue[][]): boolean {
  const values = flatten(cells).filter(nonEmpty);
  if (values.length === 0) return false;
  const numeric = values.filter(isNumeric).length;
  return numeric / values.length >= 0.6;
}

/**
 * Distil a captured workbook context into a coarse shape used to pick chips.
 * Defensive by design: anything we can't classify collapses to a safe default
 * ('empty' for no data, 'range' for an unclassifiable multi-cell selection).
 */
export function summarizeSelection(ctx: WorkbookContext | undefined): SelectionSummary {
  if (!ctx || ctx.kind === 'none') return { shape: 'empty' };

  const cells = ctx.cells;
  // captureContext omits `cells` past CONTEXT_CELL_CAP, or there may simply be
  // no selection — without cell data we can't classify, so stay generic.
  if (!cells || cells.length === 0) return { shape: 'empty' };

  const address = ctx.address;

  if (ctx.kind === 'sheet') {
    return address ? { shape: 'sheet', address } : { shape: 'sheet' };
  }

  const flat = flatten(cells);
  const single = flat.length === 1;

  if (single) {
    const value = flat[0]!;
    const shape: SelectionShape = isFormula(value) ? 'formula' : 'single';
    return address ? { shape, address } : { shape };
  }

  let shape: SelectionShape = 'range';
  if (mostlyNumeric(cells)) shape = 'numeric';
  else if (looksTabular(cells)) shape = 'table';

  return address ? { shape, address } : { shape };
}

const GENERIC: QuickAction[] = [
  {
    id: 'summarize-sheet',
    label: 'Summarize this sheet',
    prompt: 'Summarize what is on this sheet and call out the key numbers.',
  },
  {
    id: 'what-can-you-do',
    label: 'What can you do?',
    prompt: 'What can you help me do with this spreadsheet? Give me a few examples.',
  },
];

/**
 * Map a selection summary to a small, deterministic set of chips (≤ 4). Prompts
 * reference "the selection"/"the selected cell" so they read naturally — the
 * model receives the actual selection as workbook context per message.
 */
export function quickActionsFor(summary: SelectionSummary): QuickAction[] {
  switch (summary.shape) {
    case 'formula':
      return [
        {
          id: 'explain-formula',
          label: 'Explain this formula',
          prompt: 'Explain what the formula in the selected cell does, step by step.',
        },
        {
          id: 'check-errors',
          label: 'Check for errors',
          prompt: 'Check the formula in the selected cell for errors or edge cases.',
        },
      ];

    case 'numeric':
      return [
        {
          id: 'summarize-data',
          label: 'Summarize this',
          prompt: 'Summarize the selected data and call out totals, averages, and any outliers.',
        },
        {
          id: 'make-chart',
          label: 'Make a chart',
          prompt: 'Suggest and create the best chart for the selected data.',
        },
      ];

    case 'table':
      return [
        {
          id: 'find-duplicates',
          label: 'Find duplicates',
          prompt: 'Find duplicate rows in the selection and tell me where they are.',
        },
        {
          id: 'clean-data',
          label: 'Clean this data',
          prompt:
            'Clean up the selected data: flag blanks, inconsistent formatting, and obvious errors.',
        },
        {
          id: 'summarize-data',
          label: 'Summarize this',
          prompt: 'Summarize the selected table and describe what each column contains.',
        },
      ];

    case 'range':
      return [
        {
          id: 'summarize-data',
          label: 'Summarize this',
          prompt: 'Summarize the selected data and tell me what stands out.',
        },
        {
          id: 'find-duplicates',
          label: 'Find duplicates',
          prompt: 'Find duplicate values in the selection.',
        },
      ];

    case 'single':
      return [
        {
          id: 'explain-cell',
          label: 'Explain this cell',
          prompt: 'Explain the value in the selected cell and where it likely comes from.',
        },
        {
          id: 'summarize-sheet',
          label: 'Summarize this sheet',
          prompt: 'Summarize what is on this sheet and call out the key numbers.',
        },
      ];

    case 'sheet':
      return [
        {
          id: 'summarize-sheet',
          label: 'Summarize this sheet',
          prompt: 'Summarize what is on this sheet and call out the key numbers.',
        },
        {
          id: 'find-duplicates',
          label: 'Find duplicates',
          prompt: 'Find duplicate rows on this sheet and tell me where they are.',
        },
      ];

    case 'empty':
    default:
      return GENERIC;
  }
}

import { stripSheet } from '@breeze/office-addin-core';
import { addressDims, assertCellCap, optionalString, requireString, resolveSheet, ToolInputError } from './helpers';

type BorderEdge = 'top' | 'bottom' | 'left' | 'right' | 'all';
type BordersInput = { edges?: BorderEdge[]; style?: 'continuous' | 'none'; color?: string };
type AlignmentInput = {
  horizontal?: 'left' | 'center' | 'right';
  vertical?: 'top' | 'middle' | 'bottom';
  wrapText?: boolean;
};
type CellValueOperator =
  | 'greaterThan'
  | 'lessThan'
  | 'equalTo'
  | 'between'
  | 'greaterThanOrEqual'
  | 'lessThanOrEqual';
type ConditionalFormatInput =
  | { type: 'colorScale' }
  | {
      type: 'cellValue';
      operator: CellValueOperator;
      formula1: string;
      formula2?: string;
      format?: { fontColor?: string; fillColor?: string; bold?: boolean };
    };

type FormatInput = {
  bold?: boolean;
  italic?: boolean;
  fontColor?: string;
  fillColor?: string;
  numberFormat?: string;
  fontSize?: number;
  borders?: BordersInput;
  alignment?: AlignmentInput;
  conditionalFormat?: ConditionalFormatInput;
};

// 'all' fans out to every outer + inner edge so the model can box a range in one call.
const EDGE_INDEX: Record<Exclude<BorderEdge, 'all'>, Excel.BorderIndex> = {
  top: 'EdgeTop' as Excel.BorderIndex,
  bottom: 'EdgeBottom' as Excel.BorderIndex,
  left: 'EdgeLeft' as Excel.BorderIndex,
  right: 'EdgeRight' as Excel.BorderIndex,
};
const ALL_EDGES: Excel.BorderIndex[] = [
  'EdgeTop',
  'EdgeBottom',
  'EdgeLeft',
  'EdgeRight',
  'InsideHorizontal',
  'InsideVertical',
] as Excel.BorderIndex[];
const HORIZONTAL: Record<NonNullable<AlignmentInput['horizontal']>, Excel.HorizontalAlignment> = {
  left: 'Left' as Excel.HorizontalAlignment,
  center: 'Center' as Excel.HorizontalAlignment,
  right: 'Right' as Excel.HorizontalAlignment,
};
const VERTICAL: Record<NonNullable<AlignmentInput['vertical']>, Excel.VerticalAlignment> = {
  top: 'Top' as Excel.VerticalAlignment,
  middle: 'Center' as Excel.VerticalAlignment,
  bottom: 'Bottom' as Excel.VerticalAlignment,
};
const CELL_VALUE_OPERATOR: Record<CellValueOperator, Excel.ConditionalCellValueOperator> = {
  greaterThan: 'GreaterThan' as Excel.ConditionalCellValueOperator,
  lessThan: 'LessThan' as Excel.ConditionalCellValueOperator,
  equalTo: 'EqualTo' as Excel.ConditionalCellValueOperator,
  between: 'Between' as Excel.ConditionalCellValueOperator,
  greaterThanOrEqual: 'GreaterThanOrEqual' as Excel.ConditionalCellValueOperator,
  lessThanOrEqual: 'LessThanOrEqual' as Excel.ConditionalCellValueOperator,
};

function resolveEdges(edges: BorderEdge[] | undefined): Excel.BorderIndex[] {
  if (!edges || edges.length === 0) return [];
  if (edges.includes('all')) return ALL_EDGES;
  return edges.map((e) => EDGE_INDEX[e as Exclude<BorderEdge, 'all'>]);
}

/** MUTATING. Applies a whitelisted subset of formatting to a range:
 *  font styling, fill, number format, borders, alignment/wrapping, and a simple
 *  conditional-format rule. */
export async function formatRange(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const raw = input.format;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new ToolInputError('format must be an object');
  const format = raw as FormatInput;
  const { rows, cols } = addressDims(address);
  assertCellCap(rows, cols, `Format of ${address}`);

  // Validate the conditional-format type up front (untrusted model input).
  if (format.conditionalFormat !== undefined) {
    const cf = format.conditionalFormat;
    if (cf === null || typeof cf !== 'object' || (cf.type !== 'colorScale' && cf.type !== 'cellValue'))
      throw new ToolInputError('conditionalFormat.type must be "colorScale" or "cellValue"');
  }

  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const range = sheet.getRange(stripSheet(address));
    const applied: string[] = [];

    if (typeof format.bold === 'boolean') {
      range.format.font.bold = format.bold;
      applied.push('bold');
    }
    if (typeof format.italic === 'boolean') {
      range.format.font.italic = format.italic;
      applied.push('italic');
    }
    if (typeof format.fontColor === 'string') {
      range.format.font.color = format.fontColor;
      applied.push('fontColor');
    }
    if (typeof format.fillColor === 'string') {
      range.format.fill.color = format.fillColor;
      applied.push('fillColor');
    }
    if (typeof format.fontSize === 'number') {
      range.format.font.size = format.fontSize;
      applied.push('fontSize');
    }
    if (typeof format.numberFormat === 'string') {
      range.numberFormat = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => format.numberFormat!),
      );
      applied.push('numberFormat');
    }

    if (format.borders && typeof format.borders === 'object') {
      const { edges, style, color } = format.borders;
      const targets = resolveEdges(edges);
      if (targets.length > 0) {
        const lineStyle = (style === 'none' ? 'None' : 'Continuous') as Excel.BorderLineStyle;
        for (const edge of targets) {
          const border = range.format.borders.getItem(edge);
          border.style = lineStyle;
          if (typeof color === 'string') border.color = color;
        }
        applied.push('borders');
      }
    }

    if (format.alignment && typeof format.alignment === 'object') {
      const { horizontal, vertical, wrapText } = format.alignment;
      let touched = false;
      if (horizontal && HORIZONTAL[horizontal]) {
        range.format.horizontalAlignment = HORIZONTAL[horizontal];
        touched = true;
      }
      if (vertical && VERTICAL[vertical]) {
        range.format.verticalAlignment = VERTICAL[vertical];
        touched = true;
      }
      if (typeof wrapText === 'boolean') {
        range.format.wrapText = wrapText;
        touched = true;
      }
      if (touched) applied.push('alignment');
    }

    // Conditional formatting is feature-detected: older Excel hosts lack the
    // conditionalFormats collection, so skip rather than crash the whole call.
    if (format.conditionalFormat && range.conditionalFormats) {
      const cf = format.conditionalFormat;
      if (cf.type === 'colorScale') {
        range.conditionalFormats.add(Excel.ConditionalFormatType.colorScale);
        applied.push('conditionalFormat');
      } else {
        const added = range.conditionalFormats.add(Excel.ConditionalFormatType.cellValue);
        added.cellValue.rule = {
          operator: CELL_VALUE_OPERATOR[cf.operator],
          formula1: cf.formula1,
          ...(cf.formula2 !== undefined ? { formula2: cf.formula2 } : {}),
        };
        if (cf.format) {
          if (typeof cf.format.fontColor === 'string') added.cellValue.format.font.color = cf.format.fontColor;
          if (typeof cf.format.bold === 'boolean') added.cellValue.format.font.bold = cf.format.bold;
          if (typeof cf.format.fillColor === 'string') added.cellValue.format.fill.color = cf.format.fillColor;
        }
        applied.push('conditionalFormat');
      }
    }

    if (applied.length === 0)
      throw new ToolInputError(
        'format contained no supported keys (bold, italic, fontColor, fillColor, fontSize, numberFormat, borders, alignment, conditionalFormat)',
      );
    range.load('address');
    await context.sync();
    return { address: range.address, applied };
  });
}

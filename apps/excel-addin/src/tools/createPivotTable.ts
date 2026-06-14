import { stripSheet } from '@breeze/office-addin-core';
import { optionalString, requireString, resolveSheet, ToolInputError } from './helpers';

/** Friendly aggregation names → Excel.AggregationFunction string-literal values. */
const AGGREGATION_MAP: Record<string, Excel.AggregationFunction> = {
  sum: 'Sum' as Excel.AggregationFunction,
  count: 'Count' as Excel.AggregationFunction,
  average: 'Average' as Excel.AggregationFunction,
  max: 'Max' as Excel.AggregationFunction,
  min: 'Min' as Excel.AggregationFunction,
};

type ValueField = { field: string; aggregation?: string };

function parseValues(input: Record<string, unknown>): Array<{ field: string; aggregation: string }> {
  const raw = input.values;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new ToolInputError('values must be a non-empty array of { field, aggregation? }');
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new ToolInputError('each values entry must be an object { field, aggregation? }');
    const { field, aggregation } = entry as ValueField;
    if (typeof field !== 'string' || field.length === 0)
      throw new ToolInputError('each values entry needs a non-empty field name');
    const aggKey = aggregation ?? 'sum';
    if (!AGGREGATION_MAP[aggKey])
      throw new ToolInputError(
        `aggregation must be one of ${Object.keys(AGGREGATION_MAP).join(', ')} (got "${aggKey}")`,
      );
    return { field, aggregation: aggKey };
  });
}

function parseFieldList(input: Record<string, unknown>, key: string, required: boolean): string[] {
  const raw = input[key];
  if (raw === undefined || raw === null) {
    if (required) throw new ToolInputError(`${key} must be a non-empty array of field names`);
    return [];
  }
  if (!Array.isArray(raw) || (required && raw.length === 0))
    throw new ToolInputError(`${key} must be a${required ? ' non-empty' : 'n'} array of field names`);
  return raw.map((f) => {
    if (typeof f !== 'string' || f.length === 0)
      throw new ToolInputError(`${key} entries must be non-empty strings`);
    return f;
  });
}

/**
 * MUTATING — only ever invoked through the approval store (Task 8).
 * Requires ExcelApi 1.8 (PivotTable hierarchy APIs). When the host build does
 * not support it, returns { error } so the model can fall back to a formula
 * summary instead of the tool crashing.
 */
export async function createPivotTable(input: Record<string, unknown>): Promise<unknown> {
  const sourceAddress = requireString(input, 'sourceAddress');
  const destinationAddress = requireString(input, 'destinationAddress');
  const sheetName = optionalString(input, 'sheetName');
  const rows = parseFieldList(input, 'rows', true);
  const columns = parseFieldList(input, 'columns', false);
  const values = parseValues(input);

  const supported = Office.context.requirements.isSetSupported('ExcelApi', '1.8');
  if (!supported) {
    return {
      error:
        'This Excel build does not support the PivotTable API (requires ExcelApi 1.8). Fall back to a formula-based summary (e.g. SUMIFS/AVERAGEIFS into a grid) instead.',
    };
  }

  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, sourceAddress);
    sheet.load('name');
    await context.sync();

    const sourceRange = sheet.getRange(stripSheet(sourceAddress));
    const destinationRange = sheet.getRange(stripSheet(destinationAddress));
    const pivot = sheet.pivotTables.add(
      `PivotTable_${Date.now()}`,
      sourceRange,
      destinationRange,
    );
    pivot.load('name');
    await context.sync();

    const resolveHierarchy = (field: string) => {
      const hierarchy = pivot.hierarchies.getItemOrNullObject(field);
      return hierarchy;
    };

    const addField = async (field: string): Promise<Excel.PivotHierarchy> => {
      const hierarchy = resolveHierarchy(field);
      hierarchy.load('name');
      await context.sync();
      if (hierarchy.isNullObject)
        throw new ToolInputError(
          `"${field}" is not a column header in the source range ${stripSheet(sourceAddress)}`,
        );
      return hierarchy;
    };

    for (const field of rows) {
      pivot.rowHierarchies.add(await addField(field));
    }
    for (const field of columns) {
      pivot.columnHierarchies.add(await addField(field));
    }
    for (const { field, aggregation } of values) {
      const dataHierarchy = pivot.dataHierarchies.add(await addField(field));
      dataHierarchy.summarizeBy = AGGREGATION_MAP[aggregation]!;
    }
    await context.sync();

    return {
      name: pivot.name,
      sourceAddress: `${sheet.name}!${stripSheet(sourceAddress)}`,
      destinationAddress: `${sheet.name}!${stripSheet(destinationAddress)}`,
      sheetName: sheet.name,
      rows,
      columns,
      values,
    };
  });
}

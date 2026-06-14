import { stripSheet } from '@breeze/office-addin-core';
import { optionalString, requireString, resolveSheet, ToolInputError } from './helpers';

/** Friendly chart-type names → Excel.ChartType string-literal values. */
const CHART_TYPE_MAP: Record<string, Excel.ChartType> = {
  columnClustered: 'ColumnClustered' as Excel.ChartType,
  line: 'Line' as Excel.ChartType,
  pie: 'Pie' as Excel.ChartType,
  bar: 'BarClustered' as Excel.ChartType,
  area: 'Area' as Excel.ChartType,
};

/** Friendly seriesBy → Excel.ChartSeriesBy string-literal values. */
const SERIES_BY_MAP: Record<string, Excel.ChartSeriesBy> = {
  rows: 'Rows' as Excel.ChartSeriesBy,
  columns: 'Columns' as Excel.ChartSeriesBy,
  auto: 'Auto' as Excel.ChartSeriesBy,
};

/** MUTATING — only ever invoked through the approval store (Task 8). */
export async function createChart(input: Record<string, unknown>): Promise<unknown> {
  const sourceAddress = requireString(input, 'sourceAddress');
  const sheetName = optionalString(input, 'sheetName');
  const chartTypeKey = requireString(input, 'chartType');
  const type = CHART_TYPE_MAP[chartTypeKey];
  if (!type)
    throw new ToolInputError(
      `chartType must be one of ${Object.keys(CHART_TYPE_MAP).join(', ')} (got "${chartTypeKey}")`,
    );
  const title = optionalString(input, 'title');
  const seriesByKey = optionalString(input, 'seriesBy');
  if (seriesByKey !== undefined && !SERIES_BY_MAP[seriesByKey])
    throw new ToolInputError(
      `seriesBy must be one of ${Object.keys(SERIES_BY_MAP).join(', ')} (got "${seriesByKey}")`,
    );
  const seriesBy = seriesByKey ? SERIES_BY_MAP[seriesByKey] : SERIES_BY_MAP.auto;

  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, sourceAddress);
    sheet.load('name');
    await context.sync();
    const range = sheet.getRange(stripSheet(sourceAddress));
    const chart = sheet.charts.add(type, range, seriesBy);
    if (title !== undefined) chart.title.text = title;
    chart.load('name');
    await context.sync();
    return {
      name: chart.name,
      chartType: type,
      sourceAddress: `${sheet.name}!${stripSheet(sourceAddress)}`,
      sheetName: sheet.name,
      title: title ?? null,
    };
  });
}

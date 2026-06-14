import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { createChart } from './createChart';

describe('create_chart', () => {
  it('adds a chart of the requested type over the source range and reports it', async () => {
    const result = (await createChart({
      sourceAddress: 'A1:D12',
      chartType: 'columnClustered',
    })) as { name: string; chartType: string; sourceAddress: string; sheetName: string };
    expect(result.chartType).toBe('ColumnClustered');
    expect(result.sourceAddress).toBe('Sheet1!A1:D12');
    expect(result.sheetName).toBe('Sheet1');
    const charts = getOfficeMock().charts;
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ type: 'ColumnClustered', seriesBy: 'Auto' });
  });

  it('maps friendly chart types to Excel.ChartType values', async () => {
    const line = (await createChart({ sourceAddress: 'A1:B5', chartType: 'line' })) as {
      chartType: string;
    };
    expect(line.chartType).toBe('Line');
    const pie = (await createChart({ sourceAddress: 'A1:B5', chartType: 'pie' })) as {
      chartType: string;
    };
    expect(pie.chartType).toBe('Pie');
    const bar = (await createChart({ sourceAddress: 'A1:B5', chartType: 'bar' })) as {
      chartType: string;
    };
    expect(bar.chartType).toBe('BarClustered');
    const area = (await createChart({ sourceAddress: 'A1:B5', chartType: 'area' })) as {
      chartType: string;
    };
    expect(area.chartType).toBe('Area');
  });

  it('sets the chart title when provided and passes seriesBy through', async () => {
    const result = (await createChart({
      sourceAddress: 'A1:D12',
      chartType: 'line',
      title: 'Quarterly revenue',
      seriesBy: 'columns',
    })) as { title: string | null };
    expect(result.title).toBe('Quarterly revenue');
    const chart = getOfficeMock().charts[0]!;
    expect(chart.title).toBe('Quarterly revenue');
    expect(chart.seriesBy).toBe('Columns');
  });

  it('rejects an unknown chart type', async () => {
    await expect(
      createChart({ sourceAddress: 'A1:B5', chartType: 'donut3d' }),
    ).rejects.toThrow(/chartType/);
  });

  it('resolves the sheet from an explicit sheetName', async () => {
    getOfficeMock().addSheet('Data');
    const result = (await createChart({
      sourceAddress: 'A1:B5',
      sheetName: 'Data',
      chartType: 'line',
    })) as { sheetName: string };
    expect(result.sheetName).toBe('Data');
    expect(getOfficeMock().charts[0]!.sheetName).toBe('Data');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9956 — the browser "Excel" export used to save tab-separated text as
 * `.xls`, which Excel opens only after a format-mismatch warning. It must now
 * download a real .xlsx workbook (a zip, so it starts with the `PK` signature).
 */

const { downloadBlobMock } = vi.hoisted(() => ({ downloadBlobMock: vi.fn() }));

vi.mock('@/lib/downloadBlob', () => ({ downloadBlob: downloadBlobMock }));

import { exportReport } from './reportExport';

// jsdom's Blob has no arrayBuffer()/stream(); FileReader is the portable read.
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

describe('exportReport — Excel format', () => {
  beforeEach(() => {
    downloadBlobMock.mockClear();
  });

  it('downloads a real .xlsx workbook, not TSV text named .xls', async () => {
    await exportReport([{ hostname: 'pc-1', cpuPercent: 5 }], {
      format: 'excel',
      reportType: 'device_inventory',
      timezone: 'UTC',
    });

    expect(downloadBlobMock).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloadBlobMock.mock.calls[0] as [Blob, string];
    expect(filename).toMatch(/^device_inventory-report-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const bytes = await blobBytes(blob);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('still refuses an empty export', async () => {
    await expect(
      exportReport([], { format: 'excel', reportType: 'device_inventory', timezone: 'UTC' }),
    ).rejects.toThrow('No data to export');
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });
});

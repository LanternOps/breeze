import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { chunkValueRows, mergeCommitChunkResult } from './CustomFieldValueImportStep';
import type { DeviceCustomFieldImportRow, ValueImportSummary } from './CustomFieldValueImportStep';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));

const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToastMock(...a) }));

import CustomFieldValueImportStep from './CustomFieldValueImportStep';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

function row(values: number): DeviceCustomFieldImportRow {
  return {
    hostname: 'x',
    values: Array.from({ length: values }, (_, i) => ({
      target: { kind: 'customField', fieldKey: `f${i}` },
      value: 'v',
    })),
  };
}

describe('chunkValueRows', () => {
  it('splits at the row cap', () => {
    const rows = Array.from({ length: 5 }, () => row(1));
    const chunks = chunkValueRows(rows, 2, 100);
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it('splits at the value cap even under the row cap', () => {
    const rows = [row(3), row(3), row(3)];
    const chunks = chunkValueRows(rows, 100, 5);
    // 3+3=6 > 5, so the second row starts a new chunk.
    expect(chunks.map((c) => c.length)).toEqual([1, 1, 1]);
  });

  it('never produces an empty chunk and keeps every row', () => {
    const rows = Array.from({ length: 7 }, () => row(2));
    const chunks = chunkValueRows(rows, 3, 4);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.flat()).toHaveLength(7);
  });

  it('an empty input produces no chunks', () => {
    expect(chunkValueRows([], 10, 10)).toEqual([]);
  });

  it('sends a single row whose own value count exceeds the cap alone, then resumes normal chunking', () => {
    const rows = [row(10), row(1), row(1)];
    const chunks = chunkValueRows(rows, 100, 5);
    expect(chunks.map((c) => c.length)).toEqual([1, 2]);
    expect(chunks[0]![0]).toBe(rows[0]);
  });

  it('accepts a custom value-count accessor for non-{values} shapes', () => {
    const pairs = [{ n: 3 }, { n: 3 }, { n: 3 }];
    const chunks = chunkValueRows(pairs, 100, 5, (p) => p.n);
    expect(chunks.map((c) => c.length)).toEqual([1, 1, 1]);
  });
});

describe('mergeCommitChunkResult', () => {
  it('remaps a chunk-local row/error index back to the original global row index', () => {
    const aggregate: ValueImportSummary = { appliedValues: 0, skippedValues: 0, failedValues: 0, rows: [], linksCreated: 0, errors: [] };
    // The chunk contained originally-selected rows [2, 5] (non-contiguous —
    // e.g. row 3 and 4 were deselected). The server numbers its response
    // 0-indexed WITHIN the chunk, so response index 1 means "the second row
    // in this chunk", i.e. original index 5, not "original index 1".
    const originalIndexes = [2, 5];
    mergeCommitChunkResult(
      aggregate,
      {
        appliedValues: 1, skippedValues: 0, failedValues: 1,
        rows: [{ index: 0, deviceId: 'd', organizationId: 'o', method: 'serial', externalSystem: null, applied: 1, skipped: 0, failed: 0, appliedFieldKeys: [], warranty: 'none', linkCreated: false }],
        linksCreated: 0,
        errors: [{ index: 1, error: 'boom', code: 'write-failed' }],
      },
      originalIndexes,
    );
    expect(aggregate.rows[0]!.index).toBe(2);
    expect(aggregate.errors[0]!.index).toBe(5);
  });
});

describe('CustomFieldValueImportStep', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    showToastMock.mockReset();
    // vitest.config.ts sets restoreMocks: true, which restores any vi.spyOn
    // to its ORIGINAL implementation before every test — a spy installed once
    // at module scope would be silently undone before it's ever used. Install
    // it fresh here instead.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The definitions-type lookup GET, issued on mount.
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.startsWith('/custom-fields') && !url.includes('/import')) {
        return jsonResponse([{ fieldKey: 'asset_owner', type: 'text' }]);
      }
      return jsonResponse({}, 500);
    });
  });

  async function uploadCsv(csv: string) {
    const file = new File([csv], 'values.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(screen.getByTestId('cf-val-file-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('cf-val-preview')).toBeInTheDocument());
  }

  it('lets an operator map a column to a custom field, warranty target, or ignore it', async () => {
    render(<CustomFieldValueImportStep organizationId="org-1" source="csv" />);
    await uploadCsv('Hostname,Owner\nWKS-01,IT Team\n');
    expect(screen.getByTestId('cf-val-map-Hostname')).toBeInTheDocument();
    expect(screen.getByTestId('cf-val-map-Owner')).toBeInTheDocument();
  });

  it('sends the preview POST with coerced values AND the selected source through fetchWithAuth', async () => {
    // The field-type lookup GET fires once, on mount — so the type it needs
    // to know about must be in place BEFORE render, not queued afterward.
    fetchWithAuthMock.mockImplementation((url: string) =>
      url.startsWith('/custom-fields') && !url.includes('/import')
        ? jsonResponse([{ fieldKey: 'seat_count', type: 'number' }])
        : jsonResponse({}, 500),
    );
    render(<CustomFieldValueImportStep organizationId="org-1" source="datto_rmm" />);
    await uploadCsv('Hostname,Seats\nWKS-01,12\n');
    fireEvent.change(screen.getByTestId('cf-val-map-Hostname'), { target: { value: 'identifier:hostname' } });
    fireEvent.change(screen.getByTestId('cf-val-map-Seats'), { target: { value: 'customField' } });
    fireEvent.change(screen.getByTestId('cf-val-fieldkey-Seats'), { target: { value: 'seat_count' } });

    fetchWithAuthMock.mockImplementationOnce(() => jsonResponse({ rows: [] }));
    fireEvent.click(screen.getByTestId('cf-val-preview'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/devices/custom-fields/import/preview',
      expect.objectContaining({ method: 'POST' }),
    ));

    const call = fetchWithAuthMock.mock.calls.find(([url]) => url === '/devices/custom-fields/import/preview')!;
    const body = JSON.parse((call[1] as { body: string }).body) as {
      externalSystem: string;
      rows: Array<{ hostname?: string; values: Array<{ target: unknown; value: unknown }> }>;
    };
    expect(body.externalSystem).toBe('datto_rmm');
    expect(body.rows[0]!.hostname).toBe('WKS-01');
    // The whole point of coercion: "12" must arrive as the number 12, not the string "12".
    expect(body.rows[0]!.values[0]!.value).toBe(12);
  });

  it('requires a candidate pick before an ambiguous row can be committed', async () => {
    render(<CustomFieldValueImportStep organizationId="org-1" source="csv" />);
    await uploadCsv('Hostname,Owner\nWKS-01,IT Team\n');
    fireEvent.change(screen.getByTestId('cf-val-map-Hostname'), { target: { value: 'identifier:hostname' } });
    fireEvent.change(screen.getByTestId('cf-val-map-Owner'), { target: { value: 'customField' } });
    fireEvent.change(screen.getByTestId('cf-val-fieldkey-Owner'), { target: { value: 'asset_owner' } });

    fetchWithAuthMock.mockImplementationOnce(() =>
      jsonResponse({
        rows: [
          {
            index: 0,
            outcome: 'ambiguous',
            deviceId: null,
            method: null,
            organizationId: 'org-1',
            candidates: [
              {
                deviceId: 'dev-1', hostname: 'WKS-01', displayName: null, serialNumber: 'SN-1',
                osType: 'windows', status: 'online', enrolledAt: null, lastSeenAt: null, siteId: null, method: 'hostname',
              },
            ],
            values: [{ target: { kind: 'customField', fieldKey: 'asset_owner' }, outcome: 'applied' }],
          },
        ],
      }),
    );
    fireEvent.click(screen.getByTestId('cf-val-preview'));
    await waitFor(() => expect(screen.getByTestId('cf-import-row-0')).toBeInTheDocument());
    expect(screen.getByTestId('cf-import-row-0')).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(screen.getByTestId('cf-import-expand-0'));
    fireEvent.click(screen.getByTestId('cf-import-candidate-0-pick'));
    await waitFor(() => expect(screen.getByTestId('cf-import-row-0')).toHaveAttribute('aria-disabled', 'false'));
  });

  it('surfaces the exact failed-VALUE count after a partial-success commit', async () => {
    render(<CustomFieldValueImportStep organizationId="org-1" source="csv" />);
    await uploadCsv('Hostname,Owner\nWKS-01,IT Team\n');
    fireEvent.change(screen.getByTestId('cf-val-map-Hostname'), { target: { value: 'identifier:hostname' } });
    fireEvent.change(screen.getByTestId('cf-val-map-Owner'), { target: { value: 'customField' } });
    fireEvent.change(screen.getByTestId('cf-val-fieldkey-Owner'), { target: { value: 'asset_owner' } });

    fetchWithAuthMock.mockImplementationOnce(() =>
      jsonResponse({
        rows: [
          {
            index: 0, outcome: 'matched', deviceId: 'dev-1', method: 'hostname', organizationId: 'org-1',
            candidates: [], values: [{ target: { kind: 'customField', fieldKey: 'asset_owner' }, outcome: 'applied' }],
          },
        ],
      }),
    );
    fireEvent.click(screen.getByTestId('cf-val-preview'));
    await waitFor(() => screen.getByTestId('cf-val-commit'));

    fetchWithAuthMock.mockImplementationOnce(() =>
      jsonResponse({
        appliedValues: 3,
        skippedValues: 0,
        failedValues: 7,
        rows: [{ index: 0, deviceId: 'dev-1', organizationId: 'org-1', method: 'hostname', externalSystem: null, applied: 3, skipped: 0, failed: 7, appliedFieldKeys: ['asset_owner'], warranty: 'none', linkCreated: false }],
        linksCreated: 0,
        errors: [],
      }),
    );
    fireEvent.click(screen.getByTestId('cf-val-commit'));
    await waitFor(() => expect(screen.getByTestId('cf-val-summary')).toBeInTheDocument());
    expect(screen.getByTestId('cf-val-summary')).toHaveTextContent(/applied 3/i);
    expect(screen.getByTestId('cf-val-summary')).toHaveTextContent(/failed 7/i);
  });

  it('renders per-row error detail from a commit response, never just a bare count', async () => {
    render(<CustomFieldValueImportStep organizationId="org-1" source="csv" />);
    await uploadCsv('Hostname,Owner\nWKS-01,IT Team\n');
    fireEvent.change(screen.getByTestId('cf-val-map-Hostname'), { target: { value: 'identifier:hostname' } });
    fireEvent.change(screen.getByTestId('cf-val-map-Owner'), { target: { value: 'customField' } });
    fireEvent.change(screen.getByTestId('cf-val-fieldkey-Owner'), { target: { value: 'asset_owner' } });

    fetchWithAuthMock.mockImplementationOnce(() =>
      jsonResponse({
        rows: [
          {
            index: 0, outcome: 'matched', deviceId: 'dev-1', method: 'hostname', organizationId: 'org-1',
            candidates: [], values: [{ target: { kind: 'customField', fieldKey: 'asset_owner' }, outcome: 'applied' }],
          },
        ],
      }),
    );
    fireEvent.click(screen.getByTestId('cf-val-preview'));
    await waitFor(() => screen.getByTestId('cf-val-commit'));

    fetchWithAuthMock.mockImplementationOnce(() =>
      jsonResponse({
        appliedValues: 0,
        skippedValues: 0,
        failedValues: 0,
        rows: [],
        linksCreated: 0,
        errors: [{ index: 0, error: 'RLS denied the write', code: 'write-failed' }],
      }),
    );
    fireEvent.click(screen.getByTestId('cf-val-commit'));
    await waitFor(() => expect(screen.getByTestId('cf-val-errors')).toBeInTheDocument());
    expect(screen.getByTestId('cf-val-error-0')).toHaveTextContent('RLS denied the write');
  });

  it('logs (does not silently swallow) a failed field-type lookup', async () => {
    fetchWithAuthMock.mockImplementation(() => Promise.reject(new Error('network down')));
    render(<CustomFieldValueImportStep organizationId="org-1" source="csv" />);
    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
  });
});

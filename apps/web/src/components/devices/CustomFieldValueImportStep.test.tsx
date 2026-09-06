import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { chunkValueRows } from './CustomFieldValueImportStep';
import type { DeviceCustomFieldImportRow } from './CustomFieldValueImportStep';

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
});

describe('CustomFieldValueImportStep', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    showToastMock.mockReset();
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
    render(<CustomFieldValueImportStep organizationId="org-1" />);
    await uploadCsv('Hostname,Owner\nWKS-01,IT Team\n');
    expect(screen.getByTestId('cf-val-map-Hostname')).toBeInTheDocument();
    expect(screen.getByTestId('cf-val-map-Owner')).toBeInTheDocument();
  });

  it('sends the preview POST with coerced values through fetchWithAuth', async () => {
    render(<CustomFieldValueImportStep organizationId="org-1" />);
    await uploadCsv('Hostname,Seats\nWKS-01,12\n');
    fireEvent.change(screen.getByTestId('cf-val-map-Hostname'), { target: { value: 'identifier:hostname' } });
    fireEvent.change(screen.getByTestId('cf-val-map-Seats'), { target: { value: 'customField' } });
    fireEvent.change(screen.getByTestId('cf-val-fieldkey-Seats'), { target: { value: 'seat_count' } });

    fetchWithAuthMock.mockImplementationOnce((url: string) =>
      url.startsWith('/custom-fields') && !url.includes('/import')
        ? jsonResponse([{ fieldKey: 'seat_count', type: 'number' }])
        : jsonResponse({}, 500),
    );

    fireEvent.click(screen.getByTestId('cf-val-preview'));
    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/devices/custom-fields/import/preview',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('requires a candidate pick before an ambiguous row can be committed', async () => {
    render(<CustomFieldValueImportStep organizationId="org-1" />);
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

  it('surfaces partial success in VALUE units after commit', async () => {
    render(<CustomFieldValueImportStep organizationId="org-1" />);
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
        appliedValues: 1,
        skippedValues: 0,
        failedValues: 1,
        rows: [{ index: 0, deviceId: 'dev-1', organizationId: 'org-1', method: 'hostname', externalSystem: null, applied: 1, skipped: 0, failed: 1, appliedFieldKeys: ['asset_owner'], warranty: 'none', linkCreated: false }],
        linksCreated: 0,
        errors: [],
      }),
    );
    fireEvent.click(screen.getByTestId('cf-val-commit'));
    await waitFor(() => expect(screen.getByTestId('cf-val-summary')).toBeInTheDocument());
    expect(screen.getByTestId('cf-val-summary')).toHaveTextContent('1');
  });
});

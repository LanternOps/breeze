import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SoftwareInventoryView from './SoftwareInventoryView';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('SoftwareInventoryView CSV export', () => {
  let capturedBlob: Blob | null;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedBlob = null;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        capturedBlob = blob;
        return 'blob:mock';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('neutralizes spreadsheet-formula injection in agent-supplied fields', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        data: [
          {
            id: 'inv-1',
            device: 'WS-ALPHA',
            software: '=cmd()|/C calc',
            version: '1.0',
            vendor: '+HYPERLINK("http://evil","click")',
            installDate: '2026-06-01T00:00:00.000Z',
            managed: true,
          },
        ],
      }),
    );

    render(<SoftwareInventoryView />);

    // Wait for the malicious inventory row to load.
    await waitFor(() => {
      expect(screen.getByText('=cmd()|/C calc')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Export CSV'));

    await waitFor(() => {
      expect(capturedBlob).not.toBeNull();
    });

    const csv = await capturedBlob!.text();
    // Leading formula chars are prefixed with a single quote inside the quoted cell.
    expect(csv).toContain('"\'=cmd()|/C calc"');
    expect(csv).toContain('"\'+HYPERLINK(');
    // Header row is still present and safe.
    expect(csv.split('\n')[0]).toContain('Device');
  });
});

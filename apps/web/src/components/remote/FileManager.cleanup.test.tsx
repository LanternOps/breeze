import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FileManager from './FileManager';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const PREVIEW = {
  cleanupRunId: 'run-42',
  snapshotId: 'snap-1',
  estimatedBytes: 4096,
  candidateCount: 1,
  categories: [{ category: 'temp_files', count: 1, estimatedBytes: 4096 }],
  candidates: [{ path: '/tmp/a.tmp', category: 'temp_files', sizeBytes: 4096 }],
};

function routeFetch(executeBody: unknown, executeOk = true) {
  fetchWithAuthMock.mockImplementation((async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && String(url).includes('/filesystem/cleanup-preview')) {
      return jsonResponse({ success: true, data: PREVIEW });
    }
    if (init?.method === 'POST' && String(url).includes('/filesystem/cleanup-execute')) {
      return jsonResponse(executeBody, executeOk, executeOk ? 200 : 500);
    }
    if (String(url).includes('/filesystem')) return jsonResponse({ success: true, data: {
      id: 'snap-1', capturedAt: '2026-09-19T12:00:00Z', trigger: 'on_demand', partial: false,
      summary: { filesScanned: 1, dirsScanned: 1, bytesScanned: 4096, maxDepthReached: 1, permissionDeniedCount: 0 },
      topLargestFiles: [], topLargestDirectories: [],
    } });
    return jsonResponse({ data: [] });
  }) as typeof fetchWithAuth);
}

async function previewThenExecute() {
  fireEvent.click(screen.getByTestId('disk-intelligence-toggle'));
  const previewButton = await screen.findByTestId('disk-preview-button');
  await waitFor(() => expect(previewButton).toBeEnabled());
  fireEvent.click(previewButton);
  const executeButton = await screen.findByTestId('disk-execute-button');
  await waitFor(() => expect(executeButton).toBeEnabled());
  fireEvent.click(executeButton);
  fireEvent.click(await screen.findByTestId('disk-execute-confirm'));
}

describe('FileManager disk cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the pinned cleanupRunId with the execute body', async () => {
    routeFetch({
      success: true,
      data: { cleanupRunId: 'run-43', status: 'executed', bytesReclaimed: 4096, selectedCount: 1, failedCount: 0, partial: false, rejectedPaths: [], counts: { completed: 1, failed: 0, skipped_locked: 0, rejected: 0, skipped_budget: 0 } },
    });

    render(<FileManager deviceId={DEVICE_ID} deviceHostname="workstation-1" initialPath="/" />);
    await previewThenExecute();

    await waitFor(() => {
      const call = fetchWithAuthMock.mock.calls.find(([url]) => String(url).includes('cleanup-execute'));
      expect(call).toBeDefined();
      // Without this, execute re-derived candidates from whatever snapshot was
      // newest — the exact race the API's pinning exists to prevent (defect 4).
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
        paths: ['/tmp/a.tmp'],
        cleanupRunId: 'run-42',
      });
    });
  });

  it('renders a partial failure in amber, not in a green box', async () => {
    routeFetch({
      success: true,
      data: {
        cleanupRunId: 'run-44', status: 'executed', bytesReclaimed: 0,
        selectedCount: 1, failedCount: 1, partial: false,
        rejectedPaths: ['/home/bob/taxes.pdf'],
        counts: { completed: 0, failed: 1, skipped_locked: 0, rejected: 1, skipped_budget: 0 },
      },
    });

    render(<FileManager deviceId={DEVICE_ID} deviceHostname="workstation-1" initialPath="/" />);
    await previewThenExecute();

    const panel = await screen.findByTestId('disk-cleanup-result');
    expect(panel.className).toContain('amber');
    expect(panel.className).not.toContain('emerald');
    expect(panel.textContent).toContain('1');
  });

  it('keeps the success box green when nothing failed', async () => {
    routeFetch({
      success: true,
      data: {
        cleanupRunId: 'run-45', status: 'executed', bytesReclaimed: 4096,
        selectedCount: 1, failedCount: 0, partial: false, rejectedPaths: [],
        counts: { completed: 1, failed: 0, skipped_locked: 0, rejected: 0, skipped_budget: 0 },
      },
    });

    render(<FileManager deviceId={DEVICE_ID} deviceHostname="workstation-1" initialPath="/" />);
    await previewThenExecute();

    const panel = await screen.findByTestId('disk-cleanup-result');
    expect(panel.className).toContain('emerald');
  });
});

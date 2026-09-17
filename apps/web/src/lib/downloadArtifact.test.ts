import type { MouseEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./downloadBlob', () => ({ downloadBlob: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';
import { downloadBlob } from './downloadBlob';
import { downloadArtifact } from './downloadArtifact';

function click(filename = '') {
  const anchor = document.createElement('a');
  anchor.href = '/api/v1/ai/artifacts/a1';
  anchor.download = filename;
  return { preventDefault: vi.fn(), currentTarget: anchor } as unknown as MouseEvent<HTMLAnchorElement>;
}

describe('authenticated artifact download', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prevents raw navigation, fetches with auth and preserves the server filename', async () => {
    const event = click();
    const blob = new Blob(['print(1)']);
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true, headers: new Headers({ 'Content-Disposition': 'attachment; filename="step-1.py"' }),
      blob: async () => blob,
    } as Response);
    await downloadArtifact(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(fetchWithAuth).toHaveBeenCalledWith('/api/v1/ai/artifacts/a1');
    expect(downloadBlob).toHaveBeenCalledWith(blob, 'step-1.py');
  });

  it('uses the artifact display name when the response has no filename', async () => {
    const blob = new Blob(['a,b']);
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, headers: new Headers(), blob: async () => blob } as Response);
    await downloadArtifact(click('report.csv'));
    expect(downloadBlob).toHaveBeenCalledWith(blob, 'report.csv');
  });

  it.each([401, 404, 503])('shows a failure and never downloads an HTTP %i error body', async (status) => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status } as Response);
    await downloadArtifact(click('report.csv'));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('surfaces network failures without an unhandled rejection', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error('offline'));
    await downloadArtifact(click());
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

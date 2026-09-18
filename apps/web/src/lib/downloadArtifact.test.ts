import type { MouseEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./downloadBlob', () => ({ downloadBlob: vi.fn() }));

import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
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

  it('shows the generic failure toast (not the expired one) for an HTTP 503 error body', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status: 503 } as Response);
    await downloadArtifact(click('report.csv'));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Download failed' }));
  });

  it.each([404, 410])('shows a distinct "expired" toast (not the generic failure one) for HTTP %i', async (status) => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status } as Response);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await downloadArtifact(click('report.csv'));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'This file has expired and is no longer available to download.',
    }));
    expect(consoleError).toHaveBeenCalledWith('[downloadArtifact]', expect.objectContaining({ path: '/api/v1/ai/artifacts/a1' }));
    consoleError.mockRestore();
  });

  it('logs the error to console before showing the generic failure toast', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status: 503 } as Response);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await downloadArtifact(click('report.csv'));
    expect(consoleError).toHaveBeenCalledWith('[downloadArtifact]', expect.objectContaining({ path: '/api/v1/ai/artifacts/a1' }));
    consoleError.mockRestore();
  });

  it('routes a 401 to session-expiry handling instead of a generic failure toast', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({ ok: false, status: 401 } as Response);
    await downloadArtifact(click('report.csv'));
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(handleSessionExpired).toHaveBeenCalledOnce();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('surfaces network failures without an unhandled rejection', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error('offline'));
    await downloadArtifact(click());
    expect(downloadBlob).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

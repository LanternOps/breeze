// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchGrant = vi.hoisted(() => vi.fn());
const downloadGrantDocument = vi.hoisted(() => vi.fn());
vi.mock('@/lib/trustAccessApi', () => ({ fetchGrant, downloadGrantDocument }));
import AccessGrantView from './AccessGrantView';

const grant = {
  orgName: 'Acme', expiresAt: '2026-10-20T00:00:00.000Z',
  documents: [
    { id: 'd1', title: 'SOC 2 report', category: 'report', contentType: 'application/pdf', byteSize: 2048 },
    { id: 'd2', title: 'Pen test', category: 'report', contentType: 'application/pdf', byteSize: 4096 },
  ],
};

beforeEach(() => {
  fetchGrant.mockReset(); downloadGrantDocument.mockReset();
  window.history.replaceState(null, '', '/trust/access/download#tok999');
});

describe('AccessGrantView', () => {
  it('clears the fragment before requesting, grants once, and lists documents with expiry', async () => {
    const spy = vi.spyOn(window.history, 'replaceState');
    fetchGrant.mockImplementation(async () => { expect(window.location.hash).toBe(''); return grant; });
    render(<AccessGrantView />);
    expect(spy).toHaveBeenCalledWith(null, '', '/trust/access/download');
    await waitFor(() => expect(screen.getByTestId('trust-access-doc-d1')).toHaveTextContent('SOC 2 report'));
    expect(screen.getByTestId('trust-access-download-d2')).toBeInTheDocument();
    expect(screen.getByTestId('trust-access-expires')).toHaveTextContent(/This link works until .*2026/);
    expect(fetchGrant).toHaveBeenCalledTimes(1);
    expect(fetchGrant).toHaveBeenCalledWith('tok999');
    spy.mockRestore();
  });

  it('invalid grant and missing token show invalid', async () => {
    fetchGrant.mockResolvedValue(null);
    const { unmount } = render(<AccessGrantView />);
    await waitFor(() => expect(screen.getByTestId('trust-access-invalid')).toBeInTheDocument());
    unmount();
    fetchGrant.mockClear();
    window.history.replaceState(null, '', '/trust/access/download');
    render(<AccessGrantView />);
    await waitFor(() => expect(screen.getByTestId('trust-access-invalid')).toBeInTheDocument());
    expect(fetchGrant).not.toHaveBeenCalled();
  });

  it('download saves via an object URL with the server filename, then revokes', async () => {
    fetchGrant.mockResolvedValue(grant);
    downloadGrantDocument.mockResolvedValue({ blob: new Blob(['x']), filename: 'soc2.pdf' });
    const create = vi.fn(() => 'blob:abc'); const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    render(<AccessGrantView />);
    fireEvent.click(await screen.findByTestId('trust-access-download-d1'));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:abc'));
    expect(downloadGrantDocument).toHaveBeenCalledWith('tok999', 'd1');
    expect(names).toEqual(['soc2.pdf']);
    expect(screen.queryByTestId('trust-access-download-error')).toBeNull();
    click.mockRestore();
  });

  it('falls back to the title for the filename', async () => {
    fetchGrant.mockResolvedValue(grant);
    downloadGrantDocument.mockResolvedValue({ blob: new Blob(['x']), filename: null });
    Object.assign(URL, { createObjectURL: () => 'blob:z', revokeObjectURL: vi.fn() });
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    render(<AccessGrantView />);
    fireEvent.click(await screen.findByTestId('trust-access-download-d2'));
    await waitFor(() => expect(names).toEqual(['Pen test']));
    click.mockRestore();
  });

  it('download failure shows the error', async () => {
    fetchGrant.mockResolvedValue(grant);
    downloadGrantDocument.mockResolvedValue(null);
    render(<AccessGrantView />);
    fireEvent.click(await screen.findByTestId('trust-access-download-d1'));
    await waitFor(() => expect(screen.getByTestId('trust-access-download-error')).toHaveTextContent('The download failed. Try again, or ask for a new link.'));
  });

  it('a transient failure offers Try again, which re-fetches the grant', async () => {
    fetchGrant.mockResolvedValueOnce('retry').mockResolvedValueOnce(grant);
    render(<AccessGrantView />);
    await waitFor(() => expect(screen.getByTestId('trust-access-retry')).toBeInTheDocument());
    expect(screen.queryByTestId('trust-access-invalid')).toBeNull();
    fireEvent.click(screen.getByTestId('trust-access-retry-button'));
    await waitFor(() => expect(screen.getByTestId('trust-access-doc-d1')).toBeInTheDocument());
    expect(fetchGrant).toHaveBeenCalledTimes(2);
  });
});

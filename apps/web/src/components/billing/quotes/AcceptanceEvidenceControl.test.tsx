import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AcceptanceEvidenceControl from './AcceptanceEvidenceControl';

// #6633 — the download-or-attach control for an on-behalf acceptance's
// evidence file.
const runAction = vi.hoisted(() => vi.fn(async (opts: { request: () => Promise<unknown> }) => opts.request()));
const showToast = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  downloadQuoteAcceptanceEvidence: vi.fn(),
  uploadQuoteAcceptanceEvidence: vi.fn(),
}));
const navigateTo = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/runAction')>();
  return { ...actual, runAction };
});
vi.mock('../../shared/Toast', () => ({ showToast }));
vi.mock('@/lib/navigation', () => ({ navigateTo }));
vi.mock('../../../lib/api/quotes', () => ({
  downloadQuoteAcceptanceEvidence: (...args: unknown[]) => api.downloadQuoteAcceptanceEvidence(...(args as [])),
  uploadQuoteAcceptanceEvidence: (...args: unknown[]) => api.uploadQuoteAcceptanceEvidence(...(args as [])),
  QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES: 10 * 1024 * 1024,
}));

const EVIDENCE = { filename: 'po.pdf', contentType: 'application/pdf', sizeBytes: 100, uploadedAt: '2026-09-21T00:00:00Z' };

function pdfFile(name = 'po.pdf', size = 100): File {
  return new File(['x'.repeat(size)], name, { type: 'application/pdf' });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.uploadQuoteAcceptanceEvidence.mockResolvedValue({
    data: { acceptanceId: 'a-1', evidence: EVIDENCE },
  });
});

describe('AcceptanceEvidenceControl', () => {
  it('renders nothing when there is no evidence and no attach permission', () => {
    const { container } = render(<AcceptanceEvidenceControl quoteId="q-1" evidence={null} canAttach={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows a download button naming the filename when evidence is present', () => {
    render(<AcceptanceEvidenceControl quoteId="q-1" evidence={EVIDENCE} canAttach={false} />);
    const btn = screen.getByTestId('quote-acceptance-evidence-download');
    expect(btn.textContent).toContain('po.pdf');
    expect(screen.queryByTestId('quote-acceptance-evidence-attach')).toBeNull();
  });

  it('downloads the file on click', async () => {
    const blob = new Blob(['data']);
    api.downloadQuoteAcceptanceEvidence.mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
    const createObjectURL = vi.fn().mockReturnValue('blob:fake');
    const revokeObjectURL = vi.fn();
    // jsdom doesn't implement these.
    (URL as unknown as { createObjectURL: typeof createObjectURL }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: typeof revokeObjectURL }).revokeObjectURL = revokeObjectURL;

    render(<AcceptanceEvidenceControl quoteId="q-1" evidence={EVIDENCE} canAttach={false} />);
    fireEvent.click(screen.getByTestId('quote-acceptance-evidence-download'));
    await waitFor(() => expect(api.downloadQuoteAcceptanceEvidence).toHaveBeenCalledWith('q-1'));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  });

  it('toasts an error when the download fails', async () => {
    api.downloadQuoteAcceptanceEvidence.mockResolvedValue({ ok: false, status: 500 });
    render(<AcceptanceEvidenceControl quoteId="q-1" evidence={EVIDENCE} canAttach={false} />);
    fireEvent.click(screen.getByTestId('quote-acceptance-evidence-download'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('redirects to login on a 401 download', async () => {
    api.downloadQuoteAcceptanceEvidence.mockResolvedValue({ ok: false, status: 401 });
    render(<AcceptanceEvidenceControl quoteId="q-1" evidence={EVIDENCE} canAttach={false} />);
    fireEvent.click(screen.getByTestId('quote-acceptance-evidence-download'));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }));
  });

  it('shows an attach button (no evidence) when the user can attach', () => {
    render(<AcceptanceEvidenceControl quoteId="q-1" evidence={null} canAttach />);
    expect(screen.getByTestId('quote-acceptance-evidence-attach').textContent).toBe('Attach evidence');
  });

  it('shows a replace button when evidence already exists', () => {
    render(<AcceptanceEvidenceControl quoteId="q-1" evidence={EVIDENCE} canAttach />);
    expect(screen.getByTestId('quote-acceptance-evidence-attach').textContent).toBe('Replace evidence');
  });

  it('uploads a chosen file and calls onChanged', async () => {
    const onChanged = vi.fn();
    render(<AcceptanceEvidenceControl quoteId="q-1" evidence={null} canAttach onChanged={onChanged} />);
    const file = pdfFile();
    fireEvent.change(screen.getByTestId('quote-acceptance-evidence-input'), { target: { files: [file] } });
    await waitFor(() => expect(api.uploadQuoteAcceptanceEvidence).toHaveBeenCalledWith('q-1', file));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('rejects a file over 10 MB without making a request', async () => {
    const onChanged = vi.fn();
    render(<AcceptanceEvidenceControl quoteId="q-1" evidence={null} canAttach onChanged={onChanged} />);
    const bigFile = pdfFile('big.pdf', 11 * 1024 * 1024);
    fireEvent.change(screen.getByTestId('quote-acceptance-evidence-input'), { target: { files: [bigFile] } });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(api.uploadQuoteAcceptanceEvidence).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@/lib/i18n';

const exp = vi.hoisted(() => ({ downloadTrustQuestionnaire: vi.fn() }));
vi.mock('@/lib/trustExport', () => exp);
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@/components/shared/Toast', () => toast);

import TrustExportMenu from './TrustExportMenu';

const props = { publishedAt: '2026-10-11T12:00:00.000Z', partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: false, pageUrl: 'https://breeze.test/portal/trust/nw/acme' };

describe('TrustExportMenu', () => {
  beforeEach(() => { exp.downloadTrustQuestionnaire.mockReset(); toast.showToast.mockReset(); });

  it('disabled with the unpublished note when publishedAt is null', () => {
    render(<TrustExportMenu {...props} publishedAt={null} />);
    expect((screen.getByTestId('trust-export-csv') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('trust-export-json') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('trust-export-note').textContent).toMatch(/publish/i);
  });

  it('CSV and JSON buttons call the download with the right format', async () => {
    exp.downloadTrustQuestionnaire.mockResolvedValue(true);
    render(<TrustExportMenu {...props} />);
    fireEvent.click(screen.getByTestId('trust-export-csv'));
    await waitFor(() => expect(exp.downloadTrustQuestionnaire).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByTestId('trust-export-json') as HTMLButtonElement).disabled).toBe(false));
    expect(exp.downloadTrustQuestionnaire.mock.calls[0]![0]).toBe('csv');
    expect(exp.downloadTrustQuestionnaire.mock.calls[0]![1]).toMatchObject({ partnerSlug: 'nw', orgSlug: 'acme', isPartnerHome: false, pageUrl: props.pageUrl });
    fireEvent.click(screen.getByTestId('trust-export-json'));
    await waitFor(() => expect(exp.downloadTrustQuestionnaire).toHaveBeenCalledTimes(2));
    expect(exp.downloadTrustQuestionnaire.mock.calls[1]![0]).toBe('json');
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('a failed fetch shows an error toast', async () => {
    exp.downloadTrustQuestionnaire.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<TrustExportMenu {...props} />);
    fireEvent.click(screen.getByTestId('trust-export-csv'));
    await waitFor(() => expect(toast.showToast).toHaveBeenCalled());
    expect(toast.showToast.mock.calls[0]![0]).toMatchObject({ type: 'error' });
  });

  it('a page that is no longer served (download returns false) shows an error toast', async () => {
    exp.downloadTrustQuestionnaire.mockResolvedValue(false);
    render(<TrustExportMenu {...props} />);
    fireEvent.click(screen.getByTestId('trust-export-json'));
    await waitFor(() => expect(toast.showToast).toHaveBeenCalled());
    expect(toast.showToast.mock.calls[0]![0]).toMatchObject({ type: 'error' });
  });
});

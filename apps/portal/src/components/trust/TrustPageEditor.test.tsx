// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), previewToken: vi.fn(), unpublish: vi.fn() }));
vi.mock('@/lib/trustEditorApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/trustEditorApi')>()),
  trustEditorApi: api,
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/basePath', () => ({ withBase: (p: string) => `/based${p}` }));

import { TrustPageEditor } from './TrustPageEditor';
import type { PortalTrustPageDraft } from '@/lib/trustEditorApi';

const PAGE: PortalTrustPageDraft = {
  securityContactEmail: 'sec@example.com',
  websiteUrl: 'https://example.com',
  hiddenControlIds: ['dns_filtering'],
  showPercentages: false,
  showDeviceCount: true,
  publishedAt: '2026-10-01T00:00:00.000Z',
  publicationRevision: 4,
  publicPath: '/trust/msp/acme',
};

const renderEditor = (page: PortalTrustPageDraft = PAGE) => render(<TrustPageEditor initialPage={page} orgName="Acme Dental" />);

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
});
afterEach(cleanup);

describe('TrustPageEditor (Trust Center W3d)', () => {
  it('renders the five fields', () => {
    renderEditor();
    expect((screen.getByTestId('trust-editor-email') as HTMLInputElement).value).toBe('sec@example.com');
    expect((screen.getByTestId('trust-editor-website') as HTMLInputElement).value).toBe('https://example.com');
    expect((screen.getByTestId('trust-editor-show-percentages') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId('trust-editor-show-device-count') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('trust-editor-hide-dns_filtering') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('trust-editor-hide-endpoint_protection') as HTMLInputElement).checked).toBe(false);
  });

  it('Save sends only changed fields with the loaded revision', async () => {
    api.save.mockResolvedValue({ statusCode: 200, data: { data: { page: { ...PAGE, websiteUrl: 'https://example.org', publicationRevision: 5 } } } });
    renderEditor();
    fireEvent.change(screen.getByTestId('trust-editor-website'), { target: { value: 'https://example.org' } });
    fireEvent.click(screen.getByTestId('trust-editor-hide-endpoint_protection'));
    fireEvent.click(screen.getByTestId('trust-editor-save'));
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save).toHaveBeenCalledWith({
      expectedRevision: 4,
      websiteUrl: 'https://example.org',
      hiddenControlIds: ['dns_filtering', 'endpoint_protection'],
    });
    await screen.findByTestId('trust-editor-saved');
  });

  it('does not call the API when nothing changed', async () => {
    renderEditor();
    fireEvent.click(screen.getByTestId('trust-editor-save'));
    await screen.findByText(/no changes to save/i);
    expect(api.save).not.toHaveBeenCalled();
  });

  it('a 409 reloads and says the provider changed the page', async () => {
    api.save.mockResolvedValue({ statusCode: 409, code: 'REVISION_MISMATCH', error: 'changed' });
    api.get.mockResolvedValue({ statusCode: 200, data: { data: { page: { ...PAGE, securityContactEmail: 'msp@example.com', publicationRevision: 6 } } } });
    renderEditor();
    fireEvent.change(screen.getByTestId('trust-editor-email'), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByTestId('trust-editor-save'));
    await screen.findByText('Your provider changed this page; review and save again.');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('trust-editor-email') as HTMLInputElement).value).toBe('msp@example.com');

    // The next save carries the reloaded revision.
    api.save.mockResolvedValue({ statusCode: 200, data: { data: { page: { ...PAGE, publicationRevision: 7 } } } });
    fireEvent.change(screen.getByTestId('trust-editor-email'), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByTestId('trust-editor-save'));
    await waitFor(() => expect(api.save).toHaveBeenLastCalledWith({ expectedRevision: 6, securityContactEmail: 'me@example.com' }));
  });

  it('shows the API error for a refused save', async () => {
    api.save.mockResolvedValue({ statusCode: 400, error: 'https URL required' });
    renderEditor();
    fireEvent.change(screen.getByTestId('trust-editor-website'), { target: { value: 'http://example.com' } });
    fireEvent.click(screen.getByTestId('trust-editor-save'));
    expect((await screen.findByTestId('trust-editor-error')).textContent).toContain('https URL required');
  });

  it('Preview opens /trust/preview/<token> via withBase', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    api.previewToken.mockResolvedValue({ statusCode: 200, data: { data: { token: 'tok', expiresInSeconds: 900, previewPath: '/trust/preview/tok' } } });
    renderEditor();
    fireEvent.click(screen.getByTestId('trust-editor-preview'));
    await waitFor(() => expect(open).toHaveBeenCalledWith('/based/trust/preview/tok', '_blank', 'noopener,noreferrer'));
    vi.unstubAllGlobals();
  });

  it('Unpublish requires typing the org name before confirm: true is sent', async () => {
    api.unpublish.mockResolvedValue({ statusCode: 200, data: { data: { page: { ...PAGE, publishedAt: null, publicationRevision: 5 } } } });
    renderEditor();
    fireEvent.click(screen.getByTestId('trust-editor-unpublish'));
    const confirm = screen.getByTestId('trust-editor-unpublish-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('trust-editor-unpublish-name'), { target: { value: 'Acme' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(api.unpublish).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('trust-editor-unpublish-name'), { target: { value: 'Acme Dental' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(api.unpublish).toHaveBeenCalledTimes(1));
    await screen.findByText(/not published/i);
    expect(screen.queryByTestId('trust-editor-unpublish')).toBeNull();
  });

  it('an unpublished page offers no Unpublish', () => {
    renderEditor({ ...PAGE, publishedAt: null });
    expect(screen.queryByTestId('trust-editor-unpublish')).toBeNull();
  });

  it('says the provider publishes, and never offers Publish', () => {
    renderEditor();
    expect(screen.getByText(/Your provider publishes your changes/)).toBeTruthy();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent?.trim() ?? '');
    expect(buttons.some((t) => /^publish/i.test(t))).toBe(false);
  });
});

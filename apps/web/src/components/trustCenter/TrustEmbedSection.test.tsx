// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/shared/Toast', () => ({ showToast: toast }));
const api = vi.hoisted(() => ({ updateTrustEmbedOrigins: vi.fn() }));
vi.mock('@/lib/api/trustPage', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/trustPage')>()),
  ...api,
  trustPublicUrl: (p: string) => `https://breeze.test${p}`,
}));
import TrustEmbedSection from './TrustEmbedSection';
import type { TrustPageState } from '@/lib/api/trustPage';

const orgFetch = vi.fn() as never;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const stateWith = (origins: string[], publishedAt: string | null = '2026-10-01T00:00:00Z') => ({
  page: { publicationRevision: 3, publishedAt, embedAllowedOrigins: origins },
  embedPath: '/portal/trust/embed/nw/acme',
}) as unknown as TrustPageState;
const mount = (origins: string[] = ['https://www.example.com'], props: Record<string, unknown> = {}) =>
  render(<TrustEmbedSection orgId="o1" orgFetch={orgFetch} state={stateWith(origins)} canWrite onReload={vi.fn(async () => {})} {...props} />);
const typeOrigin = (v: string) => fireEvent.change(screen.getByTestId('trust-embed-origin-input'), { target: { value: v } });

describe('TrustEmbedSection (W03a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.updateTrustEmbedOrigins.mockImplementation(async (_f: unknown, _o: string, origins: string[]) => json(200, { data: { embedAllowedOrigins: origins } }));
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } });
  });

  it('lists the current origins from page.embedAllowedOrigins', () => {
    mount(['https://www.example.com', 'https://example.org']);
    expect(screen.getAllByTestId(/^trust-embed-origin-\d+$/).map((n) => n.textContent)).toEqual(['https://www.example.com', 'https://example.org']);
  });

  it('previews the normalized origin while typing and adds it', () => {
    mount([]);
    typeOrigin('https://Example.com/');
    expect(screen.getByTestId('trust-embed-origin-preview')).toHaveTextContent('https://example.com');
    fireEvent.click(screen.getByTestId('trust-embed-add'));
    expect(screen.getByTestId('trust-embed-origin-0')).toHaveTextContent('https://example.com');
  });

  it('an invalid origin shows the inline error; Add and Save stay disabled', () => {
    mount([]);
    typeOrigin('http://example.com/path');
    expect(screen.getByTestId('trust-embed-origin-error')).toBeInTheDocument();
    expect(screen.getByTestId('trust-embed-add')).toBeDisabled();
    expect(screen.getByTestId('trust-embed-save')).toBeDisabled();
  });

  it('a duplicate (after normalization) is refused inline', () => {
    mount(['https://www.example.com']);
    typeOrigin('https://WWW.example.com/');
    expect(screen.getByTestId('trust-embed-origin-error')).toBeInTheDocument();
    expect(screen.getByTestId('trust-embed-add')).toBeDisabled();
  });

  it('the 11th origin is refused (max 10)', () => {
    mount(Array.from({ length: 10 }, (_, i) => `https://s${i}.example.com`));
    typeOrigin('https://s10.example.com');
    expect(screen.getByTestId('trust-embed-origin-error')).toBeInTheDocument();
    expect(screen.getByTestId('trust-embed-add')).toBeDisabled();
  });

  it('Save sends the edited list through runAction and shows the stored list', async () => {
    mount(['https://www.example.com']);
    fireEvent.click(screen.getByTestId('trust-embed-remove-0'));
    typeOrigin('https://shop.example.com');
    fireEvent.click(screen.getByTestId('trust-embed-add'));
    fireEvent.click(screen.getByTestId('trust-embed-save'));
    await waitFor(() => expect(api.updateTrustEmbedOrigins).toHaveBeenCalledWith(orgFetch, 'o1', ['https://shop.example.com']));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
    expect(screen.getByTestId('trust-embed-save')).toBeDisabled(); // clean after save
  });

  it('a 403 MFA_REQUIRED answer toasts the MFA copy (same path as publish) and keeps the edit', async () => {
    api.updateTrustEmbedOrigins.mockResolvedValueOnce(json(403, { error: 'MFA required', code: 'MFA_REQUIRED' }));
    mount([]);
    typeOrigin('https://example.com');
    fireEvent.click(screen.getByTestId('trust-embed-add'));
    fireEvent.click(screen.getByTestId('trust-embed-save'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/^Changing the embed websites requires multi-factor authentication/) })));
    expect(screen.getByTestId('trust-embed-origin-0')).toHaveTextContent('https://example.com');
    expect(screen.getByTestId('trust-embed-save')).not.toBeDisabled();
  });

  it('canWrite=false → inputs disabled and nothing is sent', () => {
    mount(['https://www.example.com'], { canWrite: false });
    expect(screen.getByTestId('trust-embed-origin-input')).toBeDisabled();
    expect(screen.getByTestId('trust-embed-add')).toBeDisabled();
    expect(screen.getByTestId('trust-embed-remove-0')).toBeDisabled();
    expect(screen.getByTestId('trust-embed-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('trust-embed-remove-0'));
    fireEvent.click(screen.getByTestId('trust-embed-save'));
    expect(screen.getByTestId('trust-embed-origin-0')).toBeInTheDocument();
    expect(api.updateTrustEmbedOrigins).not.toHaveBeenCalled();
  });

  it('renders the iframe snippet and copies it', async () => {
    mount(['https://www.example.com']);
    const snippet = (screen.getByTestId('trust-embed-snippet') as HTMLTextAreaElement).value;
    expect(snippet).toMatch(/^<iframe src="https:\/\/breeze\.test\/portal\/trust\/embed\/nw\/acme" title="[^"<>]+" width="100%" height="160" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"><\/iframe>$/);
    fireEvent.click(screen.getByTestId('trust-embed-copy'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(snippet));
  });

  it('with no saved origins the snippet is replaced by the empty note', () => {
    mount([]);
    expect(screen.queryByTestId('trust-embed-snippet')).toBeNull();
    expect(screen.getByTestId('trust-embed-empty')).toBeInTheDocument();
  });

  it('an unpublished page shows the publish-first note', () => {
    render(<TrustEmbedSection orgId="o1" orgFetch={orgFetch} state={stateWith(['https://www.example.com'], null)} canWrite onReload={vi.fn(async () => {})} />);
    expect(screen.getByTestId('trust-embed-unpublished')).toBeInTheDocument();
  });
});

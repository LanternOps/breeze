// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({ updateTrustPage: vi.fn() }));
vi.mock('@/lib/api/trustPage', () => api);
vi.mock('@/components/common/RichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (h: string) => void; testId: string }) => (
    <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
import TrustContentSection from './TrustContentSection';

const page = { id: 'pg', orgId: 'o1', isPartnerHome: false, publishedAt: null, publicationRevision: 3, searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true, securityContactEmail: null, websiteUrl: null, introHtml: '<p>Hi</p>', hiddenControlIds: [], publicationAuthorizedBy: null, publicationAuthorizedAt: null, lastEvaluatedAt: null };
const orgFetch = vi.fn() as never;
const mount = (canWrite = true) => {
  const onReload = vi.fn(async () => {});
  render(<TrustContentSection orgId="o1" orgFetch={orgFetch} page={page as never} canWrite={canWrite} onReload={onReload} />);
  return onReload;
};

describe('TrustContentSection', () => {
  beforeEach(() => { vi.clearAllMocks(); api.updateTrustPage.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 })); });
  it('saves intro, contact and website', async () => {
    const onReload = mount();
    fireEvent.change(screen.getByTestId('trust-content-contact'), { target: { value: 'sec@acme.test' } });
    fireEvent.change(screen.getByTestId('trust-content-website'), { target: { value: 'https://acme.test' } });
    fireEvent.click(screen.getByTestId('trust-content-save'));
    await waitFor(() => expect(api.updateTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { introHtml: '<p>Hi</p>', securityContactEmail: 'sec@acme.test', websiteUrl: 'https://acme.test' }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });
  it('rejects a non-https website inline and blocks Save', () => {
    mount();
    fireEvent.change(screen.getByTestId('trust-content-website'), { target: { value: 'http://acme.test' } });
    expect(screen.getByTestId('trust-content-website-error')).toBeInTheDocument();
    expect(screen.getByTestId('trust-content-save')).toBeDisabled();
  });
  it('shows the intro counter and disables inputs without write', () => {
    mount(false);
    expect(screen.getByTestId('trust-content-counter')).toHaveTextContent('9 / 5,000');
    expect(screen.getByTestId('trust-content-contact')).toBeDisabled();
    expect(screen.getByTestId('trust-content-save')).toBeDisabled();
    expect(screen.getByTestId('trust-content-intro-wrap')).toHaveAttribute('inert');
  });
  it('editable render is not inert', () => {
    mount();
    expect(screen.getByTestId('trust-content-intro-wrap')).not.toHaveAttribute('inert');
  });
  it('blocks Save and shows the too-long message past 5,000 characters', () => {
    mount();
    fireEvent.change(screen.getByTestId('trust-content-intro'), { target: { value: 'x'.repeat(5001) } });
    expect(screen.getByTestId('trust-content-intro-error')).toHaveTextContent('too long');
    expect(screen.getByTestId('trust-content-save')).toBeDisabled();
  });
});

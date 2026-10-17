// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({
  getTrustSubprocessors: vi.fn(), getTrustSubprocessorSuggestions: vi.fn(), putTrustSubprocessors: vi.fn(),
}));
vi.mock('@/lib/api/trustPageContent', () => api);
import TrustSubprocessorsSection from './TrustSubprocessorsSection';

const orgFetch = vi.fn() as never;
const sp = (name: string, extra: Record<string, unknown> = {}) => ({ name, purpose: 'Endpoint security', location: null, websiteUrl: null, source: 'manual', sourceKey: null, ...extra });
const mount = (canWrite = true, revision = 7) => {
  const onReload = vi.fn(async () => {});
  render(<TrustSubprocessorsSection orgId="o1" orgFetch={orgFetch} state={{ page: { publicationRevision: revision } } as never} canWrite={canWrite} onReload={onReload} />);
  return onReload;
};

describe('TrustSubprocessorsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getTrustSubprocessors.mockResolvedValue({ subprocessors: [sp('Acme EDR')], publicationRevision: 7 });
    api.getTrustSubprocessorSuggestions.mockResolvedValue([sp('Huntress', { source: 'security_product', sourceKey: 'security_product:huntress' })]);
    api.putTrustSubprocessors.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
  });

  it('loads and lists the saved subprocessors', async () => {
    mount();
    expect(await screen.findByTestId('trust-subprocessors-name-0')).toHaveValue('Acme EDR');
  });

  it('a suggestion click appends a row carrying its sourceKey, and Save sends expectedRevision with the whole list', async () => {
    const onReload = mount();
    await screen.findByTestId('trust-subprocessors-name-0');
    fireEvent.click(screen.getByTestId('trust-subprocessors-add-detected'));
    fireEvent.click(await screen.findByTestId('trust-subprocessors-suggestion-0'));
    expect(screen.getByTestId('trust-subprocessors-name-1')).toHaveValue('Huntress');
    fireEvent.click(screen.getByTestId('trust-subprocessors-save'));
    await waitFor(() => expect(api.putTrustSubprocessors).toHaveBeenCalledWith(orgFetch, 'o1', 7, [
      sp('Acme EDR'),
      sp('Huntress', { source: 'security_product', sourceKey: 'security_product:huntress' }),
    ]));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('a saved suggestion is no longer offered', async () => {
    api.getTrustSubprocessors.mockResolvedValue({ subprocessors: [sp('Huntress', { source: 'security_product', sourceKey: 'security_product:huntress' })], publicationRevision: 7 });
    mount();
    await screen.findByTestId('trust-subprocessors-name-0');
    fireEvent.click(screen.getByTestId('trust-subprocessors-add-detected'));
    await waitFor(() => expect(api.getTrustSubprocessorSuggestions).toHaveBeenCalled());
    expect(screen.queryByTestId('trust-subprocessors-suggestion-0')).toBeNull();
  });

  it('manual add, reorder and remove', async () => {
    mount();
    await screen.findByTestId('trust-subprocessors-name-0');
    fireEvent.click(screen.getByTestId('trust-subprocessors-add-manual'));
    fireEvent.change(screen.getByTestId('trust-subprocessors-name-1'), { target: { value: 'Second' } });
    fireEvent.change(screen.getByTestId('trust-subprocessors-purpose-1'), { target: { value: 'Mail' } });
    fireEvent.click(screen.getByTestId('trust-subprocessors-up-1'));
    expect(screen.getByTestId('trust-subprocessors-name-0')).toHaveValue('Second');
    fireEvent.click(screen.getByTestId('trust-subprocessors-remove-0'));
    expect(screen.getByTestId('trust-subprocessors-name-0')).toHaveValue('Acme EDR');
    expect(screen.queryByTestId('trust-subprocessors-name-1')).toBeNull();
  });

  it('blocks Save on an http:// website or an empty name', async () => {
    mount();
    await screen.findByTestId('trust-subprocessors-name-0');
    fireEvent.change(screen.getByTestId('trust-subprocessors-website-0'), { target: { value: 'http://x.example' } });
    expect(screen.getByTestId('trust-subprocessors-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('trust-subprocessors-website-0'), { target: { value: 'https://x.example' } });
    expect(screen.getByTestId('trust-subprocessors-save')).not.toBeDisabled();
    fireEvent.change(screen.getByTestId('trust-subprocessors-name-0'), { target: { value: ' ' } });
    expect(screen.getByTestId('trust-subprocessors-save')).toBeDisabled();
  });

  it('is read-only without write permission', async () => {
    mount(false);
    expect(await screen.findByTestId('trust-subprocessors-name-0')).toBeDisabled();
    expect(screen.getByTestId('trust-subprocessors-save')).toBeDisabled();
  });
});

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

  it('a failed load never lets Add or Save run (a replace-all Save would wipe the saved list)', async () => {
    api.getTrustSubprocessors.mockRejectedValue(new Error('boom'));
    mount();
    await screen.findByTestId('trust-subprocessors-load-error');
    expect(screen.getByTestId('trust-subprocessors-add-manual')).toBeDisabled();
    expect(screen.getByTestId('trust-subprocessors-add-detected')).toBeDisabled();
    expect(screen.getByTestId('trust-subprocessors-save')).toBeDisabled();
  });

  it('Save sends the revision the list was loaded at, so a concurrent change is a conflict, not an overwrite', async () => {
    const { rerender } = (() => {
      const onReload = vi.fn(async () => {});
      const utils = render(<TrustSubprocessorsSection orgId="o1" orgFetch={orgFetch} state={{ page: { publicationRevision: 7 } } as never} canWrite onReload={onReload} />);
      return { rerender: (rev: number) => utils.rerender(<TrustSubprocessorsSection orgId="o1" orgFetch={orgFetch} state={{ page: { publicationRevision: rev } } as never} canWrite onReload={onReload} />) };
    })();
    await screen.findByTestId('trust-subprocessors-name-0');
    fireEvent.change(screen.getByTestId('trust-subprocessors-purpose-0'), { target: { value: 'Edited' } });
    rerender(9); // someone else saved meanwhile
    fireEvent.click(screen.getByTestId('trust-subprocessors-save'));
    await waitFor(() => expect(api.putTrustSubprocessors).toHaveBeenCalledWith(orgFetch, 'o1', 7, expect.any(Array)));
  });

  it('a failed suggestions fetch is reported and retried on the next open, not cached as "none detected"', async () => {
    api.getTrustSubprocessorSuggestions.mockRejectedValueOnce(new Error('boom'));
    mount();
    await screen.findByTestId('trust-subprocessors-name-0');
    fireEvent.click(screen.getByTestId('trust-subprocessors-add-detected'));
    expect(await screen.findByTestId('trust-subprocessors-suggestions-error')).toBeInTheDocument();
    expect(screen.queryByTestId('trust-subprocessors-no-suggestions')).toBeNull();
    fireEvent.click(screen.getByTestId('trust-subprocessors-add-detected')); // close
    fireEvent.click(screen.getByTestId('trust-subprocessors-add-detected')); // reopen -> refetch
    await waitFor(() => expect(api.getTrustSubprocessorSuggestions).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('trust-subprocessors-suggestion-0')).toBeInTheDocument();
  });

  it('Save sends only the input fields even when the GET rows carry ids and timestamps (strict PUT schema)', async () => {
    api.getTrustSubprocessors.mockResolvedValue({
      subprocessors: [{ ...sp('Acme EDR'), id: 'x', trustPageId: 'pg', orgId: 'o1', sortOrder: 0, updatedByUserId: 'u', createdAt: 't', updatedAt: 't' }],
      publicationRevision: 7,
    });
    mount();
    await screen.findByTestId('trust-subprocessors-name-0');
    fireEvent.change(screen.getByTestId('trust-subprocessors-purpose-0'), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByTestId('trust-subprocessors-save'));
    await waitFor(() => expect(api.putTrustSubprocessors).toHaveBeenCalled());
    const body = api.putTrustSubprocessors.mock.calls[0]![3] as Array<Record<string, unknown>>;
    expect(Object.keys(body[0]!).sort()).toEqual(['location', 'name', 'purpose', 'source', 'sourceKey', 'websiteUrl']);
  });

  it('a failed load shows a retry that reloads', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.getTrustSubprocessors.mockRejectedValueOnce(new Error('boom'));
    mount();
    await screen.findByTestId('trust-subprocessors-load-error');
    expect(api.getTrustSubprocessors).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('trust-subprocessors-retry'));
    expect(await screen.findByTestId('trust-subprocessors-name-0')).toHaveValue('Acme EDR');
    expect(api.getTrustSubprocessors).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('trust-subprocessors-load-error')).toBeNull();
    expect(screen.queryByTestId('trust-subprocessors-retry')).toBeNull();
    expect(screen.getByTestId('trust-subprocessors-save')).not.toBeDisabled();
    err.mockRestore();
  });

  it('a failed reload offers retry until the user edits: a retry never replaces unsaved rows', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = (rev: number) => <TrustSubprocessorsSection orgId="o1" orgFetch={orgFetch} state={{ page: { publicationRevision: rev } } as never} canWrite onReload={vi.fn(async () => {})} />;
    const { rerender } = render(view(7));
    await screen.findByTestId('trust-subprocessors-name-0');
    api.getTrustSubprocessors.mockRejectedValueOnce(new Error('boom'));
    rerender(view(8));
    expect(await screen.findByTestId('trust-subprocessors-retry')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('trust-subprocessors-name-0'), { target: { value: 'Edited locally' } });
    expect(screen.queryByTestId('trust-subprocessors-retry')).toBeNull();
    expect(screen.getByTestId('trust-subprocessors-load-error')).toBeInTheDocument();
    expect(screen.getByTestId('trust-subprocessors-name-0')).toHaveValue('Edited locally');
    err.mockRestore();
  });

  it('a retry that fails again keeps the alert and the retry', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.getTrustSubprocessors.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce(new Error('boom again'));
    mount();
    fireEvent.click(await screen.findByTestId('trust-subprocessors-retry'));
    await waitFor(() => expect(api.getTrustSubprocessors).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('trust-subprocessors-load-error')).toBeInTheDocument();
    expect(screen.getByTestId('trust-subprocessors-retry')).toBeInTheDocument();
    expect(screen.getByTestId('trust-subprocessors-save')).toBeDisabled();
    err.mockRestore();
  });

  it('an older load resolving after a newer one applies nothing (rows and Save revision stay the newer ones)', async () => {
    const settle: Array<(v: unknown) => void> = [];
    api.getTrustSubprocessors.mockImplementation(() => new Promise((r) => { settle.push(r); }));
    const view = (rev: number) => <TrustSubprocessorsSection orgId="o1" orgFetch={orgFetch} state={{ page: { publicationRevision: rev } } as never} canWrite onReload={vi.fn(async () => {})} />;
    const { rerender } = render(view(7));
    rerender(view(8));
    await waitFor(() => expect(settle).toHaveLength(2));
    settle[1]!({ subprocessors: [sp('Newer EDR')], publicationRevision: 8 });
    expect(await screen.findByTestId('trust-subprocessors-name-0')).toHaveValue('Newer EDR');
    settle[0]!({ subprocessors: [sp('Older EDR')], publicationRevision: 7 });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('trust-subprocessors-name-0')).toHaveValue('Newer EDR');
    fireEvent.click(screen.getByTestId('trust-subprocessors-save'));
    await waitFor(() => expect(api.putTrustSubprocessors).toHaveBeenCalledWith(orgFetch, 'o1', 8, expect.any(Array)));
  });
});

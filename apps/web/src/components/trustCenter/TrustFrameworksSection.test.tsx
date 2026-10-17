// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({ updateTrustPage: vi.fn() }));
vi.mock('@/lib/api/trustPage', () => api);
import TrustFrameworksSection from './TrustFrameworksSection';

const orgFetch = vi.fn() as never;
const options = (cisAvailable: boolean, suggested: string | null = null) =>
  ['cis_v8', 'essential_eight', 'cyber_essentials', 'nist_csf_2'].map((framework) => ({
    framework, available: framework !== 'cis_v8' || cisAvailable, suggested: framework === suggested,
  }));
const mount = (over: { cis?: boolean; suggested?: string | null; pageView?: string[] | null; source?: string; canWrite?: boolean } = {}) => {
  const pageView = over.pageView === undefined ? ['nist_csf_2'] : over.pageView;
  const state = {
    page: { publicationRevision: 7, frameworkView: pageView },
    effective: { values: { frameworkView: pageView ?? ['nist_csf_2'] }, sources: { frameworkView: over.source ?? (pageView ? 'page' : 'default') } },
    frameworkOptions: options(over.cis ?? false, over.suggested ?? null),
  };
  const onReload = vi.fn(async () => {});
  render(<TrustFrameworksSection orgId="o1" orgFetch={orgFetch} state={state as never} canWrite={over.canWrite ?? true} onReload={onReload} />);
  return onReload;
};

describe('TrustFrameworksSection', () => {
  beforeEach(() => { vi.clearAllMocks(); api.updateTrustPage.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 })); });

  it('disables the CIS checkbox with a licensing hint when it is unavailable', () => {
    mount({ cis: false });
    expect(screen.getByTestId('trust-frameworks-option-cis_v8')).toBeDisabled();
    expect(screen.getByTestId('trust-frameworks-cis-hint')).toHaveTextContent('Available once CIS licensing is confirmed');
    expect(screen.getByTestId('trust-frameworks-option-essential_eight')).not.toBeDisabled();
  });

  it('enables CIS and hides the hint when the deployment allows it', () => {
    mount({ cis: true });
    expect(screen.getByTestId('trust-frameworks-option-cis_v8')).not.toBeDisabled();
    expect(screen.queryByTestId('trust-frameworks-cis-hint')).toBeNull();
  });

  it('shows a suggestion chip for the suggested framework only', () => {
    mount({ suggested: 'essential_eight' });
    expect(screen.getByTestId('trust-frameworks-suggested-essential_eight')).toBeInTheDocument();
    expect(screen.queryByTestId('trust-frameworks-suggested-cyber_essentials')).toBeNull();
  });

  it('Save sends the selection with the loaded revision', async () => {
    const onReload = mount();
    fireEvent.click(screen.getByTestId('trust-frameworks-option-essential_eight'));
    fireEvent.click(screen.getByTestId('trust-frameworks-save'));
    await waitFor(() => expect(api.updateTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', {
      frameworkView: ['essential_eight', 'nist_csf_2'], expectedRevision: 7,
    }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('Use default sends null (inherit)', async () => {
    mount({ pageView: ['essential_eight'] });
    fireEvent.click(screen.getByTestId('trust-frameworks-use-default'));
    await waitFor(() => expect(api.updateTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { frameworkView: null, expectedRevision: 7 }));
  });

  it('Use default is disabled while the page already inherits, and shows the source', () => {
    mount({ pageView: null, source: 'template' });
    expect(screen.getByTestId('trust-frameworks-use-default')).toBeDisabled();
    expect(screen.getByTestId('trust-frameworks-source')).toHaveTextContent(/partner template/i);
  });

  it('is read-only without write access', () => {
    mount({ canWrite: false });
    expect(screen.getByTestId('trust-frameworks-option-nist_csf_2')).toBeDisabled();
    expect(screen.getByTestId('trust-frameworks-save')).toBeDisabled();
  });
});

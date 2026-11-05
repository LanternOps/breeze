import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import OrgBrandingEditor from './OrgBrandingEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

const resizeToDataUrl = vi.fn();
vi.mock('@/lib/logoDataUrl', async (orig) => ({
  ...(await orig<typeof import('@/lib/logoDataUrl')>()),
  resizeToDataUrl: (...args: unknown[]) => resizeToDataUrl(...args),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function getCustomCssTextarea() {
  const block = screen.getByText('Custom CSS (advanced)').parentElement;
  return block?.querySelector('textarea') as HTMLTextAreaElement;
}

describe('OrgBrandingEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #9673: nothing reads these, so the tab must not offer them.
  it('does not offer controls that change nothing: theme, portal subdomain, preview URL, draft preview', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: { customCss: null } }));
    const { container } = render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.queryByText('Theme')).toBeNull();
    expect(screen.queryByText('Portal subdomain')).toBeNull();
    expect(screen.queryByText(/Available preview URL/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(container.textContent).not.toMatch(/https:\/\/your-org\./);
  });

  // An archived org must not be written to and then told the save failed.
  it('saveBlockedMessage refuses Save before any write', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: { customCss: null } }));
    const onSave = vi.fn();
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} onSave={onSave} saveBlockedMessage="Archived." />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('branding-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ message: 'Archived.', type: 'error' }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('without an orgId, Save does not attempt a portal-settings call (no crash)', async () => {
    render(<OrgBrandingEditor organizationName="Acme Systems" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    await screen.findByText('Branding settings saved.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads the persisted customCss from portal-settings on mount (#5952)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: { customCss: '.portal-header{color:red}' } }));
    render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);

    await waitFor(() => expect(getCustomCssTextarea().value).toBe('.portal-header{color:red}'));
    expect(fetchMock).toHaveBeenCalledWith(`/orgs/organizations/${ORG_ID}/portal-settings`);
  });

  it('shows the sample CSS as a placeholder, never as the value, when none is saved', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: { customCss: null } }));
    render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(getCustomCssTextarea().value).toBe('');
    expect(getCustomCssTextarea().placeholder).toContain('letter-spacing');
  });

  it('Save with untouched CSS sends customCss: null, not the sample', async () => {
    fetchMock.mockImplementation(async (_input, init) =>
      makeJsonResponse({ data: { customCss: null } }, true));
    render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    await screen.findByText('Branding settings saved.');
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ customCss: null });
  });

  it('logo hint matches the accepted formats (not SVG/512)', () => {
    render(<OrgBrandingEditor organizationName="Acme Systems" />);
    expect(screen.queryByText(/512x512/)).toBeNull();
    expect(screen.getByText(/PNG, JPEG, or WebP/)).toBeTruthy();
  });

  it('saves customCss via PATCH /orgs/organizations/:id/portal-settings', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === `/orgs/organizations/${ORG_ID}/portal-settings` && !init?.method) {
        return makeJsonResponse({ data: { customCss: null } });
      }
      if (url === `/orgs/organizations/${ORG_ID}/portal-settings` && init?.method === 'PATCH') {
        return makeJsonResponse({ data: { customCss: JSON.parse(String(init.body)).customCss } });
      }
      return makeJsonResponse({ error: 'unexpected' }, false, 404);
    });

    const onSave = vi.fn();
    render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} onSave={onSave} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(getCustomCssTextarea(), { target: { value: '.a { color: blue; }' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeDefined();
    });
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    const body = JSON.parse(String(patchCall![1]!.body));
    expect(body).toEqual({ customCss: '.a { color: blue; }' });

    // #9673: everything on this tab goes through that PATCH. onSave only tells
    // the page the save finished, and carries no settings.
    expect(onSave).toHaveBeenCalledExactlyOnceWith();
  });

  it('sends null when the customCss textarea is cleared', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') return makeJsonResponse({ data: { customCss: null } });
      return makeJsonResponse({ data: { customCss: 'body{}' } });
    });

    render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);
    await waitFor(() => expect(getCustomCssTextarea().value).toBe('body{}'));

    fireEvent.change(getCustomCssTextarea(), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(patchCall).toBeDefined();
    });
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall![1]!.body))).toEqual({ customCss: null });
  });

  it('toasts an error and does not crash when the server rejects the CSS (runAction)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PATCH') {
        return makeJsonResponse({ error: 'Custom CSS contains a disallowed pattern: @import' }, false, 400);
      }
      return makeJsonResponse({ data: { customCss: '' } });
    });

    render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(getCustomCssTextarea(), { target: { value: '@import "evil.css";' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  // Review finding (#5982): a failed initial load must never let Save silently
  // overwrite the admin's real persisted CSS with the seeded placeholder.
  describe('load failure guard', () => {
    it('a non-2xx load response disables the textarea, toasts, and blocks Save from PATCHing', async () => {
      fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
      render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);

      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
      expect(getCustomCssTextarea().disabled).toBe(true);
      await screen.findByText(/Could not load your currently saved custom CSS/);

      showToast.mockClear();
      fetchMock.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));

      await waitFor(() => expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: expect.stringContaining('not saved') })
      ));
      expect(fetchMock).not.toHaveBeenCalledWith(
        `/orgs/organizations/${ORG_ID}/portal-settings`,
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    it('a network error on load also disables Save from PATCHing customCss', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));
      render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);

      await waitFor(() => expect(getCustomCssTextarea().disabled).toBe(true));

      fetchMock.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));

      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('an unparsable load response body also disables Save from PATCHing customCss', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: vi.fn().mockRejectedValue(new Error('not json'))
      } as unknown as Response);
      render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);

      await waitFor(() => expect(getCustomCssTextarea().disabled).toBe(true));

      fetchMock.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a successful load (including a legitimate null customCss) never disables Save', async () => {
      fetchMock.mockResolvedValue(makeJsonResponse({ data: { customCss: null } }));
      render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(getCustomCssTextarea().disabled).toBe(false);
      expect(showToast).not.toHaveBeenCalled();
    });
  });
});


describe('OrgBrandingEditor coordinated save (#6030)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (_input, init) => makeJsonResponse(
      init?.method === 'PATCH' ? { success: true } : { data: { customCss: 'body{}' } }
    ));
  });

  it('does not save branding or report success when CSS is rejected', async () => {
    fetchMock.mockImplementation(async (_input, init) => init?.method === 'PATCH'
      ? makeJsonResponse({ error: 'Custom CSS contains a disallowed pattern: @import' }, false, 400)
      : makeJsonResponse({ data: { customCss: 'body{}' } }));
    const onSave = vi.fn();
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} onSave={onSave} />);
    const css = await screen.findByTestId('branding-custom-css');
    await waitFor(() => expect(css).toHaveValue('body{}'));
    fireEvent.change(css, { target: { value: '@import "evil.css";' } });
    fireEvent.click(screen.getByTestId('branding-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'Custom CSS contains a disallowed pattern: @import'
    })));
    expect(onSave).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(screen.queryByTestId('branding-save-status')).toBeNull();
  });

  it('waits for both writes and reports only one success', async () => {
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('branding-custom-css')).toHaveValue('body{}'));
    fireEvent.click(screen.getByTestId('branding-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(showToast).not.toHaveBeenCalled();
    expect(screen.getByTestId('branding-save')).toBeDisabled();
    finish();
    await waitFor(() => expect(showToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'success' })));
    expect(screen.getByTestId('branding-save-status')).toHaveTextContent('Branding settings saved.');
  });

  it('does not report success when the branding write fails after CSS succeeds', async () => {
    const onSave = vi.fn(async () => false);
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} onSave={onSave} />);
    await waitFor(() => expect(screen.getByTestId('branding-custom-css')).toHaveValue('body{}'));
    fireEvent.click(screen.getByTestId('branding-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId('branding-save')).not.toBeDisabled());
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(screen.queryByTestId('branding-save-status')).toBeNull();
  });
});

// #9673 (settings rules 1 + 4): the org logo lives in portal_branding.logo_url,
// which the portal and every customer document read, and is saved through the
// portal-settings PATCH, never organizations.settings.branding.
describe('OrgBrandingEditor logo (#9673)', () => {
  const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
  const PARTNER_LOGO = 'data:image/png;base64,UEFSVE5FUkxPR08=';
  const OLD_LOGO = 'data:image/png;base64,T0xETE9HTw==';
  const portalUrl = `/orgs/organizations/${ORG_ID}/portal-settings`;

  function mockPortal(data: Record<string, unknown>) {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === portalUrl && init?.method === 'PATCH') {
        return makeJsonResponse({ data: {} });
      }
      return makeJsonResponse({ data: { customCss: null, ...data } });
    });
  }

  const patchBody = () => {
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    return call ? JSON.parse(String(call[1]!.body)) : undefined;
  };
  const preview = () => screen.queryByTestId('branding-logo-preview') as HTMLImageElement | null;
  const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;
  const pickLogo = (container: HTMLElement) => {
    fireEvent.change(fileInput(container), { target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] } });
  };
  const loaded = (container: HTMLElement) => waitFor(() => expect(fileInput(container).disabled).toBe(false));

  beforeEach(() => {
    vi.clearAllMocks();
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/abc');
    URL.revokeObjectURL = vi.fn();
  });

  it("shows the org's own logo from portal-settings", async () => {
    mockPortal({ logoUrl: OLD_LOGO, partnerLogoUrl: PARTNER_LOGO });
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await loaded(container);
    expect(preview()?.getAttribute('src')).toBe(OLD_LOGO);
    expect(screen.getByText('Overrides Partner logo')).toBeTruthy();
  });

  it("shows the partner's logo and where it comes from while the org has none", async () => {
    mockPortal({ logoUrl: null, partnerLogoUrl: PARTNER_LOGO });
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await loaded(container);
    expect(preview()?.getAttribute('src')).toBe(PARTNER_LOGO);
    expect(screen.getByText('Inherits from Partner logo')).toBeTruthy();
    expect(screen.queryByTestId('branding-logo-remove')).toBeNull();
  });

  it('says when neither level has a logo', async () => {
    mockPortal({ logoUrl: null, partnerLogoUrl: null });
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await loaded(container);
    expect(preview()).toBeNull();
    expect(screen.getByText('No Partner logo configured')).toBeTruthy();
  });

  it('saves an upload through portal-settings as an encoded data URI, never a blob: URL', async () => {
    mockPortal({ logoUrl: null, partnerLogoUrl: null });
    resizeToDataUrl.mockResolvedValue(DATA_URL);
    const onSave = vi.fn();
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} onSave={onSave} />);
    await loaded(container);
    pickLogo(container);
    await waitFor(() => expect(preview()?.getAttribute('src')).toBe(DATA_URL));
    fireEvent.click(screen.getByTestId('branding-save'));
    await screen.findByText('Branding settings saved.');
    expect(patchBody()).toEqual({ customCss: null, logoUrl: DATA_URL });
    expect(onSave).toHaveBeenCalledExactlyOnceWith();
  });

  it('an untouched logo is not re-sent', async () => {
    mockPortal({ logoUrl: OLD_LOGO, partnerLogoUrl: null });
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await loaded(container);
    fireEvent.click(screen.getByTestId('branding-save'));
    await screen.findByText('Branding settings saved.');
    expect(patchBody()).toEqual({ customCss: null });
  });

  it('Remove clears the override, so the org inherits the partner logo again', async () => {
    mockPortal({ logoUrl: OLD_LOGO, partnerLogoUrl: PARTNER_LOGO });
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await loaded(container);
    fireEvent.click(screen.getByTestId('branding-logo-remove'));
    expect(preview()?.getAttribute('src')).toBe(PARTNER_LOGO);
    fireEvent.click(screen.getByTestId('branding-save'));
    await screen.findByText('Branding settings saved.');
    expect(patchBody()).toEqual({ customCss: null, logoUrl: null });
  });

  it('clears the file input after a pick, so the same file can be picked again after Remove', async () => {
    mockPortal({ logoUrl: null, partnerLogoUrl: null });
    resizeToDataUrl.mockResolvedValue(DATA_URL);
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await loaded(container);
    const setValue = vi.fn();
    Object.defineProperty(fileInput(container), 'value', { configurable: true, get: () => '', set: setValue });
    pickLogo(container);
    await waitFor(() => expect(preview()?.getAttribute('src')).toBe(DATA_URL));
    expect(setValue).toHaveBeenCalledWith('');
  });

  it('a second save after an upload does not re-send the logo', async () => {
    mockPortal({ logoUrl: null, partnerLogoUrl: null });
    resizeToDataUrl.mockResolvedValue(DATA_URL);
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await loaded(container);
    pickLogo(container);
    await waitFor(() => expect(preview()?.getAttribute('src')).toBe(DATA_URL));
    fireEvent.click(screen.getByTestId('branding-save'));
    await screen.findByText('Branding settings saved.');
    await waitFor(() => expect(screen.getByTestId('branding-save')).not.toBeDisabled());

    fetchMock.mockClear();
    fireEvent.click(screen.getByTestId('branding-save'));
    await waitFor(() => expect(patchBody()).toEqual({ customCss: null }));
    expect(preview()?.getAttribute('src')).toBe(DATA_URL);
  });

  it('toasts and keeps the previous logo when the image cannot be decoded', async () => {
    mockPortal({ logoUrl: OLD_LOGO, partnerLogoUrl: null });
    resizeToDataUrl.mockRejectedValue(new Error('Invalid image file'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await loaded(container);
    pickLogo(container);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(preview()?.getAttribute('src')).toBe(OLD_LOGO);
    fireEvent.click(screen.getByTestId('branding-save'));
    await screen.findByText('Branding settings saved.');
    expect(patchBody()).toEqual({ customCss: null });
  });

  it('rejects an oversized logo and keeps the previous logo', async () => {
    mockPortal({ logoUrl: OLD_LOGO, partnerLogoUrl: null });
    resizeToDataUrl.mockResolvedValue('data:image/png;base64,' + 'A'.repeat(400_001));
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await loaded(container);
    pickLogo(container);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(preview()?.getAttribute('src')).toBe(OLD_LOGO);
  });

  it('upload stays disabled until portal-settings has loaded, and after a failed load', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    expect(fileInput(container).disabled).toBe(true);
    await screen.findByText('Could not load the saved logo. Uploading is disabled until this loads.');
    expect(fileInput(container).disabled).toBe(true);
  });

  it('a partner lock on the legacy settings field does not disable the org override', async () => {
    mockPortal({ logoUrl: null, partnerLogoUrl: PARTNER_LOGO });
    const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} locked={['branding.logoUrl']} />);
    await loaded(container);
    expect(screen.queryByText('Managed by partner')).toBeNull();
  });

  // The legacy blob holds a real upload, unlike its colours (the editor wrote
  // hard-coded defaults on every save), so it is offered, not silently dropped.
  describe('a logo saved to the retired organizations.settings.branding', () => {
    it('is shown with a notice and written to portal-settings on Save', async () => {
      mockPortal({ logoUrl: null, partnerLogoUrl: PARTNER_LOGO });
      const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} legacyLogoUrl={OLD_LOGO} />);
      await loaded(container);
      expect(preview()?.getAttribute('src')).toBe(OLD_LOGO);
      expect(screen.getByTestId('branding-logo-legacy-notice')).toBeTruthy();
      fireEvent.click(screen.getByTestId('branding-save'));
      await screen.findByText('Branding settings saved.');
      expect(patchBody()).toEqual({ customCss: null, logoUrl: OLD_LOGO });
      expect(screen.queryByTestId('branding-logo-legacy-notice')).toBeNull();
    });

    it('is not offered before portal-settings has loaded, or when that load fails', async () => {
      fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
      render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} legacyLogoUrl={OLD_LOGO} />);
      expect(screen.queryByTestId('branding-logo-legacy-notice')).toBeNull();
      await screen.findByText('Could not load the saved logo. Uploading is disabled until this loads.');
      expect(screen.queryByTestId('branding-logo-legacy-notice')).toBeNull();
    });

    it("yields to the org's own portal_branding logo", async () => {
      mockPortal({ logoUrl: DATA_URL, partnerLogoUrl: null });
      const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} legacyLogoUrl={OLD_LOGO} />);
      await loaded(container);
      expect(preview()?.getAttribute('src')).toBe(DATA_URL);
      expect(screen.queryByTestId('branding-logo-legacy-notice')).toBeNull();
      fireEvent.click(screen.getByTestId('branding-save'));
      await screen.findByText('Branding settings saved.');
      expect(patchBody()).toEqual({ customCss: null });
    });

    it('can be removed instead of applied', async () => {
      mockPortal({ logoUrl: null, partnerLogoUrl: null });
      const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} legacyLogoUrl={OLD_LOGO} />);
      await loaded(container);
      fireEvent.click(screen.getByTestId('branding-logo-remove'));
      expect(preview()).toBeNull();
      expect(screen.queryByTestId('branding-logo-legacy-notice')).toBeNull();
      fireEvent.click(screen.getByTestId('branding-save'));
      await screen.findByText('Branding settings saved.');
      expect(patchBody()).toEqual({ customCss: null, logoUrl: null });
    });

    it.each(['blob:http://localhost/abc', 'data:image/svg+xml;base64,PHN2Zz4=', 'http://cdn.example.com/l.png'])(
      'is ignored when the write schema would refuse it: %s',
      async (legacy) => {
        mockPortal({ logoUrl: null, partnerLogoUrl: null });
        const { container } = render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} legacyLogoUrl={legacy} />);
        await loaded(container);
        expect(screen.queryByTestId('branding-logo-legacy-notice')).toBeNull();
        fireEvent.click(screen.getByTestId('branding-save'));
        await screen.findByText('Branding settings saved.');
        expect(patchBody()).toEqual({ customCss: null });
      },
    );
  });
});

// #9673: the org override of the partner's secondary colour, on the same chain
// as the primary colour.
describe('OrgBrandingEditor secondary color (#9673)', () => {
  const portalUrl = `/orgs/organizations/${ORG_ID}/portal-settings`;

  function mockPortal(data: Record<string, unknown>) {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === portalUrl && init?.method === 'PATCH') {
        return makeJsonResponse({ data: {} });
      }
      return makeJsonResponse({ data: { customCss: null, ...data } });
    });
  }

  const colorInput = () => screen.getByTestId('branding-secondary-color') as HTMLInputElement;
  const picker = () => screen.getByTestId('branding-secondary-color-picker') as HTMLInputElement;
  const patchBody = () => {
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    return call ? JSON.parse(String(call[1]!.body)) : undefined;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the org's own secondary colour from portal-settings", async () => {
    mockPortal({ secondaryColor: '#0f766e', partnerSecondaryColor: '#7c3aed' });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().value).toBe('#0f766e'));
    expect(picker().value).toBe('#0f766e');
  });

  it('shows the inherited partner colour and its source while the org value is blank', async () => {
    mockPortal({ secondaryColor: null, partnerSecondaryColor: '#7c3aed' });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().placeholder).toBe('#7c3aed'));
    expect(colorInput().value).toBe('');
    expect(screen.getByText('Inherits from Partner secondary color')).toBeTruthy();
    expect(picker().value).toBe('#7c3aed');
  });

  it('a change is saved through portal-settings; an untouched value is not re-sent', async () => {
    mockPortal({ secondaryColor: '#0f766e', partnerSecondaryColor: null });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().value).toBe('#0f766e'));
    fireEvent.click(screen.getByTestId('branding-save'));
    await screen.findByText('Branding settings saved.');
    expect(patchBody()).toEqual({ customCss: null });

    fetchMock.mockClear();
    fireEvent.change(colorInput(), { target: { value: '#123456' } });
    fireEvent.click(screen.getByTestId('branding-save'));
    await waitFor(() => expect(patchBody()).toEqual({ customCss: null, secondaryColor: '#123456' }));
  });

  it('clearing the field sends null so the org inherits again', async () => {
    mockPortal({ secondaryColor: '#0f766e', partnerSecondaryColor: '#7c3aed' });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().value).toBe('#0f766e'));
    fireEvent.change(colorInput(), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('branding-save'));
    await waitFor(() => expect(patchBody()).toEqual({ customCss: null, secondaryColor: null }));
  });

  it('refuses to save a value that is not a hex colour: no writes, an error toast', async () => {
    mockPortal({ secondaryColor: null, partnerSecondaryColor: null });
    const onSave = vi.fn();
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} onSave={onSave} />);
    await waitFor(() => expect(colorInput().disabled).toBe(false));
    fireEvent.change(colorInput(), { target: { value: 'teal' } });
    expect(colorInput().getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByTestId('branding-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'Enter a hex color such as #2563eb.'
    })));
    expect(patchBody()).toBeUndefined();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a partner lock on the legacy settings field does not disable the org override', async () => {
    mockPortal({ secondaryColor: null, partnerSecondaryColor: '#7c3aed' });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} locked={['branding.secondaryColor']} />);
    await waitFor(() => expect(colorInput().placeholder).toBe('#7c3aed'));
    expect(colorInput().disabled).toBe(false);
  });

  it('disables the field when portal-settings could not be loaded', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().disabled).toBe(true));
    expect(screen.getByText('Could not load the saved secondary color. Editing is disabled until this loads.')).toBeTruthy();
  });
});

// #9962 (settings rules 1 + 4): the org "Primary color" is the org override of
// the partner's document accent. It lives in portal_branding.primary_color —
// the column every quote/invoice renderer reads — and is saved through the
// portal-settings PATCH, never organizations.settings.branding.
describe('OrgBrandingEditor primary color (#9962)', () => {
  const portalUrl = `/orgs/organizations/${ORG_ID}/portal-settings`;

  function mockPortal(data: Record<string, unknown>) {
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === portalUrl && init?.method === 'PATCH') {
        return makeJsonResponse({ data: {} });
      }
      return makeJsonResponse({ data: { customCss: null, ...data } });
    });
  }

  const colorInput = () => screen.getByTestId('branding-primary-color') as HTMLInputElement;
  const patchBody = () => {
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    return call ? JSON.parse(String(call[1]!.body)) : undefined;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the org's own document colour from portal-settings", async () => {
    mockPortal({ primaryColor: '#c2410c', partnerPrimaryColor: '#7c3aed' });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().value).toBe('#c2410c'));
    expect(screen.getByText('Overrides Partner brand color (#7c3aed)')).toBeTruthy();
  });

  it('shows the inherited partner colour and its source while the org value is blank', async () => {
    mockPortal({ primaryColor: null, partnerPrimaryColor: '#7c3aed' });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().placeholder).toBe('#7c3aed'));
    expect(colorInput().value).toBe('');
    expect(screen.getByText('Inherits from Partner brand color')).toBeTruthy();
    expect((screen.getByTestId('branding-primary-color-picker') as HTMLInputElement).value).toBe('#7c3aed');
  });

  it('ignores the legacy organizations.settings.branding.primaryColor value', async () => {
    mockPortal({ primaryColor: null, partnerPrimaryColor: null });
    // The page passes only the legacy logo: no other legacy value can reach the editor.
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().disabled).toBe(false));
    expect(colorInput().value).toBe('');
    expect(screen.getByText('No Partner brand color configured')).toBeTruthy();
    // The picker shows the app default, not the legacy red.
    expect((screen.getByTestId('branding-primary-color-picker') as HTMLInputElement).value).toBe('#2563eb');
  });

  it('saves a changed colour through the portal-settings PATCH, not the org settings blob', async () => {
    mockPortal({ primaryColor: null, partnerPrimaryColor: '#7c3aed' });
    const onSave = vi.fn();
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} onSave={onSave} />);
    await waitFor(() => expect(colorInput().placeholder).toBe('#7c3aed'));

    fireEvent.change(colorInput(), { target: { value: ' #0F766E ' } });
    fireEvent.click(screen.getByTestId('branding-save'));

    await screen.findByText('Branding settings saved.');
    expect(patchBody()).toEqual({ customCss: null, primaryColor: '#0F766E' });
    expect(onSave).toHaveBeenCalledExactlyOnceWith();
  });

  it('the colour picker sets the override, and it is saved', async () => {
    mockPortal({ primaryColor: null, partnerPrimaryColor: null });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().disabled).toBe(false));
    fireEvent.change(screen.getByTestId('branding-primary-color-picker'), { target: { value: '#123456' } });
    expect(colorInput().value).toBe('#123456');
    fireEvent.click(screen.getByTestId('branding-save'));
    await screen.findByText('Branding settings saved.');
    expect(patchBody()).toEqual({ customCss: null, primaryColor: '#123456' });
  });

  it('keeps the colour field disabled until portal-settings has loaded (a slow GET cannot overwrite typing)', async () => {
    let resolveLoad!: (r: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { resolveLoad = resolve; }));
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    expect(colorInput().disabled).toBe(true);
    expect((screen.getByTestId('branding-primary-color-picker') as HTMLInputElement).disabled).toBe(true);
    resolveLoad(makeJsonResponse({ data: { customCss: null, primaryColor: '#c2410c', partnerPrimaryColor: null } }));
    await waitFor(() => expect(colorInput().disabled).toBe(false));
    expect(colorInput().value).toBe('#c2410c');
  });

  it('clearing the field sends null so the org inherits the partner colour again', async () => {
    mockPortal({ primaryColor: '#c2410c', partnerPrimaryColor: '#7c3aed' });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().value).toBe('#c2410c'));

    fireEvent.change(colorInput(), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('branding-save'));

    await screen.findByText('Branding settings saved.');
    expect(patchBody()).toEqual({ customCss: null, primaryColor: null });
  });

  it('an untouched colour is not re-sent (a stored value is never rewritten as a side effect)', async () => {
    mockPortal({ primaryColor: '#c2410c', partnerPrimaryColor: null });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().value).toBe('#c2410c'));
    fireEvent.click(screen.getByTestId('branding-save'));
    await screen.findByText('Branding settings saved.');
    expect(patchBody()).toEqual({ customCss: null });
  });

  it('a legacy stored value that is not a hex colour does not block an unrelated save', async () => {
    mockPortal({ primaryColor: 'red', partnerPrimaryColor: null });
    const onSave = vi.fn();
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} onSave={onSave} />);
    await waitFor(() => expect(colorInput().value).toBe('red'));
    fireEvent.click(screen.getByTestId('branding-save'));
    await screen.findByText('Branding settings saved.');
    expect(patchBody()).toEqual({ customCss: null });
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('refuses to save a value that is not a hex colour: no writes, an error toast', async () => {
    mockPortal({ primaryColor: null, partnerPrimaryColor: null });
    const onSave = vi.fn();
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} onSave={onSave} />);
    await waitFor(() => expect(colorInput().disabled).toBe(false));

    fireEvent.change(colorInput(), { target: { value: 'red' } });
    expect(colorInput().getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByTestId('branding-save'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'Enter a hex color such as #2563eb.'
    })));
    expect(patchBody()).toBeUndefined();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a partner lock on the legacy settings field does not disable the org override', async () => {
    mockPortal({ primaryColor: null, partnerPrimaryColor: '#7c3aed' });
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} locked={['branding.primaryColor']} />);
    await waitFor(() => expect(colorInput().placeholder).toBe('#7c3aed'));
    expect(colorInput().disabled).toBe(false);
  });

  it('disables the colour field when portal-settings could not be loaded', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));
    render(<OrgBrandingEditor organizationName="Acme" orgId={ORG_ID} />);
    await waitFor(() => expect(colorInput().disabled).toBe(true));
    expect(screen.getByText('Could not load the saved primary color. Editing is disabled until this loads.')).toBeTruthy();
  });
});

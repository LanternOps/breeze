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

function getSubdomainInput() {
  const portalBlock = screen.getByText('Portal subdomain').parentElement;
  return portalBlock?.querySelector('input') as HTMLInputElement;
}

describe('OrgBrandingEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens a live preview modal using current branding inputs', async () => {
    render(<OrgBrandingEditor organizationName="Acme Systems" />);

    fireEvent.change(getSubdomainInput(), { target: { value: 'acme-it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    await screen.findByText('Portal preview');
    expect(screen.queryByText('Preview opened in a mock window.')).toBeNull();
    expect(screen.getAllByText(/https:\/\/acme-it\./).length).toBeGreaterThan(0);
    expect(screen.queryByText('Acme Systems Portal')).not.toBeNull();
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

  it('keeps the seeded placeholder when the persisted customCss is null', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: { customCss: null } }));
    render(<OrgBrandingEditor organizationName="Acme Systems" orgId={ORG_ID} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(getCustomCssTextarea().value).toContain('Add custom portal styling here');
  });

  it('saves customCss via PATCH /orgs/organizations/:id/portal-settings, decoupled from other branding fields', async () => {
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

    // onSave still fires for the unrelated branding fields (logo/colors/theme/subdomain),
    // and its payload must NOT carry customCss any more — that's the portal-settings PATCH's job.
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('customCss');
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

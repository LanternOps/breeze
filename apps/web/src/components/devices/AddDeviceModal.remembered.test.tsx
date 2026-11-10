import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same deterministic UA as AddDeviceModal.test.tsx: the installer tab is the
// default and the Windows command is the one rendered.
Object.defineProperty(window.navigator, 'userAgent', {
  configurable: true,
  value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 jsdom/test',
});

import AddDeviceModal from './AddDeviceModal';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { formatDateTime } from '@/lib/dateTimeFormat';
import {
  REMEMBERED_ENROLLMENT_ARTIFACTS_KEY as KEY,
  clearRememberedEnrollmentArtifacts,
} from '@/lib/rememberedEnrollmentArtifacts';

const { authState } = vi.hoisted(() => ({
  authState: { user: null as { id?: string; hasPassword?: boolean } | null },
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (state: typeof authState) => unknown) => selector(authState),
    { getState: () => authState },
  ),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const SITE_A = { id: 'site-aaa-111', orgId: 'org-111', name: 'HQ Office', createdAt: '2026-01-01', deviceCount: 5 };
const SITE_B = { id: 'site-bbb-222', orgId: 'org-111', name: 'Branch Office', createdAt: '2026-01-02', deviceCount: 3 };

const json = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;

/** Route the modal's requests. A handler may be overridden per test. */
function routeFetch(overrides: {
  token?: () => Response | Promise<Response>;
  childKey?: (id: string) => Response | Promise<Response>;
  link?: () => Response | Promise<Response>;
} = {}) {
  let minted = 0;
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/devices/onboarding-token' && method === 'POST') {
      minted += 1;
      if (overrides.token) return overrides.token();
      return json({
        token: `enroll_token_${minted}`,
        maxUsage: 5,
        siteId: JSON.parse(String(init?.body)).siteId,
        expiresAt: inMs(HOUR),
        serverUrl: 'https://api.example.test',
      });
    }
    if (url === '/enrollment-keys/add-device-parent') return json({ id: 'parent-1', reused: true });
    if (url.includes('/installer-link') && method === 'POST') {
      minted += 1;
      if (overrides.link) return overrides.link();
      return json({
        url: `https://api.example.test/api/v1/enrollment-keys/public-download/windows?h=handle${minted}`,
        shortUrl: `https://api.example.test/s/CODE${minted}`,
        expiresAt: inMs(HOUR),
        maxUsage: 3,
        platform: 'windows',
        childKeyId: `child-${minted}`,
      });
    }
    const child = url.match(/^\/enrollment-keys\/([^/?]+)$/);
    if (child && method === 'GET') {
      if (overrides.childKey) return overrides.childKey(child[1]);
      return json({ id: child[1], expiresAt: inMs(HOUR), maxUsage: 3, usageCount: 1 });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });
}

const mintCalls = (path: string) =>
  fetchMock.mock.calls.filter(([url, init]) => String(url).includes(path) && init?.method === 'POST');

const childKeyLookups = () =>
  fetchMock.mock.calls.filter(([url, init]) => /^\/enrollment-keys\/child-/.test(String(url)) && !init?.method);

function renderModal() {
  const view = render(<AddDeviceModal isOpen onClose={vi.fn()} />);
  return {
    ...view,
    reopen() {
      view.rerender(<AddDeviceModal isOpen={false} onClose={vi.fn()} />);
      view.rerender(<AddDeviceModal isOpen onClose={vi.fn()} />);
    },
  };
}

async function generateCliToken(expected = 'enroll_token_1') {
  fireEvent.click(screen.getByTestId('tab-cli'));
  fireEvent.click(screen.getByTestId('cli-regenerate-token'));
  await screen.findByText(expected);
}

async function generateLink(expected = 'https://api.example.test/s/CODE1') {
  fireEvent.click(screen.getByTestId('generate-link'));
  await screen.findByDisplayValue(expected);
}

describe('AddDeviceModal — remembers the last still-valid token and link (#10923)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRememberedEnrollmentArtifacts();
    sessionStorage.clear();
    authState.user = { id: 'user-1', hasPassword: true };
    vi.mocked(useOrgStore).mockReturnValue({
      currentOrgId: 'org-111',
      sites: [SITE_A, SITE_B],
      isLoading: false,
      error: null,
      fetchSites: vi.fn(),
    } as unknown as ReturnType<typeof useOrgStore>);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: async () => '' }));
    routeFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('CLI token', () => {
    it('shows the stored token on reopen, with its expiry, and does not mint again', async () => {
      const { reopen } = renderModal();
      await generateCliToken();
      expect(screen.queryByTestId('cli-token-reuse')).toBeNull();

      reopen();
      fireEvent.click(screen.getByTestId('tab-cli'));

      expect(await screen.findByText('enroll_token_1')).toBeDefined();
      const reuse = screen.getByTestId('cli-token-reuse');
      const stored = JSON.parse(sessionStorage.getItem(KEY)!).sites[SITE_A.id].cli;
      expect(reuse.textContent).toContain(formatDateTime(stored.expiresAt));
      expect(screen.getByTestId('cli-regenerate-token').textContent).toMatch(/Generate new token/);
      expect(screen.getByTestId('cli-command').textContent).toContain('https://api.example.test');
      expect(screen.getByTestId('cli-command').textContent).toContain('enroll_token_1');
      expect(mintCalls('/devices/onboarding-token')).toHaveLength(1);
    });

    it('says a restored token may be used up when the API sent no key id (older API), without any lookup', async () => {
      const { reopen } = renderModal();
      await generateCliToken();
      reopen();
      fireEvent.click(screen.getByTestId('tab-cli'));

      expect((await screen.findByTestId('cli-token-reuse')).textContent).toMatch(/unless/);
      expect(childKeyLookups()).toHaveLength(0);
    });

    describe('with the child key id from the token route (#11116)', () => {
      const withKeyId = () =>
        json({
          token: 'enroll_token_1',
          maxUsage: 5,
          siteId: SITE_A.id,
          expiresAt: inMs(HOUR),
          serverUrl: 'https://api.example.test',
          childKeyId: 'cli-key-1',
        });
      const cliKeyLookups = () =>
        fetchMock.mock.calls.filter(([url, init]) => url === '/enrollment-keys/cli-key-1' && !init?.method);

      it('checks the key on reopen and drops the "may be used up" caveat when it is usable', async () => {
        routeFetch({ token: withKeyId });
        const { reopen } = renderModal();
        await generateCliToken();
        reopen();
        fireEvent.click(screen.getByTestId('tab-cli'));

        expect(await screen.findByText('enroll_token_1')).toBeDefined();
        const reuse = screen.getByTestId('cli-token-reuse');
        expect(reuse.textContent).not.toMatch(/unless/);
        expect(reuse.textContent).toMatch(/^Generated earlier\. Valid until /);
        expect(reuse.textContent).toContain(formatDateTime(JSON.parse(sessionStorage.getItem(KEY)!).sites[SITE_A.id].cli.expiresAt));
        expect(cliKeyLookups()).toHaveLength(1);
        expect(mintCalls('/devices/onboarding-token')).toHaveLength(1);
      });

      it('clears a consumed token instead of showing it', async () => {
        routeFetch({
          token: withKeyId,
          childKey: (id) => json({ id, expiresAt: inMs(HOUR), maxUsage: 5, usageCount: 5 }),
        });
        const { reopen } = renderModal();
        await generateCliToken();
        reopen();
        fireEvent.click(screen.getByTestId('tab-cli'));

        await waitFor(() => expect(cliKeyLookups()).toHaveLength(1));
        await waitFor(() => expect(JSON.parse(sessionStorage.getItem(KEY) ?? '{"sites":{}}').sites[SITE_A.id]?.cli).toBeUndefined());
        expect(screen.queryByText('enroll_token_1')).toBeNull();
        expect(screen.queryByTestId('cli-token-reuse')).toBeNull();
      });

      it('clears a token whose key is gone (404)', async () => {
        routeFetch({ token: withKeyId, childKey: () => json({ error: 'not found' }, 404) });
        const { reopen } = renderModal();
        await generateCliToken();
        reopen();
        fireEvent.click(screen.getByTestId('tab-cli'));

        await waitFor(() => expect(JSON.parse(sessionStorage.getItem(KEY) ?? '{"sites":{}}').sites[SITE_A.id]?.cli).toBeUndefined());
        expect(screen.queryByText('enroll_token_1')).toBeNull();
      });

      it('a check that answers "consumed" after Generate new cannot wipe the new token', async () => {
        let answer!: (r: Response) => void;
        const held = new Promise<Response>((r) => { answer = r; });
        let mints = 0;
        routeFetch({
          token: () => {
            mints += 1;
            return json({
              token: `enroll_token_${mints}`, maxUsage: 5, siteId: SITE_A.id,
              expiresAt: inMs(HOUR), serverUrl: 'https://api.example.test', childKeyId: `cli-key-${mints}`,
            });
          },
          childKey: () => held,
        });
        const { reopen } = renderModal();
        await generateCliToken();
        reopen();
        fireEvent.click(screen.getByTestId('tab-cli'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/enrollment-keys/cli-key-1'));
        fireEvent.click(screen.getByTestId('cli-regenerate-token'));
        await screen.findByText('enroll_token_2');
        await act(async () => { answer(json({ id: 'cli-key-1', expiresAt: inMs(HOUR), maxUsage: 5, usageCount: 5 })); });
        expect(screen.getByText('enroll_token_2')).toBeDefined();
        expect(JSON.parse(sessionStorage.getItem(KEY)!).sites[SITE_A.id].cli.value).toBe('enroll_token_2');
      });

      it('does not show a token when the check itself fails, but keeps it for the next open', async () => {
        routeFetch({ token: withKeyId, childKey: () => json({ error: 'boom' }, 500) });
        const { reopen } = renderModal();
        await generateCliToken();
        reopen();
        fireEvent.click(screen.getByTestId('tab-cli'));

        await waitFor(() => expect(cliKeyLookups()).toHaveLength(1));
        expect(screen.queryByText('enroll_token_1')).toBeNull();
        expect(JSON.parse(sessionStorage.getItem(KEY)!).sites[SITE_A.id].cli.childKeyId).toBe('cli-key-1');
      });
    });

    it('stored past expiresAt gives the empty Generate state and leaves storage', async () => {
      const { reopen } = renderModal();
      await generateCliToken();

      const later = Date.now() + 2 * HOUR;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      reopen();
      fireEvent.click(screen.getByTestId('tab-cli'));

      expect(await screen.findByTestId('cli-token-empty')).toBeDefined();
      expect(screen.queryByTestId('cli-token-reuse')).toBeNull();
      expect(sessionStorage.getItem(KEY) ?? '').not.toContain('enroll_token_1');
    });

    it('clears a token that expires while the modal is open', async () => {
      routeFetch({
        token: () => json({ token: 'enroll_short', maxUsage: 1, siteId: SITE_A.id, expiresAt: inMs(150) }),
      });
      renderModal();
      await generateCliToken('enroll_short');

      await screen.findByTestId('cli-token-empty');
      expect(sessionStorage.getItem(KEY) ?? '').not.toContain('enroll_short');
    });

    it('does not clear a long-lived token at once (a delay above the setTimeout ceiling must not fire early)', async () => {
      routeFetch({
        token: () => json({ token: 'enroll_long', maxUsage: 1, siteId: SITE_A.id, expiresAt: inMs(60 * 24 * HOUR) }),
      });
      renderModal();
      await generateCliToken('enroll_long');

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(screen.getByText('enroll_long')).toBeDefined();
    });

    it('clears on a site change, shows nothing for the new site, and discards the site it left', async () => {
      renderModal();
      await generateCliToken();

      fireEvent.change(screen.getByTestId('cli-site'), { target: { value: SITE_B.id } });
      await screen.findByTestId('cli-token-empty');
      expect(screen.queryByText('enroll_token_1')).toBeNull();

      fireEvent.change(screen.getByTestId('cli-site'), { target: { value: SITE_A.id } });
      await screen.findByTestId('cli-token-empty');
      expect(screen.queryByText('enroll_token_1')).toBeNull();
      expect(sessionStorage.getItem(KEY) ?? '').not.toContain('enroll_token_1');
    });

    it('opening on the first site does not discard an entry stored for another site', async () => {
      const { reopen } = renderModal();
      fireEvent.click(screen.getByTestId('tab-cli'));
      fireEvent.change(screen.getByTestId('cli-site'), { target: { value: SITE_B.id } });
      fireEvent.click(screen.getByTestId('cli-regenerate-token'));
      await screen.findByText('enroll_token_1');

      reopen();
      fireEvent.click(screen.getByTestId('tab-cli'));
      await screen.findByTestId('cli-token-empty');
      fireEvent.change(screen.getByTestId('cli-site'), { target: { value: SITE_B.id } });

      expect(await screen.findByText('enroll_token_1')).toBeDefined();
      expect(screen.getByTestId('cli-token-reuse')).toBeDefined();
    });

    it('Generate new replaces the stored token', async () => {
      const { reopen } = renderModal();
      await generateCliToken();
      reopen();
      fireEvent.click(screen.getByTestId('tab-cli'));
      await screen.findByText('enroll_token_1');

      fireEvent.click(screen.getByTestId('cli-regenerate-token'));
      await screen.findByText('enroll_token_2');

      expect(screen.queryByTestId('cli-token-reuse')).toBeNull();
      expect(sessionStorage.getItem(KEY)).toContain('enroll_token_2');
      expect(sessionStorage.getItem(KEY)).not.toContain('enroll_token_1');
    });

    it('Generate new drops the old token even when the new mint fails', async () => {
      const { reopen } = renderModal();
      await generateCliToken();
      routeFetch({ token: () => json({ error: 'nope' }, 500) });
      reopen();
      fireEvent.click(screen.getByTestId('tab-cli'));
      await screen.findByText('enroll_token_1');

      fireEvent.click(screen.getByTestId('cli-regenerate-token'));

      await screen.findByText(/nope/);
      expect(sessionStorage.getItem(KEY) ?? '').not.toContain('enroll_token_1');
    });

    it('keeps the deployment secret out of storage while the same-document command still carries it', async () => {
      routeFetch({
        token: () =>
          json({
            token: 'enroll_secret',
            maxUsage: 1,
            siteId: SITE_A.id,
            expiresAt: inMs(HOUR),
            enrollmentSecret: 'fleet-secret',
            additionalSecretRequired: true,
          }),
      });
      const { reopen } = renderModal();
      await generateCliToken('enroll_secret');
      expect(sessionStorage.getItem(KEY)).not.toContain('fleet-secret');

      reopen();
      fireEvent.click(screen.getByTestId('tab-cli'));

      await screen.findByText('enroll_secret');
      expect(screen.getByTestId('cli-command').textContent).toContain('fleet-secret');
      expect(sessionStorage.getItem(KEY)).not.toContain('fleet-secret');
    });

    it('does not show a stored token to a different signed-in user', async () => {
      const { reopen } = renderModal();
      await generateCliToken();

      authState.user = { id: 'user-2', hasPassword: true };
      reopen();
      fireEvent.click(screen.getByTestId('tab-cli'));

      await screen.findByTestId('cli-token-empty');
      expect(sessionStorage.getItem(KEY) ?? '').not.toContain('enroll_token_1');
    });

    it('neither shows nor stores a token that resolves after the operator changed site', async () => {
      let resolveMint: (response: Response) => void = () => {};
      routeFetch({ token: () => new Promise<Response>((resolve) => { resolveMint = resolve; }) });
      renderModal();
      fireEvent.click(screen.getByTestId('tab-cli'));
      fireEvent.click(screen.getByTestId('cli-regenerate-token'));
      await waitFor(() => expect(mintCalls('/devices/onboarding-token')).toHaveLength(1));

      fireEvent.change(screen.getByTestId('cli-site'), { target: { value: SITE_B.id } });
      await act(async () => {
        resolveMint(json({ token: 'enroll_late', maxUsage: 1, siteId: SITE_A.id, expiresAt: inMs(HOUR) }));
      });

      await screen.findByTestId('cli-token-empty');
      expect(screen.queryByText('enroll_late')).toBeNull();
      expect(sessionStorage.getItem(KEY) ?? '').not.toContain('enroll_late');
    });
  });

  describe('session', () => {
    it('neither stores nor reads anything without a signed-in user id', async () => {
      authState.user = { hasPassword: true };
      const { reopen } = renderModal();
      await generateLink();
      await generateCliToken('enroll_token_2');
      expect(sessionStorage.getItem(KEY)).toBeNull();

      reopen();
      fireEvent.click(screen.getByTestId('tab-cli'));
      expect(await screen.findByTestId('cli-token-empty')).toBeDefined();
    });

    it('does not store a token whose mint resolves after sign-out', async () => {
      let resolveMint: (response: Response) => void = () => {};
      routeFetch({ token: () => new Promise<Response>((resolve) => { resolveMint = resolve; }) });
      const view = renderModal();
      fireEvent.click(screen.getByTestId('tab-cli'));
      fireEvent.click(screen.getByTestId('cli-regenerate-token'));
      await waitFor(() => expect(mintCalls('/devices/onboarding-token')).toHaveLength(1));

      authState.user = null;
      view.rerender(<AddDeviceModal isOpen onClose={vi.fn()} />);
      await act(async () => {
        resolveMint(json({ token: 'enroll_after_logout', maxUsage: 1, siteId: SITE_A.id, expiresAt: inMs(HOUR), enrollmentSecret: 'fleet-secret' }));
      });

      expect(screen.queryByText('enroll_after_logout')).toBeNull();
      expect(sessionStorage.getItem(KEY)).toBeNull();
    });
  });

  describe('sign-out while a mint is in flight', () => {
    it('does not store a token that resolves after logout cleared storage and the modal unmounted', async () => {
      let resolveMint: (response: Response) => void = () => {};
      routeFetch({ token: () => new Promise<Response>((resolve) => { resolveMint = resolve; }) });
      const view = renderModal();
      fireEvent.click(screen.getByTestId('tab-cli'));
      fireEvent.click(screen.getByTestId('cli-regenerate-token'));
      await waitFor(() => expect(mintCalls('/devices/onboarding-token')).toHaveLength(1));

      clearRememberedEnrollmentArtifacts();
      view.unmount();
      await act(async () => {
        resolveMint(json({ token: 'enroll_orphan', maxUsage: 1, siteId: SITE_A.id, expiresAt: inMs(HOUR) }));
      });

      expect(sessionStorage.getItem(KEY)).toBeNull();
    });
  });

  describe('installer link', () => {
    it('neither shows nor stores a link that resolves after the operator changed site', async () => {
      let resolveLink: (response: Response) => void = () => {};
      routeFetch({ link: () => new Promise<Response>((resolve) => { resolveLink = resolve; }) });
      renderModal();
      fireEvent.click(screen.getByTestId('generate-link'));
      await waitFor(() => expect(mintCalls('/installer-link')).toHaveLength(1));

      fireEvent.change(screen.getByTestId('installer-site'), { target: { value: SITE_B.id } });
      await act(async () => {
        resolveLink(json({ shortUrl: 'https://api.example.test/s/LATE', expiresAt: inMs(HOUR), maxUsage: 1, childKeyId: 'child-late' }));
      });

      expect(screen.queryByDisplayValue('https://api.example.test/s/LATE')).toBeNull();
      expect(sessionStorage.getItem(KEY) ?? '').not.toContain('LATE');
    });

    it('labels a restored macOS link as macOS', async () => {
      routeFetch({
        link: () =>
          json({ shortUrl: 'https://api.example.test/s/MAC', expiresAt: inMs(HOUR), maxUsage: 1, childKeyId: 'child-mac', platform: 'macos' }),
      });
      const { reopen } = renderModal();
      fireEvent.click(screen.getByText('macOS (.zip)'));
      await generateLink('https://api.example.test/s/MAC');

      reopen();

      expect((await screen.findByTestId('link-reuse')).textContent).toContain('macOS');
    });

    it('labels the link button as Generate new once a link is on screen', async () => {
      renderModal();
      expect(screen.getByTestId('generate-link').textContent).toMatch(/Generate Link/);

      await generateLink();

      expect(screen.getByTestId('generate-link').textContent).toMatch(/Generate new link/);
    });

    it('checks the child key, then shows the stored link with its expiry, platform and remaining uses', async () => {
      const { reopen } = renderModal();
      await generateLink();
      expect(screen.queryByTestId('link-reuse')).toBeNull();

      reopen();

      expect(await screen.findByDisplayValue('https://api.example.test/s/CODE1')).toBeDefined();
      const reuse = screen.getByTestId('link-reuse');
      const stored = JSON.parse(sessionStorage.getItem(KEY)!).sites[SITE_A.id].link;
      expect(reuse.textContent).toContain(formatDateTime(stored.expiresAt));
      expect(reuse.textContent).toContain('Windows');
      expect(screen.getByText(/2 downloads/)).toBeDefined();
      expect(fetchMock).toHaveBeenCalledWith('/enrollment-keys/child-1');
      expect(mintCalls('/installer-link')).toHaveLength(1);
    });

    it('hides the link until the child-key check has answered', async () => {
      let resolveCheck: (response: Response) => void = () => {};
      const { reopen } = renderModal();
      await generateLink();
      routeFetch({ childKey: () => new Promise<Response>((resolve) => { resolveCheck = resolve; }) });

      reopen();
      await waitFor(() => expect(childKeyLookups()).toHaveLength(1));
      expect(screen.queryByTestId('link-reuse')).toBeNull();
      expect(screen.queryByDisplayValue('https://api.example.test/s/CODE1')).toBeNull();

      await act(async () => {
        resolveCheck(json({ expiresAt: inMs(HOUR), maxUsage: 3, usageCount: 0 }));
      });
      expect(await screen.findByTestId('link-reuse')).toBeDefined();
    });

    it.each([
      ['has no uses left', () => json({ expiresAt: inMs(HOUR), maxUsage: 3, usageCount: 3 })],
      ['is gone', () => json({ error: 'Enrollment key not found' }, 404)],
      ['has expired on the server', () => json({ expiresAt: inMs(-1000), maxUsage: 3, usageCount: 0 })],
    ])('hides and clears a link whose child key %s', async (_label, childKey) => {
      const { reopen } = renderModal();
      await generateLink();
      routeFetch({ childKey });

      reopen();

      await waitFor(() => expect(sessionStorage.getItem(KEY) ?? '').not.toContain('CODE1'));
      expect(screen.queryByTestId('link-reuse')).toBeNull();
      expect(screen.queryByDisplayValue('https://api.example.test/s/CODE1')).toBeNull();
      expect(screen.getByTestId('generate-link').textContent).toMatch(/Generate Link/);
    });

    it.each([
      ['answers 500', () => json({ error: 'boom' }, 500)],
      ['is refused (no organizations:read)', () => json({ error: 'Forbidden' }, 403)],
      ['cannot be reached', () => Promise.reject(new Error('network down'))],
    ])('hides the link but keeps it stored when the check %s', async (_label, childKey) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { reopen } = renderModal();
      await generateLink();
      routeFetch({ childKey });

      reopen();

      await waitFor(() => expect(warn).toHaveBeenCalled());
      expect(screen.queryByTestId('link-reuse')).toBeNull();
      expect(screen.queryByDisplayValue('https://api.example.test/s/CODE1')).toBeNull();
      expect(sessionStorage.getItem(KEY)).toContain('CODE1');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('CODE1');
    });

    it('stored past expiresAt gives the empty state without asking the server', async () => {
      const { reopen } = renderModal();
      await generateLink();

      const later = Date.now() + 2 * HOUR;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      reopen();

      await waitFor(() => expect(sessionStorage.getItem(KEY) ?? '').not.toContain('CODE1'));
      expect(screen.queryByTestId('link-reuse')).toBeNull();
      expect(childKeyLookups()).toHaveLength(0);
    });

    it('clears a link that expires while the modal is open', async () => {
      routeFetch({
        link: () =>
          json({ shortUrl: 'https://api.example.test/s/SHORT', expiresAt: inMs(150), maxUsage: 1, childKeyId: 'child-9' }),
      });
      renderModal();
      await generateLink('https://api.example.test/s/SHORT');

      await waitFor(() => expect(screen.queryByDisplayValue('https://api.example.test/s/SHORT')).toBeNull());
      expect(sessionStorage.getItem(KEY) ?? '').not.toContain('SHORT');
    });

    it('clears on a site change', async () => {
      renderModal();
      await generateLink();

      fireEvent.change(screen.getByTestId('installer-site'), { target: { value: SITE_B.id } });

      await waitFor(() => expect(screen.queryByDisplayValue('https://api.example.test/s/CODE1')).toBeNull());
      expect(sessionStorage.getItem(KEY) ?? '').not.toContain('CODE1');
    });

    it('Generate new replaces the stored link', async () => {
      const { reopen } = renderModal();
      await generateLink();
      reopen();
      await screen.findByTestId('link-reuse');

      fireEvent.click(screen.getByTestId('generate-link'));
      await screen.findByDisplayValue('https://api.example.test/s/CODE2');

      expect(screen.queryByTestId('link-reuse')).toBeNull();
      expect(sessionStorage.getItem(KEY)).toContain('CODE2');
      expect(sessionStorage.getItem(KEY)).not.toContain('CODE1');
    });

    it('a check that answers after Generate new cannot touch the new link', async () => {
      let resolveCheck: (response: Response) => void = () => {};
      const { reopen } = renderModal();
      await generateLink();
      routeFetch({ childKey: () => new Promise<Response>((resolve) => { resolveCheck = resolve; }) });
      reopen();
      await waitFor(() => expect(childKeyLookups()).toHaveLength(1));

      fireEvent.click(screen.getByTestId('generate-link'));
      await screen.findByDisplayValue('https://api.example.test/s/CODE1');
      await act(async () => {
        resolveCheck(json({ error: 'Enrollment key not found' }, 404));
      });

      expect(screen.getByDisplayValue('https://api.example.test/s/CODE1')).toBeDefined();
      expect(sessionStorage.getItem(KEY)).toContain('CODE1');
    });

    it('does not remember a link without a short URL, whose fallback URL carries a one-time handle', async () => {
      routeFetch({
        link: () =>
          json({ url: 'https://api.example.test/public?h=one-time', expiresAt: inMs(HOUR), maxUsage: 1, childKeyId: 'child-9' }),
      });
      renderModal();
      await generateLink('https://api.example.test/public?h=one-time');

      expect(sessionStorage.getItem(KEY)).toBeNull();
    });
  });
});

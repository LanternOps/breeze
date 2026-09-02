import { render, waitFor, act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
// Raw source of the component under test, for the build-mechanism guard below.
import scriptFormSource from './ScriptForm.tsx?raw';

// Track every Monaco editor instance the mock hands to ScriptForm's onMount, so
// we can assert the component disposes them rather than leaking them across
// Astro View-Transition DOM swaps (issue #1186).
const { editorInstances } = vi.hoisted(() => ({
  editorInstances: [] as Array<{ layout: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>
}));

vi.mock('@monaco-editor/react', async () => {
  const React = (await vi.importActual<typeof import('react')>('react'));
  const loader = { config: vi.fn() };
  function MockEditor({ onMount, value }: { onMount?: (e: unknown) => void; value?: string }) {
    React.useEffect(() => {
      const instance = { layout: vi.fn(), dispose: vi.fn() };
      editorInstances.push(instance);
      onMount?.(instance);
      // The real wrapper disposes on its own unmount; the mock deliberately does
      // NOT, so the test only passes if ScriptForm itself disposes the instance.
    }, []);
    return React.createElement('div', { 'data-testid': 'mock-monaco' }, value);
  }
  return { __esModule: true, default: MockEditor, loader };
});

vi.mock('@/stores/scriptAiStore', () => ({
  useScriptAiStore: () => ({ panelOpen: false, togglePanel: vi.fn() })
}));

// Partner-scope gate (#1386 sibling): the availability picker keys off the JWT
// scope claim, not `useOrgStore().partners`. Mock both so the gate is testable.
const { getJwtClaimsMock, orgStoreMock } = vi.hoisted(() => ({
  getJwtClaimsMock: vi.fn<() => { scope: 'system' | 'partner' | 'organization' | null; partnerId: string | null; orgId: string | null }>(
    () => ({ scope: 'partner', partnerId: 'p-1', orgId: null })
  ),
  orgStoreMock: vi.fn<() => { organizations: Array<{ id: string; name: string }>; partners: unknown[]; sites: unknown[] }>(
    () => ({ organizations: [], partners: [], sites: [] })
  )
}));

vi.mock('@/lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authScope')>('@/lib/authScope');
  return { ...actual, getJwtClaims: getJwtClaimsMock };
});

vi.mock('@/stores/orgStore', async () => {
  const actual = await vi.importActual<typeof import('@/stores/orgStore')>('@/stores/orgStore');
  return { ...actual, useOrgStore: orgStoreMock };
});

// The variable picker fetches GET /tenant-variables on mount (#3409 PR2).
// Stub the transport — the real store is kept so `useAuthStore.setState` below
// still drives the same module instance the component reads.
const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));

vi.mock('@/stores/auth', async () => {
  const actual = await vi.importActual<typeof import('@/stores/auth')>('@/stores/auth');
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

import ScriptForm from './ScriptForm';
import { useAuthStore } from '@/stores/auth';

describe('ScriptForm Monaco lifecycle (issue #1186)', () => {
  beforeEach(() => {
    editorInstances.length = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('disposes the prior editor instance on an Astro View-Transition swap instead of leaking it', async () => {
    render(<ScriptForm />);
    await waitFor(() => expect(editorInstances).toHaveLength(1));
    const first = editorInstances[0];
    expect(first.dispose).not.toHaveBeenCalled();

    // Astro swaps the document on SPA navigation; ScriptForm re-runs loadEditor.
    // It must dispose the now-orphaned editor before reloading.
    act(() => {
      document.dispatchEvent(new Event('astro:after-swap'));
    });

    await waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(1));
  });

  it('disposes the editor instance when the form unmounts', async () => {
    const { unmount } = render(<ScriptForm />);
    await waitFor(() => expect(editorInstances).toHaveLength(1));
    const first = editorInstances[0];
    expect(first.dispose).not.toHaveBeenCalled();

    unmount();
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it('tolerates a throwing dispose on swap — logs and continues instead of aborting the reload', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ScriptForm />);
    await waitFor(() => expect(editorInstances).toHaveLength(1));
    // A real Monaco dispose can throw on a double-dispose / internal edge case.
    // Unguarded, that throw escapes the astro:after-swap listener and leaves a
    // stale ref the layout() handler would call into. The dispose must be caught.
    editorInstances[0].dispose.mockImplementation(() => {
      throw new Error('monaco dispose failed');
    });

    expect(() => {
      act(() => {
        document.dispatchEvent(new Event('astro:after-swap'));
      });
    }).not.toThrow();

    expect(editorInstances[0].dispose).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      'Failed to dispose previous Monaco editor:',
      expect.any(Error)
    );
    errSpy.mockRestore();
  });

  // Build-mechanism guard: the white-box cure (#1186) is the static editor.main.css
  // import landing in the route <head> so it survives View-Transition swaps. That's
  // invisible to jsdom (CSS imports are no-ops in vitest), so nothing else here would
  // catch someone "cleaning up an unused import" and silently regressing the fix.
  it('keeps the static Monaco editor.main.css import (headline #1186 cure)', () => {
    expect(scriptFormSource).toMatch(/import\s+['"]monaco-editor\/min\/vs\/editor\/editor\.main\.css['"]/);
  });
});

describe('ScriptForm Monaco theme preservation across View-Transition swap (issue #1589)', () => {
  afterEach(() => {
    document.head.querySelectorAll('style.monaco-colors').forEach(el => el.remove());
    vi.clearAllMocks();
  });

  // The theme-color preservation now lives in the always-present global handler
  // (public/monaco-theme-persist.js, wired into Layout.astro) — its behavior is
  // covered by src/layouts/monacoThemePersist.test.ts. The earlier in-component
  // listener (#1593) could not fire on the failing navigation (scripts-list ->
  // editor) because ScriptForm is unmounted on the list page. Guard that the
  // component does NOT re-introduce its own astro:before-swap monaco-colors
  // listener: with no global handler loaded in this jsdom test, a swap must
  // leave the incoming document untouched.
  it('does not own a before-swap monaco-colors listener (deferred to the global handler)', () => {
    render(<ScriptForm />);
    const live = document.createElement('style');
    live.className = 'monaco-colors';
    live.textContent = '.monaco-editor { color: #d4d4d4; }';
    document.head.appendChild(live);

    const newDocument = document.implementation.createHTMLDocument('');
    const event = Object.assign(new Event('astro:before-swap'), { newDocument });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(newDocument.head.querySelector('style.monaco-colors')).toBeNull();
  });

  // Build-mechanism guard: the cure must stay wired globally, not slip back into
  // this component where it can't see the list -> editor navigation. Invisible
  // to jsdom otherwise (the global script isn't loaded in unit tests).
  it('points the theme-preservation cure at the global Layout handler', () => {
    expect(scriptFormSource).toContain('monaco-theme-persist.js');
    expect(scriptFormSource).not.toMatch(/addEventListener\(\s*['"]astro:before-swap['"]/);
  });
});

describe('ScriptForm availability picker — partner-scope gate', () => {
  beforeEach(() => {
    editorInstances.length = 0;
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    orgStoreMock.mockReturnValue({
      organizations: [{ id: 'o-1', name: 'Org One' }, { id: 'o-2', name: 'Org Two' }],
      partners: [],
      sites: []
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the "Available to" picker for a partner-scope user creating a new script with >1 org', async () => {
    const { findByText } = render(<ScriptForm isNew />);
    expect(await findByText('Available to')).toBeTruthy();
  });

  it('hides the picker for an org-scope user even with >1 org — must not gate on the (empty) partners list', async () => {
    // A real partner user has partners=[] (the system-scope-only /orgs/partners 403s);
    // the OLD `partners.length > 0` gate hid the picker from partner users and is the bug.
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'o-1' });
    const { queryByText } = render(<ScriptForm isNew />);
    await waitFor(() => expect(editorInstances.length).toBeGreaterThan(0));
    expect(queryByText('Available to')).toBeNull();
  });

  it('hides the picker for a partner-scope user with a null partnerId — guards the `&& !!partnerId` half of the gate', async () => {
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: null, orgId: null });
    const { queryByText } = render(<ScriptForm isNew />);
    await waitFor(() => expect(editorInstances.length).toBeGreaterThan(0));
    expect(queryByText('Available to')).toBeNull();
  });

  it('hides the picker for a single-org partner user', async () => {
    orgStoreMock.mockReturnValue({
      organizations: [{ id: 'o-1', name: 'Org One' }],
      partners: [],
      sites: []
    });
    const { queryByText } = render(<ScriptForm isNew />);
    await waitFor(() => expect(editorInstances.length).toBeGreaterThan(0));
    expect(queryByText('Available to')).toBeNull();
  });

  // Re-scope on edit (issue #1734): the picker now also renders when EDITING,
  // so a partner-scope user can move a script org→org or promote it to All Orgs.
  it('shows the "Available to" picker when editing an existing script (partner scope, >1 org)', async () => {
    const { findByText } = render(<ScriptForm />);
    expect(await findByText('Available to')).toBeTruthy();
  });

  it('hides the re-scope picker when editing a system script', async () => {
    const { queryByText } = render(<ScriptForm isSystemScript />);
    await waitFor(() => expect(editorInstances.length).toBeGreaterThan(0));
    expect(queryByText('Available to')).toBeNull();
  });
});

// #3262: the server 403s partner-wide writes for partner users without
// org_access = 'all', so the picker must not offer (or default to) an option
// the save would reject. Capability rides on /users/me → auth store.
describe('ScriptForm availability picker — partner-wide capability gate (#3262)', () => {
  const baseUser = {
    id: 'u-1', email: 'tech@example.com', name: 'Selected Tech', mfaEnabled: true
  };

  beforeEach(() => {
    editorInstances.length = 0;
    getJwtClaimsMock.mockReturnValue({ scope: 'partner', partnerId: 'p-1', orgId: null });
    orgStoreMock.mockReturnValue({
      organizations: [{ id: 'o-1', name: 'Org One' }, { id: 'o-2', name: 'Org Two' }],
      partners: [],
      sites: []
    });
  });
  afterEach(() => {
    useAuthStore.setState({ user: null });
    vi.clearAllMocks();
  });

  it('disables "All my organizations" and defaults to a specific org for a selected-access user', async () => {
    useAuthStore.setState({ user: { ...baseUser, canManagePartnerWide: false } });
    const { findByText, getByLabelText } = render(<ScriptForm isNew />);
    await findByText('Available to');

    const partnerRadio = getByLabelText('All my organizations') as HTMLInputElement;
    const orgRadio = getByLabelText(/A specific organization/) as HTMLInputElement;
    expect(partnerRadio.disabled).toBe(true);
    expect(partnerRadio.checked).toBe(false);
    expect(orgRadio.checked).toBe(true);
    expect(await findByText(/Requires full partner org access/)).toBeTruthy();
  });

  it('keeps the partner-wide default enabled for a full-access user', async () => {
    useAuthStore.setState({ user: { ...baseUser, canManagePartnerWide: true } });
    const { findByText, getByLabelText, queryByText } = render(<ScriptForm isNew />);
    await findByText('Available to');

    const partnerRadio = getByLabelText('All my organizations') as HTMLInputElement;
    expect(partnerRadio.disabled).toBe(false);
    expect(partnerRadio.checked).toBe(true);
    expect(queryByText(/Requires full partner org access/)).toBeNull();
  });

  it('treats an absent capability field (pre-field session) as capable — server still enforces', async () => {
    useAuthStore.setState({ user: { ...baseUser } });
    const { findByText, getByLabelText } = render(<ScriptForm isNew />);
    await findByText('Available to');
    expect((getByLabelText('All my organizations') as HTMLInputElement).disabled).toBe(false);
  });

  it('warns that an existing partner-wide script is read-only for a selected-access user', async () => {
    useAuthStore.setState({ user: { ...baseUser, canManagePartnerWide: false } });
    const { findByText } = render(
      <ScriptForm defaultValues={{ availability: 'partner' }} />
    );
    await findByText('Available to');
    expect(await findByText(/Editing it requires full partner org access/)).toBeTruthy();
  });
});

// #3409 PR2: a `{{var.<key>}}` token the tenant has no variable for fails the
// device at dispatch, so the editor says so — but a key can legitimately be
// created after the script, so this must never gate the save.
describe('ScriptForm unknown-variable notice', () => {
  const tenantVariable = {
    id: 'tv-1',
    key: 'vendor_token',
    value: 'abc',
    isSecret: false,
    description: 'Vendor portal token',
    ownerScope: 'partner' as const,
    orgId: null,
    partnerId: 'p-1',
    version: 1,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };

  const draft = { name: 'Draft', category: 'Custom', language: 'powershell' as const };

  beforeEach(() => {
    editorInstances.length = 0;
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'o-1' });
    orgStoreMock.mockReturnValue({ organizations: [], partners: [], sites: [] });
    // Fresh Response per call: the form now issues several reads on mount
    // (tenant variables + the test runner's device list), and a shared
    // Response body can only be consumed once.
    fetchWithAuthMock.mockImplementation(async () =>
      new Response(JSON.stringify({ data: [tenantVariable] }), { status: 200 })
    );
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('warns — without blocking submit — when the content references an unknown key', async () => {
    const onSubmit = vi.fn();
    render(
      <ScriptForm isNew onSubmit={onSubmit} defaultValues={{ ...draft, content: 'echo {{var.ghost}}' }} />
    );

    const notice = await screen.findByTestId('script-variable-warning');
    expect(notice).toHaveTextContent(/ghost/);

    fireEvent.click(screen.getByRole('button', { name: /save script/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('does not warn on ${{var.x}} or on a {{org.name}} token from another namespace', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{ ...draft, content: '${{var.ghost}} and {{org.name}} and {{var.vendor_token}}' }}
      />
    );

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(editorInstances.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('script-variable-warning')).toBeNull();
  });

  it('stays silent when the variable list could not be loaded', async () => {
    fetchWithAuthMock.mockRejectedValue(new Error('offline'));
    render(<ScriptForm isNew defaultValues={{ ...draft, content: 'echo {{var.ghost}}' }} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(editorInstances.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('script-variable-warning')).toBeNull();
  });
});

// #3409 PR3: a parameter definition can be BOUND to a tenant variable, a device
// custom field or a built-in property instead of being asked for at run time.
describe('ScriptForm sourced parameters', () => {
  const variableRow = (key: string, description: string, isSecret: boolean) => ({
    id: `tv-${key}`,
    key,
    value: 'x',
    isSecret,
    description,
    ownerScope: 'partner' as const,
    orgId: null,
    partnerId: 'p-1',
    version: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  });

  const draft = { name: 'Draft', category: 'Custom', language: 'powershell' as const, content: 'echo hi' };

  beforeEach(() => {
    editorInstances.length = 0;
    getJwtClaimsMock.mockReturnValue({ scope: 'organization', partnerId: null, orgId: 'o-1' });
    orgStoreMock.mockReturnValue({ organizations: [], partners: [], sites: [] });
    fetchWithAuthMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            variableRow('vendor_token', 'Vendor portal token', false),
            variableRow('api_password', 'Vendor API password', true),
          ],
        }),
        { status: 200 }
      )
    );
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a legacy parameter (no `source`) on the runtime behaviour with no binding field', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{ ...draft, parameters: [{ name: 'message', type: 'string' }] }}
      />
    );

    const sourceSelect = await screen.findByLabelText('Source for parameter 1');
    expect((sourceSelect as HTMLSelectElement).value).toBe('runtime');
    expect(screen.queryByPlaceholderText('e.g. vendor_token')).toBeNull();
    expect(screen.getByText('Default Value')).toBeInTheDocument();
  });

  it('reveals the variable key picker when the row is switched to a variable source', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{ ...draft, parameters: [{ name: 'message', type: 'string' }] }}
      />
    );

    const sourceSelect = await screen.findByLabelText('Source for parameter 1');
    fireEvent.change(sourceSelect, { target: { value: 'tenantVariable' } });

    expect(screen.getByPlaceholderText('e.g. vendor_token')).toBeInTheDocument();
    // A bound parameter's default is a fallback, not a prefilled answer.
    expect(screen.getByText('Fallback value')).toBeInTheDocument();
  });

  it('stores the bare KEY when a variable is picked from the menu — never a {{var.x}} token', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [{ name: 'token', type: 'string', source: 'tenantVariable', variableKey: '' }],
        }}
      />
    );

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTitle('Choose a variable'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Vendor portal token/i }));

    const keyInput = screen.getByPlaceholderText('e.g. vendor_token') as HTMLInputElement;
    await waitFor(() => expect(keyInput.value).toBe('vendor_token'));
    expect(keyInput.value).not.toContain('{{');
  });

  it('offers secret variables as disabled rows in the key picker', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [{ name: 'token', type: 'string', source: 'tenantVariable', variableKey: '' }],
        }}
      />
    );

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTitle('Choose a variable'));
    expect(await screen.findByRole('menuitem', { name: /Vendor API password/i })).toBeDisabled();
  });

  it('warns before save when a binding targets a secret variable (the API 400s it)', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [
            { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_password' },
          ],
        }}
      />
    );

    const warning = await screen.findByTestId('script-parameter-secret-warning');
    expect(warning).toHaveTextContent(/api_password/);
    expect(warning).toHaveTextContent(/rejected/i);
  });

  it('gives every secret-bound row its own warning id so both announce', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [
            { name: 'first', type: 'string', source: 'tenantVariable', variableKey: 'api_password' },
            { name: 'second', type: 'string', source: 'tenantVariable', variableKey: 'api_password' },
          ],
        }}
      />
    );

    const warnings = await screen.findAllByTestId('script-parameter-secret-warning');
    expect(warnings).toHaveLength(2);
    const ids = warnings.map(w => w.id);
    expect(new Set(ids).size).toBe(2);
    // Each input points at its OWN paragraph — a shared id would silently drop one.
    const inputs = screen.getAllByPlaceholderText('e.g. vendor_token');
    expect(inputs.map(i => i.getAttribute('aria-describedby'))).toEqual(ids);
  });

  it('does not warn for a non-secret binding', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [
            { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'vendor_token' },
          ],
        }}
      />
    );

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(editorInstances.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('script-parameter-secret-warning')).toBeNull();
  });

  it('hides the run-time options list for a bound select parameter', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [{ name: 'env', type: 'select', options: 'a,b', source: 'builtin', builtinKey: 'org.name' }],
        }}
      />
    );

    await waitFor(() => expect(editorInstances.length).toBeGreaterThan(0));
    expect(screen.queryByPlaceholderText('option1, option2, option3')).toBeNull();
    // The built-in vocabulary comes from @breeze/shared, not a local copy.
    expect(screen.getByText('device.hostname')).toBeInTheDocument();
  });

  // #3409 PR4c-2: the fifth arm — a SECRET tenant variable, delivered to the
  // agent only as an environment variable.
  it('renders the secret binding field and its env-var hint, and hides value-bearing fields', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [{ name: 'api_token', source: 'tenantSecret', variableKey: 'api_password' }],
        }}
      />
    );

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const hint = await screen.findByTestId('script-parameter-secret-hint');
    expect(hint).toHaveTextContent('BREEZE_VAR_API_TOKEN');
    expect(screen.getByPlaceholderText('e.g. vendor_token')).toBeInTheDocument();
    // A secret parameter is always required, always a string, and can carry no
    // default — the API rejects any of those, so the form must not offer them.
    expect(screen.queryByPlaceholderText('Default')).toBeNull();
    expect(screen.queryByText('Required')).toBeNull();
    // The plain-mode "this is a secret, the save will be rejected" warning must
    // NOT fire here — a secret is exactly what this arm wants.
    expect(screen.queryByTestId('script-parameter-secret-warning')).toBeNull();
    expect(screen.queryByTestId('script-parameter-not-secret-warning')).toBeNull();
  });

  it('falls back to a placeholder env name while the parameter name is blank', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [{ name: '', source: 'tenantSecret', variableKey: '' }],
        }}
      />
    );

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(await screen.findByTestId('script-parameter-secret-hint')).toHaveTextContent('BREEZE_VAR_NAME');
  });

  it('warns when a secret parameter is bound to a variable that is NOT a secret', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [{ name: 'api_token', source: 'tenantSecret', variableKey: 'vendor_token' }],
        }}
      />
    );

    const warning = await screen.findByTestId('script-parameter-not-secret-warning');
    expect(warning).toHaveTextContent(/vendor_token/);
    expect(warning).toHaveTextContent(/not a secret/i);
  });

  it('inverts the picker in secret mode: secrets selectable, plain variables disabled', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [{ name: 'api_token', source: 'tenantSecret', variableKey: '' }],
        }}
      />
    );

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTitle('Choose a variable'));
    const plainRow = await screen.findByRole('menuitem', { name: /Vendor portal token/i });
    expect(plainRow).toBeDisabled();
    expect(plainRow).toHaveTextContent('Not a secret');

    const secretRow = await screen.findByRole('menuitem', { name: /Vendor API password/i });
    expect(secretRow).not.toBeDisabled();
    fireEvent.click(secretRow);
    const keyInput = screen.getByPlaceholderText('e.g. vendor_token') as HTMLInputElement;
    await waitFor(() => expect(keyInput.value).toBe('api_password'));
  });

  it('clears the abandoned key and the secret-only fields when switching off tenantSecret', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [{ name: 'api_token', source: 'tenantSecret', variableKey: 'api_password' }],
        }}
      />
    );

    await screen.findByTestId('script-parameter-secret-hint');
    fireEvent.change(screen.getByLabelText('Source for parameter 1'), {
      target: { value: 'tenantVariable' },
    });

    expect(screen.queryByTestId('script-parameter-secret-hint')).toBeNull();
    expect((screen.getByPlaceholderText('e.g. vendor_token') as HTMLInputElement).value).toBe('');
    // The value-bearing fields come back for a non-secret arm.
    expect(screen.getByPlaceholderText('Default')).toBeInTheDocument();
  });

  it('clears a runtime row\'s default and options when it becomes a secret parameter', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [{ name: 'api_token', type: 'select', defaultValue: 'a', options: 'a,b' }],
        }}
      />
    );

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Source for parameter 1'), {
      target: { value: 'tenantSecret' },
    });
    await screen.findByTestId('script-parameter-secret-hint');

    // Switching back proves the values were cleared rather than merely hidden —
    // a stray `defaultValue: 'a'` would 400 at save.
    fireEvent.change(screen.getByLabelText('Source for parameter 1'), {
      target: { value: 'runtime' },
    });
    expect((screen.getByPlaceholderText('Default') as HTMLInputElement).value).toBe('');
    // `type` is forced to `string` for a secret, so the options input (which only
    // renders for `select`) is gone — its stored value was cleared with it.
    expect(screen.queryByPlaceholderText('option1, option2, option3')).toBeNull();
  });

  it('submits a secret row without the seeded default/options the API would 400', async () => {
    const onSubmit = vi.fn();
    render(
      <ScriptForm
        isNew
        onSubmit={onSubmit}
        defaultValues={{ ...draft, parameters: [{ name: 'api_token', type: 'string' }] }}
      />
    );

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Source for parameter 1'), {
      target: { value: 'tenantSecret' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. vendor_token'), {
      target: { value: 'api_password' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save script/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].parameters[0]).toEqual({
      name: 'api_token',
      source: 'tenantSecret',
      variableKey: 'api_password',
      type: 'string',
      required: true,
    });
  });

  it('clears the previous arm\'s binding key when the source changes', async () => {
    render(
      <ScriptForm
        isNew
        defaultValues={{
          ...draft,
          parameters: [
            { name: 'token', type: 'string', source: 'tenantVariable', variableKey: 'api_password' },
          ],
        }}
      />
    );

    await screen.findByTestId('script-parameter-secret-warning');
    fireEvent.change(screen.getByLabelText('Source for parameter 1'), {
      target: { value: 'deviceCustomField' },
    });

    expect(screen.getByPlaceholderText('e.g. asset_tag')).toBeInTheDocument();
    // Switching back must not resurrect the abandoned (secret) key.
    fireEvent.change(screen.getByLabelText('Source for parameter 1'), {
      target: { value: 'tenantVariable' },
    });
    expect((screen.getByPlaceholderText('e.g. vendor_token') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('script-parameter-secret-warning')).toBeNull();
  });
});

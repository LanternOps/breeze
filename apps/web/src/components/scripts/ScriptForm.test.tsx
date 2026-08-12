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
    fetchWithAuthMock.mockResolvedValue(
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

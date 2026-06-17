import { render, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import ScriptForm from './ScriptForm';

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

  it('hides the picker when editing an existing script (not isNew)', async () => {
    const { queryByText } = render(<ScriptForm />);
    await waitFor(() => expect(editorInstances.length).toBeGreaterThan(0));
    expect(queryByText('Available to')).toBeNull();
  });
});

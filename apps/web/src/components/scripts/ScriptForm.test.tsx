import { render, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});

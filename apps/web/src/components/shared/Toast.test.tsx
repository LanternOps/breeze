import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ToastContainer, { showToast, _resetToastQueueForTests } from './Toast';

describe('ToastContainer', () => {
  beforeEach(() => {
    _resetToastQueueForTests();
  });

  afterEach(() => {
    _resetToastQueueForTests();
  });

  it('renders an error toast with role=alert and aria-live=assertive so screen readers and Playwright role-selectors find it', () => {
    render(<ToastContainer />);

    act(() => {
      showToast({ type: 'error', message: 'NO_MACS: no MAC on file' });
    });

    const toast = screen.getByTestId('toast');
    expect(toast).toHaveAttribute('role', 'alert');
    expect(toast).toHaveAttribute('aria-live', 'assertive');
    expect(toast).toHaveAttribute('data-toast-type', 'error');
    expect(toast).toHaveTextContent('NO_MACS: no MAC on file');

    expect(screen.getByRole('alert')).toBe(toast);
  });

  it('renders a success toast with role=status and aria-live=polite', () => {
    render(<ToastContainer />);

    act(() => {
      showToast({ type: 'success', message: 'Wake packet sent' });
    });

    const toast = screen.getByTestId('toast');
    expect(toast).toHaveAttribute('role', 'status');
    expect(toast).toHaveAttribute('aria-live', 'polite');
    expect(toast).toHaveAttribute('data-toast-type', 'success');
    expect(toast).toHaveTextContent('Wake packet sent');
  });

  it('renders an undo toast with role=status and exposes the Undo button', () => {
    render(<ToastContainer />);
    const onUndo = vi.fn();

    act(() => {
      showToast({ type: 'undo', message: 'Decommissioning...', onUndo });
    });

    const toast = screen.getByTestId('toast');
    expect(toast).toHaveAttribute('role', 'status');
    expect(toast).toHaveAttribute('data-toast-type', 'undo');

    const undoBtn = screen.getByRole('button', { name: /undo/i });
    expect(undoBtn).toBeInTheDocument();
  });

  it('flushes toasts queued before the container mounts (avoids silent-drop on early showToast calls)', async () => {
    // showToast called before any ToastContainer is mounted — the existing
    // production failure mode was that this silently no-op'd. The queue
    // change must surface the toast as soon as the container appears.
    showToast({ type: 'error', message: 'queued-error-message' });
    showToast({ type: 'success', message: 'queued-success-message' });

    render(<ToastContainer />);

    await waitFor(() => {
      const toasts = screen.getAllByTestId('toast');
      expect(toasts).toHaveLength(2);
    });

    expect(screen.getByText('queued-error-message')).toBeInTheDocument();
    expect(screen.getByText('queued-success-message')).toBeInTheDocument();
  });

  it('survives an unmount/remount cycle without losing toasts emitted in the gap', async () => {
    const { unmount } = render(<ToastContainer />);

    unmount();

    // Emit a toast while no container is mounted (e.g., between Astro view
    // transitions). It must land when the next container mounts.
    showToast({ type: 'error', message: 'between-mounts-message' });

    render(<ToastContainer />);

    await waitFor(() => {
      expect(screen.getByText('between-mounts-message')).toBeInTheDocument();
    });
    expect(screen.getByTestId('toast')).toHaveAttribute('role', 'alert');
  });

  it('with two mounted containers, a pre-mount queued toast lands in exactly one and the survivor keeps its registration after the other unmounts', async () => {
    // Model the Astro island duplication / view-transition overlap case:
    // a toast is queued before any container exists, then two containers
    // mount, then the older one unmounts. The newer container's
    // registration must survive.
    showToast({ type: 'error', message: 'pre-mount-queued' });

    const first = render(<ToastContainer />);
    const second = render(<ToastContainer />);

    // The pre-mount queued toast lands in exactly one container (the first
    // to mount drains the shared queue via splice).
    await waitFor(() => {
      const allToasts = screen.getAllByTestId('toast');
      expect(allToasts).toHaveLength(1);
      expect(allToasts[0]).toHaveTextContent('pre-mount-queued');
    });

    // Unmount the older container. Under the old cleanup (unconditional
    // null), this would clobber the second container's registration and
    // subsequent showToast calls would silently queue instead of render.
    first.unmount();

    act(() => {
      showToast({ type: 'success', message: 'after-first-unmount' });
    });

    await waitFor(() => {
      expect(
        within(second.container).getByText('after-first-unmount')
      ).toBeInTheDocument();
    });
  });

  it('with two containers both mounted, a single live showToast renders exactly one toast (#1301 duplicate-island symptom)', async () => {
    // The closest runtime analog of the #1301 "×2 toast" report: two
    // ToastContainers simultaneously mounted/registered (the Astro island
    // duplication / view-transition overlap case), then a SINGLE live
    // showToast call. The single module-level emitter slot means the second
    // mount overwrote the first's registration, so only one container renders
    // the toast — a single emit must produce exactly one DOM toast, never two.
    // (The pre-mount-queue test above exercises the splice-drain path; this
    // one exercises the live-emit path through addToastFn.)
    render(<ToastContainer />);
    render(<ToastContainer />);

    act(() => {
      showToast({ type: 'success', message: 'single-live-emit' });
    });

    await waitFor(() => {
      expect(screen.getByText('single-live-emit')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
  });

  it('renders a warning toast with role=status and the correct data-toast-type', () => {
    render(<ToastContainer />);

    act(() => {
      showToast({ type: 'warning', message: 'heads up' });
    });

    const toast = screen.getByTestId('toast');
    expect(toast).toHaveAttribute('data-toast-type', 'warning');
    // The triangle icon is the only visual cue distinguishing warning from success.
    expect(toast.querySelector('svg.lucide-triangle-alert, svg.lucide-alert-triangle')).not.toBeNull();
    expect(toast).toHaveAttribute('role', 'status');
    expect(toast).toHaveTextContent('heads up');
  });

  it('auto-dismisses after the default 5000ms', async () => {
    vi.useFakeTimers();
    try {
      render(<ToastContainer />);

      act(() => {
        showToast({ type: 'success', message: 'self-dismissing' });
      });

      expect(screen.getByTestId('toast')).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(screen.queryByTestId('toast')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // These two run LAST on purpose: they call vi.resetModules(), which perturbs the
  // module registry for the remainder of the file. Keeping them at the end means
  // no other case can inherit a re-evaluated module copy.
  it('delivers a toast when showToast and ToastContainer come from DUPLICATED copies of this module (#2014 Astro-island module graphs)', async () => {
    // Reproduces the dev-server failure mode directly: `vi.resetModules()` clears
    // the module registry, so the dynamic import below re-evaluates Toast.tsx and
    // hands back a genuinely separate module instance — the same split Astro 7 /
    // Vite 8 dev produces when two islands each get their own module graph.
    // Pre-fix, the container registered into copy B's module-scope `addToastFn`
    // while showToast pushed into copy A's `pendingToasts`, and nothing ever
    // drained it: the toast was silently swallowed. The globalThis-keyed bus makes
    // both copies talk to the same emitter slot.
    vi.resetModules();
    const duplicate = await import('./Toast');

    // Guard the guard: if the re-import ever starts returning the cached instance
    // this test would pass vacuously and stop protecting anything.
    expect(duplicate.default).not.toBe(ToastContainer);

    const DuplicatedContainer = duplicate.default;
    render(<DuplicatedContainer />);

    act(() => {
      // Emitter from the ORIGINAL copy; container from the duplicate.
      showToast({ type: 'success', message: 'cross-module-emit' });
    });

    await waitFor(() => {
      expect(screen.getByText('cross-module-emit')).toBeInTheDocument();
    });
    expect(screen.getAllByTestId('toast')).toHaveLength(1);

    // The duplicate's reset must clear the same shared bus the original sees.
    duplicate._resetToastQueueForTests();
  });

  it('drains a pre-mount queued toast across duplicated module copies (#2014 queue half of the split)', async () => {
    // The other half of the same split: the toast is queued BEFORE any container
    // exists, then the container mounts from a different module copy. Pre-fix the
    // queue and the drain lived in two different arrays, so the drain found
    // nothing.
    showToast({ type: 'error', message: 'queued-across-copies' });

    vi.resetModules();
    const duplicate = await import('./Toast');
    const DuplicatedContainer = duplicate.default;

    render(<DuplicatedContainer />);

    await waitFor(() => {
      expect(screen.getByText('queued-across-copies')).toBeInTheDocument();
    });
    expect(screen.getByTestId('toast')).toHaveAttribute('role', 'alert');

    duplicate._resetToastQueueForTests();
  });
});

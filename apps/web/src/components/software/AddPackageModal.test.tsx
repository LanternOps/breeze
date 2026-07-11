import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AddPackageModal from './AddPackageModal';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

// DetectionRulesEditor is exercised elsewhere; it lives behind the Advanced
// disclosure and isn't needed for the create-flow assertions here.
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

/** Route mock keyed by URL + method so effect-order doesn't matter. */
function routeMock(handlers: {
  customFields?: unknown;
  createCatalog?: () => Response;
  createVersion?: () => Response;
}) {
  fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
    if (url.startsWith('/custom-fields')) {
      return Promise.resolve(jsonResponse({ data: handlers.customFields ?? [] }));
    }
    if (url === '/software/catalog' && opts?.method === 'POST') {
      return Promise.resolve((handlers.createCatalog ?? (() => jsonResponse({ data: { id: 'cat-1' } })))());
    }
    if (/\/software\/catalog\/.+\/versions$/.test(url) && opts?.method === 'POST') {
      return Promise.resolve((handlers.createVersion ?? (() => jsonResponse({ data: { id: 'ver-1' } })))());
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
}

const fillMinimum = () => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Google Chrome' } });
  fireEvent.change(screen.getByLabelText('Version'), { target: { value: '1.0.0' } });
  fireEvent.change(screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi'), {
    target: { value: 'https://dl.example.com/chrome.msi' },
  });
};

describe('AddPackageModal', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    showToast.mockReset();
  });

  it('keeps Create disabled until name, version and a source are present', async () => {
    routeMock({});
    render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

    const submit = screen.getByRole('button', { name: 'Create package' });
    expect(submit).toBeDisabled();

    fillMinimum();
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it('creates the catalog item then its first version and reports the new package', async () => {
    const onCreated = vi.fn();
    routeMock({});
    render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);

    fillMinimum();
    fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

    const catalogCall = fetchMock.mock.calls.find(([u, o]) => u === '/software/catalog' && o?.method === 'POST');
    const versionCall = fetchMock.mock.calls.find(([u, o]) => /\/versions$/.test(u as string) && o?.method === 'POST');
    expect(catalogCall).toBeTruthy();
    expect(versionCall).toBeTruthy();

    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cat-1', name: 'Google Chrome', versionCount: 1 }),
    );
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('blocks submit when the URL contains an unknown variable', async () => {
    routeMock({});
    render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'App' } });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2.0' } });
    fireEvent.change(screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi'), {
      target: { value: 'https://dl/{{org.bogus}}/app.msi' },
    });

    expect(await screen.findByText(/Unknown variable/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create package' })).toBeDisabled();
  });

  it('on version-write failure keeps the created catalog id and retries only the version step', async () => {
    const onCreated = vi.fn();
    let versionAttempts = 0;
    routeMock({
      createVersion: () => {
        versionAttempts += 1;
        return versionAttempts === 1
          ? jsonResponse({ error: 'boom' }, false, 500)
          : jsonResponse({ data: { id: 'ver-1' } });
      },
    });
    render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);

    fillMinimum();
    fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));

    // First attempt fails on the version write; onCreated must NOT fire and the
    // button flips to a retry label.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry adding version' })).toBeInTheDocument(),
    );
    expect(onCreated).not.toHaveBeenCalled();

    // Retry: succeeds, and the catalog item is NOT created a second time.
    fireEvent.click(screen.getByRole('button', { name: 'Retry adding version' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

    const catalogPosts = fetchMock.mock.calls.filter(
      ([u, o]) => u === '/software/catalog' && o?.method === 'POST',
    );
    expect(catalogPosts).toHaveLength(1);
    expect(versionAttempts).toBe(2);
  });

  it('surfaces the created package (0 versions) if the user cancels after a version-write failure', async () => {
    const onCreated = vi.fn();
    routeMock({ createVersion: () => jsonResponse({ error: 'boom' }, false, 500) });
    render(<AddPackageModal open onClose={() => {}} onCreated={onCreated} />);

    fillMinimum();
    fireEvent.click(await screen.findByRole('button', { name: 'Create package' }));

    // Version write failed → button flips to retry, catalog id retained.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry adding version' })).toBeInTheDocument(),
    );

    // Cancelling now must NOT leave an invisible orphan — the created package is
    // surfaced with versionCount 0 so it appears in the catalog.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cat-1', name: 'Google Chrome', versionCount: 0 }),
    );
  });
});

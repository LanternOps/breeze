import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import '@/lib/i18n';

// Stub the transport — mirrors the idiom in ScriptForm.test.tsx: keep the real
// store (default unauthenticated state is fine here) and swap only the fetch.
const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));

vi.mock('@/stores/auth', async () => {
  const actual = await vi.importActual<typeof import('@/stores/auth')>('@/stores/auth');
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

import { ScriptBundleImportModal } from './ScriptBundleImport';

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const bundleJson = JSON.stringify({
  bundleVersion: 1,
  scripts: [
    { name: 'legacy-script', osTypes: ['linux'], language: 'bash', content: 'echo hi' }
  ]
});

/** Upload the fixed one-script bundle above via the hidden file input. */
async function uploadBundle() {
  const file = new File([bundleJson], 'bundle.json', { type: 'application/json' });
  const input = screen.getByTestId('bundle-import-file-input');
  fireEvent.change(input, { target: { files: [file] } });
  // Uploading triggers a preview request first.
  await screen.findByTestId('bundle-import-mode');
}

describe('ScriptBundleImportModal legacy tagging (#5654)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/scripts/bundle/preview')) {
        return makeJsonResponse({ entries: [{ index: 0, name: 'legacy-script', status: 'new' }] });
      }
      if (url.includes('/scripts/bundle/import')) {
        return makeJsonResponse({ imported: 1, skipped: 0, renamed: 0, versioned: 0, errors: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  });

  it('renders the "Tag as legacy import" checkbox unchecked by default', async () => {
    render(<ScriptBundleImportModal isOpen onClose={vi.fn()} onImported={vi.fn()} />);
    await uploadBundle();
    const checkbox = screen.getByTestId('bundle-import-tag-legacy') as HTMLInputElement;
    expect(checkbox).not.toBeChecked();
  });

  it('sends NO tags key when the checkbox is left unchecked', async () => {
    render(<ScriptBundleImportModal isOpen onClose={vi.fn()} onImported={vi.fn()} />);
    await uploadBundle();
    fireEvent.click(screen.getByTestId('bundle-import-submit'));

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/scripts/bundle/import',
        expect.anything()
      )
    );
    const importCall = fetchWithAuthMock.mock.calls.find(([url]) => url === '/scripts/bundle/import');
    const body = JSON.parse(importCall![1].body as string);
    expect(body).not.toHaveProperty('tags');
  });

  it('sends tags: ["legacy-import"] when the checkbox is checked', async () => {
    render(<ScriptBundleImportModal isOpen onClose={vi.fn()} onImported={vi.fn()} />);
    await uploadBundle();
    fireEvent.click(screen.getByTestId('bundle-import-tag-legacy'));
    fireEvent.click(screen.getByTestId('bundle-import-submit'));

    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/scripts/bundle/import',
        expect.anything()
      )
    );
    const importCall = fetchWithAuthMock.mock.calls.find(([url]) => url === '/scripts/bundle/import');
    const body = JSON.parse(importCall![1].body as string);
    expect(body.tags).toEqual(['legacy-import']);
  });

  it('shows a one-line hint under the checkbox', async () => {
    render(<ScriptBundleImportModal isOpen onClose={vi.fn()} onImported={vi.fn()} />);
    await uploadBundle();
    expect(screen.getByText(/legacy-import tag/i)).toBeInTheDocument();
  });
});

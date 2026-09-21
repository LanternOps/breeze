import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import { ScriptBundleImportModal } from './ScriptBundleImport';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { user: { canManagePartnerWide: boolean } }) => unknown) =>
    sel({ user: { canManagePartnerWide: false } })
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToastMock(a) }));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    (sel: (s: { currentOrgId: string | null }) => unknown) => sel({ currentOrgId: 'org-1' }),
    { getState: () => ({ currentOrgId: 'org-1', organizations: [] }) }
  )
}));

vi.mock('@/lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'organization', partnerId: null })
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const navigateToMock = vi.mocked(navigateTo);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

async function pickLooseFile(name = 'Move-CoveStorage.ps1') {
  const file = new File(['Write-Host hi'], name, { type: 'text/plain' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve('Write-Host hi') });
  const input = screen.getByTestId('bundle-import-file-input');
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByTestId('bundle-import-submit');
  await waitFor(() => expect(screen.getByTestId('bundle-import-submit')).not.toBeDisabled());
}

describe('ScriptBundleImportModal — post-import success screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/scripts/bundle/preview') {
        return jsonResponse({ entries: [{ index: 0, name: 'Move-CoveStorage', status: 'new' }] });
      }
      if (url === '/scripts/bundle/import' && init?.method === 'POST') {
        return jsonResponse({
          imported: 1,
          skipped: 0,
          renamed: 0,
          versioned: 0,
          errors: [],
          scripts: [{ index: 0, name: 'Move-CoveStorage', action: 'imported', scriptId: 'script-9' }]
        });
      }
      return jsonResponse({}, false, 404);
    });
  });

  it('replaces the picker with a success panel listing the imported script, and Open navigates to it', async () => {
    render(<ScriptBundleImportModal isOpen onClose={vi.fn()} onImported={vi.fn()} />);
    await pickLooseFile();

    fireEvent.click(screen.getByTestId('bundle-import-submit'));

    const panel = await screen.findByTestId('bundle-import-result');
    expect(panel).toHaveTextContent('Import complete');
    expect(panel).toHaveTextContent('Move-CoveStorage');
    // The file picker and the SYSTEM warning belong to the intake step only.
    expect(screen.queryByTestId('bundle-import-choose-files')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bundle-import-system-warning')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('bundle-import-open-script'));
    expect(navigateToMock).toHaveBeenCalledWith('/scripts/script-9');
  });

  it('shows a per-script Open link for every written script when more than one was imported', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/scripts/bundle/preview') {
        return jsonResponse({ entries: [{ index: 0, name: 'A', status: 'new' }] });
      }
      if (url === '/scripts/bundle/import' && init?.method === 'POST') {
        return jsonResponse({
          imported: 1,
          skipped: 1,
          renamed: 1,
          versioned: 0,
          errors: [],
          scripts: [
            { index: 0, name: 'A', action: 'imported', scriptId: 's-a' },
            { index: 1, name: 'B', action: 'renamed', finalName: 'B (2)', scriptId: 's-b' },
            { index: 2, name: 'C', action: 'skipped', scriptId: 's-c' }
          ]
        });
      }
      return jsonResponse({}, false, 404);
    });
    render(<ScriptBundleImportModal isOpen onClose={vi.fn()} onImported={vi.fn()} />);
    await pickLooseFile('A.ps1');
    fireEvent.click(screen.getByTestId('bundle-import-submit'));

    await screen.findByTestId('bundle-import-result');
    // Skipped entries wrote nothing — no link for them; no single "Open script" CTA either.
    expect(screen.queryByTestId('bundle-import-open-script')).not.toBeInTheDocument();
    const rows = screen.getAllByTestId('bundle-import-result-row');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('B (2)');
    fireEvent.click(screen.getByTestId('bundle-import-result-open-s-b'));
    expect(navigateToMock).toHaveBeenCalledWith('/scripts/s-b');
  });
});

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
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/scripts/bundle/preview')) {
        return jsonResponse({ entries: [{ index: 0, name: 'legacy-script', status: 'new' }] });
      }
      if (url.includes('/scripts/bundle/import')) {
        return jsonResponse({ imported: 1, skipped: 0, renamed: 0, versioned: 0, errors: [] });
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
    const body = JSON.parse(importCall![1]!.body as string);
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
    const body = JSON.parse(importCall![1]!.body as string);
    expect(body.tags).toEqual(['legacy-import']);
  });

  it('shows a one-line hint under the checkbox', async () => {
    render(<ScriptBundleImportModal isOpen onClose={vi.fn()} onImported={vi.fn()} />);
    await uploadBundle();
    expect(screen.getByText(/legacy-import tag/i)).toBeInTheDocument();
  });
});

describe('ScriptBundleImportModal import button pluralization (sweep paper cut #20)', () => {
  it('says "Import 1 script" (singular) for a one-script bundle', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/scripts/bundle/preview')) {
        return jsonResponse({ entries: [{ index: 0, name: 'legacy-script', status: 'new' }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    render(<ScriptBundleImportModal isOpen onClose={vi.fn()} onImported={vi.fn()} />);
    await uploadBundle();
    // Exact match: `toHaveTextContent('Import 1 script')` would also pass
    // against the buggy "Import 1 scripts" (substring match), which is
    // exactly the bug this test exists to catch.
    expect(screen.getByTestId('bundle-import-submit')).toHaveTextContent('Import 1 script', {
      normalizeWhitespace: true
    });
    expect(screen.getByTestId('bundle-import-submit').textContent?.trim()).toBe('Import 1 script');
  });

  it('says "Import 2 scripts" (plural) for a two-script bundle', async () => {
    const twoScriptBundle = JSON.stringify({
      bundleVersion: 1,
      scripts: [
        { name: 'legacy-script-a', osTypes: ['linux'], language: 'bash', content: 'echo a' },
        { name: 'legacy-script-b', osTypes: ['linux'], language: 'bash', content: 'echo b' }
      ]
    });
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/scripts/bundle/preview')) {
        return jsonResponse({
          entries: [
            { index: 0, name: 'legacy-script-a', status: 'new' },
            { index: 1, name: 'legacy-script-b', status: 'new' }
          ]
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    render(<ScriptBundleImportModal isOpen onClose={vi.fn()} onImported={vi.fn()} />);
    const file = new File([twoScriptBundle], 'bundle.json', { type: 'application/json' });
    fireEvent.change(screen.getByTestId('bundle-import-file-input'), { target: { files: [file] } });
    await screen.findByTestId('bundle-import-mode');
    expect(screen.getByTestId('bundle-import-submit')).toHaveTextContent('Import 2 scripts');
  });
});

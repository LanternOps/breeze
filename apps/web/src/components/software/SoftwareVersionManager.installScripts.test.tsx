/**
 * #6958 PR D: install-script awareness in the version manager.
 * - A version whose stored scripts are not enabled shows the inactive notice.
 * - A Breeze-pinned built-in opens read-only (no add/edit/promote).
 * (The add-version form's script fields and zip support: #10037,
 *  SoftwareVersionManager.scriptFields.test.tsx.)
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SoftwareVersionManager from './SoftwareVersionManager';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);
const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const base = { releaseDate: '2026-01-01T00:00:00Z', architecture: 'x64', isLatest: false };
const VERSIONS = [
  { ...base, id: 'v-dormant', version: '1.0.0', fileType: 'exe', preInstallScript: 'echo hi', postInstallScript: null, installScriptsEnabled: false },
  { ...base, id: 'v-active', version: '1.1.0', fileType: 'zip', preInstallScript: null, postInstallScript: 'x', installScriptsEnabled: true, isLatest: true },
  { ...base, id: 'v-none', version: '0.9.0', fileType: 'msi', preInstallScript: null, postInstallScript: null, installScriptsEnabled: false },
];

function serve(versions: unknown[]) {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).startsWith('/custom-fields')) return Promise.resolve(jsonResponse({ data: [] }));
    return Promise.resolve(jsonResponse({ data: versions }));
  });
}

async function renderLoaded(props: { builtinReadOnly?: boolean } = {}) {
  render(<SoftwareVersionManager catalogId="cat-1" embedded {...props} />);
  await waitFor(() => expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument());
}

describe('SoftwareVersionManager install scripts (#6958)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    serve(VERSIONS);
  });

  it('flags only a version whose stored scripts are inactive', async () => {
    await renderLoaded();
    expect(await screen.findByTestId('inactive-scripts-v-dormant')).toHaveTextContent(
      'Stored install scripts are not active; re-create the version to activate them.',
    );
    expect(screen.queryByTestId('inactive-scripts-v-active')).toBeNull();
    expect(screen.queryByTestId('inactive-scripts-v-none')).toBeNull();
  });

  it('a built-in package is read-only: no add, edit or promote controls, with a notice', async () => {
    await renderLoaded({ builtinReadOnly: true });
    expect(await screen.findByTestId('builtin-versions-readonly')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add version/i })).toBeNull();
    expect(screen.queryByTestId('version-edit-v-active')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('an ordinary package keeps its add, edit and promote controls', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: /add version/i })).toBeInTheDocument();
    expect(screen.getByTestId('version-edit-v-active')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').length).toBe(3);
  });
});

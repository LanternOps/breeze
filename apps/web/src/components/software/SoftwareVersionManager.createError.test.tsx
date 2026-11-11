/**
 * A rejected create must not unmount the version form (the error panel is for
 * LOAD failures only), and the generic silent-args prefill must not run for a
 * built-in integration package (server default template applies when blank).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SoftwareVersionManager from './SoftwareVersionManager';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const REJECTION = 'Install arguments for SentinelOne Agent must include {s1_site_token}';

const urlInput = () =>
  screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi');

async function renderLoaded(props: Record<string, unknown> = {}) {
  render(<SoftwareVersionManager catalogId="cat-1" embedded {...props} />);
  await waitFor(() =>
    expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: /add version/i }));
}

describe('SoftwareVersionManager create error with zero versions', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (/\/versions$/.test(String(url)) && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ error: REJECTION }, false, 400));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    });
  });

  it('keeps the form and typed input, showing the error inline', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByPlaceholderText('e.g. 1.0.0'), { target: { value: '25.1.1' } });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/agent.exe' } });
    fireEvent.submit(urlInput().closest('form')!);

    await waitFor(() => expect(screen.getByText(REJECTION)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(urlInput()).toHaveValue('https://cdn.example/agent.exe');
  });

  it('still shows the Try again panel when the versions LOAD fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).startsWith('/custom-fields')) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      return Promise.reject(new Error('network down'));
    });
    render(<SoftwareVersionManager catalogId="cat-1" embedded />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('SoftwareVersionManager silent-args prefill', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
  });

  it('leaves args empty for a built-in integration package', async () => {
    await renderLoaded({ integrationProvider: 'sentinelone' });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/agent.msi' } });
    await waitFor(() => expect(urlInput()).toHaveValue('https://cdn.example/agent.msi'));
    expect(screen.queryByDisplayValue('msiexec /i "{file}" /qn /norestart')).toBeNull();
    expect(screen.getByTestId('builtin-args-default')).toBeInTheDocument();
  });

  it('still prefills for an ordinary package', async () => {
    await renderLoaded();
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/agent.msi' } });
    await waitFor(() =>
      expect(screen.getByDisplayValue('msiexec /i "{file}" /qn /norestart')).toBeTruthy(),
    );
  });
});

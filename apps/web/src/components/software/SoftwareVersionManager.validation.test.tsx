/**
 * #11606: Save on a blank Add Version form must give feedback (inline message,
 * aria-invalid, focus on the first invalid field) instead of silently no-op'ing,
 * and a malformed download URL must be caught before any request is sent.
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

const versionInput = () => screen.getByPlaceholderText('e.g. 1.0.0');
const urlInput = () => screen.getByPlaceholderText('https://example.com/package-v1.0.0.msi');
const posts = () =>
  fetchMock.mock.calls.filter(([, o]) => (o as RequestInit | undefined)?.method === 'POST');

async function openForm() {
  render(<SoftwareVersionManager catalogId="cat-1" embedded />);
  await waitFor(() =>
    expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: /add version/i }));
}

describe('SoftwareVersionManager Add Version validation (#11606)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: [] })));
  });

  it('blank submit shows an inline version error, marks it invalid, focuses it, sends nothing', async () => {
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: /save version/i }));

    expect(await screen.findByText(/version is required/i)).toBeInTheDocument();
    expect(versionInput()).toHaveAttribute('aria-invalid', 'true');
    expect(versionInput()).toHaveFocus();
    expect(posts()).toHaveLength(0);
  });

  it('clears the version error once the user types', async () => {
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: /save version/i }));
    await screen.findByText(/version is required/i);
    fireEvent.change(versionInput(), { target: { value: '1.0.0' } });
    expect(screen.queryByText(/version is required/i)).not.toBeInTheDocument();
    expect(versionInput()).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('rejects a malformed download URL before submit', async () => {
    await openForm();
    fireEvent.change(versionInput(), { target: { value: '1.0.0' } });
    fireEvent.change(urlInput(), { target: { value: 'not a url' } });
    fireEvent.click(screen.getByRole('button', { name: /save version/i }));

    expect(await screen.findByText(/valid http\(s\) url/i)).toBeInTheDocument();
    expect(urlInput()).toHaveAttribute('aria-invalid', 'true');
    expect(posts()).toHaveLength(0);
  });

  it('still accepts a URL carrying a {{variable}} token', async () => {
    await openForm();
    fireEvent.change(versionInput(), { target: { value: '1.0.0' } });
    fireEvent.change(urlInput(), { target: { value: 'https://cdn.example/{{org.name}}/a.msi' } });
    fireEvent.click(screen.getByRole('button', { name: /save version/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(screen.queryByText(/valid http\(s\) url/i)).not.toBeInTheDocument();
  });
});

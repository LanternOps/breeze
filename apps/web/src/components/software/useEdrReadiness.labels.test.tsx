import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEdrReadiness } from './useEdrReadiness';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function LabelProbe({ versions }: { versions: number }) {
  const r = useEdrReadiness(['sentinelone'], { s1VersionCount: versions }).sentinelone;
  return (
    <span data-testid="label">
      {r.checks.find((c) => c.key === 'installerUploaded')?.label}
    </span>
  );
}

describe('SentinelOne installer readiness check label', () => {
  beforeEach(() => fetchMock.mockReset());

  it('words the pending step as a to-do, not as done', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { isActive: true } }));
    render(<LabelProbe versions={0} />);
    await waitFor(() =>
      expect(screen.getByTestId('label')).toHaveTextContent('Upload the installer'),
    );
  });

  it('keeps "Installer uploaded" once a version exists', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { isActive: true } }));
    render(<LabelProbe versions={1} />);
    await waitFor(() =>
      expect(screen.getByTestId('label')).toHaveTextContent('Installer uploaded'),
    );
  });
});

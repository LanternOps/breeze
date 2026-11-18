/**
 * The "{{org.name}}" code chip sits between two translated fragments; the
 * fragments carry no edge whitespace, so the components must render the spaces.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AddPackageModal from './AddPackageModal';
import SoftwareVersionManager from './SoftwareVersionManager';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));
vi.mock('../../lib/softwarePackageUpload', () => ({ uploadPackageVersion: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./DetectionRulesEditor', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);

const helpParagraph = () => {
  const code = screen.getAllByText('{{org.name}}').find((el) => el.tagName === 'CODE')!;
  return code.parentElement!.textContent ?? '';
};

describe('{{org.name}} help text spacing', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    } as unknown as Response);
  });

  it('AddPackageModal puts a space on both sides of the chip', () => {
    render(<AddPackageModal open onClose={() => {}} onCreated={() => {}} />);
    expect(helpParagraph()).toMatch(/like \{\{org\.name\}\} —/);
  });

  it('SoftwareVersionManager puts a space on both sides of the chip', async () => {
    render(<SoftwareVersionManager catalogId="cat-1" embedded />);
    await waitFor(() =>
      expect(screen.queryByText(/loading software versions/i)).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: /add version/i }));
    expect(helpParagraph()).toMatch(/like \{\{org\.name\}\} resolve/);
  });
});


import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ArchiveOrgModal from './ArchiveOrgModal';
import MergeOrgModal from './MergeOrgModal';
import type { Organization } from './organizationTypes';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG: Organization = {
  id: 'org-1111-1111-1111-111111111111',
  name: 'Acme Corp',
  status: 'active',
  deviceCount: 5,
  createdAt: '2026-01-01T00:00:00Z',
};

const SURVIVOR: Organization = {
  id: 'org-2222-2222-2222-222222222222',
  name: 'Acme Holdings',
  status: 'active',
  deviceCount: 40,
  createdAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe('ArchiveOrgModal — dialog semantics', () => {
  it('renders as a modal dialog named by its heading and closes on Escape', () => {
    const onClose = vi.fn();
    render(<ArchiveOrgModal org={ORG} onClose={onClose} onArchived={vi.fn()} onDoneClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Archive organization' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MergeOrgModal — dialog semantics', () => {
  it('renders as a modal dialog named by its heading and closes on Escape in the pick phase', () => {
    const onClose = vi.fn();
    render(
      <MergeOrgModal loserOrg={ORG} orgs={[ORG, SURVIVOR]} onClose={onClose} onMerged={vi.fn()} onDoneClose={vi.fn()} />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Merge organization' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

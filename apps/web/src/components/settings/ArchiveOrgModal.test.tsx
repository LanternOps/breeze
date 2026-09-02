import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ArchiveOrgModal from './ArchiveOrgModal';
import type { Organization } from './OrganizationList';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const sessionExpiredMock = vi.mocked(handleSessionExpired);
const toastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ORG: Organization = {
  id: 'org-1111-1111-1111-111111111111',
  name: 'Acme Corp',
  status: 'active',
  deviceCount: 5,
  createdAt: '2026-01-01T00:00:00Z',
};

interface ArchiveResponse {
  payload: unknown;
  status?: number;
}

function routeFetch(handlers: { archive?: (body: unknown) => ArchiveResponse }) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && /\/organizations\/[^/]+\/archive$/.test(url)) {
      const body = JSON.parse(String(init.body));
      const { payload, status = 202 } =
        handlers.archive?.(body) ?? { payload: { status: 'offboarding', purgeAt: '2026-11-24T00:00:00.000Z' } };
      return jsonResponse(payload, status < 400, status);
    }
    return jsonResponse({});
  });
}

function renderModal(overrides?: Partial<{ onClose: () => void; onArchived: (id: string) => void; onDoneClose: () => void }>) {
  const onClose = overrides?.onClose ?? vi.fn();
  const onArchived = overrides?.onArchived ?? vi.fn();
  const onDoneClose = overrides?.onDoneClose ?? vi.fn();
  render(<ArchiveOrgModal org={ORG} onClose={onClose} onArchived={onArchived} onDoneClose={onDoneClose} />);
  return { onClose, onArchived, onDoneClose };
}

beforeEach(() => {
  fetchMock.mockReset();
  sessionExpiredMock.mockReset();
  toastMock.mockReset();
});

describe('ArchiveOrgModal — retention picker', () => {
  it('defaults to the 90-day option', () => {
    renderModal();
    expect(screen.getByTestId('org-archive-retention-90')).toBeChecked();
  });

  it('renders every retention option', () => {
    renderModal();
    expect(screen.getByTestId('org-archive-retention-30')).toBeInTheDocument();
    expect(screen.getByTestId('org-archive-retention-90')).toBeInTheDocument();
    expect(screen.getByTestId('org-archive-retention-365')).toBeInTheDocument();
    expect(screen.getByTestId('org-archive-retention-never')).toBeInTheDocument();
    expect(screen.getByTestId('org-archive-retention-custom')).toBeInTheDocument();
  });

  it('hides the custom day input until Custom is selected', () => {
    renderModal();
    expect(screen.queryByTestId('org-archive-custom-days-input')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('org-archive-retention-custom'));
    expect(screen.getByTestId('org-archive-custom-days-input')).toBeInTheDocument();
  });

  it('rejects a custom value below 1, above 3650, or non-numeric, and accepts one in range', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('org-archive-retention-custom'));
    const input = screen.getByTestId('org-archive-custom-days-input');
    const submit = screen.getByTestId('org-archive-submit');

    fireEvent.change(input, { target: { value: '0' } });
    expect(screen.getByTestId('org-archive-custom-error')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: '3651' } });
    expect(screen.getByTestId('org-archive-custom-error')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: 'abc' } });
    expect(screen.getByTestId('org-archive-custom-error')).toBeInTheDocument();
    expect(submit).toBeDisabled();

    fireEvent.change(input, { target: { value: '500' } });
    expect(screen.queryByTestId('org-archive-custom-error')).not.toBeInTheDocument();
    expect(submit).not.toBeDisabled();
  });

  it('accepts the boundary values 1 and 3650', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('org-archive-retention-custom'));
    const input = screen.getByTestId('org-archive-custom-days-input');
    const submit = screen.getByTestId('org-archive-submit');

    fireEvent.change(input, { target: { value: '1' } });
    expect(screen.queryByTestId('org-archive-custom-error')).not.toBeInTheDocument();
    expect(submit).not.toBeDisabled();

    fireEvent.change(input, { target: { value: '3650' } });
    expect(screen.queryByTestId('org-archive-custom-error')).not.toBeInTheDocument();
    expect(submit).not.toBeDisabled();
  });
});

describe('ArchiveOrgModal — consequences copy', () => {
  it('states what archiving does: hidden, read-only, agents uninstalled, billing stops', () => {
    renderModal();
    const consequences = screen.getByTestId('org-archive-consequences');
    expect(consequences).toHaveTextContent('Hidden from your organization list and search');
    expect(consequences).toHaveTextContent('Existing data stays intact and read-only');
    expect(consequences).toHaveTextContent('Agents are uninstalled from its devices');
    expect(consequences).toHaveTextContent('Billing for this organization stops');
    expect(screen.getByText(/Restoring Acme Corp is the undo for this action/)).toBeInTheDocument();
  });

  it('shows the auto-purge consequence for a numeric retention option', () => {
    renderModal();
    expect(screen.getByTestId('org-archive-purge-consequence')).toHaveTextContent(
      'Permanently deleted after the retention period, unless you restore it first',
    );
  });

  it('shows the kept-indefinitely consequence when Never is selected', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('org-archive-retention-never'));
    expect(screen.getByTestId('org-archive-purge-consequence')).toHaveTextContent(
      'Kept until you delete it',
    );
  });

  it('never claims the action cannot be undone', () => {
    renderModal();
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
  });
});

describe('ArchiveOrgModal — submit', () => {
  it('POSTs {retentionDays: 90} for the default option and calls onArchived on 202', async () => {
    routeFetch({});
    const { onArchived } = renderModal();

    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(ORG.id));
    expect(fetchMock).toHaveBeenCalledWith(
      `/orgs/organizations/${ORG.id}/archive`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ retentionDays: 90 }) }),
    );
  });

  it('POSTs {retentionDays: null} when Never is selected', async () => {
    routeFetch({ archive: () => ({ payload: { status: 'archived', purgeAt: null } }) });
    renderModal();

    fireEvent.click(screen.getByTestId('org-archive-retention-never'));
    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/orgs/organizations/${ORG.id}/archive`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ retentionDays: null }) }),
      ),
    );
  });

  it('POSTs the custom day count when Custom is selected', async () => {
    routeFetch({});
    renderModal();

    fireEvent.click(screen.getByTestId('org-archive-retention-custom'));
    fireEvent.change(screen.getByTestId('org-archive-custom-days-input'), { target: { value: '500' } });
    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/orgs/organizations/${ORG.id}/archive`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ retentionDays: 500 }) }),
      ),
    );
  });

  it('POSTs the custom boundary value 1', async () => {
    routeFetch({});
    renderModal();

    fireEvent.click(screen.getByTestId('org-archive-retention-custom'));
    fireEvent.change(screen.getByTestId('org-archive-custom-days-input'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/orgs/organizations/${ORG.id}/archive`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ retentionDays: 1 }) }),
      ),
    );
  });

  it('POSTs the custom boundary value 3650', async () => {
    routeFetch({});
    renderModal();

    fireEvent.click(screen.getByTestId('org-archive-retention-custom'));
    fireEvent.change(screen.getByTestId('org-archive-custom-days-input'), { target: { value: '3650' } });
    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/orgs/organizations/${ORG.id}/archive`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ retentionDays: 3650 }) }),
      ),
    );
  });

  it('POSTs {retentionDays: 30} for the 30-day preset', async () => {
    routeFetch({});
    renderModal();

    fireEvent.click(screen.getByTestId('org-archive-retention-30'));
    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/orgs/organizations/${ORG.id}/archive`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ retentionDays: 30 }) }),
      ),
    );
  });

  it('POSTs {retentionDays: 365} for the 365-day preset', async () => {
    routeFetch({});
    renderModal();

    fireEvent.click(screen.getByTestId('org-archive-retention-365'));
    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/orgs/organizations/${ORG.id}/archive`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ retentionDays: 365 }) }),
      ),
    );
  });

  it('renders the draining-copy done state, description, and purge date for an offboarding response', async () => {
    routeFetch({ archive: () => ({ payload: { status: 'offboarding', purgeAt: '2026-11-24T00:00:00.000Z' } }) });
    renderModal();

    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() => expect(screen.getByTestId('org-archive-done')).toBeInTheDocument());
    expect(screen.getByText('Archiving started')).toBeInTheDocument();
    expect(
      screen.getByText(
        `${ORG.name} is being archived — its agents are being uninstalled now. This finishes automatically within a few minutes.`,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('org-archive-purge-summary')).toHaveTextContent('2026');
  });

  it('renders the archived-immediately done state and description for a suspended-entry response', async () => {
    routeFetch({ archive: () => ({ payload: { status: 'archived', purgeAt: null } }) });
    renderModal();

    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() => expect(screen.getByTestId('org-archive-done')).toBeInTheDocument());
    expect(screen.getByText('Organization archived')).toBeInTheDocument();
    expect(screen.getByText(`${ORG.name} has been archived.`)).toBeInTheDocument();
    expect(screen.getByTestId('org-archive-purge-summary')).toHaveTextContent('kept until you delete it');
  });

  it('closing the done summary calls onDoneClose', async () => {
    routeFetch({});
    const { onDoneClose } = renderModal();
    fireEvent.click(screen.getByTestId('org-archive-submit'));
    await waitFor(() => expect(screen.getByTestId('org-archive-done')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('org-archive-close'));
    expect(onDoneClose).toHaveBeenCalled();
  });

  it('on a server error, toasts and leaves the form open without calling onArchived', async () => {
    routeFetch({ archive: () => ({ payload: { error: 'Organization cannot be archived from status \'purging\'' }, status: 409 }) });
    const { onArchived } = renderModal();

    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(onArchived).not.toHaveBeenCalled();
    expect(screen.getByTestId('org-archive-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('org-archive-done')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-archive-submit')).not.toBeDisabled();
  });

  it('cancel calls onClose without submitting', () => {
    routeFetch({});
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId('org-archive-cancel'));
    expect(onClose).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redirects through handleSessionExpired on a 401 without an extra toast', async () => {
    routeFetch({ archive: () => ({ payload: { error: 'Unauthorized' }, status: 401 }) });
    const { onArchived } = renderModal();

    fireEvent.click(screen.getByTestId('org-archive-submit'));

    await waitFor(() => expect(sessionExpiredMock).toHaveBeenCalled());
    expect(onArchived).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });
});

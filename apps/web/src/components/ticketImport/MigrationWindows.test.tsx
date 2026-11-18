import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { fetchMock, toastMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), toastMock: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import MigrationWindowList from './MigrationWindows';
import CloseStep from './CloseStep';
import { ORG_A, WINDOW_ID, json, migrationWindow, sourceDetail } from './testFixtures';

const nameOfOrg = (id: string) => (id === ORG_A ? 'Acme' : id);

beforeEach(() => vi.clearAllMocks());

describe('MigrationWindowList (#8313 W6)', () => {
  it('lists every window with its counts and closes an open one after confirmation', async () => {
    fetchMock.mockResolvedValue(json(200, { data: migrationWindow({ status: 'closed' }), alreadyClosed: false }));
    const onChanged = vi.fn();
    render(<MigrationWindowList windows={[migrationWindow()]} loadFailed={false} nameOfOrg={nameOfOrg} onChanged={onChanged} />);
    expect(screen.getByTestId(`ticket-import-window-status-${WINDOW_ID}`)).toHaveTextContent('Open');
    expect(screen.getByTestId(`ticket-import-window-row-${WINDOW_ID}`)).toHaveTextContent('5 tickets, 9 comments, 1 files');
    fireEvent.click(screen.getByTestId(`ticket-import-window-close-${WINDOW_ID}`));
    fireEvent.click(await screen.findByTestId('ticket-import-window-close-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(`/migration-windows/${WINDOW_ID}/close`, expect.objectContaining({ method: 'POST', skipOrgIdInjection: true }));
  });

  it('says when there is none, or when they could not be read', () => {
    const { rerender } = render(<MigrationWindowList windows={[]} loadFailed={false} nameOfOrg={nameOfOrg} onChanged={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-windows-empty')).toBeInTheDocument();
    rerender(<MigrationWindowList windows={[]} loadFailed nameOfOrg={nameOfOrg} onChanged={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-windows-failed')).toBeInTheDocument();
  });
});

describe('CloseStep (#8313 W6)', () => {
  it('closes the source\'s open window, showing what it imported so far', async () => {
    fetchMock.mockResolvedValue(json(200, { data: migrationWindow({ status: 'closed' }), alreadyClosed: false }));
    const onClosed = vi.fn();
    render(<CloseStep source={sourceDetail()} latestWindow={migrationWindow()} runActive nameOfOrg={nameOfOrg} onClosed={onClosed} onManageSource={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-close-run-active')).toBeInTheDocument();
    expect(screen.getByTestId(`ticket-import-window-total-tickets-${WINDOW_ID}`)).toHaveTextContent('5');
    fireEvent.click(screen.getByTestId(`ticket-import-window-close-${WINDOW_ID}`));
    fireEvent.click(await screen.findByTestId('ticket-import-window-close-confirm'));
    await waitFor(() => expect(onClosed).toHaveBeenCalled());
  });

  it('shows the closed window\'s summary and the after-cutover steps', () => {
    const onManageSource = vi.fn();
    render(<CloseStep source={sourceDetail()} latestWindow={migrationWindow({ status: 'closed', closedReason: 'closed_by_admin', closedAt: '2026-11-14T00:00:00.000Z' })}
      runActive={false} nameOfOrg={nameOfOrg} onClosed={vi.fn()} onManageSource={onManageSource} />);
    expect(screen.getByTestId('ticket-import-close-summary')).toHaveTextContent('closed by an administrator');
    expect(screen.getByTestId(`ticket-import-window-summary-${WINDOW_ID}`)).toHaveTextContent('Acme');
    fireEvent.click(screen.getByTestId('ticket-import-close-manage-source'));
    expect(onManageSource).toHaveBeenCalled();
  });

  it('says when the source has no window', () => {
    render(<CloseStep source={sourceDetail()} latestWindow={null} runActive={false} nameOfOrg={nameOfOrg} onClosed={vi.fn()} onManageSource={vi.fn()} />);
    expect(screen.getByTestId('ticket-import-close-no-window')).toBeInTheDocument();
  });
});

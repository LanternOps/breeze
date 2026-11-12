import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { fetchMock, toastMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), toastMock: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import CreatedContactsPanel from './CreatedContactsPanel';
import { ORG_A, SOURCE_ID, json, sourceDetail } from './testFixtures';

const contact = (id: string, keptBecause: string[] = []) => ({
  contactId: id, orgId: ORG_A, name: `Person ${id}`, email: `${id}@example.com`, sourceUserKey: id,
  createdAt: '2026-11-12T09:00:00Z', keptBecause,
});

beforeEach(() => vi.clearAllMocks());

describe('CreatedContactsPanel (#8313 W6)', () => {
  it('lists the created contacts with why a removal would keep one, and pages', async () => {
    fetchMock.mockImplementation(async (url: string) => (url.includes('after=c-2')
      ? json(200, { data: [contact('c-3')], next: null })
      : json(200, { data: [contact('c-1'), contact('c-2', ['portal_login', 'edited'])], next: 'c-2' })));
    render(<CreatedContactsPanel source={sourceDetail()} nameOfOrg={() => 'Acme'} runActive={false} />);
    expect(await screen.findByTestId('ticket-import-contact-c-1')).toHaveTextContent('As imported');
    expect(screen.getByTestId('ticket-import-contact-c-2')).toHaveTextContent('Has a portal login, Edited');
    expect(screen.getByTestId('ticket-import-contact-c-1')).toHaveTextContent('Acme');
    fireEvent.click(screen.getByTestId('ticket-import-contacts-more'));
    expect(await screen.findByTestId('ticket-import-contact-c-3')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-import-contacts-more')).toBeNull();
  });

  it('removes the set after confirmation and reports what it kept and what remains', async () => {
    let removed = false;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && url === `/ticket-imports/sources/${SOURCE_ID}/created-contacts/remove`) {
        removed = true;
        return json(200, { data: { removed: 1, skipped: 1, skippedBy: { portal_login: 1, role: 0, other_link: 0, edited: 0, in_use: 0 }, remaining: 0, stoppedBy: null } });
      }
      return json(200, { data: removed ? [contact('c-2', ['portal_login'])] : [contact('c-1'), contact('c-2', ['portal_login'])], next: null });
    });
    render(<CreatedContactsPanel source={sourceDetail()} nameOfOrg={() => 'Acme'} runActive={false} />);
    fireEvent.click(await screen.findByTestId('ticket-import-contacts-remove'));
    fireEvent.click(await screen.findByTestId('ticket-import-contacts-remove-confirm'));
    expect(await screen.findByTestId('ticket-import-contacts-result')).toHaveTextContent('Removed 1, kept 1, 0 left');
    expect(screen.getByTestId('ticket-import-contacts-result')).toHaveTextContent('Has a portal login: 1');
    await waitFor(() => expect(screen.queryByTestId('ticket-import-contact-c-1')).toBeNull());
  });

  it('cannot remove while a run is active, and says so', async () => {
    fetchMock.mockResolvedValue(json(200, { data: [contact('c-1')], next: null }));
    render(<CreatedContactsPanel source={sourceDetail()} nameOfOrg={() => 'Acme'} runActive />);
    expect(await screen.findByTestId('ticket-import-contacts-remove')).toBeDisabled();
  });

  it('a removal refused by a run that just started says why', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => (init?.method === 'POST'
      ? json(409, { error: 'active', code: 'TICKET_IMPORT_RUN_ACTIVE' })
      : json(200, { data: [contact('c-1')], next: null })));
    render(<CreatedContactsPanel source={sourceDetail()} nameOfOrg={() => 'Acme'} runActive={false} />);
    fireEvent.click(await screen.findByTestId('ticket-import-contacts-remove'));
    fireEvent.click(await screen.findByTestId('ticket-import-contacts-remove-confirm'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'A run of this source is in progress. Wait for it or cancel it.',
    })));
  });

  it('says so when the source created no contact', async () => {
    fetchMock.mockResolvedValue(json(200, { data: [], next: null }));
    render(<CreatedContactsPanel source={sourceDetail()} nameOfOrg={() => 'Acme'} runActive={false} />);
    expect(await screen.findByTestId('ticket-import-contacts-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-import-contacts-remove')).toBeNull();
  });

  it('reads the set again when a run ends', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls += 1;
      return json(200, { data: calls === 1 ? [] : [contact('c-new')], next: null });
    });
    const { rerender } = render(<CreatedContactsPanel source={sourceDetail()} nameOfOrg={() => 'Acme'} runActive />);
    expect(await screen.findByTestId('ticket-import-contacts-empty')).toBeInTheDocument();
    rerender(<CreatedContactsPanel source={sourceDetail()} nameOfOrg={() => 'Acme'} runActive />);
    expect(calls).toBe(1);
    rerender(<CreatedContactsPanel source={sourceDetail()} nameOfOrg={() => 'Acme'} runActive={false} />);
    expect(await screen.findByTestId('ticket-import-contact-c-new')).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});

import '@/lib/i18n';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PsaTicketList, { type PsaTicket } from './PsaTicketList';

// The row exactly as GET /api/v1/psa/tickets returns it (mapTicketRow in
// apps/api/src/routes/psa.ts), including the `status: null` the ledger carries
// because no worker syncs a PSA status back yet.
const ledgerRow = {
  id: '6f1c2b1a-0000-4000-8000-000000000001',
  psaId: 'conn-1',
  title: 'Ticket 8841',
  status: null,
  syncedAt: '2026-11-02T10:00:00.000Z',
  connectionId: 'conn-1',
  alertId: 'alert-1',
  createState: 'created',
  closeState: 'none',
  noteState: 'none',
  lastError: null,
  lastErrorClass: null,
  externalTicketNumber: 'CW-8841',
  externalTicketUrl: 'https://psa.example/tickets/8841',
  source: 'auto',
  attempts: 1,
  nextAttemptAt: null,
  createAnywayUsed: false,
  raw: {
    externalTicketId: '8841',
    externalTicketUrl: 'https://psa.example/tickets/8841',
    alertId: 'alert-1',
    deviceId: 'device-1',
  },
};

const row = (overrides: Record<string, unknown>) => ({ ...ledgerRow, ...overrides }) as unknown as PsaTicket;
const connections = [{ id: 'conn-1', provider: 'connectwise' as const }];

describe('PsaTicketList status filter select accessible name (#7156)', () => {
  it('gives the status filter select a real accessible name', () => {
    render(<PsaTicketList tickets={[]} />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});

describe('PsaTicketList with the ledger shape GET /psa/tickets returns', () => {
  it('renders a real row instead of crashing, showing its ticket number and create state', () => {
    render(<PsaTicketList tickets={[row({})]} connections={connections} />);

    const tableRow = screen.getByRole('link', { name: 'CW-8841' }).closest('tr') as HTMLElement;
    expect(within(tableRow).getByText('Created')).toBeInTheDocument();
    expect(within(tableRow).getByText('Ticket 8841')).toBeInTheDocument();
    expect(within(tableRow).getByText('ConnectWise')).toBeInTheDocument();
    expect(within(tableRow).getByText(new Date(ledgerRow.syncedAt).toLocaleDateString())).toBeInTheDocument();
    expect(within(tableRow).queryByText('Unlinked')).toBeNull();
  });

  it('links the ticket number for an https URL and opens it safely', () => {
    render(<PsaTicketList tickets={[row({})]} />);
    const link = screen.getByRole('link', { name: 'CW-8841' });
    expect(link).toHaveAttribute('href', 'https://psa.example/tickets/8841');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it.each(['http://psa.example/tickets/8841', 'javascript:alert(1)', 'not a url', null])(
    'renders the ticket number as a plain label for %s, like the alert page',
    externalTicketUrl => {
      render(<PsaTicketList tickets={[row({ externalTicketUrl })]} />);
      expect(screen.getByText('CW-8841')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'CW-8841' })).toBeNull();
    }
  );

  it('falls back to the external ticket id when the provider gave no number', () => {
    render(<PsaTicketList tickets={[row({ externalTicketNumber: null })]} />);
    expect(screen.getByRole('link', { name: '8841' })).toBeInTheDocument();
  });

  it('shows only the title for a row with no external ticket yet', () => {
    render(
      <PsaTicketList
        tickets={[
          row({
            title: 'Ticket 6f1c2b1a',
            createState: 'failed',
            externalTicketNumber: null,
            externalTicketUrl: null,
            raw: { externalTicketId: null, externalTicketUrl: null, alertId: 'alert-1', deviceId: null },
          }),
        ]}
      />
    );
    const tableRow = screen.getByText('Ticket 6f1c2b1a').closest('tr') as HTMLElement;
    expect(within(tableRow).getByText('Failed')).toBeInTheDocument();
  });

  it('links to the alert when alertId is set and says unlinked when it is not', () => {
    const { unmount } = render(<PsaTicketList tickets={[row({})]} />);
    expect(screen.getByRole('link', { name: 'View alert' })).toHaveAttribute('href', '/alerts/alert-1');
    unmount();

    render(<PsaTicketList tickets={[row({ alertId: null })]} />);
    expect(screen.queryByRole('link', { name: 'View alert' })).toBeNull();
    expect(screen.getByText('Unlinked')).toBeInTheDocument();
  });

  it('keeps rendering on values it does not know', () => {
    render(
      <PsaTicketList
        tickets={[
          row({ id: 'a', createState: 'some_future_state', connectionId: 'conn-hidden', externalTicketNumber: 'A-1' }),
          row({ id: 'b', createState: null, connectionId: 'conn-2', externalTicketNumber: 'B-2', syncedAt: null }),
        ]}
        connections={[{ id: 'conn-2', provider: 'some_future_provider' as never }]}
      />
    );

    const first = screen.getByRole('link', { name: 'A-1' }).closest('tr') as HTMLElement;
    expect(within(first).getByText('some_future_state')).toBeInTheDocument();
    const second = screen.getByRole('link', { name: 'B-2' }).closest('tr') as HTMLElement;
    expect(within(second).getByText('some_future_provider')).toBeInTheDocument();

    // The filter offers only states a row actually has, so no blank option.
    const options = within(screen.getByRole('combobox', { name: 'Status' })).getAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual(['All statuses', 'some_future_state']);
  });

  it('searches on the fields the API returns', () => {
    render(
      <PsaTicketList
        tickets={[
          row({ id: 'a', externalTicketNumber: 'CW-1', title: 'Ticket 1' }),
          row({ id: 'b', externalTicketNumber: null, title: 'Ticket 2', connectionId: null, raw: null }),
        ]}
        connections={connections}
      />
    );
    const search = screen.getByRole('searchbox');

    fireEvent.change(search, { target: { value: 'cw-1' } });
    expect(screen.getByRole('link', { name: 'CW-1' })).toBeInTheDocument();
    expect(screen.queryByText('Ticket 2')).toBeNull();

    fireEvent.change(search, { target: { value: 'ticket 2' } });
    expect(screen.getByText('Ticket 2')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'CW-1' })).toBeNull();

    fireEvent.change(search, { target: { value: 'connectwise' } });
    expect(screen.getByRole('link', { name: 'CW-1' })).toBeInTheDocument();
    expect(screen.queryByText('Ticket 2')).toBeNull();
  });

  it('filters on create state', () => {
    render(
      <PsaTicketList
        tickets={[
          row({ id: 'a', externalTicketNumber: 'CW-1', createState: 'created' }),
          row({ id: 'b', externalTicketNumber: 'CW-2', createState: 'failed' }),
        ]}
      />
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'failed' } });
    expect(screen.getByRole('link', { name: 'CW-2' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'CW-1' })).toBeNull();
  });
});

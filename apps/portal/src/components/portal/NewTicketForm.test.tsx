// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { PortalTicketForm } from '@/lib/api';

// Mock the API client + navigation so the component fetches from stubs and never
// touches window navigation.
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/api', () => ({
  portalApi: {
    getTicketForms: vi.fn(),
    createTicket: vi.fn()
  }
}));

import { portalApi } from '@/lib/api';
import { NewTicketForm } from './NewTicketForm';

const getTicketForms = portalApi.getTicketForms as ReturnType<typeof vi.fn>;
const createTicket = portalApi.createTicket as ReturnType<typeof vi.fn>;

const FORM: PortalTicketForm = {
  id: 'form-1',
  name: 'Printer Problem',
  description: 'Report a printer issue',
  categoryId: null,
  defaultPriority: 'high',
  fields: [
    { key: 'model', label: 'Model', type: 'text', required: true },
    { key: 'qty', label: 'Quantity', type: 'number', required: false }
  ]
};

beforeEach(() => {
  vi.clearAllMocks();
  createTicket.mockResolvedValue({ data: { id: 'ticket-99' } });
});

afterEach(() => cleanup());

describe('NewTicketForm (portal) — intake form grid', () => {
  it('renders the card grid from the fetched forms plus a "Something else" card', async () => {
    getTicketForms.mockResolvedValue({ data: [FORM] });
    render(<NewTicketForm />);

    expect(await screen.findByTestId('portal-ticket-form-card-form-1')).toBeTruthy();
    expect(screen.getByTestId('portal-ticket-form-card-blank')).toBeTruthy();
  });

  it('the blank card falls through to the legacy subject/description form', async () => {
    getTicketForms.mockResolvedValue({ data: [FORM] });
    render(<NewTicketForm />);

    fireEvent.click(await screen.findByTestId('portal-ticket-form-card-blank'));

    // Legacy free-text inputs are present; intake fields are not.
    expect(screen.getByLabelText('Title')).toBeTruthy();
    expect(screen.queryByTestId('ticket-form-field-model')).toBeNull();
  });

  it('selecting a form card renders its intake fields', async () => {
    getTicketForms.mockResolvedValue({ data: [FORM] });
    render(<NewTicketForm />);

    fireEvent.click(await screen.findByTestId('portal-ticket-form-card-form-1'));

    expect(screen.getByTestId('ticket-form-field-model')).toBeTruthy();
    expect(screen.getByTestId('ticket-form-field-qty')).toBeTruthy();
  });

  it('blocks submit with an inline error when a required field is empty — no API call', async () => {
    getTicketForms.mockResolvedValue({ data: [FORM] });
    render(<NewTicketForm />);

    fireEvent.click(await screen.findByTestId('portal-ticket-form-card-form-1'));
    fireEvent.click(screen.getByTestId('portal-ticket-form-submit'));

    const err = await screen.findByTestId('ticket-form-field-error-model');
    expect(err.textContent).toBe('This field is required');
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('posts formId + coerced responses (no subject) on a valid submit', async () => {
    getTicketForms.mockResolvedValue({ data: [FORM] });
    render(<NewTicketForm />);

    fireEvent.click(await screen.findByTestId('portal-ticket-form-card-form-1'));
    fireEvent.change(screen.getByTestId('ticket-form-field-model'), { target: { value: 'HP LaserJet' } });
    fireEvent.change(screen.getByTestId('ticket-form-field-qty'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('portal-ticket-form-submit'));

    await waitFor(() => expect(createTicket).toHaveBeenCalledTimes(1));
    const payload = createTicket.mock.calls[0][0];
    expect(payload).toMatchObject({
      formId: 'form-1',
      formResponses: { model: 'HP LaserJet', qty: 3 }, // '3' coerced to a number
      priority: 'high' // prefilled from defaultPriority
    });
    expect(payload).not.toHaveProperty('subject');
  });

  it('degrades to the legacy form (with a console.warn) when the forms fetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getTicketForms.mockResolvedValue({ error: 'Network error' });
    render(<NewTicketForm />);

    // Legacy form is shown; no grid.
    expect(await screen.findByLabelText('Title')).toBeTruthy();
    expect(screen.queryByTestId('portal-ticket-form-card-blank')).toBeNull();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});

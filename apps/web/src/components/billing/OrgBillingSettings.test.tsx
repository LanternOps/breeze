import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgBillingSettings from './OrgBillingSettings';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// The org GET the billing tab loads from. Callers override individual fields.
const orgPayload = (over: Record<string, unknown> = {}) => json({
  taxId: null, taxExempt: false, taxRate: null,
  billingContact: null,
  billingAddressLine1: null, billingAddressLine2: null, billingAddressCity: null,
  billingAddressRegion: null, billingAddressPostalCode: null, billingAddressCountry: null,
  ...over,
});
const findPatch = () =>
  fetchMock.mock.calls.find((c) => c[0] === '/orgs/org-1/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');

describe('OrgBillingSettings — billing contact', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads and shows the saved billing contact email + name', async () => {
    fetchMock.mockResolvedValue(orgPayload({ billingContact: { email: 'ap@customer.example', name: 'AP Dept' } }));
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() =>
      expect((screen.getByTestId('org-billing-contact-email') as HTMLInputElement).value).toBe('ap@customer.example'));
    expect((screen.getByTestId('org-billing-contact-name') as HTMLInputElement).value).toBe('AP Dept');
  });

  it('sends billingContactEmail/Name in the PATCH body when filled', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) =>
      opts?.method === 'PATCH' ? json({ data: {} }) : orgPayload());
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('org-billing-contact-email'), { target: { value: 'billing@customer.example' } });
    fireEvent.change(screen.getByTestId('org-billing-contact-name'), { target: { value: 'Accounts Payable' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));

    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({
        billingContactEmail: 'billing@customer.example', billingContactName: 'Accounts Payable',
      });
    });
  });

  it('serializes a cleared contact email to null (never "") so the schema does not 400', async () => {
    // The linchpin of the design: orgBillingSettingsSchema rejects '' via .email();
    // clearing the field must send null. Mirrors PartnerBillingSettings' address test.
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) =>
      opts?.method === 'PATCH' ? json({ data: {} }) : orgPayload({ billingContact: { email: 'ap@customer.example', name: 'AP' } }));
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() =>
      expect((screen.getByTestId('org-billing-contact-email') as HTMLInputElement).value).toBe('ap@customer.example'));

    // Clear the email to whitespace-only, then save.
    fireEvent.change(screen.getByTestId('org-billing-contact-email'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));

    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string).billingContactEmail).toBeNull();
    });
  });
});

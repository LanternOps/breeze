import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #8796: every curated template dialog asks who the report is for and where it
// is sent — the shared Covers + delivery block — before the report is created.
const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector({}), {
    getState: () => ({}),
  }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import ReportTemplates from './ReportTemplates';

const ok = (payload: unknown, status = 200) =>
  Promise.resolve({ ok: true, status, json: () => Promise.resolve(payload) });
const fail = (status: number, payload: unknown = { error: 'nope' }) =>
  Promise.resolve({ ok: false, status, json: () => Promise.resolve(payload) });
const posts = (url: string) =>
  fetchWithAuth.mock.calls.filter(([u, i]) => u === url && (i as { method?: string } | undefined)?.method === 'POST');
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body);

let recipientResponse: () => Promise<unknown>;

const CASES = [
  { name: 'Intune Endpoint Management Review', type: 'endpoint_management_review', submit: 'endpoint-management-create-report' },
  { name: 'Vulnerability Management Report', type: 'vulnerability_management', submit: 'vulnerability-create-report' },
  { name: 'Backup Status Report', type: 'backup_status', submit: 'backup-status-create-report' },
  { name: 'Identity & Access Review', type: 'identity_access_review', submit: 'identity-access-create-report' },
  { name: 'Threat Detection Review', type: 'threat_detection_review', submit: 'threat-detection-create-report' },
  { name: 'Hardware Lifecycle Report', type: 'hardware_lifecycle', submit: 'lifecycle-create-report' },
  { name: 'Security & Compliance Posture (Insurance)', type: 'security_compliance_posture', submit: 'posture-options-submit' },
] as const;

const TEMPLATE_ID: Record<string, string> = Object.fromEntries(CASES.map((c) => [c.name, c.type]));

async function useTemplate(name: string) {
  await userEvent.setup().click(await screen.findByTestId(`report-template-use-${TEMPLATE_ID[name]}`));
}

describe('ReportTemplates — template dialogs ask for recipients (#8796)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recipientResponse = () => ok({ id: 'r-1' }, 201);
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/orgs/organizations/org-1/contacts') {
        return ok({
          data: [
            { id: 'c-1', name: 'Pat Owner', email: 'pat@acme.test' },
            { id: 'c-2', name: 'No Email', email: '' },
          ],
        });
      }
      if (url === '/reports' && init?.method === 'POST') return ok({ id: 'rep-9' }, 201);
      if (url === '/reports/rep-9/recipients' && init?.method === 'POST') return recipientResponse();
      return fail(404);
    });
  });

  it.each(CASES)('$type: covers + delivery block, contact and address sent with the create', async ({ name, type, submit }) => {
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate(name);

    expect(screen.getByTestId(`template-covers-${type}`)).toBeInTheDocument();
    const delivery = screen.getByTestId('template-delivery');
    await user.selectOptions(within(delivery).getByTestId('template-delivery-schedule'), 'weekly');
    // Only contacts with an address are offered.
    const contact = await within(delivery).findByTestId('template-delivery-contact-c-1');
    expect(within(delivery).queryByTestId('template-delivery-contact-c-2')).toBeNull();
    await user.click(within(contact).getByRole('checkbox'));
    await user.type(within(delivery).getByTestId('template-delivery-email-input'), 'it@acme.test');
    await user.click(within(delivery).getByTestId('template-delivery-email-add'));

    await user.click(screen.getByTestId(submit));

    await waitFor(() => expect(posts('/reports/rep-9/recipients')).toHaveLength(1));
    const created = bodyOf(posts('/reports')[0]!);
    expect(created).toMatchObject({ type, orgId: 'org-1', schedule: 'weekly' });
    expect(created.config.emailRecipients).toEqual(['it@acme.test']);
    expect(bodyOf(posts('/reports/rep-9/recipients')[0]!)).toEqual({ contactId: 'c-1' });
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports'));
  });

  it('a one-time report is not emailed: no recipient fields, none sent', async () => {
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Intune Endpoint Management Review');

    const delivery = screen.getByTestId('template-delivery');
    // Pick a contact while recurring, then switch to one-time.
    await user.click(within(await within(delivery).findByTestId('template-delivery-contact-c-1')).getByRole('checkbox'));
    await user.selectOptions(within(delivery).getByTestId('template-delivery-schedule'), 'one_time');
    expect(within(delivery).getByTestId('template-delivery-one-time-note')).toBeInTheDocument();
    expect(within(delivery).queryByTestId('template-delivery-email-input')).toBeNull();

    await user.click(screen.getByTestId('endpoint-management-create-report'));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports'));
    const created = bodyOf(posts('/reports')[0]!);
    expect(created.schedule).toBe('one_time');
    expect(created.config).not.toHaveProperty('emailRecipients');
    expect(posts('/reports/rep-9/recipients')).toHaveLength(0);
  });

  it('defaults the delivery schedule to the template cadence and sends no recipients when none are chosen', async () => {
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Vulnerability Management Report');

    expect(within(screen.getByTestId('template-delivery')).getByTestId('template-delivery-schedule')).toHaveValue('monthly');
    await user.click(screen.getByTestId('vulnerability-create-report'));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports'));
    const created = bodyOf(posts('/reports')[0]!);
    expect(created.schedule).toBe('monthly');
    expect(created.config).not.toHaveProperty('emailRecipients');
    expect(posts('/reports/rep-9/recipients')).toHaveLength(0);
  });

  it('a recipient that fails to attach is reported, and the user lands on the new report to fix it', async () => {
    recipientResponse = () => fail(403, { error: 'forbidden' });
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Threat Detection Review');

    const delivery = screen.getByTestId('template-delivery');
    await user.click(within(await within(delivery).findByTestId('template-delivery-contact-c-1')).getByRole('checkbox'));
    await user.click(screen.getByTestId('threat-detection-create-report'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports/rep-9/edit'));
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringMatching(/recipients/i) }),
    );
  });

  it('one refused contact does not stop the others from being attached', async () => {
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/orgs/organizations/org-1/contacts') {
        return ok({
          data: [
            { id: 'c-1', name: 'Pat Owner', email: 'pat@acme.test' },
            { id: 'c-3', name: 'Sam Admin', email: 'sam@acme.test' },
          ],
        });
      }
      if (url === '/reports' && init?.method === 'POST') return ok({ id: 'rep-9' }, 201);
      if (url === '/reports/rep-9/recipients' && init?.method === 'POST') {
        const { contactId } = JSON.parse((init as { body: string }).body);
        return contactId === 'c-1' ? fail(404, { error: 'Contact not found' }) : ok({ id: 'r-3' }, 201);
      }
      return fail(404);
    });
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Intune Endpoint Management Review');
    const delivery = screen.getByTestId('template-delivery');
    await user.click(within(await within(delivery).findByTestId('template-delivery-contact-c-1')).getByRole('checkbox'));
    await user.click(within(delivery).getByTestId('template-delivery-contact-c-3').querySelector('input')!);
    await user.click(screen.getByTestId('endpoint-management-create-report'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports/rep-9/edit'));
    expect(posts('/reports/rep-9/recipients').map((call) => bodyOf(call).contactId)).toEqual(['c-1', 'c-3']);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('an invalid address is refused, not added', async () => {
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Identity & Access Review');

    const delivery = screen.getByTestId('template-delivery');
    await user.type(within(delivery).getByTestId('template-delivery-email-input'), 'not-an-address');
    await user.click(within(delivery).getByTestId('template-delivery-email-add'));
    expect(within(delivery).getByTestId('template-delivery-email-error')).toBeInTheDocument();
    expect(within(delivery).queryByTestId('template-delivery-email-chip-not-an-address')).toBeNull();
  });

  it('says so when the organization contacts cannot be loaded', async () => {
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/reports' && init?.method === 'POST') return ok({ id: 'rep-9' }, 201);
      return fail(403);
    });
    render(<ReportTemplates />);
    await useTemplate('Backup Status Report');
    await userEvent.setup().selectOptions(screen.getByTestId('template-delivery-schedule'), 'monthly');
    expect(await screen.findByTestId('template-delivery-contacts-failed')).toBeInTheDocument();
  });
});

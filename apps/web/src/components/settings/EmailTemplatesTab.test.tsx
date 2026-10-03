import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  EMAIL_TEMPLATE_IDS,
  emailTemplateLabel,
} from '@breeze/shared';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));
vi.mock('../../lib/runAction', () => ({
  runAction: async (o: { request: () => Promise<Response> }) => {
    const r = await o.request();
    return r.json().catch(() => null);
  },
  handleActionError: vi.fn(),
}));
vi.mock('../common/RichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) => (
    <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import EmailTemplatesTab from './EmailTemplatesTab';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function routeFetch(emailTemplates: Record<string, unknown> = {}) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/orgs/partners/me') {
      return Promise.resolve(jsonRes({ id: 'p-1', settings: { emailTemplates } }));
    }
    return Promise.resolve(jsonRes({}));
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('EmailTemplatesTab', () => {
  it('mounts all enrollment templates under Billing & payments and opens their existing editor', async () => {
    routeFetch();
    render(<EmailTemplatesTab />);
    const group = await screen.findByTestId('autopay-email-template-group');
    expect(group.textContent).toContain('Billing & payments');
    for (const id of ['autopay_request', 'autopay_enrolled', 'autopay_stopped','autopay_paused','autopay_resumed', 'card_expiring']) {
      expect(within(group).getByTestId(`autopay-email-template-${id}`)).toBeTruthy();
    }
    fireEvent.click(within(group).getByTestId('autopay-email-template-autopay_request'));
    expect(await screen.findByTestId('email-template-editor')).toBeTruthy();
  });

  it('lists all catalog template ids with catalog labels', async () => {
    routeFetch();
    render(<EmailTemplatesTab />);

    expect(await screen.findByTestId('email-templates-list')).toBeTruthy();
    expect([...EMAIL_TEMPLATE_IDS]).toEqual([
      'ticket_comment_notification',
      'ticket_autoresponse',
      'ticket_resolved',
      'quote_send',
      'invoice_send',
      'invoice_autopay',
      'portal_invite',
      'autopay_request',
      'autopay_enrolled',
      'autopay_stopped','autopay_paused','autopay_resumed',
      'card_expiring',
      'payment_reminder', 'payment_overdue',
      'payment_receipt', 'payment_failed',
    ]);
    expect(screen.getByTestId('autopay-email-template-group').contains(screen.getByTestId('email-template-row-invoice_autopay'))).toBe(true);
    const newIds = new Set(['autopay_request', 'autopay_enrolled', 'autopay_stopped','autopay_paused','autopay_resumed', 'card_expiring']);
    for (const id of EMAIL_TEMPLATE_IDS) {
      const row = screen.getByTestId(newIds.has(id) ? `autopay-email-template-${id}` : id === 'payment_reminder' || id === 'payment_overdue' ? `autopay-template-${id}` : `email-template-row-${id}`);
      expect(row.textContent).toContain(emailTemplateLabel(id));
      expect(screen.getByTestId(`email-template-status-${id}`).textContent).toContain('Using default');
    }
  });

  it('shows quote, invoice, and portal-invite rows and copy that is not ticket-only', async () => {
    routeFetch();
    render(<EmailTemplatesTab />);

    const tab = await screen.findByTestId('email-templates-tab');
    expect(screen.getByTestId('email-template-row-quote_send').textContent).toContain('Quote / proposal');
    expect(screen.getByTestId('email-template-row-invoice_send').textContent).toContain('Invoice');
    expect(screen.getByTestId('email-template-row-portal_invite').textContent).toContain('Portal invite');
    const description = tab.querySelector('p')?.textContent ?? '';
    expect(description).toMatch(/quotes/i);
    expect(description).toMatch(/invoices/i);
    expect(description).toMatch(/invite/i);
    expect(description).not.toMatch(/^Customize the emails customers receive about tickets\./);
  });

  it('marks a template Custom when any stored field is non-null', async () => {
    routeFetch({
      ticket_resolved: { subject: 'Resolved: {{ticket_subject}}', heading: null, buttonLabel: null, html: null },
    });
    render(<EmailTemplatesTab />);

    await screen.findByTestId('email-templates-list');
    expect(screen.getByTestId('email-template-status-ticket_resolved').textContent).toContain('Custom');
    expect(screen.getByTestId('email-template-status-ticket_comment_notification').textContent).toContain('Using default');
    expect(screen.getByTestId('email-template-status-ticket_autoresponse').textContent).toContain('Using default');
  });

  it('opens the editor for a row without changing the page hash', async () => {
    window.location.hash = '#email-templates';
    routeFetch();
    render(<EmailTemplatesTab />);

    await screen.findByTestId('email-templates-list');
    fireEvent.click(screen.getByTestId('email-template-row-ticket_comment_notification'));

    expect(await screen.findByTestId('email-template-editor')).toBeTruthy();
    expect(window.location.hash).toBe('#email-templates');
  });
});

it.each(['payment_reminder', 'payment_overdue'])('opens the %s editor from Billing & payments', async id => {
  routeFetch(); render(<EmailTemplatesTab />);
  const row = await screen.findByTestId(`autopay-template-${id}`);
  expect(screen.getByTestId('autopay-email-template-group')).toContainElement(row);
  fireEvent.click(row);
  expect(await screen.findByTestId('email-template-editor')).toBeTruthy();
});

it('retains translated enrollment and group labels alongside reminder rows', async () => {
  const translated = createInstance();
  const labels = {
    autopay_request: 'Demande de paiement automatique',
    autopay_enrolled: 'Paiements automatiques confirmés',
    autopay_stopped: 'Paiements automatiques arrêtés',
    autopay_paused: 'Paiements automatiques suspendus',
    autopay_resumed: 'Paiements automatiques repris',
    card_expiring: 'Expiration de la carte enregistrée',
  };
  await translated.init({ lng: 'fr', fallbackLng: false, defaultNS: 'settings',
    resources: { fr: { settings: { emailTemplates: {
      billingPayments: 'Facturation et paiements', supportPortal: 'Assistance et portail', labels,
    } } } }, interpolation: { escapeValue: false } });
  routeFetch();
  render(<I18nextProvider i18n={translated}><EmailTemplatesTab /></I18nextProvider>);
  const group = await screen.findByTestId('autopay-email-template-group');
  expect(group.textContent).toContain('Facturation et paiements');
  expect(screen.getByTestId('email-template-other-group').textContent).toContain('Assistance et portail');
  for (const [id, label] of Object.entries(labels)) {
    expect(within(group).getByTestId(`autopay-email-template-${id}`).textContent).toContain(label);
  }
  for (const id of ['payment_reminder', 'payment_overdue']) {
    expect(within(group).getByTestId(`autopay-template-${id}`)).toBeTruthy();
  }
});

it.each([
  ['payment_reminder', 'Rappel de paiement'],
  ['payment_overdue', 'Rappel de paiement en retard'],
])('translates the %s row and opened editor heading', async (id, label) => {
  const translated = createInstance();
  await translated.init({ lng: 'fr', fallbackLng: false, defaultNS: 'settings',
    resources: { fr: { billing: { reminders: { templates: {
      paymentReminder: 'Rappel de paiement', paymentOverdue: 'Rappel de paiement en retard',
    } } } } }, interpolation: { escapeValue: false } });
  routeFetch();
  render(<I18nextProvider i18n={translated}><EmailTemplatesTab /></I18nextProvider>);
  const row = await screen.findByTestId(`autopay-template-${id}`);
  expect(row).toHaveTextContent(label);
  fireEvent.click(row);
  expect(within(await screen.findByTestId('email-template-editor')).getByRole('heading', { name: label })).toBeInTheDocument();
});

it.each([
  ['payment_receipt', 'Reçu de paiement'],
  ['payment_failed', 'Le paiement n’a pas pu être effectué'],
])('translates the %s row and editor heading', async (id, label) => {
  const translated = createInstance();
  await translated.init({ lng: 'fr', fallbackLng: false, defaultNS: 'settings',
    resources: { fr: { settings: { emailTemplates: { labels: { [id]: label } } } } },
    interpolation: { escapeValue: false } });
  routeFetch();
  render(<I18nextProvider i18n={translated}><EmailTemplatesTab /></I18nextProvider>);
  const row = await screen.findByTestId(`email-template-row-${id}`);
  expect(row).toHaveTextContent(label);
  fireEvent.click(row);
  expect(within(await screen.findByTestId('email-template-editor')).getByRole('heading', { name: label })).toBeInTheDocument();
});

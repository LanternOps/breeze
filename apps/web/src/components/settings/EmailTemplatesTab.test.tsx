import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
  it('lists the three PR1 template ids with catalog labels', async () => {
    routeFetch();
    render(<EmailTemplatesTab />);

    expect(await screen.findByTestId('email-templates-list')).toBeTruthy();
    for (const id of EMAIL_TEMPLATE_IDS) {
      const row = screen.getByTestId(`email-template-row-${id}`);
      expect(row.textContent).toContain(emailTemplateLabel(id));
      expect(screen.getByTestId(`email-template-status-${id}`).textContent).toContain('Using default');
    }
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

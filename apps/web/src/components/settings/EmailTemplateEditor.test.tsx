import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));
vi.mock('../../lib/runAction', () => ({
  runAction: async (o: {
    request: () => Promise<Response>;
    parseSuccess?: (d: unknown) => unknown;
  }) => {
    const r = await o.request();
    const data = await r.json().catch(() => null);
    return o.parseSuccess ? o.parseSuccess(data) : data;
  },
  handleActionError: vi.fn(),
}));
vi.mock('../common/RichTextEditor', () => ({
  default: ({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) => (
    <textarea data-testid={testId} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import {
  EMAIL_TEMPLATE_IDS,
  emailTemplateFieldDefaults,
  emailTemplateHasCta,
  varsForEmailTemplate,
} from '@breeze/shared';
import EmailTemplateEditor from './EmailTemplateEditor';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function lastPatchBody(): Record<string, unknown> {
  const call = fetchWithAuth.mock.calls.find(
    (c) => c[0] === '/orgs/partners/me' && (c[1] as { method?: string })?.method === 'PATCH',
  );
  if (!call) throw new Error('no PATCH /orgs/partners/me');
  return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockResolvedValue(jsonRes({ id: 'p-1', settings: {} }));
});

describe('EmailTemplateEditor', () => {
  it('fills empty stored fields with the catalog defaults', () => {
    const defaults = emailTemplateFieldDefaults('ticket_comment_notification');
    render(
      <EmailTemplateEditor
        templateId="ticket_comment_notification"
        value={{ subject: null, heading: null, buttonLabel: null, html: null }}
        onBack={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect((screen.getByTestId('email-template-subject') as HTMLInputElement).value).toBe(defaults.subject);
    expect((screen.getByTestId('email-template-heading') as HTMLInputElement).value).toBe(defaults.heading);
    expect((screen.getByTestId('email-template-button-label') as HTMLInputElement).value).toBe(defaults.buttonLabel);
    expect((screen.getByTestId('email-template-html') as HTMLTextAreaElement).value).toBe(defaults.html);
  });

  it('keeps a saved override instead of the default', () => {
    render(
      <EmailTemplateEditor
        templateId="ticket_comment_notification"
        value={{ subject: 'Custom subject', heading: 'Custom heading', buttonLabel: 'Go', html: '<p>Custom</p>' }}
        onBack={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect((screen.getByTestId('email-template-subject') as HTMLInputElement).value).toBe('Custom subject');
    expect((screen.getByTestId('email-template-html') as HTMLTextAreaElement).value).toBe('<p>Custom</p>');
  });

  it('saves untouched defaults as null so the list stays Using default', async () => {
    render(
      <EmailTemplateEditor
        templateId="ticket_comment_notification"
        value={{ subject: null, heading: null, buttonLabel: null, html: null }}
        onBack={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('email-template-save'));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      '/orgs/partners/me',
      expect.objectContaining({ method: 'PATCH' }),
    ));
    expect(lastPatchBody()).toEqual({
      settings: {
        emailTemplates: {
          ticket_comment_notification: {
            subject: null,
            heading: null,
            buttonLabel: null,
            html: null,
          },
        },
      },
    });
  });

  it('PATCHes only the edited id under settings.emailTemplates', async () => {
    const onSaved = vi.fn();
    render(
      <EmailTemplateEditor
        templateId="ticket_comment_notification"
        value={{ subject: null, heading: null, buttonLabel: null, html: null }}
        onBack={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByTestId('email-template-subject'), {
      target: { value: 'Reply on {{ticket_number}}' },
    });
    fireEvent.change(screen.getByTestId('email-template-heading'), {
      target: { value: 'New reply' },
    });
    fireEvent.change(screen.getByTestId('email-template-button-label'), {
      target: { value: 'Open ticket' },
    });
    fireEvent.change(screen.getByTestId('email-template-html'), {
      target: { value: '<p>Hi {{requester_name}}</p>' },
    });
    fireEvent.click(screen.getByTestId('email-template-save'));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      '/orgs/partners/me',
      expect.objectContaining({ method: 'PATCH' }),
    ));
    const body = lastPatchBody();
    expect(body).toEqual({
      settings: {
        emailTemplates: {
          ticket_comment_notification: {
            subject: 'Reply on {{ticket_number}}',
            heading: 'New reply',
            buttonLabel: 'Open ticket',
            html: '<p>Hi {{requester_name}}</p>',
          },
        },
      },
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('inserts {{ticket_number}} into the html value', () => {
    render(
      <EmailTemplateEditor
        templateId="ticket_comment_notification"
        value={{ subject: null, heading: null, buttonLabel: null, html: '<p>Hello</p>' }}
        onBack={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('email-template-var-ticket_number'));
    expect((screen.getByTestId('email-template-html') as HTMLTextAreaElement).value).toBe(
      '<p>Hello</p>{{ticket_number}}',
    );
  });

  it('reset saves all four fields as null and puts the defaults back in the form', async () => {
    const defaults = emailTemplateFieldDefaults('ticket_resolved');
    render(
      <EmailTemplateEditor
        templateId="ticket_resolved"
        value={{ subject: 'Done', heading: 'Resolved', buttonLabel: 'View', html: '<p>Bye</p>' }}
        onBack={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('email-template-reset'));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      '/orgs/partners/me',
      expect.objectContaining({ method: 'PATCH' }),
    ));
    expect(lastPatchBody()).toEqual({
      settings: {
        emailTemplates: {
          ticket_resolved: {
            subject: null,
            heading: null,
            buttonLabel: null,
            html: null,
          },
        },
      },
    });
    expect((screen.getByTestId('email-template-subject') as HTMLInputElement).value).toBe(defaults.subject);
    expect((screen.getByTestId('email-template-heading') as HTMLInputElement).value).toBe(defaults.heading);
    expect((screen.getByTestId('email-template-button-label') as HTMLInputElement).value).toBe(defaults.buttonLabel);
    expect((screen.getByTestId('email-template-html') as HTMLTextAreaElement).value).toBe(defaults.html);
  });

  it('hides the button label when the template has no CTA', () => {
    render(
      <EmailTemplateEditor
        templateId="ticket_autoresponse"
        value={{ subject: null, heading: null, buttonLabel: null, html: null }}
        onBack={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('email-template-button-label')).toBeNull();
    expect(screen.queryByTestId('email-template-var-cta_button')).toBeNull();
    expect(screen.getByTestId('email-template-subject')).toBeTruthy();
  });

  it.each([...EMAIL_TEMPLATE_IDS])('shows every catalog insert chip for %s', (id) => {
    render(
      <EmailTemplateEditor
        templateId={id}
        value={{ subject: null, heading: null, buttonLabel: null, html: null }}
        onBack={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    for (const key of varsForEmailTemplate(id)) {
      expect(screen.getByTestId(`email-template-var-${key}`)).toBeTruthy();
    }
    if (emailTemplateHasCta(id)) {
      expect(screen.getByTestId('email-template-button-label')).toBeTruthy();
      expect(screen.getByTestId('email-template-var-cta_button')).toBeTruthy();
    } else {
      expect(screen.queryByTestId('email-template-button-label')).toBeNull();
      expect(screen.queryByTestId('email-template-var-cta_button')).toBeNull();
    }
  });

  it('previews substituted html in a read-only prose div without running scripts', () => {
    render(
      <EmailTemplateEditor
        templateId="ticket_comment_notification"
        value={{
          subject: null,
          heading: null,
          buttonLabel: null,
          html: '<p>Hi {{requester_name}}</p><script>window.__emailTplPwned=1</script>',
        }}
        onBack={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const preview = screen.getByTestId('email-template-preview');
    expect(preview.className).toContain('prose');
    expect(preview.textContent).toContain('Hi Sample Requester');
    expect(preview.innerHTML).not.toMatch(/<script/i);
    expect((window as unknown as { __emailTplPwned?: number }).__emailTplPwned).toBeUndefined();
  });

  it('strips javascript hrefs, style, base, and form from the preview', () => {
    render(
      <EmailTemplateEditor
        templateId="ticket_comment_notification"
        value={{
          subject: null,
          heading: null,
          buttonLabel: null,
          html:
            '<p style="color:red"><a href="javascript:alert(1)">x</a><a href="java\tscript:alert(1)">y</a><a href="java\nscript:alert(1)">z</a><a href="java\rscript:alert(1)">w</a></p><base href="https://evil.example"><form action="https://evil.example"><input name="q"></form>',
        }}
        onBack={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const html = screen.getByTestId('email-template-preview').innerHTML;
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/java[\x00-\x20]+script:/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/<base/i);
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/<input/i);
  });

  it('applies the sanitized html from the save response, not the pre-save editor value', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({
      id: 'p-1',
      settings: {
        emailTemplates: {
          ticket_comment_notification: {
            subject: 'Hi',
            heading: 'Hello',
            buttonLabel: 'Go',
            html: '<p>clean</p>',
          },
        },
      },
    }));
    const onSaved = vi.fn();
    render(
      <EmailTemplateEditor
        templateId="ticket_comment_notification"
        value={{ subject: 'Hi', heading: 'Hello', buttonLabel: 'Go', html: '<p>dirty</p>' }}
        onBack={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByTestId('email-template-html'), {
      target: { value: '<p>dirty<script>x</script></p>' },
    });
    fireEvent.click(screen.getByTestId('email-template-save'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({
      subject: 'Hi',
      heading: 'Hello',
      buttonLabel: 'Go',
      html: '<p>clean</p>',
    }));
    expect((screen.getByTestId('email-template-html') as HTMLTextAreaElement).value).toBe('<p>clean</p>');
  });
});
